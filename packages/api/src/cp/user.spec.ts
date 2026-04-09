const mockRunAsTenant = jest.fn((_tenantId: string, fn: () => Promise<unknown>) => fn());
const mockRunAsSystem = jest.fn((fn: () => Promise<unknown>) => fn());

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  runAsTenant: (tenantId: string, fn: () => Promise<unknown>) => mockRunAsTenant(tenantId, fn),
  runAsSystem: (fn: () => Promise<unknown>) => mockRunAsSystem(fn),
}));

jest.mock('~/app/config', () => ({
  getBalanceConfig: jest.fn().mockReturnValue(null),
}));

import { Types } from 'mongoose';
import { findOrCreateTenantUser, findLastTenantForCpUser, buildTenantUserInput } from './user';

import type { IUser } from '@librechat/data-schemas';
import type { UserMethods, TenantUserInput } from './user';
import type { ResolvedCpContext } from './types';

function stubObjectId(hex = 'aaaaaaaaaaaaaaaaaaaaaaaa'): Types.ObjectId {
  return new Types.ObjectId(hex);
}

function buildUser(overrides: Partial<IUser> = {}): IUser {
  return {
    _id: stubObjectId(),
    email: 'user@example.com',
    emailVerified: true,
    provider: 'openid',
    role: 'USER',
    idOnTheSource: 'chc-1',
    openidId: 'oid-1',
    name: 'Test User',
    ...overrides,
  } as IUser;
}

function buildInput(overrides: Partial<TenantUserInput> = {}): TenantUserInput {
  return {
    cpUserId: 'chc-1',
    email: 'user@example.com',
    name: 'Test User',
    openidId: 'oid-1',
    tenantId: 'tenant-1',
    role: 'USER',
    resolvedAt: new Date(),
    ...overrides,
  };
}

function buildMethods(overrides: Partial<UserMethods> = {}): UserMethods {
  return {
    findUser: jest.fn().mockResolvedValue(null),
    findUsers: jest.fn().mockResolvedValue([]),
    createUser: jest.fn().mockResolvedValue(buildUser()),
    updateUser: jest.fn().mockResolvedValue(buildUser()),
    ...overrides,
  };
}

describe('findOrCreateTenantUser', () => {
  beforeEach(() => {
    mockRunAsTenant.mockClear();
    mockRunAsTenant.mockImplementation((_tenantId: string, fn: () => Promise<unknown>) => fn());
  });

  it('finds existing user by idOnTheSource and updates with openidId', async () => {
    const existing = buildUser({ openidId: undefined });
    const updated = buildUser({ openidId: 'oid-1' });
    const methods = buildMethods({
      findUser: jest.fn().mockResolvedValue(existing),
      updateUser: jest.fn().mockResolvedValue(updated),
    });

    const result = await findOrCreateTenantUser(buildInput(), methods);

    expect(result.openidId).toBe('oid-1');
    expect(mockRunAsTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
    expect(methods.updateUser).toHaveBeenCalledWith(
      existing._id.toString(),
      expect.objectContaining({ openidId: 'oid-1' }),
    );
    expect(methods.createUser).not.toHaveBeenCalled();
  });

  it('finds existing user by email fallback when provider is openid', async () => {
    const existing = buildUser({ idOnTheSource: undefined, provider: 'openid' });
    const methods = buildMethods({
      findUser: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(existing),
      updateUser: jest.fn().mockResolvedValue(existing),
    });

    const result = await findOrCreateTenantUser(buildInput(), methods);

    expect(result).toEqual(existing);
    expect(methods.findUser).toHaveBeenCalledTimes(2);
    expect((methods.findUser as jest.Mock).mock.calls[0][0]).toEqual({ idOnTheSource: 'chc-1' });
    expect((methods.findUser as jest.Mock).mock.calls[1][0]).toEqual({ email: 'user@example.com' });
    expect(methods.updateUser).toHaveBeenCalledWith(
      existing._id.toString(),
      expect.objectContaining({ idOnTheSource: 'chc-1' }),
    );
  });

  it('skips email fallback when matched user has non-openid provider', async () => {
    const localUser = buildUser({ idOnTheSource: undefined, provider: 'local' });
    const created = buildUser();
    const methods = buildMethods({
      findUser: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(localUser),
      createUser: jest.fn().mockResolvedValue(created),
    });

    const result = await findOrCreateTenantUser(buildInput(), methods);

    expect(result).toBe(created);
    expect(methods.createUser).toHaveBeenCalled();
  });

  it('skips email fallback when email-matched user belongs to a different CP identity', async () => {
    const otherCpUser = buildUser({ idOnTheSource: 'chc-OTHER', provider: 'openid' });
    const created = buildUser();
    const methods = buildMethods({
      findUser: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(otherCpUser),
      createUser: jest.fn().mockResolvedValue(created),
    });

    const result = await findOrCreateTenantUser(buildInput(), methods);

    expect(result).toEqual(created);
    expect(methods.createUser).toHaveBeenCalled();
    expect(methods.updateUser).not.toHaveBeenCalled();
  });

  it('skips email fallback when email-matched user has a different openidId', async () => {
    const otherOidUser = buildUser({
      openidId: 'oid-OTHER',
      provider: 'openid',
      idOnTheSource: undefined,
    });
    const created = buildUser();
    const methods = buildMethods({
      findUser: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(otherOidUser),
      createUser: jest.fn().mockResolvedValue(created),
    });

    const result = await findOrCreateTenantUser(buildInput(), methods);

    expect(result).toEqual(created);
    expect(methods.createUser).toHaveBeenCalled();
  });

  it('creates new user when none found', async () => {
    const created = buildUser();
    const methods = buildMethods({
      findUser: jest.fn().mockResolvedValue(null),
      createUser: jest.fn().mockResolvedValue(created),
    });

    const result = await findOrCreateTenantUser(buildInput(), methods);

    expect(result).toBe(created);
    expect(methods.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openid',
        email: 'user@example.com',
        idOnTheSource: 'chc-1',
      }),
      null,
      true,
      true,
    );
  });

  it('handles E11000 catch-and-retry returning existing user', async () => {
    const existing = buildUser();
    const e11000 = Object.assign(new Error('duplicate key'), { code: 11000 });
    const methods = buildMethods({
      findUser: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existing),
      createUser: jest.fn().mockRejectedValue(e11000),
    });

    const result = await findOrCreateTenantUser(buildInput(), methods);

    expect(result).toEqual(existing);
    expect(methods.findUser).toHaveBeenCalledTimes(3);
    expect((methods.findUser as jest.Mock).mock.calls[2][0]).toEqual({ idOnTheSource: 'chc-1' });
    expect(methods.createUser).toHaveBeenCalledTimes(1);
  });
});

