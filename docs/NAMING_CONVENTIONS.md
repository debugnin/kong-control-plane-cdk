# Naming Conventions

All resources are named for a single environment: `dev`, `qa`, `uat` or `prd` (set with `ENVIRONMENT`). Pattern: `kong-cp-<resource>-<env>`, using the cloud-native resource type where it helps.

## Stacks

| Stack | Name |
|---|---|
| Network | `kong-cp-network-stack-{env}` |
| Database + backup | `kong-cp-database-stack-{env}` |
| Control plane service | `kong-cp-service-stack-{env}` |

## Resources

| Resource | Name |
|---|---|
| VPC (Name tag) | `kong-vpc-{env}` |
| VPC flow logs | `/aws/vpc/kong-vpc-flowlogs-{env}` |
| Transit Gateway attachment | `kong-vpc-tgw-attachment-{env}` |
| Aurora cluster | `kong-cp-db-{env}` |
| Aurora KMS key alias | `alias/kong-cp-db-{env}` |
| Aurora master secret | `kong/cp/{env}/db-master` |
| Kong admin bootstrap secret | `kong/cp/{env}/admin` |
| Manager session secret | `kong/cp/{env}/manager-session` |
| License / cluster cert secrets (created by script) | `kong/cp/{env}/license`, `kong/cp/{env}/cluster-cert` |
| Backup vault | `kong-cp-backup-vault-{env}` |
| Backup plan / selection | `kong-cp-backup-plan-{env}` / `kong-cp-aurora-{env}` |
| Backup KMS key alias | `alias/kong-cp-backup-{env}` |
| ECS cluster | `kong-cp-ecscluster-{env}` |
| ECS service | `kong-cp-ecsservice-{env}` |
| Task definition family | `kong-cp-task-{env}` |
| Control plane log group | `/aws/ecs/kong-cp-logs-{env}` |
| ALB | `kong-cp-alb-{env}` |
| NLB | `kong-cp-nlb-{env}` |
| WAF web ACL | `kong-cp-alb-waf-{env}` |
| Log forwarding role | `kong-logstreaming-role-{env}` |

Names are fixed per environment, so **one environment per account and region**. Deploying two stacks with the same `ENVIRONMENT` into one account/region will conflict (for example on the Aurora identifier and secret names).

## Config and tags

Config keys are `camelCase`; the matching environment variables are `UPPER_SNAKE_CASE` (`cpReplicas` → `CP_REPLICAS`). The full list is in the [README](../README.md#configuration).
