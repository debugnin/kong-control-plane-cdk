# Architecture

## Components

| Component | Implementation | Notes |
|---|---|---|
| Kong control plane | ECS Fargate service, `KONG_ROLE=control_plane`, `KONG_PROXY_LISTEN=off` | 2 tasks by default, spread across AZs, deployment circuit breaker with rollback |
| Schema migrations | `kong-migrations` init container (`kong migrations bootstrap`) | Non-essential; the `kong-cp` container starts only after it exits 0. Idempotent on an already-bootstrapped database |
| Database | Aurora Serverless v2, PostgreSQL | Writer + reader (`db.serverless`), KMS-encrypted, private subnets, TLS to Kong (`KONG_PG_SSL=on`) |
| Backup | AWS Backup vault + plan + selection | Plan targets the Aurora cluster; KMS-encrypted vault |
| Kong Manager / Admin API | Internal ALB, HTTPS listeners on 443 (Manager) and 8444 (Admin API) | WAF attached by default; reachable only from `albAllowedCidrs` |
| Data plane endpoints | Internal NLB, TCP listeners on 8005 (cluster) and 8006 (telemetry) | TCP passthrough – Kong terminates the CP↔DP mTLS |
| Secrets | Secrets Manager | DB master and Kong admin/session secrets are generated; license and cluster certificate are supplied |

## Ports

| Port | Protocol | Exposed via | Purpose |
|---|---|---|---|
| 443 → 8445 | HTTPS | ALB | Kong Manager |
| 8444 | HTTPS | ALB | Admin API |
| 8100 | HTTP | ALB health checks only | Status API (`/status`) |
| 8005 | mTLS | NLB | Config sync from control plane to data planes |
| 8006 | mTLS | NLB | Telemetry from data planes to control plane |

## Security model

- **Network:** everything runs in private subnets. The ALB and NLB are internal; the Admin API is never public unless `albInternetFacing=true` is set deliberately. Security groups allow only the ALB to reach ports 8444/8445/8100, and only `dataPlaneCidrs` (plus the VPC CIDR for NLB health checks) to reach 8005/8006. Only the task security group can reach Aurora on 5432.
- **Admin access:** `KONG_ENFORCE_RBAC=on` and Kong Manager basic-auth are enabled. `kong migrations bootstrap` creates the super-admin `kong_admin` with the generated password in secret `kong/cp/{env}/admin`.
- **Encryption:** Aurora storage and master secret use a dedicated KMS key (rotation on); the backup vault uses its own key; TLS terminates at the ALB (ACM) and Kong re-encrypts to the tasks.
- **Cluster mTLS:** `cluster_mtls=shared` – one certificate/key pair (secret `clusterCertSecretArn`) is used by the control plane and every data plane. Rotate it by updating the secret on all nodes together. PKI mode (CA-signed per-node certs) is not configured by this project.
- **Secrets never appear in the task definition:** ECS injects them from Secrets Manager at start. If you supply secrets encrypted with a customer-managed KMS key, grant the ECS task execution role (`kong-cp-service-stack-{env}`) `kms:Decrypt` on that key.

## Database

- Aurora Serverless v2 scales between `dbMinCapacityAcu` and `dbMaxCapacityAcu` ACUs. Kong holds long-lived connections and is not suited to scale-to-zero, so the minimum is 0.5 ACU, not 0.
- `dbReaderCount=1` places a reader in another AZ for failover; readers use `scaleWithWriter`. Kong is configured against the **writer endpoint only** (no read-replica routing).
- Aurora native automated backups (`dbBackupRetentionDays`, default 14) give point-in-time recovery; AWS Backup adds scheduled, longer-retention, optionally cross-region recovery points. See [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md).
- Aurora cluster logs (`postgresql`) are exported to CloudWatch.
- `KONG_PG_SSL=on` encrypts the connection; the Aurora server certificate is not verified (`KONG_PG_SSL_VERIFY` is unset). To verify, bake the RDS CA bundle into the image and set `KONG_LUA_SSL_TRUSTED_CERTIFICATE` / `KONG_PG_SSL_VERIFY=on`.

## Connecting data planes

Data planes are out of scope here, but they need these values (stack outputs in parentheses):

| Data plane setting | Value |
|---|---|
| `KONG_ROLE` | `data_plane` |
| `KONG_DATABASE` | `off` |
| `KONG_CLUSTER_CONTROL_PLANE` | `DataPlaneClusterEndpoint` output |
| `KONG_CLUSTER_TELEMETRY_ENDPOINT` | `DataPlaneTelemetryEndpoint` output |
| `KONG_CLUSTER_MTLS` | `shared` |
| `KONG_CLUSTER_CERT` / `KONG_CLUSTER_CERT_KEY` | Same values as secret `clusterCertSecretArn` |
| `KONG_LICENSE_DATA` | Same license |

Network path: data planes must route to the NLB on 8005/8006 (same VPC, peering, Transit Gateway or Direct Connect) and their CIDRs must be listed in `dataPlaneCidrs`. Data planes must not run a newer Kong version than the control plane; check Kong's CP/DP version compatibility rules before upgrades.

## Design notes

- **Three stacks:** the database and backup resources live apart from the ECS service so the service can be replaced or destroyed without touching data. The service stack imports the Aurora secret by ARN to avoid a cross-stack dependency cycle through the KMS key policy.
- **Migrations on every task start:** only `bootstrap` runs automatically. Version upgrades need `kong migrations up` and `finish` – see the [upgrade procedure](DEPLOYMENT_GUIDE.md#upgrading-kong).
