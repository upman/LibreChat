const mockRunAsTenant = jest.fn((_tenantId: string, fn: () => Promise<unknown>) => fn());
const mockRunAsSystem = jest.fn((fn: () => Promise<unknown>) => fn());

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  runAsTenant: (tenantId: string, fn: () => Promise<unknown>) => mockRunAsTenant(tenantId, fn),
  runAsSystem: (fn: () => Promise<unknown>) => mockRunAsSystem(fn),
}));

jest.mock('./client');
jest.mock('./resolve');
jest.mock('./tenant');
jest.mock('./provision');
jest.mock('./cache');
jest.mock('./user');

import { handleChcLogin, isChcLoginError } from './login';
import { fetchUserSessionDetails } from './client';
import { resolveGUSD } from './resolve';
import { resolveTenant } from './tenant';
import { provisionTenant } from './provision';
import { setCachedGUSD } from './cache';
import { findOrCreateTenantUser, findLastTenantForCpUser, buildTenantUserInput } from './user';

import type { IUser } from '@librechat/data-schemas';
import type { ChcLoginInput, ChcLoginResult, ChcLoginError } from './login';
import type { ResolvedCpContext, GUSDResponse, TenantResolutionResult } from './types';
import type { TenantUserInput } from './user';
import type { ProvisionDeps } from './provision';

const mockFetchUserSessionDetails = fetchUserSessionDetails as jest.MockedFunction<
  typeof fetchUserSessionDetails
>;
const mockResolveGUSD = resolveGUSD as jest.MockedFunction<typeof resolveGUSD>;
const mockResolveTenant = resolveTenant as jest.MockedFunction<typeof resolveTenant>;
const mockProvisionTenant = provisionTenant as jest.MockedFunction<typeof provisionTenant>;
const mockSetCachedGUSD = setCachedGUSD as jest.MockedFunction<typeof setCachedGUSD>;
const mockFindOrCreateTenantUser = findOrCreateTenantUser as jest.MockedFunction<
  typeof findOrCreateTenantUser
>;
const mockFindLastTenantForCpUser = findLastTenantForCpUser as jest.MockedFunction<
  typeof findLastTenantForCpUser
>;
const mockBuildTenantUserInput = buildTenantUserInput as jest.MockedFunction<
  typeof buildTenantUserInput
>;

function buildUser(overrides: Partial<IUser> = {}): IUser {
  return {
    _id: 'user-123',
    email: 'user@example.com',
    name: 'Test User',
    role: 'USER',
    provider: 'openid',
    tenantId: 'org-1',
    lastTenantId: 'org-1',
    idOnTheSource: 'chc-1',
    ...overrides,
  } as unknown as IUser;
}

function buildCpContext(overrides: Partial<ResolvedCpContext> = {}): ResolvedCpContext {
  return {
    cpUserId: 'chc-1',
    email: 'user@example.com',
    name: 'Test User',
    chcSessionDetails: { organizations: {}, orgFeatures: {}, orgRolesV2: {} },
    eligibleOrgIds: ['org-1'],
    adminOrgIds: [],
    resolvedAt: Date.now(),
    ...overrides,
  } as ResolvedCpContext;
}

function buildGUSDResponse(): GUSDResponse {
  return {
    userId: 'chc-1',
    name: 'Test User',
    email: 'user@example.com',
    userFeatures: [],
    orgFeatures: { 'org-1': ['FT_ORG_LIBRECHAT'] },
    orgRoles: {},
    orgRolesV2: {},
    organizations: {},
    instances: {},
    roleMappings: [],
    pendingActions: [],
    dashboardRolesV2: [],
  };
}

function buildProvisionDeps(): ProvisionDeps {
  return {
    initializeRoles: jest.fn().mockResolvedValue(undefined),
    seedDefaultRoles: jest.fn().mockResolvedValue(undefined),
    ensureDefaultCategories: jest.fn().mockResolvedValue(true),
    seedSystemGrants: jest.fn().mockResolvedValue(undefined),
  };
}

function buildTenantUserInputFixture(): TenantUserInput {
  return {
    cpUserId: 'chc-1',
    email: 'user@example.com',
    name: 'Test User',
    openidId: 'openid-abc',
    tenantId: 'org-1',
    role: 'USER',
    resolvedAt: new Date(),
  };
}

function buildLoginInput(overrides: Partial<ChcLoginInput> = {}): ChcLoginInput {
  return {
    cpAccessToken: 'access-token',
    openidId: 'openid-abc',
    provisionDeps: buildProvisionDeps(),
    userMethods: {
      findUser: jest.fn().mockResolvedValue(null),
      findUsers: jest.fn().mockResolvedValue([]),
      createUser: jest.fn().mockResolvedValue(buildUser()),
      updateUser: jest.fn().mockResolvedValue(buildUser()),
    },
    ...overrides,
  };
}

