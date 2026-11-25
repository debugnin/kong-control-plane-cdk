import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { AuroraConstruct } from './constructs/aurora-construct';
import { BackupConstruct } from './constructs/backup-construct';

export interface KongDatabaseStackProps extends cdk.StackProps {
    environment: string; // Environment: dev, qa, uat, prd
    vpc: ec2.IVpc;

    aurora?: {
        engineVersion?: string;
        minCapacityAcu?: number;
        maxCapacityAcu?: number;
        readerCount?: number;
        backupRetentionDays?: number;
        preferredBackupWindow?: string;
        preferredMaintenanceWindow?: string;
        deletionProtection?: boolean;
        snapshotIdentifier?: string;
    };

    backup?: {
        enabled?: boolean;
        intervalHours?: number;
        retentionDays?: number;
        weeklyRetentionDays?: number;
        monthlyRetentionDays?: number;
        startHourUtc?: number;
        copyToVaultArn?: string;
    };
}

/**
 * Stateful resources for the control plane: the Aurora Serverless v2 cluster, the AWS
 * Backup plan that protects it, and the generated Kong admin secrets.
 * Kept separate from the ECS stack so the service can be replaced without touching data.
 */
export class KongDatabaseStack extends cdk.Stack {
    public readonly aurora: AuroraConstruct;
    public readonly backup?: BackupConstruct;
    /** Secret with the initial Kong super-admin password (key: `password`). */
    public readonly adminSecret: secretsmanager.Secret;
    /** Secret holding the Kong Manager session configuration JSON. */
    public readonly sessionSecret: secretsmanager.Secret;

    constructor(scope: Construct, id: string, props: KongDatabaseStackProps) {
        super(scope, id, props);

        const { environment } = props;

        this.aurora = new AuroraConstruct(this, 'Aurora', {
            vpc: props.vpc,
            environment,
            ...props.aurora,
        });

        if (props.backup?.enabled !== false) {
            this.backup = new BackupConstruct(this, 'Backup', {
                environment,
                cluster: this.aurora.cluster,
                ...props.backup,
            });
        }

        // Used by `kong migrations bootstrap` to create the initial `kong_admin` super-admin.
        this.adminSecret = new secretsmanager.Secret(this, 'AdminSecret', {
            secretName: `kong/cp/${environment}/admin`,
            description: `Kong super-admin bootstrap password (${environment})`,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            generateSecretString: {
                secretStringTemplate: JSON.stringify({ username: 'kong_admin' }),
                generateStringKey: 'password',
                passwordLength: 32,
                excludePunctuation: true,
            },
        });

        // KONG_ADMIN_GUI_SESSION_CONF - the generated `secret` key completes the JSON document.
        this.sessionSecret = new secretsmanager.Secret(this, 'SessionSecret', {
            secretName: `kong/cp/${environment}/manager-session`,
            description: `Kong Manager session configuration (${environment})`,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            generateSecretString: {
                secretStringTemplate: JSON.stringify({
                    cookie_name: 'kong_manager_session',
                    cookie_samesite: 'Strict',
                    cookie_secure: true,
                    storage: 'kong',
                }),
                generateStringKey: 'secret',
                passwordLength: 32,
                excludePunctuation: true,
            },
        });

        new cdk.CfnOutput(this, 'ClusterEndpoint', {
            value: this.aurora.cluster.clusterEndpoint.hostname,
            description: 'Aurora writer endpoint',
        });
        new cdk.CfnOutput(this, 'DbMasterSecretArn', {
            value: this.aurora.cluster.secret!.secretArn,
            description: 'Secrets Manager ARN of the Aurora master credentials',
        });
        new cdk.CfnOutput(this, 'AdminSecretArn', {
            value: this.adminSecret.secretArn,
            description: 'Secrets Manager ARN of the Kong super-admin password',
        });
    }
}
