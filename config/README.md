# Configuration files

`config/{environment}.json` holds the settings for one environment and has the highest precedence. Copy `dev.json.example`:

```bash
cp config/dev.json.example config/dev.json
```

`config/*.json` is git-ignored (only `*.json.example` is committed) because it contains account-specific ARNs. All values are strings (`"true"`, `"2"`); lists are comma-separated.

Precedence: `config/{env}.json` → `cdk.context.json` / `--context key=value` → environment variable. The environment-variable name for each key is in the [README](../README.md#configuration).

Minimum viable file:

```json
{
    "kongImageUri": "kong/kong-gateway:3.15",
    "kongLicenseSecretArn": "arn:aws:secretsmanager:...:secret:kong/cp/dev/license-AbCdEf",
    "clusterCertSecretArn": "arn:aws:secretsmanager:...:secret:kong/cp/dev/cluster-cert-AbCdEf",
    "albCertificateArn": "arn:aws:acm:...:certificate/..."
}
```

Pin `kongImageUri` to the Kong Gateway Enterprise version you have validated; `3.15` in the example is a placeholder.

Use a separate file per environment (`dev.json`, `uat.json`, `prd.json`) and select it with `ENVIRONMENT`.
