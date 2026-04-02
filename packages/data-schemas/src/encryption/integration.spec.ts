/**
 * CSFLE Integration Tests — Three acceptance criteria from the technical brief.
 *
 * These tests run against a local mongod (via mongodb-memory-server) with the local KMS provider.
 * No Docker, Atlas, or AWS dependency is required.
 *
 * Prerequisites:
 *   - `mongodb-client-encryption` package installed (provides libmongocrypt bindings)
 *
 * If `mongodb-client-encryption` is not available, the test suite is skipped.
 */

import crypto from 'node:crypto';
import mongoose, { Schema } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Binary } from 'mongodb';
import { tenantStorage } from '~/config/tenantContext';
import { applyTenantIsolation, _resetStrictCache } from '~/models/plugins/tenantIsolation';
import { applyEncryption, encryptDocumentsForBulk } from './plugin';
import {
  getEncryptionService,
  initializeEncryptionService,
  _resetEncryptionService,
} from './service';
import { KmsUnavailableError } from './types';
import {
  KEY_VAULT_DB,
  KEY_VAULT_COLLECTION,
  KEY_VAULT_NAMESPACE,
  _clearEncryptionConfigCache,
} from './config';

// ---------------------------------------------------------------------------
// Pre-flight: check if CSFLE bindings are available
// ---------------------------------------------------------------------------
let csfleAvailable = false;

try {
  // ClientEncryption requires mongodb-client-encryption native bindings.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic check, not a module import
  const mongodb = require('mongodb') as typeof import('mongodb');
  csfleAvailable = typeof mongodb.ClientEncryption === 'function';
} catch {
  csfleAvailable = false;
}

const describeIf = csfleAvailable ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------
let mongoServer: InstanceType<typeof MongoMemoryServer>;
let rawClient: MongoClient;

const LOCAL_MASTER_KEY = crypto.randomBytes(96);

const kmsProviders = { local: { key: LOCAL_MASTER_KEY } };

interface ITestMessage {
  messageId: string;
  conversationId: string;
  user: string;
  text?: string;
  content?: unknown[];
  isCreatedByUser: boolean;
  tenantId?: string;
}

interface ITestFile {
  user: mongoose.Types.ObjectId;
  file_id: string;
  filename: string;
  filepath: string;
  text?: string;
  bytes: number;
  type: string;
  tenantId?: string;
}

// ---------------------------------------------------------------------------
// Test-local model factories (mirror the real schemas but minimal)
// ---------------------------------------------------------------------------
let modelCounter = 0;
function createTestMessageModel() {
  const schema = new Schema<ITestMessage>(
    {
      messageId: { type: String, unique: true, required: true },
      conversationId: { type: String, required: true },
      user: { type: String, required: true },
      text: { type: String },
      content: { type: [{ type: mongoose.Schema.Types.Mixed }], default: undefined },
      isCreatedByUser: { type: Boolean, required: true, default: false },
      tenantId: { type: String, index: true },
    },
    { timestamps: true },
  );

  applyTenantIsolation(schema);
  applyEncryption(schema, 'Message');

  const name = `TestMessage_${++modelCounter}`;
  return mongoose.model<ITestMessage>(name, schema);
}

function createTestFileModel() {
  const schema = new Schema<ITestFile>(
    {
      user: { type: mongoose.Schema.Types.ObjectId, required: true },
      file_id: { type: String, required: true },
      filename: { type: String, required: true },
      filepath: { type: String, required: true },
      text: { type: String },
      bytes: { type: Number, required: true },
      type: { type: String, required: true },
      tenantId: { type: String, index: true },
    },
    { timestamps: true },
  );

  applyTenantIsolation(schema);
  applyEncryption(schema, 'File');

  const name = `TestFile_${++modelCounter}`;
  return mongoose.model<ITestFile>(name, schema);
}

