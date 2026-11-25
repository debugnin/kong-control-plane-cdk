import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { CertificateConstruct } from './constructs/certificate-construct';
import { WafConstruct } from './constructs/waf-construct';
import { AlbConstruct, ADMIN_API_PORT } from './constructs/alb-construct';
import { LoggingConstruct } from './constructs/logging-construct';

// Kong container ports
const KONG_ADMIN_PORT = 8444; // Admin API (TLS)
const KONG_MANAGER_PORT = 8445; // Kong Manager (TLS)
const KONG_STATUS_PORT = 8100; // Status API (HTTP) - unauthenticated /status for health checks
const KONG_CLUSTER_PORT = 8005; // CP<->DP config sync (mTLS, terminated by Kong)
const KONG_TELEMETRY_PORT = 8006; // CP<->DP telemetry (mTLS, terminated by Kong)

export interface KongControlPlaneStackProps extends cdk.StackProps {
    environment: string; // Environment: dev, qa, uat, prd
    vpc: ec2.IVpc;

    /** Aurora cluster, its security group and the credentials Kong uses to connect. */
    database: {
        cluster: rds.DatabaseClusterBase;
        securityGroup: ec2.ISecurityGroup;
        databaseName: string;
        /** PEM bundle of the RDS CA(s) used to verify the Aurora server certificate. */
        caBundlePem: string;
        /** KMS key encrypting the Aurora master secret. */
        encryptionKey: kms.IKey;
        adminSecret: secretsmanager.ISecret;
        sessionSecret: secretsmanager.ISecret;
    };

    controlPlane: {
        imageUri: string;
        /** Secrets Manager ARN (complete, with suffix) whose value is the Kong Enterprise license. */
        licenseSecretArn: string;
        /** Secrets Manager ARN (complete) with keys `cluster_cert` and `cluster_cert_key` (PEM). */
        clusterCertSecretArn: string;
        cpu?: number;
        memoryMiB?: number;
        replicas?: number;
        logLevel?: string;
        logRetentionDays?: logs.RetentionDays;
        /** CIDRs of the data planes that connect to ports 8005/8006 (default: VPC CIDR). */
        dataPlaneCidrs?: string[];
        /** Optional DNS name for the cluster (NLB) endpoint, e.g. cp-cluster.example.com. */
        clusterDomain?: string;
    };

    certificate: {
        /** Use an existing ACM certificate... */
        existingArn?: string;
        /** ...or request a new one for this domain (DNS-validated in the hosted zone). */
        domainName?: string;
        subjectAlternativeNames?: string[];
        hostedZoneId?: string;
        hostedZoneName?: string;
    };

    alb: {
        /** CIDRs allowed to reach Kong Manager and the Admin API (default: VPC CIDR). */
        allowedCidrs?: string[];
        internetFacing?: boolean;
        enableAccessLogs?: boolean;
    };

    waf?: {
        enabled?: boolean;
        rateLimitPerMinute?: number;
        allowedCidrs?: string[];
        enableCidrRestriction?: boolean;
    };

    logging?: {
        enabled?: boolean;
        centralDestinationArn?: string;
        filterPattern?: string;
    };
}

/**
 * Stateless Kong control plane: ECS Fargate service (role=control_plane), an internal
 * ALB for Kong Manager / Admin API, and an internal NLB for the data plane cluster
 * and telemetry endpoints (TCP passthrough - Kong terminates the CP<->DP mTLS itself).
 */
export class KongControlPlaneStack extends cdk.Stack {
    public readonly cluster: ecs.Cluster;
    public readonly service: ecs.FargateService;
    public readonly alb: AlbConstruct;
    public readonly nlb: elbv2.NetworkLoadBalancer;

