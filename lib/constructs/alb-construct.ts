import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';

export const MANAGER_PORT = 443;
export const ADMIN_API_PORT = 8444;

export interface AlbConstructProps {
    vpc: ec2.IVpc;
    environment: string; // Environment: dev, qa, uat, prd
    certificateArn: string;
    /** CIDRs allowed to reach Kong Manager (443) and the Admin API (8444). */
    allowedCidrs: string[];
    internetFacing?: boolean;
    customDomain?: string;
    hostedZoneId?: string;
    hostedZoneName?: string;
    webAclArn?: string;
    enableAccessLogs?: boolean;
}

/**
 * Application Load Balancer fronting Kong Manager (443) and the Kong Admin API (8444).
 * Internal by default - the Admin API should never be exposed to the internet.
 * The control plane service construct attaches the target groups (default action).
 */
export class AlbConstruct extends Construct {
    public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
    public readonly securityGroup: ec2.SecurityGroup;
    public readonly managerListener: elbv2.ApplicationListener;
    public readonly adminListener: elbv2.ApplicationListener;
    public readonly accessLogBucket?: s3.Bucket;

    constructor(scope: Construct, id: string, props: AlbConstructProps) {
        super(scope, id);

        const {
            vpc,
            environment,
            certificateArn,
            allowedCidrs,
            internetFacing = false,
            customDomain,
            hostedZoneId,
            hostedZoneName,
            webAclArn,
            enableAccessLogs = true,
        } = props;

        this.securityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
            vpc,
            description: `Kong control plane ALB (${environment})`,
            allowAllOutbound: false,
        });

        for (const cidr of allowedCidrs) {
            this.securityGroup.addIngressRule(
                ec2.Peer.ipv4(cidr),
                ec2.Port.tcp(MANAGER_PORT),
                'Kong Manager'
            );
            this.securityGroup.addIngressRule(
                ec2.Peer.ipv4(cidr),
                ec2.Port.tcp(ADMIN_API_PORT),
                'Kong Admin API'
            );
        }

        if (enableAccessLogs) {
            this.accessLogBucket = new s3.Bucket(this, 'AccessLogBucket', {
                encryption: s3.BucketEncryption.S3_MANAGED,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                enforceSSL: true,
                removalPolicy: cdk.RemovalPolicy.RETAIN,
                lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
            });
        }

        this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
            vpc,
            internetFacing,
            securityGroup: this.securityGroup,
            loadBalancerName: `kong-cp-alb-${environment}`,
            vpcSubnets: {
                subnetType: internetFacing
                    ? ec2.SubnetType.PUBLIC
                    : ec2.SubnetType.PRIVATE_WITH_EGRESS,
            },
        });

        if (this.accessLogBucket) {
            this.loadBalancer.logAccessLogs(this.accessLogBucket);
        }

        if (webAclArn) {
            new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
                resourceArn: this.loadBalancer.loadBalancerArn,
                webAclArn,
            });
        }

        const certificates = [elbv2.ListenerCertificate.fromArn(certificateArn)];
        this.managerListener = this.loadBalancer.addListener('ManagerListener', {
            port: MANAGER_PORT,
            protocol: elbv2.ApplicationProtocol.HTTPS,
            certificates,
            open: false, // ingress is limited to allowedCidrs above
        });

        this.adminListener = this.loadBalancer.addListener('AdminApiListener', {
            port: ADMIN_API_PORT,
            protocol: elbv2.ApplicationProtocol.HTTPS,
            certificates,
            open: false,
        });

        if (customDomain && (hostedZoneId || hostedZoneName)) {
            const zoneName = hostedZoneName || customDomain;
            const hostedZone = hostedZoneId
                ? route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
                      hostedZoneId,
                      zoneName,
                  })
                : route53.HostedZone.fromLookup(this, 'HostedZone', {
                      domainName: zoneName,
                  });

            new route53.ARecord(this, 'AlbAliasRecord', {
                zone: hostedZone,
                recordName: customDomain,
                target: route53.RecordTarget.fromAlias(
                    new route53targets.LoadBalancerTarget(this.loadBalancer)
                ),
            });
        }
    }
}
