import { Binary } from 'mongodb';
import { Schema } from 'mongoose';
import type { Query, UpdateQuery } from 'mongoose';
import type { EncryptionContext, IEncryptionService } from './types';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { encryptedFieldMap, getEncryptionConfig } from './config';
import { getEncryptionService } from './service';
import logger from '~/config/winston';

const appliedSchemas = new WeakSet<Schema>();

/**
 * Mongoose schema plugin that encrypts designated fields on all write paths.
 *
 * Covers:
 *  - `pre('save')` — for `.create()` and `.save()`
 *  - `pre('findOneAndUpdate')` / `pre('updateOne')` / `pre('updateMany')` — for update operations
 *
 * For bulk operations (`insertMany`, `bulkWrite`) that bypass all Mongoose middleware,
 * use {@link encryptDocumentsForBulk} before the call.
 *
 * Read-side decryption is handled automatically by the MongoDB driver
 * (`bypassAutoEncryption: true` still enables auto-decryption).
 */
export function applyEncryption(schema: Schema, modelName: string): void {
  const fieldConfig = encryptedFieldMap[modelName];
  if (!fieldConfig) {
    return;
  }

  if (appliedSchemas.has(schema)) {
    return;
  }
  appliedSchemas.add(schema);

  const fields = Object.keys(fieldConfig);

  // Only modify schema types and register hooks when encryption is configured.
  // Without this guard, existing deployments (no ENCRYPTION_PROVIDER) would lose
  // String type validation on text/filepath and the array wrapper on content.
  if (!getEncryptionConfig()) {
    return;
  }

  // Override schema path types to Mixed for encrypted fields while preserving
  // existing validators/options (required, default, index, etc.).
  // Without this, Mongoose's update-path type casters (e.g., String()) would
  // convert encrypted Binary values to garbled strings before sending to MongoDB.
  // Mixed accepts any BSON value, so Binary passes through untouched.
  for (const field of fields) {
    const existingPath = schema.path(field);
    if (existingPath) {
      const existingOptions = { ...existingPath.options };
      delete existingOptions.type;
      schema.add({ [field]: { ...existingOptions, type: Schema.Types.Mixed } });
    }
  }

  // ---- save path (create / save) ----
  schema.pre('save', async function encryptOnSave() {
    const service = getEncryptionService();
    if (!service?.isEnabled()) {
      return;
    }

    const tenantId = getTenantId();
    if (!tenantId || tenantId === SYSTEM_TENANT_ID) {
      return;
    }

    const context: EncryptionContext = { tenantId };

    for (const field of fields) {
      if (!this.isModified(field)) {
        continue;
      }

      const value = this.get(field) as unknown;
      if (value == null || isBinarySubtype6(value)) {
        continue;
      }

      try {
        this.set(field, await service.encrypt(value, context));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(
          `[Encryption] Failed to encrypt ${modelName}.${field} for tenant ${tenantId}: ${msg}`,
        );
        throw error;
      }
    }
  });

  // ---- update paths (findOneAndUpdate, updateOne, updateMany) ----
  const updateMiddleware = async function encryptOnUpdate(this: Query<unknown, unknown>) {
    const service = getEncryptionService();
    if (!service?.isEnabled()) {
      return;
    }

    const tenantId = getTenantId();
    if (!tenantId || tenantId === SYSTEM_TENANT_ID) {
      return;
    }

    const update = this.getUpdate() as UpdateQuery<unknown> | null;
    if (!update) {
      return;
    }

    if (Array.isArray(update)) {
      throw new Error(
        `[Encryption] Aggregation-pipeline updates on encrypted model "${modelName}" are not supported`,
      );
    }

    const context: EncryptionContext = { tenantId };

    // Encrypt fields set directly at the top level: { text: 'value' }
    await encryptUpdateFields(
      update as Record<string, unknown>,
      fields,
      context,
      modelName,
      service,
    );

    // Encrypt fields inside $set: { $set: { text: 'value' } }
    if (update.$set) {
      await encryptUpdateFields(
        update.$set as Record<string, unknown>,
        fields,
        context,
        modelName,
        service,
      );
    }

    // Encrypt fields inside $setOnInsert (for upserts): { $setOnInsert: { text: 'value' } }
    if (update.$setOnInsert) {
      await encryptUpdateFields(
        update.$setOnInsert as Record<string, unknown>,
        fields,
        context,
        modelName,
        service,
      );
    }
  };

  schema.pre('findOneAndUpdate', updateMiddleware);
  schema.pre('updateOne', updateMiddleware);

  // Block updateMany on encrypted fields: the middleware encrypts the $set
  // payload once and MongoDB replicates the same ciphertext to all matched
  // documents, defeating the randomized encryption guarantee. Callers must
  // use per-document updates (find + save, or updateOne in a loop).
  schema.pre('updateMany', async function blockEncryptedUpdateMany() {
    const service = getEncryptionService();
    if (!service?.isEnabled()) {
      return;
    }

    const tenantId = getTenantId();
    if (!tenantId || tenantId === SYSTEM_TENANT_ID) {
      return;
    }

    const update = this.getUpdate() as UpdateQuery<unknown> | null;
    if (!update) {
      return;
    }

    if (Array.isArray(update)) {
      throw new Error(
        `[Encryption] Aggregation-pipeline updates on encrypted model "${modelName}" are not supported`,
      );
    }

    const targets = [update, update.$set, update.$setOnInsert].filter(Boolean);
    for (const payload of targets) {
      for (const field of fields) {
        if (field in (payload as Record<string, unknown>)) {
          throw new Error(
            `[Encryption] updateMany on encrypted field "${modelName}.${field}" is not allowed. ` +
              'Use per-document updates to ensure unique ciphertext per document.',
          );
        }
      }
    }
  });
}

