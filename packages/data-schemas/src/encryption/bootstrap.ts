import type { MongoClient, AutoEncryptionOptions } from 'mongodb';
import type { EncryptionConfig } from './types';
import { KEY_VAULT_DB, KEY_VAULT_COLLECTION, getEncryptionConfig } from './config';
import { initializeEncryptionService } from './service';
import logger from '~/config/winston';

let _cachedAutoEncryption:
  | { options: AutoEncryptionOptions; config: EncryptionConfig }
  | null
  | undefined;

/**
 * Returns the `autoEncryption` options to pass to `mongoose.connect()`,
 * plus the parsed config for reuse in {@link bootstrapEncryption}.
 *
 * Returns `undefined` if encryption is not configured.
 * Result is memoized — env vars and options are computed only once.
 */
export function getAutoEncryptionOptions():
  | { options: AutoEncryptionOptions; config: EncryptionConfig }
  | undefined {
  if (_cachedAutoEncryption !== undefined) {
    return _cachedAutoEncryption ?? undefined;
  }

  const config = getEncryptionConfig();
  if (!config) {
    _cachedAutoEncryption = null;
    return undefined;
  }

  const options: AutoEncryptionOptions = {
    keyVaultNamespace: config.keyVaultNamespace,
    kmsProviders: config.kmsProviders,
    bypassAutoEncryption: true,
  };

  if (config.provider === 'aws' && config.awsTlsCAFile) {
    options.tlsOptions = {
      aws: { tlsCAFile: config.awsTlsCAFile },
    };
  }

  const cryptSharedLibPath = process.env.CRYPT_SHARED_LIB_PATH;
  if (cryptSharedLibPath) {
    options.extraOptions = { cryptSharedLibPath };
  }

  _cachedAutoEncryption = { options, config };
  return _cachedAutoEncryption;
}

/** Reset the memoized auto-encryption options (for testing only). */
export function _clearAutoEncryptionOptionsCache(): void {
  _cachedAutoEncryption = undefined;
}

/**
 * Bootstrap the encryption infrastructure after the MongoDB connection is established.
 *
 * 1. Creates the `__keyVault` collection if it doesn't exist.
 * 2. Ensures the required unique partial index on `keyAltNames`.
 * 3. Initializes the encryption service singleton.
 *
 * Call this once during server startup, after `connectDb()` completes.
 * Receives the already-parsed config from {@link getAutoEncryptionOptions} to avoid
 * re-reading environment variables.
 */
export async function bootstrapEncryption(
  client: MongoClient,
  config: EncryptionConfig,
): Promise<void> {
  if (process.env.DEFAULT_TENANT_ID) {
    logger.warn(
      `[TenantContext] DEFAULT_TENANT_ID="${process.env.DEFAULT_TENANT_ID}" is set. ` +
        'All tenant isolation, encryption, cache scoping, and bulk write injection are active. ' +
        'Documents without a tenantId field will not be queryable.',
    );
  }

  if (process.env.MEILI_HOST && process.env.MEILI_MASTER_KEY) {
    logger.warn(
      '[Encryption] MeiliSearch is configured alongside CSFLE. Encrypted fields ' +
        '(Message.text, Message.content) will be stored as BinData and will not be ' +
        'searchable via MeiliSearch.',
    );
  }

  await bootstrapKeyVault(client);
  initializeEncryptionService(client, config);
}

/**
 * Creates the `__keyVault` collection and its required unique index on `keyAltNames`.
 * Idempotent — safe to call on every startup.
 *
 * Attempts a partial filter index first (MongoDB). If the server does not support
 * `partialFilterExpression` (e.g. AWS DocumentDB), falls back to a plain unique index.
 */
async function bootstrapKeyVault(client: MongoClient): Promise<void> {
  const db = client.db(KEY_VAULT_DB);
  const collection = db.collection(KEY_VAULT_COLLECTION);

  try {
    await collection.createIndex(
      { keyAltNames: 1 },
      {
        unique: true,
        partialFilterExpression: { keyAltNames: { $exists: true } },
      },
    );
    logger.info(`[Encryption] __keyVault index ensured on ${KEY_VAULT_DB}.${KEY_VAULT_COLLECTION}`);
  } catch (error) {
    if (error && typeof error === 'object' && 'codeName' in error) {
      const codeName = (error as { codeName: string }).codeName;
      if (codeName === 'IndexOptionsConflict' || codeName === 'IndexKeySpecsConflict') {
        logger.info('[Encryption] __keyVault index already exists');
        return;
      }
    }

    // Only fall back for errors indicating the server doesn't support
    // partialFilterExpression (e.g. DocumentDB, older MongoDB). Re-throw
    // auth errors, network errors, and anything else immediately.
    if (!isUnsupportedOperatorError(error)) {
      throw error;
    }

    const originalMsg = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[Encryption] partialFilterExpression not supported (${originalMsg}), falling back to plain unique index`,
    );
    try {
      await collection.createIndex({ keyAltNames: 1 }, { unique: true });
      logger.info(
        `[Encryption] __keyVault fallback index ensured on ${KEY_VAULT_DB}.${KEY_VAULT_COLLECTION}`,
      );
    } catch (fallbackError) {
      if (fallbackError && typeof fallbackError === 'object' && 'codeName' in fallbackError) {
        const codeName = (fallbackError as { codeName: string }).codeName;
        if (codeName === 'IndexOptionsConflict' || codeName === 'IndexKeySpecsConflict') {
          logger.info('[Encryption] __keyVault index already exists');
          return;
        }
      }
      throw fallbackError;
    }
  }
}

/**
 * Returns `true` when the error indicates the server does not support
 * `partialFilterExpression` (e.g. AWS DocumentDB, very old MongoDB).
 *
 * Known codes:
 *  - 115 (`CommandNotSupported`)
 *  - 9   (`FailedToParse` — some DocumentDB versions)
 *  - 303 (`IndexOptionsConflict` variant on DocumentDB for unsupported options)
 *  - String-based detection for DocumentDB's "not supported" messages
 */
function isUnsupportedOperatorError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const UNSUPPORTED_CODES = new Set([9, 115, 303]);
  if ('code' in error && typeof (error as { code: unknown }).code === 'number') {
    if (UNSUPPORTED_CODES.has((error as { code: number }).code)) {
      return true;
    }
  }

  // String fallback only when no numeric code is present (some DocumentDB versions)
  if (!('code' in error)) {
    const msg = error instanceof Error ? error.message : '';
    return (
      /partialFilterExpression/i.test(msg) && /not\s*(supported|implemented|allowed)/i.test(msg)
    );
  }
  return false;
}
