# Logging

## Log groups

| Log group | Source | Retention |
|---|---|---|
| `/aws/ecs/kong-cp-logs-{env}` | `kong-cp` (stream prefix `kong-cp`) and `kong-migrations` (prefix `kong-migrations`): Kong error log and Admin API access log | `logRetentionDays` (default 30) |
| `/aws/vpc/kong-vpc-flowlogs-{env}` | VPC Flow Logs | 1 month |
| `/aws/rds/cluster/kong-cp-db-{env}/postgresql` | Aurora PostgreSQL log | 1 month |
| S3 (ALB access logs bucket) | ALB access logs | 30 days |
| S3 `aws-waf-logs-kong-cp-alb-{env}-{stack id suffix}` | WAF logs (bucket is retained on stack deletion) | 30 days |

Kong writes the Admin API access log to stdout (`KONG_ADMIN_ACCESS_LOG=/dev/stdout`) and errors to stderr. Verbosity is `cpLogLevel` (default `notice`). Log level changes need a service redeploy.

The control plane log group is deleted with the service stack (so a redeploy never collides with a leftover group). Forward logs centrally (below) if you need them to outlive the stack.

## Forwarding to a central account

Set `loggingCentralDestinationArn` to forward the control plane log group to a CloudWatch Logs *destination* in a central account (typically backed by Kinesis Data Firehose). The service stack creates a subscription filter and the role `kong-logstreaming-role-{env}`.

```json
{
    "loggingEnabled": "true",
    "loggingCentralDestinationArn": "arn:aws:logs:ap-southeast-2:111122223333:destination:CentralLogDestination",
    "loggingFilterPattern": ""
}
```

Prerequisites in the central account:

1. A Firehose delivery stream and an IAM role it trusts (`logs.amazonaws.com`).
2. A CloudWatch Logs destination pointing at the stream:
   ```bash
   aws logs put-destination --destination-name CentralLogDestination \
     --target-arn arn:aws:firehose:<region>:<central-account>:deliverystream/<name> \
     --role-arn arn:aws:iam::<central-account>:role/CWLtoFirehoseRole
   ```
3. A destination policy allowing the source account:
   ```bash
   aws logs put-destination-policy --destination-name CentralLogDestination \
     --access-policy '{"Statement":[{"Effect":"Allow","Principal":{"AWS":"<source-account>"},"Action":"logs:PutSubscriptionFilter","Resource":"*"}]}'
   ```

Forwarding is skipped when `loggingCentralDestinationArn` is empty. Only the control plane log group is forwarded; the VPC flow log, Aurora and S3 logs stay in the account.