/**
 * Encrypt fields within an update payload object.
 * Mutates the object in place — replaces plaintext values with encrypted Binary.
 */
async function encryptUpdateFields(
  payload: Record<string, unknown>,
  fields: string[],
  context: EncryptionContext,
  modelName: string,
  service: IEncryptionService,
): Promise<void> {
  for (const field of fields) {
    if (!(field in payload) || payload[field] == null || isBinarySubtype6(payload[field])) {
      continue;
    }
    try {
      payload[field] = await service.encrypt(payload[field], context);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(
        `[Encryption] Failed to encrypt ${modelName}.${field} ` +
          `for tenant ${context.tenantId} (update path): ${msg}`,
      );
      throw error;
    }
  }
}

/**
 * Pre-encrypt fields for bulk operations (`insertMany`, `bulkWrite`) that bypass
 * all Mongoose middleware.
 *
 * Mutates documents in place. Encryption is fully sequential (one field at a time,
 * across all documents) to avoid exhausting the circuit breaker's exclusive half-open
 * probe slot during KMS recovery.
 *
 * **Important:** If encryption fails mid-batch, the input array is left in a
 * partially-encrypted state. Callers must not reuse `docs` after a thrown error.
 *
 * **Important:** After calling this function, use `Model.collection.insertMany(docs)`
 * (raw driver), not `Model.insertMany(docs)` (Mongoose). Mongoose's `insertMany`
 * applies schema type casting which will corrupt the encrypted Binary values for
 * non-string fields.
 */
export async function encryptDocumentsForBulk<T extends Record<string, unknown>>(
  modelName: string,
  docs: T[],
  tenantId: string,
): Promise<T[]> {
  const service = getEncryptionService();
  if (!service?.isEnabled()) {
    return docs;
  }

  const fieldConfig = encryptedFieldMap[modelName];
  if (!fieldConfig) {
    return docs;
  }

  const context: EncryptionContext = { tenantId };
  const fieldNames = Object.keys(fieldConfig);

  // Sequential per doc and per field to avoid exhausting the circuit breaker's
  // exclusive half-open probe slot when multiple encrypts run concurrently.
  for (const doc of docs) {
    for (const field of fieldNames) {
      const value = doc[field];
      if (value == null || isBinarySubtype6(value)) {
        continue;
      }
      (doc as Record<string, unknown>)[field] = await service.encrypt(value, context);
    }
  }

  return docs;
}

function isBinarySubtype6(value: unknown): boolean {
  return value instanceof Binary && value.sub_type === 6;
}
