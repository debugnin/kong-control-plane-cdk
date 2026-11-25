#!/usr/bin/env bash
# Downloads the regional Amazon RDS CA bundle that Kong uses to verify the Aurora server
# certificate. The bundle is public; it is committed under certs/ and embedded at synth time.
#
# Usage: ./scripts/fetch-rds-ca.sh <region>     e.g. ./scripts/fetch-rds-ca.sh ap-southeast-2
set -euo pipefail
REGION="${1:?usage: $0 <region>}"
OUT="$(dirname "$0")/../certs/rds-ca-${REGION}.pem"
mkdir -p "$(dirname "$OUT")"
curl -sSf -o "$OUT" "https://truststore.pki.rds.amazonaws.com/${REGION}/${REGION}-bundle.pem"
echo "Saved $(grep -c 'BEGIN CERTIFICATE' "$OUT") certificates to $OUT"
