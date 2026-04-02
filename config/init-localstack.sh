#!/bin/sh
# Wait for LocalStack KMS to be ready, create a CMK, extract the TLS CA chain,
# and write the ARN to a shared volume.
# Runs as an init container — exits after setup is complete.

set -e

echo "[init-localstack] Waiting for LocalStack KMS..."
until awslocal kms list-keys --region us-east-1 > /dev/null 2>&1; do
  sleep 1
done
echo "[init-localstack] LocalStack KMS is ready"

# Extract the full TLS certificate chain from LocalStack's HTTPS endpoint.
# libmongocrypt needs the complete chain (leaf + intermediate + root) to verify.
echo "[init-localstack] Extracting TLS CA chain from LocalStack..."
openssl s_client -connect localstack:4566 -showcerts </dev/null 2>/dev/null \
  | sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' \
  > /shared/localstack-ca.pem
echo "[init-localstack] CA chain written to /shared/localstack-ca.pem ($(grep -c 'BEGIN CERTIFICATE' /shared/localstack-ca.pem) certs)"

echo "[init-localstack] Creating KMS key..."
KEY_OUTPUT=$(awslocal kms create-key --region us-east-1 --description "LibreChat CSFLE test CMK")
KEY_ARN=$(echo "$KEY_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['KeyMetadata']['Arn'])")

echo "[init-localstack] Created KMS key: $KEY_ARN"
echo "$KEY_ARN" > /shared/kms-key-arn

echo "[init-localstack] Done — api container can start"
