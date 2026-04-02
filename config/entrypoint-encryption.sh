#!/bin/sh
# Entrypoint wrapper for CSFLE testing with LocalStack.
# Reads the KMS key ARN from the shared volume (written by init-localstack),
# builds a combined CA bundle, exports env vars, and starts the backend.

set -e

echo "[entrypoint-encryption] Waiting for KMS key ARN..."
TIMEOUT=60
ELAPSED=0
while [ ! -f /shared/kms-key-arn ]; do
  sleep 1
  ELAPSED=$((ELAPSED + 1))
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "[entrypoint-encryption] ERROR: /shared/kms-key-arn not found after ${TIMEOUT}s"
    exit 1
  fi
done

export AWS_KMS_KEY_ARN=$(cat /shared/kms-key-arn)
echo "[entrypoint-encryption] AWS_KMS_KEY_ARN=$AWS_KMS_KEY_ARN"

# Combine the LocalStack cert chain with the system CA bundle.
# libmongocrypt's TLS needs the full trust chain including the root CA.
if [ -f /shared/localstack-ca.pem ]; then
  cat /shared/localstack-ca.pem /etc/ssl/certs/ca-certificates.crt > /shared/combined-ca.pem
  export AWS_KMS_TLS_CA_FILE=/shared/combined-ca.pem
  echo "[entrypoint-encryption] Combined CA bundle at $AWS_KMS_TLS_CA_FILE"
fi

exec npm run backend