    constructor(scope: Construct, id: string, props: KongControlPlaneStackProps) {
        super(scope, id, props);

        const { environment, vpc, database, controlPlane } = props;
        const vpcCidr = vpc.vpcCidrBlock;
        const managerHost = props.certificate.domainName;

        // ---------------------------------------------------------------- Certificate
        let certificateArn = props.certificate.existingArn;
        if (!certificateArn) {
            if (!props.certificate.domainName) {
                throw new Error(
                    'A TLS certificate is required for Kong Manager / Admin API. ' +
                        'Set albCertificateArn (existing ACM certificate) or albDomain (new certificate).'
                );
            }
            certificateArn = new CertificateConstruct(this, 'CertificateConstruct', {
                domainName: props.certificate.domainName,
                subjectAlternativeNames: props.certificate.subjectAlternativeNames,
                hostedZoneId: props.certificate.hostedZoneId,
                hostedZoneName: props.certificate.hostedZoneName,
            }).certificate.certificateArn;
        }

        // ------------------------------------------------------------------------ WAF
        const wafConstruct =
            props.waf?.enabled !== false
                ? new WafConstruct(this, 'AlbWafConstruct', {
                      scope: 'REGIONAL',
                      environment,
                      component: 'cp-alb',
                      rateLimitPerMinute: props.waf?.rateLimitPerMinute,
                      allowedCidrs: props.waf?.allowedCidrs,
                      enableCidrRestriction: props.waf?.enableCidrRestriction,
                  })
                : undefined;

        // ------------------------------------------------------------------------ ALB
        this.alb = new AlbConstruct(this, 'AlbConstruct', {
            vpc,
            environment,
            certificateArn,
            allowedCidrs: props.alb.allowedCidrs?.length
                ? props.alb.allowedCidrs
                : [vpcCidr],
            internetFacing: props.alb.internetFacing,
            customDomain: props.certificate.domainName,
            hostedZoneId: props.certificate.hostedZoneId,
            hostedZoneName: props.certificate.hostedZoneName,
            webAclArn: wafConstruct?.webAcl.attrArn,
            enableAccessLogs: props.alb.enableAccessLogs,
        });

        const publicHost = managerHost ?? this.alb.loadBalancer.loadBalancerDnsName;

        // ------------------------------------------------------------- Security group
        const taskSg = new ec2.SecurityGroup(this, 'ControlPlaneTaskSg', {
            vpc,
            description: `Kong control plane ECS tasks (${environment})`,
            allowAllOutbound: true,
        });
        for (const port of [KONG_ADMIN_PORT, KONG_MANAGER_PORT, KONG_STATUS_PORT]) {
            taskSg.addIngressRule(this.alb.securityGroup, ec2.Port.tcp(port), 'From ALB');
        }
        const dataPlaneCidrs = Array.from(
            new Set([vpcCidr, ...(controlPlane.dataPlaneCidrs ?? [])])
        );
        for (const cidr of dataPlaneCidrs) {
            taskSg.addIngressRule(
                ec2.Peer.ipv4(cidr),
                ec2.Port.tcpRange(KONG_CLUSTER_PORT, KONG_TELEMETRY_PORT),
                'Data plane config sync / telemetry (8005-8006) and NLB health checks'
            );
        }
        // ALB egress to the tasks (the ALB SG does not allow all outbound)
        for (const port of [KONG_ADMIN_PORT, KONG_MANAGER_PORT, KONG_STATUS_PORT]) {
            this.alb.securityGroup.addEgressRule(
                taskSg,
                ec2.Port.tcp(port),
                'To Kong control plane tasks'
            );
        }
        // Allow the tasks to reach Aurora. Created here (not via connections) so the
        // database stack does not depend on this one.
        new ec2.CfnSecurityGroupIngress(this, 'DbIngressFromTasks', {
            groupId: database.securityGroup.securityGroupId,
            sourceSecurityGroupId: taskSg.securityGroupId,
            ipProtocol: 'tcp',
            fromPort: 5432,
            toPort: 5432,
            description: 'Kong control plane to Aurora PostgreSQL',
        });

        // ------------------------------------------------------------------------ ECS
        this.cluster = new ecs.Cluster(this, 'Cluster', {
            vpc,
            clusterName: `kong-cp-ecscluster-${environment}`,
            containerInsightsV2: ecs.ContainerInsights.ENABLED,
        });

        const logGroup = new logs.LogGroup(this, 'LogGroup', {
            logGroupName: `/aws/ecs/kong-cp-logs-${environment}`,
            retention: controlPlane.logRetentionDays ?? logs.RetentionDays.ONE_MONTH,
            // A retained fixed-name log group would block redeploying the stack after a teardown.
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
            family: `kong-cp-task-${environment}`,
            cpu: controlPlane.cpu ?? 1024,
            memoryLimitMiB: controlPlane.memoryMiB ?? 2048,
        });

        const licenseSecret = secretsmanager.Secret.fromSecretCompleteArn(
            this,
            'LicenseSecret',
            controlPlane.licenseSecretArn
        );
        const clusterCertSecret = secretsmanager.Secret.fromSecretCompleteArn(
            this,
            'ClusterCertSecret',
            controlPlane.clusterCertSecretArn
        );
        // Import by ARN/key ARN so the ECS execution role's grants stay in this stack
        // (granting on the database stack's key would create a cross-stack dependency cycle).
        const dbSecret = secretsmanager.Secret.fromSecretAttributes(this, 'DbSecret', {
            secretCompleteArn: database.cluster.secret!.secretArn,
            encryptionKey: kms.Key.fromKeyArn(
                this,
                'DbKey',
                database.encryptionKey.keyArn
            ),
        });

        // CDK does not add the KMS grant for an imported key, so the execution role could not
        // decrypt the Aurora master secret (AccessDeniedException: Access to KMS is not allowed).
        // The key policy delegates to IAM, so an identity policy is sufficient.
        taskDefinition.obtainExecutionRole().addToPrincipalPolicy(
            new iam.PolicyStatement({
                actions: ['kms:Decrypt'],
                resources: [database.encryptionKey.keyArn],
            })
        );

        const image = ecs.ContainerImage.fromRegistry(controlPlane.imageUri);

        const sharedEnvironment: Record<string, string> = {
            KONG_DATABASE: 'postgres',
            KONG_PG_HOST: database.cluster.clusterEndpoint.hostname,
            KONG_PG_PORT: String(database.cluster.clusterEndpoint.port),
            KONG_PG_DATABASE: database.databaseName,
            KONG_PG_SSL: 'on',
            // Kong verifies the Aurora certificate (its global tls_certificate_verify cannot be
            // overridden per connection). The RDS CA is not in the image's trust store, so it is
            // passed as base64 certificate content alongside the system store.
            KONG_PG_SSL_VERIFY: 'on',
            KONG_LUA_SSL_TRUSTED_CERTIFICATE: `system,${Buffer.from(database.caBundlePem).toString('base64')}`,
        };
        const sharedSecrets: Record<string, ecs.Secret> = {
            KONG_PG_USER: ecs.Secret.fromSecretsManager(dbSecret, 'username'),
            KONG_PG_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
            KONG_LICENSE_DATA: ecs.Secret.fromSecretsManager(licenseSecret),
        };

        // Idempotent: bootstraps an empty database, no-op when already bootstrapped.
        // Upgrades (`kong migrations up` / `finish`) are a deliberate manual step - see docs.
        const migrations = taskDefinition.addContainer('kong-migrations', {
            image,
            essential: false,
            command: ['kong', 'migrations', 'bootstrap'],
            environment: sharedEnvironment,
            secrets: {
                ...sharedSecrets,
                KONG_PASSWORD: ecs.Secret.fromSecretsManager(
                    database.adminSecret,
                    'password'
                ),
            },
            logging: ecs.LogDrivers.awsLogs({
                logGroup,
                streamPrefix: 'kong-migrations',
            }),
        });

        const kong = taskDefinition.addContainer('kong-cp', {
            image,
            essential: true,
            environment: {
                ...sharedEnvironment,
                KONG_ROLE: 'control_plane',
                KONG_PROXY_LISTEN: 'off',
                KONG_ADMIN_LISTEN: `0.0.0.0:${KONG_ADMIN_PORT} ssl`,
                KONG_ADMIN_GUI_LISTEN: `0.0.0.0:${KONG_MANAGER_PORT} ssl`,
                KONG_STATUS_LISTEN: `0.0.0.0:${KONG_STATUS_PORT}`,
                KONG_CLUSTER_LISTEN: `0.0.0.0:${KONG_CLUSTER_PORT}`,
                KONG_CLUSTER_TELEMETRY_LISTEN: `0.0.0.0:${KONG_TELEMETRY_PORT}`,
                KONG_CLUSTER_MTLS: 'shared',
                KONG_ADMIN_GUI_URL: `https://${publicHost}`,
                KONG_ADMIN_GUI_API_URL: `https://${publicHost}:${ADMIN_API_PORT}`,
                KONG_ENFORCE_RBAC: 'on',
                KONG_ADMIN_GUI_AUTH: 'basic-auth',
                KONG_LOG_LEVEL: controlPlane.logLevel ?? 'notice',
                KONG_ADMIN_ACCESS_LOG: '/dev/stdout',
                KONG_ADMIN_ERROR_LOG: '/dev/stderr',
            },
            secrets: {
                ...sharedSecrets,
                KONG_CLUSTER_CERT: ecs.Secret.fromSecretsManager(
                    clusterCertSecret,
                    'cluster_cert'
                ),
                KONG_CLUSTER_CERT_KEY: ecs.Secret.fromSecretsManager(
                    clusterCertSecret,
                    'cluster_cert_key'
                ),
                KONG_ADMIN_GUI_SESSION_CONF: ecs.Secret.fromSecretsManager(
                    database.sessionSecret
                ),
            },
            portMappings: [
                { containerPort: KONG_ADMIN_PORT },
                { containerPort: KONG_MANAGER_PORT },
                { containerPort: KONG_STATUS_PORT },
                { containerPort: KONG_CLUSTER_PORT },
                { containerPort: KONG_TELEMETRY_PORT },
            ],
            healthCheck: {
                command: ['CMD', 'kong', 'health'],
                interval: cdk.Duration.seconds(15),
                timeout: cdk.Duration.seconds(10),
                retries: 5,
                startPeriod: cdk.Duration.seconds(60),
            },
            logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'kong-cp' }),
        });
        kong.addContainerDependencies({
            container: migrations,
            condition: ecs.ContainerDependencyCondition.SUCCESS,
        });

        this.service = new ecs.FargateService(this, 'Service', {
            cluster: this.cluster,
            serviceName: `kong-cp-ecsservice-${environment}`,
            taskDefinition,
            desiredCount: controlPlane.replicas ?? 2,
            securityGroups: [taskSg],
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            minHealthyPercent: 100,
            maxHealthyPercent: 200,
            circuitBreaker: { enable: true, rollback: true },
            healthCheckGracePeriod: cdk.Duration.seconds(120),
        });

        // ---------------------------------------------- ALB target groups (Manager, Admin API)
        const albHealthCheck: elbv2.HealthCheck = {
            protocol: elbv2.Protocol.HTTP,
            port: String(KONG_STATUS_PORT),
            path: '/status',
            healthyHttpCodes: '200',
            interval: cdk.Duration.seconds(15),
            healthyThresholdCount: 2,
            unhealthyThresholdCount: 3,
        };
        this.alb.managerListener.addTargets('ManagerTargets', {
            port: KONG_MANAGER_PORT,
            protocol: elbv2.ApplicationProtocol.HTTPS,
            targets: [
                this.service.loadBalancerTarget({
                    containerName: 'kong-cp',
                    containerPort: KONG_MANAGER_PORT,
                }),
            ],
            healthCheck: albHealthCheck,
            deregistrationDelay: cdk.Duration.seconds(30),
        });
        this.alb.adminListener.addTargets('AdminApiTargets', {
            port: KONG_ADMIN_PORT,
            protocol: elbv2.ApplicationProtocol.HTTPS,
            targets: [
                this.service.loadBalancerTarget({
                    containerName: 'kong-cp',
                    containerPort: KONG_ADMIN_PORT,
                }),
            ],
            healthCheck: albHealthCheck,
            deregistrationDelay: cdk.Duration.seconds(30),
        });

        // ---------------------------------- NLB for data plane cluster / telemetry endpoints
        this.nlb = new elbv2.NetworkLoadBalancer(this, 'ClusterNlb', {
            vpc,
            internetFacing: false,
            loadBalancerName: `kong-cp-nlb-${environment}`,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            crossZoneEnabled: true,
        });
        for (const [name, port] of [
            ['Cluster', KONG_CLUSTER_PORT],
            ['Telemetry', KONG_TELEMETRY_PORT],
        ] as const) {
            this.nlb
                .addListener(`${name}Listener`, { port, protocol: elbv2.Protocol.TCP })
                .addTargets(`${name}Targets`, {
                    port,
                    protocol: elbv2.Protocol.TCP,
                    targets: [
                        this.service.loadBalancerTarget({
                            containerName: 'kong-cp',
                            containerPort: port,
                        }),
                    ],
                    healthCheck: { protocol: elbv2.Protocol.TCP },
                    deregistrationDelay: cdk.Duration.seconds(30),
                });
        }

        if (controlPlane.clusterDomain) {
            const zoneName =
                props.certificate.hostedZoneName ?? props.certificate.domainName;
            if (!props.certificate.hostedZoneId || !zoneName) {
                throw new Error(
                    'clusterDomain requires albHostedZoneId and albHostedZoneName.'
                );
            }
            new route53.ARecord(this, 'ClusterAliasRecord', {
                zone: route53.HostedZone.fromHostedZoneAttributes(this, 'ClusterZone', {
                    hostedZoneId: props.certificate.hostedZoneId,
                    zoneName,
                }),
                recordName: controlPlane.clusterDomain,
                target: route53.RecordTarget.fromAlias(
                    new route53targets.LoadBalancerTarget(this.nlb)
                ),
            });
        }

        // -------------------------------------------------------- Central log forwarding
        if (props.logging?.enabled !== false && props.logging?.centralDestinationArn) {
            new LoggingConstruct(this, 'LoggingConstruct', {
                environment,
                centralDestinationArn: props.logging.centralDestinationArn,
                logGroupNames: [logGroup.logGroupName],
                filterPattern: props.logging.filterPattern,
            });
        }

        // -------------------------------------------------------------------- Outputs
        const dpHost = controlPlane.clusterDomain ?? this.nlb.loadBalancerDnsName;
        new cdk.CfnOutput(this, 'KongManagerUrl', { value: `https://${publicHost}` });
        new cdk.CfnOutput(this, 'KongAdminApiUrl', {
            value: `https://${publicHost}:${ADMIN_API_PORT}`,
        });
        new cdk.CfnOutput(this, 'DataPlaneClusterEndpoint', {
            value: `${dpHost}:${KONG_CLUSTER_PORT}`,
            description: 'Use as KONG_CLUSTER_CONTROL_PLANE on data planes',
        });
        new cdk.CfnOutput(this, 'DataPlaneTelemetryEndpoint', {
            value: `${dpHost}:${KONG_TELEMETRY_PORT}`,
            description: 'Use as KONG_CLUSTER_TELEMETRY_ENDPOINT on data planes',
        });
        new cdk.CfnOutput(this, 'AlbDnsName', {
            value: this.alb.loadBalancer.loadBalancerDnsName,
        });
        new cdk.CfnOutput(this, 'EcsClusterName', { value: this.cluster.clusterName });
        new cdk.CfnOutput(this, 'EcsServiceName', { value: this.service.serviceName });
    }
}
