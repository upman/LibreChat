// Types
export type {
  EncryptionContext,
  IEncryptionService,
  EncryptedFieldMap,
  EncryptionConfig,
} from './types';
export { KmsUnavailableError } from './types';

// Configuration
export {
  encryptedFieldMap,
  getEncryptionConfig,
  keyAltNameForTenant,
  KEY_VAULT_NAMESPACE,
  KEY_VAULT_DB,
  KEY_VAULT_COLLECTION,
  ALGORITHM_RANDOM,
} from './config';

// Service
export { getEncryptionService, initializeEncryptionService } from './service';

// Mongoose plugin
export { applyEncryption, encryptDocumentsForBulk } from './plugin';

// Bootstrap
export { getAutoEncryptionOptions, bootstrapEncryption } from './bootstrap';
