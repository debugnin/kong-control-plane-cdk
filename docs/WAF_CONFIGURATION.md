# WAF Configuration

An AWS WAFv2 web ACL (`kong-cp-alb-waf-{env}`) is associated with the control plane ALB, which fronts Kong Manager and the Admin API. It is enabled by default and can be turned off with `wafEnabled=false`. The NLB (ports 8005/8006) has no WAF – WAF does not apply to NLBs; that traffic is protected by security groups and Kong's mTLS.

## Rules (in priority order)

1. **AllowOnlyFromAllowedCidrs** – only when `wafEnableCidrRestriction=true` and `wafAllowedCidrs` is non-empty. Matching sources are allowed; the web ACL default action becomes **block (403)**.
2. **AWSManagedRulesCommonRuleSet**
3. **AWSManagedRulesKnownBadInputsRuleSet**
4. **AWSManagedRulesAmazonIpReputationList**
5. **RateLimitRule** – blocks (429) any single IP above `wafRateLimit` requests per 5-minute window (AWS evaluation window; default 2000).

The default action is **allow** unless CIDR restriction is active. WAF logs go to an S3 bucket `aws-waf-logs-kong-cp-alb-{env}-{stack id suffix}` (retained on stack deletion) (30-day expiry).

## Settings

| Config key | Default | Description |
|---|---|---|
| `wafEnabled` | `true` | Create and associate the web ACL |
| `wafRateLimit` | `2000` | Per-IP request limit |
| `wafAllowedCidrs` | – | CIDRs allowed when restriction is on |
| `wafEnableCidrRestriction` | `false` | Block everything not in `wafAllowedCidrs` |

## Layering with security groups

The ALB is internal and its security group already limits ingress to `albAllowedCidrs` (default: the VPC CIDR). WAF is a second layer. Use `wafEnableCidrRestriction` when the ALB is reached through shared networks (Transit Gateway, Direct Connect) and you want an extra allow-list.

Note: when WAF CIDR restriction is on, requests from VPC-internal sources to the ALB must be in `wafAllowedCidrs` too, or they are blocked.

## Troubleshooting

- **403 from Manager/Admin API:** check the source IP against `wafAllowedCidrs` and the ALB security group (`albAllowedCidrs`); inspect WAF sampled requests in the console.
- **429:** a client exceeded the rate limit; raise `wafRateLimit` for automation that polls the Admin API heavily (for example CI running decK).
- **Managed rule false positives on Admin API payloads:** review sampled requests, then add a rule exclusion to `lib/constructs/waf-construct.ts`.
