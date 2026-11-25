# Overview: Kong Control Plane Reference Implementation (AWS)

A Kong Professional Services **reference implementation** that automates a self-hosted Kong Gateway Enterprise control plane on AWS using the AWS CDK (TypeScript). It shows a repeatable, reviewable way to stand up and operate a Kong control plane with a managed PostgreSQL database and scheduled backups.

> **Scope and intent.** This is a reference asset, not a statement of any customer's target architecture. It deploys the control plane only, on AWS-managed services (ECS Fargate, Aurora, AWS Backup). Where a deployment runs elsewhere, for example on virtual machines in a data centre, the AWS resources do not apply, but the Kong-level patterns listed under [What carries over](#what-carries-over-to-other-environments) do.

## Key features

| Area | What it provides |
|---|---|
| **Control plane** | Kong Gateway Enterprise as `control_plane` with no proxy listener, run as a multi-task service spread across availability zones. Rolling deployments with automatic rollback on failure. |
| **Database** | Aurora Serverless v2 (PostgreSQL), writer plus a reader for failover, capacity range configurable (default 0.5–4 ACU), encrypted with a dedicated KMS key (rotation on), private subnets only. |
| **Automated backup** | AWS Backup vault and plan: backups every 4 hours (35 days by default), optional weekly and monthly rules, optional copy to another region or account, KMS-encrypted vault. Aurora point-in-time recovery (14 days) runs alongside. |
| **Restore** | A single setting (`dbSnapshotIdentifier`) rebuilds the database from a snapshot or AWS Backup recovery point. Runbook in [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md). |
| **Schema management** | `kong migrations bootstrap` runs automatically before the control plane starts (idempotent). Version upgrades are a deliberate, documented manual step. |
| **Secure by default** | Internal load balancers only; security groups limited to configured CIDRs; RBAC enforced and Kong Manager basic-auth on; admin and session secrets generated into Secrets Manager; the Aurora TLS certificate is verified against the RDS CA. |
| **Data plane connectivity** | Config-sync (8005) and telemetry (8006) endpoints exposed on an internal network load balancer using cluster mTLS in shared-certificate mode. Outputs give the exact values data planes need. |
| **Edge protection** | Optional WAF on the admin/Manager load balancer (managed rule sets, per-IP rate limit, optional CIDR allow-list). |
| **Observability** | CloudWatch logs for Kong, Aurora and VPC flow logs; optional forwarding of control plane logs to a central account. |
| **Automation hygiene** | Three stacks (network, database, service) so stateful data is separate from the replaceable service; per-environment config files; unit tests on the generated infrastructure. |

## Architecture at a glance

```text
 Admins / CI ──443 / 8444──► ALB (internal, TLS, WAF) ─┐
                                                      ├─► Kong control plane (ECS Fargate, 2+ tasks)
 Data planes ──8005 / 8006─► NLB (internal, TCP) ─────┘             │
                                                                    ▼
                                            Aurora Serverless v2 PostgreSQL (writer + reader)
                                                                    ▲
                                            AWS Backup vault + plan (every 4 h / weekly / monthly)
```

## What carries over to other environments

These are Kong configuration patterns, independent of AWS:

- Control plane with `KONG_PROXY_LISTEN=off`, admin on TLS, status listener on a separate port for health checks
- Cluster mTLS in shared mode with a certificate/key supplied from a secret store
- RBAC enforcement with a bootstrap super-admin, and Kong Manager session configuration
- PostgreSQL over TLS with server-certificate verification against your own CA
- Idempotent `migrations bootstrap` on first start; `up` / `finish` for upgrades
- The backup/restore discipline: scheduled recovery points, a tested restore path, and a documented RPO

## Status and limits

Verified in a development account: all three stacks deploy; the control plane tasks start and pass Kong's health check; the schema bootstraps; all load balancer targets are healthy.

Not yet verified: Kong Manager/Admin API sign-in from a routed network, a data plane connecting and syncing, and an on-demand AWS Backup job and restore test. Treat these as acceptance steps before relying on the pattern.

Also note:

- One environment per account and region (resource names are fixed per environment).
- The Kong image tag, Aurora engine version and sizing in the examples are placeholders to be validated against the Kong version and workload in use.
- Cluster mTLS uses a single shared certificate; rotation must be coordinated across the control plane and all data planes.
- Backups protect the database. The license and cluster certificate are supplied by the operator and must be kept in the operator's own secure store.

## Where to go next

| Need | Document |
|---|---|
| Deploy it | [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) |
| Components, ports and security model | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Backups and restore | [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md) |
| Every setting | [../README.md](../README.md#configuration) |
