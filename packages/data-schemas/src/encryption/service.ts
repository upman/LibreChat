import { ClientEncryption } from 'mongodb';
import type { Binary, MongoClient } from 'mongodb';
import type { IEncryptionService, EncryptionContext, EncryptionConfig } from './types';
import {
  ALGORITHM_RANDOM,
  keyAltNameForTenant,
  KEY_VAULT_DB,
  KEY_VAULT_COLLECTION,
} from './config';
import { CircuitBreaker } from './circuitBreaker';
import { KmsUnavailableError } from './types';
import logger from '~/config/winston';

/**
 * CSFLE encryption service: DEK lifecycle, tenant-scoped key resolution, and explicit encryption.
 *
 * Uses a hybrid approach: explicit encryption on writes (this service),
 * automatic decryption on reads (MongoDB driver with bypassAutoEncryption: true).
 */
export class EncryptionService implements IEncryptionService {
  private clientEncryption: ClientEncryption;
  private circuitBreaker: CircuitBreaker;
  private config: EncryptionConfig;
  private client: MongoClient;
  private knownTenants = new Set<string>();
  private shreddedTenants = new Set<string>();
  private pendingKeys = new Map<string, Promise<void>>();

  constructor(client: MongoClient, config: EncryptionConfig) {
    this.client = client;
    this.config = config;
    this.circuitBreaker = new CircuitBreaker();

    const clientEncryptionOpts: ConstructorParameters<typeof ClientEncryption>[1] = {
      keyVaultNamespace: config.keyVaultNamespace,
      kmsProviders: config.kmsProviders,
    };

    if (config.provider === 'aws' && config.awsTlsCAFile) {
      clientEncryptionOpts.tlsOptions = {
        aws: { tlsCAFile: config.awsTlsCAFile },
      };
    }

    this.clientEncryption = new ClientEncryption(client, clientEncryptionOpts);
  }

  isEnabled(): boolean {
    return true;
  }

