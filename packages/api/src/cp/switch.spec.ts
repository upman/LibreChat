const mockRunAsTenant = jest.fn((_tenantId: string, fn: () => Promise<unknown>) => fn());
const mockRunAsSystem = jest.fn((fn: () => Promise<unknown>) => fn());

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  runAsTenant: (tenantId: string, fn: () => Promise<unknown>) => mockRunAsTenant(tenantId, fn),
  runAsSystem: (fn: () => Promise<unknown>) => mockRunAsSystem(fn),
  getEncryptionService: () => null,
}));

jest.mock('~/app/config', () => ({
  getBalanceConfig: jest.fn().mockReturnValue(null),
}));

import { Types } from 'mongoose';
import { switchOrg, isSwitchError } from './switch';
import { _resetProvisioningState } from './provision';

import type { IUser } from '@librechat/data-schemas';
import type { ProvisionDeps } from './provision';
import type { UserMethods } from './user';
import type { ResolvedCpContext, ChcSessionDetails } from './types';

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

function buildProvisionDeps(): ProvisionDeps {
  return {
    initializeRoles: jest.fn().mockResolvedValue(undefined),
    seedDefaultRoles: jest.fn().mockResolvedValue(undefined),
    ensureDefaultCategories: jest.fn().mockResolvedValue(true),
    seedSystemGrants: jest.fn().mockResolvedValue(undefined),
  };
}

function buildUserMethods(overrides: Partial<UserMethods> = {}): UserMethods {
  return {
    findUser: jest.fn().mockResolvedValue(null),
    findUsers: jest.fn().mockResolvedValue([]),
    createUser: jest.fn().mockResolvedValue(buildUser()),
    updateUser: jest.fn().mockResolvedValue(buildUser()),
    ...overrides,
  };
}

function buildCpContext(overrides: Partial<ResolvedCpContext> = {}): ResolvedCpContext {
  return {
    cpUserId: 'chc-1',
    email: 'user@example.com',
    name: 'Test User',
    eligibleOrgIds: ['org-target'],
    adminOrgIds: [],
    resolvedAt: Date.now(),
    chcSessionDetails: {
      organizations: {
        'org-target': {
          id: 'org-target',
          name: 'Target Org',
          users: {},
          tier: 'PRODUCTION',
          roleV2Migrated: true,
        },
      },
      orgFeatures: {
        'org-target': ['FT_ORG_LIBRECHAT'],
      },
      orgRolesV2: {
        'org-target': [],
      },
    } as ChcSessionDetails,
    instances: {},
    ...overrides,
  };
}

describe('switchOrg', () => {
  beforeEach(() => {
    _resetProvisioningState();
    mockRunAsTenant.mockClear();
    mockRunAsTenant.mockImplementation((_tenantId: string, fn: () => Promise<unknown>) => fn());
  });

  it('returns ORG_NOT_ELIGIBLE when org lacks FT_ORG_LIBRECHAT', async () => {
    const ctx = buildCpContext({
      chcSessionDetails: {
        organizations: {},
        orgFeatures: { 'org-target': ['FT_OTHER'] },
        orgRolesV2: {},
      } as ChcSessionDetails,
    });

    const result = await switchOrg(buildUser(), 'org-target', {
      provision: buildProvisionDeps(),
      user: buildUserMethods(),
      freshContext: ctx,
    });

    expect(isSwitchError(result)).toBe(true);
    if (isSwitchError(result)) {
      expect(result.errorCode).toBe('ORG_NOT_ELIGIBLE');
    }
  });

  it('returns CP_IDENTITY_MISSING when user has no idOnTheSource', async () => {
    const user = buildUser({ idOnTheSource: undefined });

    const result = await switchOrg(user, 'org-target', {
      provision: buildProvisionDeps(),
      user: buildUserMethods(),
      freshContext: buildCpContext(),
    });

    expect(isSwitchError(result)).toBe(true);
    if (isSwitchError(result)) {
      expect(result.errorCode).toBe('CP_IDENTITY_MISSING');
    }
  });

  it('returns GUSD_UNAVAILABLE when freshContext is undefined', async () => {
    const result = await switchOrg(buildUser(), 'org-target', {
      provision: buildProvisionDeps(),
      user: buildUserMethods(),
      freshContext: undefined as unknown as ResolvedCpContext,
    });

    expect(isSwitchError(result)).toBe(true);
    if (isSwitchError(result)) {
      expect(result.errorCode).toBe('GUSD_UNAVAILABLE');
    }
  });

  it('returns OPENID_IDENTITY_MISSING when user has no openidId', async () => {
    const user = buildUser({ openidId: undefined });

    const result = await switchOrg(user, 'org-target', {
      provision: buildProvisionDeps(),
      user: buildUserMethods(),
      freshContext: buildCpContext(),
    });

    expect(isSwitchError(result)).toBe(true);
    if (isSwitchError(result)) {
      expect(result.errorCode).toBe('OPENID_IDENTITY_MISSING');
    }
  });

  it('provisions tenant, creates user, and returns correct role on success', async () => {
    const tenantUser = buildUser({ role: 'ADMIN' });
    const provisionDeps = buildProvisionDeps();
    const userMethods = buildUserMethods({
      findUser: jest.fn().mockResolvedValue(null),
      createUser: jest.fn().mockResolvedValue(tenantUser),
    });
    const ctx = buildCpContext({ adminOrgIds: ['org-target'] });

    const result = await switchOrg(buildUser(), 'org-target', {
      provision: provisionDeps,
      user: userMethods,
      freshContext: ctx,
    });

    expect(isSwitchError(result)).toBe(false);
    if (!isSwitchError(result)) {
      expect(result.tenantId).toBe('org-target');
      expect(result.role).toBe('ADMIN');
      expect(result.tenantUser).toBe(tenantUser);
    }
    expect(provisionDeps.initializeRoles).toHaveBeenCalled();
  });
});
