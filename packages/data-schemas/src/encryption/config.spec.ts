import { keyAltNameForTenant, getEncryptionConfig, _clearEncryptionConfigCache } from './config';

describe('keyAltNameForTenant', () => {
  it('prefixes with "tenant:"', () => {
    expect(keyAltNameForTenant('org-123')).toBe('tenant:org-123');
  });
});

describe('getEncryptionConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    _clearEncryptionConfigCache();
    process.env = { ...originalEnv };
    delete process.env.ENCRYPTION_PROVIDER;
    delete process.env.ENCRYPTION_LOCAL_KEY;
    delete process.env.AWS_KMS_ACCESS_KEY_ID;
    delete process.env.AWS_KMS_SECRET_ACCESS_KEY;
    delete process.env.AWS_KMS_REGION;
    delete process.env.AWS_KMS_KEY_ARN;
    delete process.env.AWS_KMS_SESSION_TOKEN;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns null when ENCRYPTION_PROVIDER is not set', () => {
    expect(getEncryptionConfig()).toBeNull();
  });

  it('returns local config with valid key', () => {
    const key96 = Buffer.alloc(96, 0xab);
    process.env.ENCRYPTION_PROVIDER = 'local';
    process.env.ENCRYPTION_LOCAL_KEY = key96.toString('base64');

    const config = getEncryptionConfig()!;
    expect(config.provider).toBe('local');
    expect(config.keyVaultNamespace).toBe('encryption.__keyVault');
    expect(config.kmsProviders).toHaveProperty('local');
  });

  it('throws if local key is missing', () => {
    process.env.ENCRYPTION_PROVIDER = 'local';
    expect(() => getEncryptionConfig()).toThrow('ENCRYPTION_LOCAL_KEY');
  });

  it('throws if local key is wrong length', () => {
    process.env.ENCRYPTION_PROVIDER = 'local';
    process.env.ENCRYPTION_LOCAL_KEY = Buffer.alloc(32).toString('base64');
    expect(() => getEncryptionConfig()).toThrow('96 bytes');
  });

  it('returns aws config with all required vars', () => {
    process.env.ENCRYPTION_PROVIDER = 'aws';
    process.env.AWS_KMS_ACCESS_KEY_ID = 'AKIA...';
    process.env.AWS_KMS_SECRET_ACCESS_KEY = 'secret';
    process.env.AWS_KMS_REGION = 'us-east-1';
    process.env.AWS_KMS_KEY_ARN = 'arn:aws:kms:us-east-1:123:key/abc';

    const config = getEncryptionConfig()!;
    expect(config.provider).toBe('aws');
    if (config.provider === 'aws') {
      expect(config.awsKeyArn).toBe('arn:aws:kms:us-east-1:123:key/abc');
      expect(config.awsRegion).toBe('us-east-1');
    }
  });

  it('returns aws config with empty credentials for IAM role / default credential chain', () => {
    process.env.ENCRYPTION_PROVIDER = 'aws';
    process.env.AWS_KMS_REGION = 'us-east-1';
    process.env.AWS_KMS_KEY_ARN = 'arn:aws:kms:us-east-1:123:key/abc';
    // No ACCESS_KEY_ID or SECRET_ACCESS_KEY → driver uses default credential chain

    const config = getEncryptionConfig()!;
    expect(config.provider).toBe('aws');
    expect(config.kmsProviders).toEqual({ aws: {} });
  });

  it('includes sessionToken when AWS_KMS_SESSION_TOKEN is set', () => {
    process.env.ENCRYPTION_PROVIDER = 'aws';
    process.env.AWS_KMS_ACCESS_KEY_ID = 'AKIA...';
    process.env.AWS_KMS_SECRET_ACCESS_KEY = 'secret';
    process.env.AWS_KMS_SESSION_TOKEN = 'FwoGZX...';
    process.env.AWS_KMS_REGION = 'us-east-1';
    process.env.AWS_KMS_KEY_ARN = 'arn:aws:kms:us-east-1:123:key/abc';

    const config = getEncryptionConfig()!;
    expect(config.kmsProviders).toEqual({
      aws: { accessKeyId: 'AKIA...', secretAccessKey: 'secret', sessionToken: 'FwoGZX...' },
    });
  });

  it('throws if only one of accessKeyId / secretAccessKey is provided', () => {
    process.env.ENCRYPTION_PROVIDER = 'aws';
    process.env.AWS_KMS_ACCESS_KEY_ID = 'AKIA...';
    process.env.AWS_KMS_REGION = 'us-east-1';
    process.env.AWS_KMS_KEY_ARN = 'arn:aws:kms:us-east-1:123:key/abc';
    expect(() => getEncryptionConfig()).toThrow('provide both');
  });

  it('throws if aws region or key ARN are missing', () => {
    process.env.ENCRYPTION_PROVIDER = 'aws';
    expect(() => getEncryptionConfig()).toThrow('AWS_KMS_REGION');
  });

  it('throws for unknown provider', () => {
    process.env.ENCRYPTION_PROVIDER = 'gcp';
    expect(() => getEncryptionConfig()).toThrow('Unknown ENCRYPTION_PROVIDER');
  });
});
