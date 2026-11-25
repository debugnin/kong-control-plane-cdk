#!/usr/bin/env bash
# Creates the two Secrets Manager secrets the control plane stack needs but cannot generate:
#   1. Kong Enterprise license    -> kong/cp/<env>/license
#   2. CP<->DP cluster certificate -> kong/cp/<env>/cluster-cert  (keys: cluster_cert, cluster_cert_key)
#
# Usage: ./scripts/create-cp-secrets.sh <env> <path-to-license.json> [region]
#
# The cluster certificate is self-signed (CN=kong_clustering, 3 years) and shared by the control
# plane and every data plane (cluster_mtls=shared). Use your own PKI instead if policy requires it:
# create the secret yourself with the same two keys.
set -euo pipefail

ENVIRONMENT="${1:?usage: $0 <env> <license.json> [region]}"
LICENSE_FILE="${2:?usage: $0 <env> <license.json> [region]}"
REGION="${3:-${AWS_REGION:-${AWS_DEFAULT_REGION:-}}}"
[ -n "$REGION" ] || { echo "Set a region (3rd arg or AWS_REGION)" >&2; exit 1; }
[ -f "$LICENSE_FILE" ] || { echo "License file not found: $LICENSE_FILE" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
chmod 700 "$WORKDIR"

openssl req -new -x509 -nodes -newkey ec:<(openssl ecparam -name secp384r1) \
    -keyout "$WORKDIR/cluster.key" -out "$WORKDIR/cluster.crt" \
    -days 1095 -subj "/CN=kong_clustering" 2>/dev/null

put_secret() { # name, value-file
    local name="$1" file="$2"
    if aws secretsmanager describe-secret --secret-id "$name" --region "$REGION" >/dev/null 2>&1; then
        echo "Secret $name already exists - leaving it unchanged" >&2
        aws secretsmanager describe-secret --secret-id "$name" --region "$REGION" --query ARN --output text
    else
        aws secretsmanager create-secret --name "$name" --region "$REGION" \
            --secret-string "file://$file" --query ARN --output text
    fi
}

jq -n --rawfile c "$WORKDIR/cluster.crt" --rawfile k "$WORKDIR/cluster.key" \
    '{cluster_cert: $c, cluster_cert_key: $k}' > "$WORKDIR/cluster.json"

echo "License secret ARN:"
LICENSE_ARN="$(put_secret "kong/cp/$ENVIRONMENT/license" "$LICENSE_FILE")"
echo "$LICENSE_ARN"
echo "Cluster certificate secret ARN:"
CLUSTER_ARN="$(put_secret "kong/cp/$ENVIRONMENT/cluster-cert" "$WORKDIR/cluster.json")"
echo "$CLUSTER_ARN"

cat <<MSG

Add to config/$ENVIRONMENT.json:
  "kongLicenseSecretArn": "$LICENSE_ARN",
  "clusterCertSecretArn": "$CLUSTER_ARN"
MSG
