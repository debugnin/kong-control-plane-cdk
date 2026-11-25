# Backup and Recovery

The Aurora PostgreSQL database holds all Kong configuration (services, routes, plugins, consumers, RBAC, workspaces). Data planes cache their last configuration, but a lost database means a lost control plane. Two layers protect it.

## What is protected

| Layer | Mechanism | Default | Recovery |
|---|---|---|---|
| Aurora native backups | Continuous, point-in-time recovery | 14 days (`dbBackupRetentionDays`) | Any second in the window → new cluster |
| **AWS Backup** | Scheduled snapshots in `kong-cp-backup-vault-{env}` | Every 4 hours, 35 days | Snapshot → new cluster |
| AWS Backup (optional) | Weekly / monthly rules | Off | Longer retention |
| AWS Backup (optional) | Copy to a vault in another region/account | Off | Regional DR |
| Final snapshot | Taken if the cluster is deleted from CloudFormation | On (`RemovalPolicy.SNAPSHOT`) | Snapshot → new cluster |

Not covered by AWS Backup: the Secrets Manager secrets (license, cluster certificate) and generated admin secrets. Keep the license and cluster certificate in your own secure store too – they are supplied by you and are needed to rebuild.

## Configuration

```json
{
    "backupEnabled": "true",
    "backupIntervalHours": "4",
    "backupRetentionDays": "35",
    "backupWeeklyRetentionDays": "90",
    "backupMonthlyRetentionDays": "365",
    "backupStartHourUtc": "16",
    "backupCopyToVaultArn": "arn:aws:backup:ap-southeast-4:123456789012:backup-vault:kong-cp-dr-vault"
}
```

- Schedule: the primary rule (`Frequent`) runs every `backupIntervalHours` (default 4) from the anchor hour `backupStartHourUtc` (default 16 UTC = midnight Perth), i.e. 00, 04, 08, 12, 16, 20 UTC. The interval must divide 24. Weekly rules run Sundays and monthly rules on the 1st. Start window 1 hour, completion window 4 hours.
- Retention applies to every recovery point of the primary rule: at the defaults that is up to about 210 recovery points. Aurora snapshots are incremental, but lower `backupRetentionDays` (for example to 7) and rely on the weekly/monthly rules for long-term copies if cost matters.
- The vault and its KMS key are **retained** on stack deletion; CloudFormation cannot delete a vault that holds recovery points.
- The plan selects the cluster by ARN, so resizing or adding readers does not change protection.
- Cross-region/account copy: create the destination vault first (and allow the source account in its access policy). The plan copies each recovery point with the same retention as the source rule. If the destination vault uses a customer-managed KMS key, that key policy must allow AWS Backup.

## Verify backups

```bash
# On-demand backup (do this once after first deployment)
aws backup start-backup-job \
  --backup-vault-name kong-cp-backup-vault-dev \
  --resource-arn arn:aws:rds:<region>:<account>:cluster:kong-cp-db-dev \
  --iam-role-arn <role arn of the backup selection>   # see AWS Backup > Backup plans > Resource assignments

aws backup list-backup-jobs --by-resource-arn arn:aws:rds:<region>:<account>:cluster:kong-cp-db-dev
aws backup list-recovery-points-by-backup-vault --backup-vault-name kong-cp-backup-vault-dev
```

Alert on failures with an EventBridge rule on `Backup Job State Change` (`state = FAILED`/`EXPIRED`) routed to your paging system; this project does not create one.

## Restore

Restores always create a **new** Aurora cluster; they never overwrite the running one. Use one of two paths.

### A. Through this stack (recommended for DR / rebuild)

1. Identify the recovery point and its ARN:
   ```bash
   aws backup list-recovery-points-by-backup-vault --backup-vault-name kong-cp-backup-vault-dev \
     --query "RecoveryPoints[].[RecoveryPointArn,CreationDate]" --output table
   ```
   The recovery point ARN of an Aurora backup is a cluster snapshot (`...:cluster-snapshot:awsbackup:job-...`). To use a vault in another region, first copy it to a local snapshot (`aws backup start-copy-job`).
2. Set `"dbSnapshotIdentifier": "<snapshot arn>"` in the config of the **new** environment (or after deleting the damaged database stack) and deploy:
   ```bash
   ENVIRONMENT=dr npx cdk deploy --all
   ```
   The cluster is created from the snapshot; a new master password is generated into Secrets Manager (name is auto-generated, not `kong/cp/{env}/db-master`) and the control plane connects with it. `kong migrations bootstrap` finds the schema already present and does nothing.
3. Point data planes at the new `DataPlaneClusterEndpoint` (or keep `clusterDomain` and repoint DNS).

> Setting `dbSnapshotIdentifier` on an **existing** database stack **replaces** the cluster (CloudFormation creates a new one and deletes the old). Do that only deliberately, with a fresh backup taken first.

The principal that runs `cdk deploy` must be able to use the backup vault's KMS key to restore (`kms:Decrypt`, `kms:CreateGrant`, `kms:DescribeKey`).

### B. Point-in-time restore (corruption or bad change)

```bash
aws rds restore-db-cluster-to-point-in-time \
  --source-db-cluster-identifier kong-cp-db-dev \
  --db-cluster-identifier kong-cp-db-dev-restored \
  --restore-type copy-on-write --use-latest-restorable-time \
  --db-subnet-group-name <subnet group> --vpc-security-group-ids <db sg> --kms-key-id <db kms key>
aws rds create-db-instance --db-cluster-identifier kong-cp-db-dev-restored \
  --db-instance-identifier kong-cp-db-dev-restored-1 --db-instance-class db.serverless --engine aurora-postgresql
```

(Serverless v2 capacity must be set on the restored cluster with `modify-db-cluster --serverless-v2-scaling-configuration`.) Inspect the restored copy, export the needed configuration (for example with `deck gateway dump`), and apply it to the live control plane. Cutting the stack itself over to a manually restored cluster is not supported – use path A for that.

## Recovery targets

| Scenario | Approach | Data loss (RPO) |
|---|---|---|
| Bad config pushed | Restore PITR copy, export the config, re-apply | Seconds |
| AZ failure | Aurora failover to the reader (needs `dbReaderCount >= 1`); ECS tasks reschedule | None / seconds |
| Database lost | Path A from the latest recovery point | Up to 4 h with the default schedule |
| Region failure | Path A from a cross-region copy (`backupCopyToVaultArn`) | Up to 4 h (plus copy lag) |

Practise a restore into a throwaway environment at least once per quarter; an untested backup is not a backup.
