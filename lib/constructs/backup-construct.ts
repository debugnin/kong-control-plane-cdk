import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as events from 'aws-cdk-lib/aws-events';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';

export interface BackupConstructProps {
    environment: string; // Environment: dev, qa, uat, prd
    cluster: rds.IDatabaseCluster;

    /** Daily backup retention in days. Always enabled. */
    dailyRetentionDays?: number;
    /** Weekly backup retention in days. 0 disables the weekly rule. */
    weeklyRetentionDays?: number;
    /** Monthly backup retention in days. 0 disables the monthly rule. */
    monthlyRetentionDays?: number;

    /** Hour (0-23, UTC) the daily backup job starts. */
    startHourUtc?: number;

    /**
     * ARN of an existing backup vault in another region/account. When set, every
     * recovery point is copied there (cross-region / cross-account DR).
     * The destination vault must already exist and allow the copy.
     */
    copyToVaultArn?: string;
}

/**
 * AWS Backup for the Aurora cluster: a KMS-encrypted vault, a backup plan with
 * daily (and optional weekly/monthly) rules, and a selection that targets the cluster.
 */
export class BackupConstruct extends Construct {
    public readonly vault: backup.BackupVault;
    public readonly plan: backup.BackupPlan;

    constructor(scope: Construct, id: string, props: BackupConstructProps) {
        super(scope, id);

        const {
            environment,
            cluster,
            dailyRetentionDays = 35,
            weeklyRetentionDays = 0,
            monthlyRetentionDays = 0,
            startHourUtc = 16, // 00:00 AWST (Perth)
            copyToVaultArn,
        } = props;

        const key = new kms.Key(this, 'VaultKey', {
            alias: `alias/kong-cp-backup-${environment}`,
            description: `Encrypts the Kong control plane backup vault (${environment})`,
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        // Recovery points cannot be removed by CloudFormation, so the vault is retained.
        this.vault = new backup.BackupVault(this, 'Vault', {
            backupVaultName: `kong-cp-backup-vault-${environment}`,
            encryptionKey: key,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        const copyAction = copyToVaultArn
            ? [
                  {
                      destinationBackupVault: backup.BackupVault.fromBackupVaultArn(
                          this,
                          'CopyVault',
                          copyToVaultArn
                      ),
                  },
              ]
            : undefined;

        this.plan = new backup.BackupPlan(this, 'Plan', {
            backupPlanName: `kong-cp-backup-plan-${environment}`,
            backupVault: this.vault,
        });

        const startWindow = cdk.Duration.hours(1);
        const completionWindow = cdk.Duration.hours(4);

        this.plan.addRule(
            new backup.BackupPlanRule({
                ruleName: 'Daily',
                scheduleExpression: events.Schedule.cron({
                    minute: '0',
                    hour: String(startHourUtc),
                }),
                startWindow,
                completionWindow,
                deleteAfter: cdk.Duration.days(dailyRetentionDays),
                copyActions: copyAction?.map((a) => ({
                    ...a,
                    deleteAfter: cdk.Duration.days(dailyRetentionDays),
                })),
            })
        );

        if (weeklyRetentionDays > 0) {
            this.plan.addRule(
                new backup.BackupPlanRule({
                    ruleName: 'Weekly',
                    scheduleExpression: events.Schedule.cron({
                        minute: '0',
                        hour: String(startHourUtc),
                        weekDay: 'SUN',
                    }),
                    startWindow,
                    completionWindow,
                    deleteAfter: cdk.Duration.days(weeklyRetentionDays),
                    copyActions: copyAction?.map((a) => ({
                        ...a,
                        deleteAfter: cdk.Duration.days(weeklyRetentionDays),
                    })),
                })
            );
        }

        if (monthlyRetentionDays > 0) {
            this.plan.addRule(
                new backup.BackupPlanRule({
                    ruleName: 'Monthly',
                    scheduleExpression: events.Schedule.cron({
                        minute: '0',
                        hour: String(startHourUtc),
                        day: '1',
                    }),
                    startWindow,
                    completionWindow,
                    deleteAfter: cdk.Duration.days(monthlyRetentionDays),
                    copyActions: copyAction?.map((a) => ({
                        ...a,
                        deleteAfter: cdk.Duration.days(monthlyRetentionDays),
                    })),
                })
            );
        }

        this.plan.addSelection('AuroraSelection', {
            backupSelectionName: `kong-cp-aurora-${environment}`,
            resources: [backup.BackupResource.fromRdsDatabaseCluster(cluster)],
        });

        new cdk.CfnOutput(this, 'BackupVaultName', {
            value: this.vault.backupVaultName,
            description: 'AWS Backup vault holding the Aurora recovery points',
        });

        new cdk.CfnOutput(this, 'BackupPlanId', {
            value: this.plan.backupPlanId,
            description: 'AWS Backup plan ID',
        });
    }
}