// ---------------------------------------------------------------------------
describeIf('CSFLE Integration', () => {
  beforeAll(async () => {
    // Set ENCRYPTION_PROVIDER so applyEncryption activates schema type overrides and hooks
    process.env.ENCRYPTION_PROVIDER = 'local';
    process.env.ENCRYPTION_LOCAL_KEY = LOCAL_MASTER_KEY.toString('base64');

    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();

    // Connect Mongoose with autoEncryption (bypassAutoEncryption: true → explicit encrypt, auto decrypt)
    await mongoose.connect(uri, {
      autoEncryption: {
        keyVaultNamespace: KEY_VAULT_NAMESPACE,
        kmsProviders,
        bypassAutoEncryption: true,
      },
    });

    // Bootstrap key vault index
    const client = mongoose.connection.getClient();
    const keyVault = client.db(KEY_VAULT_DB).collection(KEY_VAULT_COLLECTION);
    await keyVault.createIndex(
      { keyAltNames: 1 },
      { unique: true, partialFilterExpression: { keyAltNames: { $exists: true } } },
    );

    // Initialize encryption service
    initializeEncryptionService(client as unknown as MongoClient, {
      provider: 'local',
      keyVaultNamespace: KEY_VAULT_NAMESPACE,
      kmsProviders,
    });

    // Separate raw client for verifying encryption at rest (NO autoEncryption)
    rawClient = new MongoClient(uri);
    await rawClient.connect();
  });

  afterAll(async () => {
    _resetEncryptionService();
    _clearEncryptionConfigCache();
    _resetStrictCache();
    delete process.env.ENCRYPTION_PROVIDER;
    delete process.env.ENCRYPTION_LOCAL_KEY;
    try {
      await rawClient?.close();
    } catch {
      /* ignore */
    }
    try {
      await mongoose.disconnect();
    } catch {
      /* ignore */
    }
    try {
      await mongoServer?.stop();
    } catch {
      /* ignore */
    }
  });

  // =========================================================================
  // Acceptance Criterion 1: Data is actually encrypted at rest
  // =========================================================================
  describe('1. Data encrypted at rest', () => {
    it('stores text as BinData subtype 6 in MongoDB', async () => {
      const Message = createTestMessageModel();
      const service = getEncryptionService()!;
      await service.createKey({ tenantId: 'test-at-rest' });

      const msg = await tenantStorage.run({ tenantId: 'test-at-rest' }, async () =>
        Message.create({
          messageId: 'msg-at-rest-1',
          conversationId: 'conv-1',
          user: 'user-1',
          text: 'This is a secret message',
          isCreatedByUser: true,
          tenantId: 'test-at-rest',
        }),
      );

      // Read with raw client (no autoEncryption → no auto-decrypt)
      const collectionName = Message.collection.collectionName;
      const rawDoc = await rawClient
        .db(mongoose.connection.db!.databaseName)
        .collection(collectionName)
        .findOne({ _id: msg._id });

      expect(rawDoc).not.toBeNull();
      // text field should be BinData subtype 6
      expect(rawDoc!.text).toBeInstanceOf(Binary);
      expect((rawDoc!.text as Binary).sub_type).toBe(6);
    });

    it('stores content array as BinData subtype 6', async () => {
      const Message = createTestMessageModel();
      const service = getEncryptionService()!;
      // Key already exists from previous test — createKey is idempotent for the same tenant
      await service.createKey({ tenantId: 'test-at-rest' });

      const contentParts = [
        { type: 'text', text: 'Hello, how can I help you?' },
        { type: 'tool_use', id: 'tool-1', name: 'search', input: { query: 'test' } },
      ];

      const msg = await tenantStorage.run({ tenantId: 'test-at-rest' }, async () =>
        Message.create({
          messageId: 'msg-at-rest-2',
          conversationId: 'conv-1',
          user: 'user-1',
          content: contentParts,
          isCreatedByUser: false,
          tenantId: 'test-at-rest',
        }),
      );

      const collectionName = Message.collection.collectionName;
      const rawDoc = await rawClient
        .db(mongoose.connection.db!.databaseName)
        .collection(collectionName)
        .findOne({ _id: msg._id });

      expect(rawDoc).not.toBeNull();
      expect(rawDoc!.content).toBeInstanceOf(Binary);
      expect((rawDoc!.content as Binary).sub_type).toBe(6);
    });

    it('stores filepath as BinData subtype 6', async () => {
      const FileModel = createTestFileModel();
      const service = getEncryptionService()!;
      await service.createKey({ tenantId: 'test-at-rest' });

      const userId = new mongoose.Types.ObjectId();
      const file = await tenantStorage.run({ tenantId: 'test-at-rest' }, async () =>
        FileModel.create({
          user: userId,
          file_id: 'file-at-rest-1',
          filename: 'document.pdf',
          filepath: '/uploads/tenant-a/document.pdf',
          bytes: 1024,
          type: 'application/pdf',
          tenantId: 'test-at-rest',
        }),
      );

      const collectionName = FileModel.collection.collectionName;
      const rawDoc = await rawClient
        .db(mongoose.connection.db!.databaseName)
        .collection(collectionName)
        .findOne({ _id: file._id });

      expect(rawDoc).not.toBeNull();
      expect(rawDoc!.filepath).toBeInstanceOf(Binary);
      expect((rawDoc!.filepath as Binary).sub_type).toBe(6);
    });

    it('stores File.text (extracted document content) as BinData subtype 6', async () => {
      const FileModel = createTestFileModel();
      const service = getEncryptionService()!;
      await service.createKey({ tenantId: 'test-at-rest' });

      const userId = new mongoose.Types.ObjectId();
      const file = await tenantStorage.run({ tenantId: 'test-at-rest' }, async () =>
        FileModel.create({
          user: userId,
          file_id: 'file-at-rest-text',
          filename: 'meeting-notes.pdf',
          filepath: '/uploads/tenant-a/meeting-notes.pdf',
          text: 'Confidential meeting notes with sensitive financial data',
          bytes: 2048,
          type: 'application/pdf',
          tenantId: 'test-at-rest',
        }),
      );

      const collectionName = FileModel.collection.collectionName;
      const rawDoc = await rawClient
        .db(mongoose.connection.db!.databaseName)
        .collection(collectionName)
        .findOne({ _id: file._id });

      expect(rawDoc).not.toBeNull();
      expect(rawDoc!.text).toBeInstanceOf(Binary);
      expect((rawDoc!.text as Binary).sub_type).toBe(6);
      // filename should remain plaintext (not in encryptedFieldMap)
      expect(rawDoc!.filename).toBe('meeting-notes.pdf');

      // Verify auto-decrypt round-trip
      const read = await tenantStorage.run({ tenantId: 'test-at-rest' }, async () =>
        FileModel.findOne({ file_id: 'file-at-rest-text' }),
      );
      expect(read!.text).toBe('Confidential meeting notes with sensitive financial data');
    });
  });

  // =========================================================================
  // Acceptance Criterion 2: Tenant isolation holds
  // =========================================================================
  describe('2. Tenant isolation', () => {
    it('shredding one tenant key makes their data unrecoverable while other tenants are unaffected', async () => {
      const Message = createTestMessageModel();
      const service = getEncryptionService()!;

      const tenantA = { tenantId: 'iso-tenant-a' };
      const tenantB = { tenantId: 'iso-tenant-b' };

      await service.createKey(tenantA);
      await service.createKey(tenantB);

      // Write encrypted messages for both tenants
      const msgA = await tenantStorage.run(tenantA, async () =>
        Message.create({
          messageId: 'iso-msg-a',
          conversationId: 'conv-iso',
          user: 'user-a',
          text: 'secret-a',
          isCreatedByUser: true,
          tenantId: tenantA.tenantId,
        }),
      );

      const msgB = await tenantStorage.run(tenantB, async () =>
        Message.create({
          messageId: 'iso-msg-b',
          conversationId: 'conv-iso',
          user: 'user-b',
          text: 'secret-b',
          isCreatedByUser: true,
          tenantId: tenantB.tenantId,
        }),
      );

      // Both decrypt normally through app reads
      const readA = await tenantStorage.run(tenantA, async () => Message.findById(msgA._id));
      const readB = await tenantStorage.run(tenantB, async () => Message.findById(msgB._id));
      expect(readA!.text).toBe('secret-a');
      expect(readB!.text).toBe('secret-b');

      // Shred Tenant A's key
      await service.destroyKey(tenantA);

      // The existing mongoose connection caches DEKs for ~60s (libmongocrypt internal cache).
      // To prove isolation, create a FRESH MongoClient with autoEncryption that has no cache.
      const freshClient = new MongoClient(mongoServer.getUri(), {
        autoEncryption: {
          keyVaultNamespace: KEY_VAULT_NAMESPACE,
          kmsProviders,
          bypassAutoEncryption: true,
        },
      } as ConstructorParameters<typeof MongoClient>[1]);
      await freshClient.connect();

      try {
        const dbName = mongoose.connection.db!.databaseName;
        const collectionName = Message.collection.collectionName;

        // Tenant A: fresh connection can't decrypt — DEK is gone
        await expect(
          freshClient.db(dbName).collection(collectionName).findOne({ _id: msgA._id }),
        ).rejects.toThrow();

        // Tenant B: fresh connection can still decrypt (DEK exists)
        const freshReadB = await freshClient
          .db(dbName)
          .collection(collectionName)
          .findOne({ _id: msgB._id });
        expect(freshReadB!.text).toBe('secret-b');
      } finally {
        await freshClient.close();
      }
    });
    it('blocks all subsequent writes after destroyKey and does not trip circuit breaker', async () => {
      const Message = createTestMessageModel();
      const service = getEncryptionService()!;
      await service.createKey({ tenantId: 'shred-block' });

      // Pre-shred write works
      await tenantStorage.run({ tenantId: 'shred-block' }, async () =>
        Message.create({
          messageId: 'msg-pre-shred',
          conversationId: 'conv-shred',
          user: 'user-shred',
          text: 'before shredding',
          isCreatedByUser: true,
          tenantId: 'shred-block',
        }),
      );

      await service.destroyKey({ tenantId: 'shred-block' });

      // Post-shred write must throw
      await expect(
        tenantStorage.run({ tenantId: 'shred-block' }, async () =>
          Message.create({
            messageId: 'msg-post-shred',
            conversationId: 'conv-shred',
            user: 'user-shred',
            text: 'after shredding',
            isCreatedByUser: true,
            tenantId: 'shred-block',
          }),
        ),
      ).rejects.toThrow('has been shredded');

      // Circuit breaker must remain closed — shredded error is not transient
      const cb = (service as unknown as { circuitBreaker: { getState(): string } }).circuitBreaker;
      expect(cb.getState()).toBe('closed');
    });
  });

  // =========================================================================
  // Acceptance Criterion 3: Write-path hooks fire correctly
  // =========================================================================
  describe('3. Write-path hooks fire', () => {
    it('transparently encrypts on save and decrypts on read', async () => {
      const Message = createTestMessageModel();
      const service = getEncryptionService()!;
      await service.createKey({ tenantId: 'test-hooks' });

      // Write through normal Mongoose save (hooks should encrypt)
      const msg = await tenantStorage.run({ tenantId: 'test-hooks' }, async () =>
        Message.create({
          messageId: 'msg-hook-1',
          conversationId: 'conv-hook',
          user: 'user-hook',
          text: 'hook-test-value',
          content: [{ type: 'text', text: 'structured content' }],
          isCreatedByUser: true,
          tenantId: 'test-hooks',
        }),
      );

      // Verify raw document is encrypted
      const collectionName = Message.collection.collectionName;
      const rawDoc = await rawClient
        .db(mongoose.connection.db!.databaseName)
        .collection(collectionName)
        .findOne({ _id: msg._id });

      expect(rawDoc).not.toBeNull();
      expect(rawDoc!.text).toBeInstanceOf(Binary);
      expect((rawDoc!.text as Binary).sub_type).toBe(6);
      expect(rawDoc!.content).toBeInstanceOf(Binary);
      expect((rawDoc!.content as Binary).sub_type).toBe(6);

      // Read through app path: should return plaintext
      const read = await tenantStorage.run({ tenantId: 'test-hooks' }, async () =>
        Message.findById(msg._id),
      );

      expect(read!.text).toBe('hook-test-value');
      expect(read!.content).toEqual([{ type: 'text', text: 'structured content' }]);
    });

    it('skips encryption for null/undefined fields', async () => {
      const Message = createTestMessageModel();
      const service = getEncryptionService()!;
      await service.createKey({ tenantId: 'test-hooks' });

      const msg = await tenantStorage.run({ tenantId: 'test-hooks' }, async () =>
        Message.create({
          messageId: 'msg-hook-null',
          conversationId: 'conv-hook',
          user: 'user-hook',
          // text is undefined, content is undefined
          isCreatedByUser: true,
          tenantId: 'test-hooks',
        }),
      );

      const read = await tenantStorage.run({ tenantId: 'test-hooks' }, async () =>
        Message.findById(msg._id),
      );
      expect(read!.text).toBeUndefined();
      expect(read!.content).toBeUndefined();
    });

    it('skips encryption when no tenant context', async () => {
      const Message = createTestMessageModel();

      // No tenantStorage.run() wrapper — no tenant context
      const msg = await Message.create({
        messageId: 'msg-no-tenant',
        conversationId: 'conv-nt',
        user: 'user-nt',
        text: 'plaintext message',
        isCreatedByUser: true,
      });

      // Should be stored as plaintext
      const collectionName = Message.collection.collectionName;
      const rawDoc = await rawClient
        .db(mongoose.connection.db!.databaseName)
        .collection(collectionName)
        .findOne({ _id: msg._id });

      expect(rawDoc!.text).toBe('plaintext message');
    });

    it('does not re-encrypt already encrypted values', async () => {
      const Message = createTestMessageModel();
      const service = getEncryptionService()!;
      await service.createKey({ tenantId: 'test-hooks' });

      const msg = await tenantStorage.run({ tenantId: 'test-hooks' }, async () =>
        Message.create({
          messageId: 'msg-no-reenc',
          conversationId: 'conv-reenc',
          user: 'user-reenc',
          text: 'original',
          isCreatedByUser: true,
          tenantId: 'test-hooks',
        }),
      );

      // Update the message (text stays the same, only other field changes)
      await tenantStorage.run({ tenantId: 'test-hooks' }, async () => {
        const doc = await Message.findById(msg._id);
        doc!.isCreatedByUser = false;
        await doc!.save();
      });

      // Should still read correctly
      const read = await tenantStorage.run({ tenantId: 'test-hooks' }, async () =>
        Message.findById(msg._id),
      );
      expect(read!.text).toBe('original');
    });
  });

  // =========================================================================
  // Bulk operations
  // =========================================================================
  describe('encryptDocumentsForBulk', () => {
    it('pre-encrypts fields for insertMany', async () => {
      const Message = createTestMessageModel();
      const service = getEncryptionService()!;
      await service.createKey({ tenantId: 'test-bulk' });

      const docs = [
        {
          messageId: 'bulk-1',
          conversationId: 'conv-bulk',
          user: 'user-bulk',
          text: 'bulk message 1',
          isCreatedByUser: true,
          tenantId: 'test-bulk',
        },
        {
          messageId: 'bulk-2',
          conversationId: 'conv-bulk',
          user: 'user-bulk',
          text: 'bulk message 2',
          isCreatedByUser: true,
          tenantId: 'test-bulk',
        },
      ];

      await encryptDocumentsForBulk('Message', docs, 'test-bulk');

      // After pre-encryption, text values should be Binary
      for (const doc of docs) {
        expect(doc.text).toBeInstanceOf(Binary);
        expect((doc.text as unknown as Binary).sub_type).toBe(6);
      }

      // Use raw collection for bulk insert to bypass Mongoose's String type casting
      // which would convert the Binary to a garbled string. This is the correct pattern
      // for pre-encrypted bulk operations.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pre-encrypted Binary values bypass Mongoose typing
      await Message.collection.insertMany(docs as any[]);

      // Read back through the app (auto-decrypt should return plaintext)
      const read = await tenantStorage.run({ tenantId: 'test-bulk' }, async () =>
        Message.find({ conversationId: 'conv-bulk' }).sort({ messageId: 1 }),
      );

      expect(read).toHaveLength(2);
      expect(read[0].text).toBe('bulk message 1');
      expect(read[1].text).toBe('bulk message 2');
    });

    it('pre-encrypts filepath for File.bulkWrite with $set', async () => {
      const FileModel = createTestFileModel();
      const service = getEncryptionService()!;
      await service.createKey({ tenantId: 'test-bulk-files' });

      const userId = new mongoose.Types.ObjectId();
      const file = await tenantStorage.run({ tenantId: 'test-bulk-files' }, async () =>
        FileModel.create({
          user: userId,
          file_id: 'file-bulk-1',
          filename: 'report.pdf',
          filepath: '/uploads/original/report.pdf',
          bytes: 2048,
          type: 'application/pdf',
          tenantId: 'test-bulk-files',
        }),
      );

      // Simulate the batchUpdateFiles pattern: encrypt, then bulkWrite with $set
      const updates = [{ file_id: 'file-bulk-1', filepath: '/uploads/new-secret/report.pdf' }];
      await encryptDocumentsForBulk(
        'File',
        updates as Record<string, unknown>[],
        'test-bulk-files',
      );

      // filepath should now be Binary after encryptDocumentsForBulk
      expect(updates[0].filepath).toBeInstanceOf(Binary);

      // Pass through Mongoose bulkWrite with $set (same path as batchUpdateFiles)
      await FileModel.bulkWrite([
        {
          updateOne: {
            filter: { file_id: 'file-bulk-1' },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pre-encrypted Binary
            update: { $set: { filepath: updates[0].filepath } } as any,
          },
        },
      ]);

      // Verify raw storage is encrypted
      const collectionName = FileModel.collection.collectionName;
      const rawDoc = await rawClient
        .db(mongoose.connection.db!.databaseName)
        .collection(collectionName)
        .findOne({ _id: file._id });

      expect(rawDoc!.filepath).toBeInstanceOf(Binary);
      expect((rawDoc!.filepath as Binary).sub_type).toBe(6);

      // Verify app read decrypts correctly
      const read = await tenantStorage.run({ tenantId: 'test-bulk-files' }, async () =>
        FileModel.findOne({ file_id: 'file-bulk-1' }),
      );
      expect(read!.filepath).toBe('/uploads/new-secret/report.pdf');
    });
  });

  // =========================================================================
  // Update-path encryption
  // =========================================================================
  describe('4. Update-path encryption', () => {
    it('encrypts fields via findOneAndUpdate', async () => {
      const Message = createTestMessageModel();
      const service = getEncryptionService()!;
      await service.createKey({ tenantId: 'test-update' });

      // Create initial message
      const msg = await tenantStorage.run({ tenantId: 'test-update' }, async () =>
        Message.create({
          messageId: 'msg-update-1',
          conversationId: 'conv-update',
          user: 'user-update',
          text: 'original text',
          isCreatedByUser: true,
          tenantId: 'test-update',
        }),
      );

      // Update via findOneAndUpdate
      await tenantStorage.run({ tenantId: 'test-update' }, async () =>
        Message.findOneAndUpdate(
          { messageId: 'msg-update-1' },
          { text: 'updated text' },
          { new: true },
        ),
      );

      // Verify raw storage is encrypted
      const collectionName = Message.collection.collectionName;
      const rawDoc = await rawClient
        .db(mongoose.connection.db!.databaseName)
        .collection(collectionName)
        .findOne({ _id: msg._id });

      expect(rawDoc!.text).toBeInstanceOf(Binary);
      expect((rawDoc!.text as Binary).sub_type).toBe(6);

      // Verify app read returns plaintext
      const read = await tenantStorage.run({ tenantId: 'test-update' }, async () =>
        Message.findById(msg._id),
      );
      expect(read!.text).toBe('updated text');
    });

    it('encrypts fields via updateOne with $set', async () => {
      const Message = createTestMessageModel();
      const service = getEncryptionService()!;
      await service.createKey({ tenantId: 'test-update' });

      const msg = await tenantStorage.run({ tenantId: 'test-update' }, async () =>
        Message.create({
          messageId: 'msg-update-2',
          conversationId: 'conv-update',
          user: 'user-update',
          text: 'before',
          isCreatedByUser: true,
          tenantId: 'test-update',
        }),
      );

      await tenantStorage.run({ tenantId: 'test-update' }, async () =>
        Message.updateOne({ messageId: 'msg-update-2' }, { $set: { text: 'after' } }),
      );

      const collectionName = Message.collection.collectionName;
      const rawDoc = await rawClient
        .db(mongoose.connection.db!.databaseName)
        .collection(collectionName)
        .findOne({ _id: msg._id });

      expect(rawDoc!.text).toBeInstanceOf(Binary);
      expect((rawDoc!.text as Binary).sub_type).toBe(6);

      const read = await tenantStorage.run({ tenantId: 'test-update' }, async () =>
        Message.findById(msg._id),
      );
      expect(read!.text).toBe('after');
    });

    it('encrypts fields via updateOne without explicit $set (implicit wrapping)', async () => {
      const Message = createTestMessageModel();
      const service = getEncryptionService()!;
      await service.createKey({ tenantId: 'test-update' });

      const msg = await tenantStorage.run({ tenantId: 'test-update' }, async () =>
        Message.create({
          messageId: 'msg-update-implicit',
          conversationId: 'conv-update',
          user: 'user-update',
          text: 'before-implicit',
          isCreatedByUser: true,
          tenantId: 'test-update',
        }),
      );

      // No $set — Mongoose wraps this internally
      await tenantStorage.run({ tenantId: 'test-update' }, async () =>
        Message.updateOne({ messageId: 'msg-update-implicit' }, { text: 'after-implicit' }),
      );

      const collectionName = Message.collection.collectionName;
      const rawDoc = await rawClient
        .db(mongoose.connection.db!.databaseName)
        .collection(collectionName)
        .findOne({ _id: msg._id });

      expect(rawDoc!.text).toBeInstanceOf(Binary);
      expect((rawDoc!.text as Binary).sub_type).toBe(6);

      const read = await tenantStorage.run({ tenantId: 'test-update' }, async () =>
        Message.findById(msg._id),
      );
      expect(read!.text).toBe('after-implicit');
    });

    it('blocks updateMany on encrypted fields to prevent identical ciphertext', async () => {
      const Message = createTestMessageModel();
      const service = getEncryptionService()!;
      await service.createKey({ tenantId: 'test-update' });

      await tenantStorage.run({ tenantId: 'test-update' }, async () =>
        Message.create({
          messageId: 'msg-um-block',
          conversationId: 'conv-update-many',
          user: 'user-update',
          text: 'original',
          isCreatedByUser: true,
          tenantId: 'test-update',
        }),
      );

      // updateMany on an encrypted field must throw
      await expect(
        tenantStorage.run({ tenantId: 'test-update' }, async () =>
          Message.updateMany(
            { conversationId: 'conv-update-many' },
            { $set: { text: 'bulk-updated' } },
          ),
        ),
      ).rejects.toThrow('updateMany on encrypted field');
    });

    it('allows updateMany on non-encrypted fields', async () => {
      const Message = createTestMessageModel();
      const service = getEncryptionService()!;
      await service.createKey({ tenantId: 'test-update' });

      await tenantStorage.run({ tenantId: 'test-update' }, async () =>
        Message.create({
          messageId: 'msg-um-ok',
          conversationId: 'conv-um-nonenc',
          user: 'user-update',
          text: 'stays',
          isCreatedByUser: true,
          tenantId: 'test-update',
        }),
      );

      // updateMany on a non-encrypted field should succeed
      await tenantStorage.run({ tenantId: 'test-update' }, async () =>
        Message.updateMany(
          { conversationId: 'conv-um-nonenc' },
          { $set: { isCreatedByUser: false } },
        ),
      );

      const read = await tenantStorage.run({ tenantId: 'test-update' }, async () =>
        Message.findOne({ messageId: 'msg-um-ok' }),
      );
      expect(read!.isCreatedByUser).toBe(false);
    });

    it('rejects aggregation-pipeline updates on encrypted models', async () => {
      const Message = createTestMessageModel();
      const service = getEncryptionService()!;
      await service.createKey({ tenantId: 'test-update' });

      await tenantStorage.run({ tenantId: 'test-update' }, async () =>
        Message.create({
          messageId: 'msg-pipeline',
          conversationId: 'conv-pipeline',
          user: 'user-update',
          text: 'original',
          isCreatedByUser: true,
          tenantId: 'test-update',
        }),
      );

      // Pipeline-style update ([{ $set: ... }]) must be rejected
      await expect(
        tenantStorage.run({ tenantId: 'test-update' }, async () =>
          Message.updateOne({ messageId: 'msg-pipeline' }, [
            { $set: { text: 'pipeline-plaintext' } },
          ] as unknown as Record<string, unknown>),
        ),
      ).rejects.toThrow('Aggregation-pipeline updates');

      // updateMany pipeline also rejected
      await expect(
        tenantStorage.run({ tenantId: 'test-update' }, async () =>
          Message.updateMany({ conversationId: 'conv-pipeline' }, [
            { $set: { text: 'pipeline-plaintext' } },
          ] as unknown as Record<string, unknown>),
        ),
      ).rejects.toThrow('Aggregation-pipeline updates');
    });
  });

  // =========================================================================
  // encryptBatch
  // =========================================================================
  describe('5. encryptBatch', () => {
    it('encrypts multiple values for the same tenant', async () => {
      const service = getEncryptionService()!;
      await service.createKey({ tenantId: 'test-batch' });

      const values = ['secret-1', 'secret-2', 'secret-3'];
      const encrypted = await service.encryptBatch(values, { tenantId: 'test-batch' });

      expect(encrypted).toHaveLength(3);
      for (const enc of encrypted) {
        expect(enc).toBeInstanceOf(Binary);
        expect(enc.sub_type).toBe(6);
      }

      // Each encryption should produce different ciphertext (randomized)
      const hexes = encrypted.map((e) => e.toString('hex'));
      expect(new Set(hexes).size).toBe(3);
    });
  });

  // =========================================================================
  // Circuit breaker fail-closed behavior
  // =========================================================================
  describe('6. Circuit breaker fail-closed', () => {
    it('rejects writes with KmsUnavailableError when circuit is open — no plaintext fallback', async () => {
      // KmsUnavailableError imported at top of file
      const Message = createTestMessageModel();
      const service = getEncryptionService()!;
      await service.createKey({ tenantId: 'test-cb-closed' });

      // Force the circuit breaker open via the service's internal circuit breaker.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private field for test setup
      const cb = (service as any)['circuitBreaker'];
      for (let i = 0; i < 5; i++) {
        cb.recordFailure();
      }
      expect(cb.getState()).toBe('open');

      // Attempt a write — must fail with KmsUnavailableError, not write plaintext
      await expect(
        tenantStorage.run({ tenantId: 'test-cb-closed' }, () =>
          Message.create({
            messageId: 'cb-fail-closed',
            conversationId: 'conv-cb',
            user: 'user-cb',
            text: 'must-not-be-stored-as-plaintext',
            isCreatedByUser: true,
            tenantId: 'test-cb-closed',
          }),
        ),
      ).rejects.toThrow(KmsUnavailableError);

      // Verify nothing was written to the database
      const collectionName = Message.collection.collectionName;
      const rawDoc = await rawClient
        .db(mongoose.connection.db!.databaseName)
        .collection(collectionName)
        .findOne({ messageId: 'cb-fail-closed' });
      expect(rawDoc).toBeNull();

      // Reset for other tests
      cb.recordSuccess();
    });
  });
});
