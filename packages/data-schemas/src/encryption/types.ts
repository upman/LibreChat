import type { AutoEncryptionOptions, Binary } from 'mongodb';

export interface EncryptionContext {
  tenantId: string;
}

export interface IEncryptionService {
  encrypt(value: unknown, context: EncryptionContext): Promise<Binary>;
  encryptBatch(values: unknown[], context: EncryptionContext): Promise<Binary[]>;
  createKey(context: EncryptionContext): Promise<void>;
  destroyKey(context: EncryptionContext): Promise<void>;
  isEnabled(): boolean;
}

/** Use {@link ALGORITHM_RANDOM} from config.ts as the value. */
export type CSFLEAlgorithm = 'AEAD_AES_256_CBC_HMAC_SHA_512-Random';

export interface EncryptedFieldConfig {
  algorithm: CSFLEAlgorithm;
}

export type EncryptedFieldMap = Record<string, Record<string, EncryptedFieldConfig>>;

interface BaseEncryptionConfig {
  keyVaultNamespace: string;
  kmsProviders: NonNullable<AutoEncryptionOptions['kmsProviders']>;
}

export type EncryptionConfig =
  | (BaseEncryptionConfig & { provider: 'local' })
  | (BaseEncryptionConfig & {
      provider: 'aws';
      awsKeyArn: string;
      awsRegion: string;
      awsKmsEndpoint?: string;
      awsTlsCAFile?: string;
    });

export class KmsUnavailableError extends Error {
  constructor(message = 'Encryption service is temporarily unavailable (KMS unreachable)') {
    super(message);
    this.name = 'KmsUnavailableError';
  }
}