describe('buildTenantUserInput', () => {
  function buildCpContext(overrides: Partial<ResolvedCpContext> = {}): ResolvedCpContext {
    return {
      cpUserId: 'chc-1',
      email: 'user@example.com',
      name: 'Test User',
      eligibleOrgIds: ['tenant-1', 'tenant-2'],
      adminOrgIds: [],
      resolvedAt: Date.now(),
      chcSessionDetails: {
        organizations: {
          'tenant-1': {
            id: 'tenant-1',
            name: 'Org 1',
            users: {},
            tier: 'PRODUCTION',
            roleV2Migrated: true,
          },
          'tenant-2': {
            id: 'tenant-2',
            name: 'Org 2',
            users: {},
            tier: 'PRODUCTION',
            roleV2Migrated: true,
          },
        },
        orgFeatures: {
          'tenant-1': ['FT_ORG_LIBRECHAT'],
          'tenant-2': ['FT_ORG_LIBRECHAT'],
        },
        orgRolesV2: {
          'tenant-1': [],
          'tenant-2': [],
        },
      },
      instances: {},
      ...overrides,
    };
  }

  it('assigns ADMIN role when adminOrgIds includes tenantId', () => {
    const ctx = buildCpContext({ adminOrgIds: ['tenant-1'] });

    const result = buildTenantUserInput(ctx, 'tenant-1', 'oid-1');

    expect(result.role).toBe('ADMIN');
  });

  it('assigns USER role when not admin', () => {
    const ctx = buildCpContext({ adminOrgIds: [] });

    const result = buildTenantUserInput(ctx, 'tenant-1', 'oid-1');

    expect(result.role).toBe('USER');
  });

  it('returns complete TenantUserInput shape without chcSessionDetails', () => {
    const ctx = buildCpContext({ adminOrgIds: ['tenant-1'] });

    const result = buildTenantUserInput(ctx, 'tenant-1', 'oid-1');

    expect(result).toMatchObject({
      cpUserId: 'chc-1',
      openidId: 'oid-1',
      tenantId: 'tenant-1',
      role: 'ADMIN',
      email: 'user@example.com',
      name: 'Test User',
    });
    expect(result.resolvedAt).toBeInstanceOf(Date);
    expect(result).not.toHaveProperty('chcSessionDetails');
  });
});

describe('findLastTenantForCpUser', () => {
  beforeEach(() => {
    mockRunAsSystem.mockClear();
    mockRunAsSystem.mockImplementation((fn: () => Promise<unknown>) => fn());
  });

  it('returns lastTenantId from most recently updated doc', async () => {
    const findUsers = jest
      .fn()
      .mockResolvedValue([{ lastTenantId: 'tenant-2', updatedAt: new Date('2025-01-02') }]);

    const result = await findLastTenantForCpUser('chc-1', findUsers);

    expect(result).toBe('tenant-2');
    expect(findUsers).toHaveBeenCalledWith({ idOnTheSource: 'chc-1' }, 'lastTenantId updatedAt', {
      sort: { updatedAt: -1 },
      limit: 1,
    });
  });

  it('returns undefined when no docs found', async () => {
    const findUsers = jest.fn().mockResolvedValue([]);

    const result = await findLastTenantForCpUser('chc-1', findUsers);

    expect(result).toBeUndefined();
  });
});
