import type { CSFLEAlgorithm, EncryptedFieldMap, EncryptionConfig } from './types';

export const ALGORITHM_RANDOM: CSFLEAlgorithm = 'AEAD_AES_256_CBC_HMAC_SHA_512-Random';

export const KEY_VAULT_DB = 'encryption';
export const KEY_VAULT_COLLECTION = '__keyVault';
export const KEY_VAULT_NAMESPACE = `${KEY_VAULT_DB}.${KEY_VAULT_COLLECTION}`;

/**
 * Fields encrypted per model. Only fields listed here receive write-path encryption.
 * All use randomized encryption (no query support, no frequency leakage).
 */
export const encryptedFieldMap: EncryptedFieldMap = {
  Message: {
    text: { algorithm: ALGORITHM_RANDOM },
    content: { algorithm: ALGORITHM_RANDOM },
  },
  /**
   * `filename` is intentionally excluded: `claimCodeFile()` queries by
   * `{ filename, conversationId, context }` for code interpreter file claiming.
   * Encrypting it would break that lookup. Refactor `claimCodeFile` to filter
   * by `file_id` before adding `filename` here.
   */
  File: {
    filepath: { algorithm: ALGORITHM_RANDOM },
    text: { algorithm: ALGORITHM_RANDOM },
  },
};

/** Prefix for DEK keyAltName values: `tenant:<tenantId>` */
export function keyAltNameForTenant(tenantId: string): string {
  return `tenant:${tenantId}`;
}

let _cachedConfig: EncryptionConfig | null | undefined;

/**
 * Reads encryption configuration from environment variables.
 * Returns `null` if encryption is not configured (ENCRYPTION_PROVIDER not set).
 * Result is memoized — env vars are read only once.
 */
export function getEncryptionConfig(): EncryptionConfig | null {
  if (_cachedConfig !== undefined) {
    return _cachedConfig;
  }
  _cachedConfig = parseEncryptionConfig();
  return _cachedConfig;
}

/** Reset the memoized config (for testing only). */
export function _clearEncryptionConfigCache(): void {
  _cachedConfig = undefined;
}

function parseEncryptionConfig(): EncryptionConfig | null {
  const provider = process.env.ENCRYPTION_PROVIDER;

  if (!provider) {
    return null;
  }

  if (provider === 'local') {
    const localKeyB64 = process.env.ENCRYPTION_LOCAL_KEY;
    if (!localKeyB64) {
      throw new Error(
        'ENCRYPTION_LOCAL_KEY (base64-encoded 96-byte key) is required when ENCRYPTION_PROVIDER=local',
      );
    }
    const localKey = Buffer.from(localKeyB64, 'base64');
    if (localKey.length !== 96) {
      throw new Error(
        `ENCRYPTION_LOCAL_KEY must decode to exactly 96 bytes, got ${localKey.length}`,
      );
    }
    return {
      provider: 'local',
      keyVaultNamespace: KEY_VAULT_NAMESPACE,
      kmsProviders: { local: { key: localKey } },
    };
  }

  if (provider === 'aws') {
    const accessKeyId = process.env.AWS_KMS_ACCESS_KEY_ID ?? '';
    const secretAccessKey = process.env.AWS_KMS_SECRET_ACCESS_KEY ?? '';
    const sessionToken = process.env.AWS_KMS_SESSION_TOKEN;
    const region = process.env.AWS_KMS_REGION;
    const keyArn = process.env.AWS_KMS_KEY_ARN;

    if (!region || !keyArn) {
      throw new Error('AWS KMS requires AWS_KMS_REGION and AWS_KMS_KEY_ARN');
    }

    const bothProvided = Boolean(accessKeyId) && Boolean(secretAccessKey);
    const neitherProvided = !accessKeyId && !secretAccessKey;
    if (!bothProvided && !neitherProvided) {
      throw new Error(
        'AWS KMS: provide both AWS_KMS_ACCESS_KEY_ID and AWS_KMS_SECRET_ACCESS_KEY, ' +
          'or omit both to use the default credential chain (IAM role, ECS task role, EKS IRSA)',
      );
    }

    // Empty object → MongoDB driver fetches credentials from the environment
    // (instance profile, EKS IRSA, ECS task role) and auto-rotates them.
    const awsKms:
      | { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
      | Record<string, never> = neitherProvided
      ? {}
      : { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };

    const awsKmsEndpoint = process.env.AWS_KMS_ENDPOINT?.replace(/^https?:\/\//, '') || undefined;
    if (awsKmsEndpoint && !awsKmsEndpoint.includes('.')) {
      throw new Error(
        `AWS_KMS_ENDPOINT must use a dotted hostname (e.g. "kms.us-east-1.example.com:4566"), ` +
          `got "${awsKmsEndpoint}". The MongoDB CSFLE driver requires a dot separator in the host.`,
      );
    }
    const awsTlsCAFile = process.env.AWS_KMS_TLS_CA_FILE || undefined;

    return {
      provider: 'aws',
      keyVaultNamespace: KEY_VAULT_NAMESPACE,
      kmsProviders: { aws: awsKms },
      awsKeyArn: keyArn,
      awsRegion: region,
      ...(awsKmsEndpoint ? { awsKmsEndpoint } : {}),
      ...(awsTlsCAFile ? { awsTlsCAFile } : {}),
    };
  }

  throw new Error(`Unknown ENCRYPTION_PROVIDER: "${provider}". Expected "aws" or "local".`);
}