describe('handleChcLogin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('successful flow: returns ChcLoginResult with tenantUser and tenantId', async () => {
    const gusdResponse = buildGUSDResponse();
    const cpContext = buildCpContext();
    const user = buildUser();
    const tenantUserInput = buildTenantUserInputFixture();

    mockFetchUserSessionDetails.mockResolvedValue(gusdResponse);
    mockResolveGUSD.mockReturnValue(cpContext);
    mockFindLastTenantForCpUser.mockResolvedValue('org-1');
    mockResolveTenant.mockReturnValue({ tenantId: 'org-1' } as TenantResolutionResult);
    mockProvisionTenant.mockResolvedValue(undefined);
    mockBuildTenantUserInput.mockReturnValue(tenantUserInput);
    mockFindOrCreateTenantUser.mockResolvedValue(user);

    const input = buildLoginInput();
    const result = await handleChcLogin(input);

    expect(isChcLoginError(result)).toBe(false);
    const success = result as ChcLoginResult;
    expect(success.tenantUser).toBe(user);
    expect(success.tenantId).toBe('org-1');

    expect(mockFetchUserSessionDetails).toHaveBeenCalledWith('access-token');
    expect(mockResolveGUSD).toHaveBeenCalledWith(gusdResponse);
    expect(mockProvisionTenant).toHaveBeenCalledWith('org-1', input.provisionDeps);
    expect(mockBuildTenantUserInput).toHaveBeenCalledWith(cpContext, 'org-1', 'openid-abc');
  });

  it('primes GUSD cache after successful fetch', async () => {
    const cpContext = buildCpContext();
    mockFetchUserSessionDetails.mockResolvedValue(buildGUSDResponse());
    mockResolveGUSD.mockReturnValue(cpContext);
    mockFindLastTenantForCpUser.mockResolvedValue(undefined);
    mockResolveTenant.mockReturnValue({ tenantId: 'org-1' } as TenantResolutionResult);
    mockProvisionTenant.mockResolvedValue(undefined);
    mockBuildTenantUserInput.mockReturnValue(buildTenantUserInputFixture());
    mockFindOrCreateTenantUser.mockResolvedValue(buildUser());

    await handleChcLogin(buildLoginInput());

    expect(mockSetCachedGUSD).toHaveBeenCalledWith('chc-1', cpContext);
  });

  it('returns no_eligible_org error when no eligible orgs', async () => {
    const cpContext = buildCpContext({ eligibleOrgIds: [] });
    mockFetchUserSessionDetails.mockResolvedValue(buildGUSDResponse());
    mockResolveGUSD.mockReturnValue(cpContext);
    mockFindLastTenantForCpUser.mockResolvedValue(undefined);
    mockResolveTenant.mockReturnValue({
      tenantId: null,
      error: 'LibreChat is not enabled for any of your organizations',
    } as TenantResolutionResult);

    const result = await handleChcLogin(buildLoginInput());

    expect(isChcLoginError(result)).toBe(true);
    const error = result as ChcLoginError;
    expect(error.errorCode).toBe('no_eligible_org');
    expect(error.error).toBe('LibreChat is not enabled for any of your organizations');
    expect(mockProvisionTenant).not.toHaveBeenCalled();
  });

  it('propagates fetchUserSessionDetails errors to caller', async () => {
    mockFetchUserSessionDetails.mockRejectedValue(new Error('GUSD request failed with status 500'));

    await expect(handleChcLogin(buildLoginInput())).rejects.toThrow(
      'GUSD request failed with status 500',
    );
  });

  it('propagates provisionTenant errors to caller', async () => {
    const cpContext = buildCpContext();
    mockFetchUserSessionDetails.mockResolvedValue(buildGUSDResponse());
    mockResolveGUSD.mockReturnValue(cpContext);
    mockFindLastTenantForCpUser.mockResolvedValue(undefined);
    mockResolveTenant.mockReturnValue({ tenantId: 'org-1' } as TenantResolutionResult);
    mockProvisionTenant.mockRejectedValue(new Error('DEK creation failed'));

    await expect(handleChcLogin(buildLoginInput())).rejects.toThrow('DEK creation failed');
  });
});

describe('isChcLoginError', () => {
  it('returns true for error result', () => {
    const error: ChcLoginError = { error: 'something went wrong', errorCode: 'no_eligible_org' };
    expect(isChcLoginError(error)).toBe(true);
  });

  it('returns false for success result', () => {
    const success: ChcLoginResult = { tenantUser: buildUser(), tenantId: 'org-1' };
    expect(isChcLoginError(success)).toBe(false);
  });
});
