import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';

export interface AuroraConstructProps {
    vpc: ec2.IVpc;
    environment: string; // Environment: dev, qa, uat, prd

    /** Full Aurora PostgreSQL engine version, e.g. "16.13". */
    engineVersion?: string;
    /** Name of the Kong database created in the cluster. */
    databaseName?: string;
    /** Master username. The password is generated and stored in Secrets Manager. */
    masterUsername?: string;

    /** Aurora Serverless v2 capacity range, in ACUs (0.5 ACU increments). */
    minCapacityAcu?: number;
    maxCapacityAcu?: number;
    /** Number of Aurora Serverless v2 reader instances (0 = writer only). */
    readerCount?: number;

    /** Aurora native automated backups (point-in-time recovery window). */
    backupRetentionDays?: number;
    preferredBackupWindow?: string; // UTC, e.g. "17:00-18:00"
    preferredMaintenanceWindow?: string; // UTC, e.g. "sun:18:00-sun:19:00"

    deletionProtection?: boolean;

    /**
     * Restore the cluster from this snapshot (cluster snapshot ARN/identifier, including
     * `awsbackup:` recovery points). Changing it on an existing stack REPLACES the cluster.
     */
    snapshotIdentifier?: string;
}

/**
 * Aurora Serverless v2 (PostgreSQL) cluster for the Kong control plane.
 *
 * - Storage encrypted with a dedicated KMS key (rotation enabled)
 * - Master credentials generated into Secrets Manager
 * - Placed in private subnets, reachable only through `securityGroup`
 */
export class AuroraConstruct extends Construct {
    public readonly cluster: rds.DatabaseClusterBase;
    public readonly securityGroup: ec2.SecurityGroup;
    public readonly encryptionKey: kms.Key;
    public readonly databaseName: string;

    constructor(scope: Construct, id: string, props: AuroraConstructProps) {
        super(scope, id);

        const {
            vpc,
            environment,
            engineVersion = '16.13',
            databaseName = 'kong',
            masterUsername = 'kong',
            minCapacityAcu = 0.5,
            maxCapacityAcu = 4,
            readerCount = 1,
            backupRetentionDays = 14,
            preferredBackupWindow,
            preferredMaintenanceWindow,
            deletionProtection = true,
            snapshotIdentifier,
        } = props;

        this.databaseName = databaseName;

        const majorVersion = engineVersion.split('.')[0];

        this.encryptionKey = new kms.Key(this, 'DbKey', {
            alias: `alias/kong-cp-db-${environment}`,
            description: `Encrypts the Kong control plane Aurora cluster (${environment})`,
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        this.securityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
            vpc,
            description: `Kong control plane Aurora PostgreSQL (${environment})`,
            allowAllOutbound: false,
        });

        const readers = Array.from({ length: readerCount }, (_, i) =>
            rds.ClusterInstance.serverlessV2(`Reader${i + 1}`, { scaleWithWriter: true })
        );

        const engine = rds.DatabaseClusterEngine.auroraPostgres({
            version: rds.AuroraPostgresEngineVersion.of(engineVersion, majorVersion),
        });
        const secretName = `kong/cp/${environment}/db-master`;

        const clusterProps = {
            clusterIdentifier: `kong-cp-db-${environment}`,
            engine,
            serverlessV2MinCapacity: minCapacityAcu,
            serverlessV2MaxCapacity: maxCapacityAcu,
            writer: rds.ClusterInstance.serverlessV2('Writer'),
            readers,
            vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            securityGroups: [this.securityGroup],
            storageEncrypted: true,
            storageEncryptionKey: this.encryptionKey,
            backup: {
                retention: cdk.Duration.days(backupRetentionDays),
                preferredWindow: preferredBackupWindow,
            },
            preferredMaintenanceWindow,
            copyTagsToSnapshot: true,
            deletionProtection,
            removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
            cloudwatchLogsExports: ['postgresql'],
            cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
        };

        this.cluster = snapshotIdentifier
            ? new rds.DatabaseClusterFromSnapshot(this, 'Cluster', {
                  ...clusterProps,
                  snapshotIdentifier,
                  // Restored data keeps the old master password; this generates and sets a new one.
                  snapshotCredentials: rds.SnapshotCredentials.fromGeneratedSecret(
                      masterUsername,
                      { encryptionKey: this.encryptionKey }
                  ),
              })
            : new rds.DatabaseCluster(this, 'Cluster', {
                  ...clusterProps,
                  credentials: rds.Credentials.fromGeneratedSecret(masterUsername, {
                      secretName,
                      encryptionKey: this.encryptionKey,
                  }),
                  defaultDatabaseName: databaseName,
              });
    }
}