  /**
   * Encrypt a value for a given tenant.
   * The value can be any BSON-serializable type (string, array, object, number, etc.).
   * Uses randomized encryption — same plaintext produces different ciphertext each time.
   *
   * Lazily creates the tenant's DEK on first use if it doesn't already exist.
   */
  async encrypt(value: unknown, context: EncryptionContext): Promise<Binary> {
    this.assertNotShredded(context);
    if (!this.circuitBreaker.canProceed()) {
      throw new KmsUnavailableError();
    }

    try {
      await this.ensureKey(context);
      const encrypted = await this.clientEncryption.encrypt(value, {
        keyAltName: keyAltNameForTenant(context.tenantId),
        algorithm: ALGORITHM_RANDOM,
      });
      this.circuitBreaker.recordSuccess();
      return encrypted;
    } catch (error) {
      if (isTransientKmsError(error)) {
        this.circuitBreaker.recordFailure();
      } else {
        // Non-transient = KMS responded with a deterministic error (e.g., key not found).
        // The service is reachable — close the circuit to release the half-open probe.
        this.circuitBreaker.recordSuccess();
      }
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[EncryptionService] encrypt failed for tenant ${context.tenantId}: ${msg}`);
      throw error;
    }
  }

  /**
   * Encrypt multiple values for the same tenant.
   * Uses a single `canProceed()` check, then parallelizes via `Promise.all` —
   * the batch is treated as one atomic circuit-breaker operation (one probe in
   * half-open state covers all values). This differs from `encrypt()` which
   * checks `canProceed()` per call.
   *
   * Not currently called from production write paths (which use sequential
   * `encrypt()` via `encryptDocumentsForBulk`). Retained in the interface for
   * future batch optimization when circuit-closed performance matters at scale.
   */
  async encryptBatch(values: unknown[], context: EncryptionContext): Promise<Binary[]> {
    if (values.length === 0) {
      return [];
    }

    this.assertNotShredded(context);
    if (!this.circuitBreaker.canProceed()) {
      throw new KmsUnavailableError();
    }

    try {
      await this.ensureKey(context);
      const keyAltName = keyAltNameForTenant(context.tenantId);
      const results = await Promise.all(
        values.map((value) =>
          this.clientEncryption.encrypt(value, {
            keyAltName,
            algorithm: ALGORITHM_RANDOM,
          }),
        ),
      );
      this.circuitBreaker.recordSuccess();
      return results;
    } catch (error) {
      if (isTransientKmsError(error)) {
        this.circuitBreaker.recordFailure();
      } else {
        this.circuitBreaker.recordSuccess();
      }
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(
        `[EncryptionService] encryptBatch failed for tenant ${context.tenantId}: ${msg}`,
      );
      throw error;
    }
  }

  /**
   * Create a new DEK for a tenant. Wraps the DEK with the CMK via the configured KMS provider.
   * Handles the race condition where two concurrent requests create the same key:
   * catches the E11000 duplicate key error from the unique index and falls back to a read.
   */
  async createKey(context: EncryptionContext): Promise<void> {
    const keyAltName = keyAltNameForTenant(context.tenantId);

    const masterKeyOptions = this.getMasterKeyOptions();

    try {
      await this.clientEncryption.createDataKey(this.config.provider, {
        keyAltNames: [keyAltName],
        ...masterKeyOptions,
      });
      this.knownTenants.add(context.tenantId);
      logger.info(`[EncryptionService] Created DEK for tenant ${context.tenantId}`);
    } catch (error: unknown) {
      // Handle duplicate key error (E11000) — another request created the key concurrently
      if (this.isDuplicateKeyError(error)) {
        this.knownTenants.add(context.tenantId);
        logger.info(
          `[EncryptionService] DEK already exists for tenant ${context.tenantId} (concurrent create)`,
        );
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(
        `[EncryptionService] Failed to create DEK for tenant ${context.tenantId}: ${msg}`,
      );
      throw error;
    }
  }

  /**
   * Delete a tenant's DEK from the key vault (key shredding).
   * All data encrypted with this DEK becomes permanently unrecoverable.
   * After shredding, all encrypt calls for this tenant are blocked for the
   * lifetime of this process — the tenant cannot be silently re-provisioned.
   */
  async destroyKey(context: EncryptionContext): Promise<void> {
    // Block new encrypts synchronously before any await point.
    // Any encrypt() call that begins after this line will fail via assertNotShredded().
    this.shreddedTenants.add(context.tenantId);
    this.knownTenants.delete(context.tenantId);

    // Drain any in-flight createKey before deleting to prevent race where
    // a concurrent ensureKey recreates the DEK after we delete it.
    const pending = this.pendingKeys.get(context.tenantId);
    if (pending) {
      try {
        await pending;
      } catch {
        /* ignore — createKey failure doesn't affect shredding */
      }
    }

    const keyAltName = keyAltNameForTenant(context.tenantId);
    const keyVault = this.client.db(KEY_VAULT_DB).collection(KEY_VAULT_COLLECTION);

    const result = await keyVault.deleteOne({ keyAltNames: keyAltName });

    if (result.deletedCount === 0) {
      logger.warn(
        `[EncryptionService] No DEK found for tenant ${context.tenantId} during key shredding`,
      );
    } else {
      logger.info(`[EncryptionService] Shredded DEK for tenant ${context.tenantId}`);
    }
  }

  private assertNotShredded(context: EncryptionContext): void {
    if (this.shreddedTenants.has(context.tenantId)) {
      throw new Error(
        `[EncryptionService] Tenant ${context.tenantId} has been shredded — writes are permanently blocked`,
      );
    }
  }

  /**
   * Lazily creates a DEK for the tenant if one doesn't already exist.
   * Deduplicates concurrent calls for the same tenant — only one `createDataKey`
   * KMS request is made even when N parallel encrypts arrive simultaneously.
   */
  private async ensureKey(context: EncryptionContext): Promise<void> {
    if (this.knownTenants.has(context.tenantId)) {
      return;
    }
    const pending = this.pendingKeys.get(context.tenantId);
    if (pending) {
      return pending;
    }
    const p = this.createKey(context)
      .then(() => {
        this.knownTenants.add(context.tenantId);
      })
      .finally(() => this.pendingKeys.delete(context.tenantId));
    this.pendingKeys.set(context.tenantId, p);
    return p;
  }

  private getMasterKeyOptions(): { masterKey?: Record<string, string> } {
    if (this.config.provider === 'aws') {
      const masterKey: Record<string, string> = {
        key: this.config.awsKeyArn,
        region: this.config.awsRegion,
      };
      if (this.config.awsKmsEndpoint) {
        masterKey.endpoint = this.config.awsKmsEndpoint;
      }
      return { masterKey };
    }
    // Local provider — no masterKey needed
    return {};
  }

  private isDuplicateKeyError(error: unknown): boolean {
    if (error && typeof error === 'object' && 'code' in error) {
      return (error as { code: number }).code === 11000;
    }
    if (error instanceof Error) {
      return error.message.includes('E11000');
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _instance: EncryptionService | null = null;

/**
 * Returns the active encryption service instance, or null if encryption is not configured.
 * The service is initialized by `initializeEncryptionService()` after DB connection.
 */
export function getEncryptionService(): IEncryptionService | null {
  return _instance;
}

/**
 * Initialize the encryption service singleton.
 * Call this AFTER the Mongoose connection is established.
 */
export function initializeEncryptionService(
  client: MongoClient,
  config: EncryptionConfig,
): EncryptionService {
  _instance = new EncryptionService(client, config);
  logger.info(
    `[EncryptionService] Initialized with provider="${config.provider}", ` +
      `keyVault="${config.keyVaultNamespace}"`,
  );
  return _instance;
}

/** Reset the singleton (for testing only). */
export function _resetEncryptionService(): void {
  _instance = null;
}

/**
 * Returns `true` for transient KMS/network errors that should trip the circuit breaker.
 * Deterministic errors (missing DEK, bad input, auth misconfiguration) should NOT
 * count toward the breaker — they won't resolve by retrying later.
 */
export function isTransientKmsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return true;
  }
  const msg = error instanceof Error ? error.message : '';
  // "key not found" — deterministic: DEK doesn't exist, won't appear by retrying
  if (/key.*not found|no.*key/i.test(msg)) {
    return false;
  }
  // MongoDB driver errors with specific codes are deterministic
  if ('code' in error && typeof (error as { code: unknown }).code === 'number') {
    const code = (error as { code: number }).code;
    // 11000 = duplicate key (race in createKey), not a KMS issue
    if (code === 11000) {
      return false;
    }
  }
  // Everything else (network timeout, KMS 5xx, TLS failure) is transient
  return true;
}
