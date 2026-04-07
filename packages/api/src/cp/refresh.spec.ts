import jwt from 'jsonwebtoken';

const mockRunAsSystem = jest.fn((_fn: () => Promise<unknown>) => _fn());
const mockRunAsTenant = jest.fn((_tenantId: string, fn: () => Promise<unknown>) => fn());

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  runAsSystem: (fn: () => Promise<unknown>) => mockRunAsSystem(fn),
  runAsTenant: (tenantId: string, fn: () => Promise<unknown>) => mockRunAsTenant(tenantId, fn),
}));

jest.mock('./client');
jest.mock('./resolve');
jest.mock('./tenant');
jest.mock('./cache');

import { resolveChcRefreshUser, refreshChcContext, setChcTokenCookie } from './refresh';
import { fetchUserSessionDetails } from './client';
import { resolveGUSD } from './resolve';
import { resolveTenant } from './tenant';
import { getCachedGUSD, getOrFetchGUSD } from './cache';

import type { IUser } from '@librechat/data-schemas';
import type { RefreshUserMethods } from './refresh';
import type { ResolvedCpContext, TenantResolutionResult } from './types';

const JWT_SECRET = 'test-secret';

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

function buildMethods(overrides: Partial<RefreshUserMethods> = {}): RefreshUserMethods {
  return {
    getUserById: jest.fn().mockResolvedValue(buildUser()),
    updateUser: jest.fn().mockResolvedValue(buildUser()),
    ...overrides,
  };
}

describe('resolveChcRefreshUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when tokenCookie is undefined', async () => {
    const methods = buildMethods();
    const result = await resolveChcRefreshUser(undefined, JWT_SECRET, methods);

    expect(result).toBeNull();
    expect(methods.getUserById).not.toHaveBeenCalled();
  });

  it('returns null when jwt.verify throws', async () => {
    const methods = buildMethods();
    const result = await resolveChcRefreshUser('invalid-token', JWT_SECRET, methods);

    expect(result).toBeNull();
    expect(methods.getUserById).not.toHaveBeenCalled();
  });

  it('returns null when payload has no id', async () => {
    const token = jwt.sign({ sub: 'no-id-field' }, JWT_SECRET);
    const methods = buildMethods();
    const result = await resolveChcRefreshUser(token, JWT_SECRET, methods);

    expect(result).toBeNull();
    expect(methods.getUserById).not.toHaveBeenCalled();
  });

  it('returns null when getUserById returns null', async () => {
    const token = jwt.sign({ id: 'user-123' }, JWT_SECRET);
    const methods = buildMethods({
      getUserById: jest.fn().mockResolvedValue(null),
    });

    const result = await resolveChcRefreshUser(token, JWT_SECRET, methods);

    expect(result).toBeNull();
  });

  it('loads user via runAsSystem and returns it on success', async () => {
    const user = buildUser();
    const token = jwt.sign({ id: 'user-123' }, JWT_SECRET);
    const methods = buildMethods({
      getUserById: jest.fn().mockResolvedValue(user),
    });

    const result = await resolveChcRefreshUser(token, JWT_SECRET, methods);

    expect(result).toBe(user);
    expect(mockRunAsSystem).toHaveBeenCalledTimes(1);
    expect(methods.getUserById).toHaveBeenCalledWith(
      'user-123',
      '-password -__v -totpSecret -backupCodes',
    );
  });

  it('uses ignoreExpiration: true', async () => {
    const expiredToken = jwt.sign({ id: 'user-123' }, JWT_SECRET, { expiresIn: -10 });
    const user = buildUser();
    const methods = buildMethods({
      getUserById: jest.fn().mockResolvedValue(user),
    });

    const result = await resolveChcRefreshUser(expiredToken, JWT_SECRET, methods);

    expect(result).toBe(user);
  });
});

describe('refreshChcContext', () => {
  const mockFetchUserSessionDetails = fetchUserSessionDetails as jest.MockedFunction<
    typeof fetchUserSessionDetails
  >;
  const mockResolveGUSD = resolveGUSD as jest.MockedFunction<typeof resolveGUSD>;
  const mockResolveTenant = resolveTenant as jest.MockedFunction<typeof resolveTenant>;
  const mockGetCachedGUSD = getCachedGUSD as jest.MockedFunction<typeof getCachedGUSD>;
  const mockGetOrFetchGUSD = getOrFetchGUSD as jest.MockedFunction<typeof getOrFetchGUSD>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips when userTenantId is missing', async () => {
    const user = buildUser({ tenantId: undefined, lastTenantId: undefined });
    const methods = buildMethods();

    await refreshChcContext(user, 'access-token', methods);

    expect(mockGetCachedGUSD).not.toHaveBeenCalled();
    expect(methods.updateUser).not.toHaveBeenCalled();
  });

  it('skips when user.idOnTheSource is missing', async () => {
    const user = buildUser({ idOnTheSource: undefined });
    const methods = buildMethods();

    await refreshChcContext(user, 'access-token', methods);

    expect(mockGetCachedGUSD).not.toHaveBeenCalled();
    expect(methods.updateUser).not.toHaveBeenCalled();
  });

  it('uses cached GUSD when cache is warm -- derives role without extra fetch', async () => {
    const cpContext = buildCpContext({ adminOrgIds: ['org-1'] });
    mockGetCachedGUSD.mockReturnValue(cpContext);
    mockResolveTenant.mockReturnValue({ tenantId: 'org-1' });

    const user = buildUser({ role: 'USER' });
    const methods = buildMethods();

    const result = await refreshChcContext(user, 'access-token', methods);

    expect(result).toEqual({ role: 'ADMIN' });
    expect(mockGetCachedGUSD).toHaveBeenCalledWith('chc-1');
    expect(mockGetOrFetchGUSD).not.toHaveBeenCalled();
    expect(methods.updateUser).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({ role: 'ADMIN' }),
    );
  });

  it('fetches GUSD when cache is cold and writes demoted role', async () => {
    const cpContext = buildCpContext();
    mockGetCachedGUSD.mockReturnValue(undefined);
    mockGetOrFetchGUSD.mockResolvedValue(cpContext);
    mockResolveTenant.mockReturnValue({ tenantId: 'org-1' });

    const user = buildUser({ role: 'ADMIN' });
    const methods = buildMethods();

    const result = await refreshChcContext(user, 'access-token', methods);

    expect(result).toEqual({ role: 'USER' });
    expect(mockGetOrFetchGUSD).toHaveBeenCalledWith('chc-1', expect.any(Function));
    expect(methods.updateUser).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({ role: 'USER' }),
    );
  });

  it('writes updated role to DB when role changed (ADMIN to USER demotion)', async () => {
    const cpContext = buildCpContext({ adminOrgIds: [] });
    mockGetCachedGUSD.mockReturnValue(cpContext);
    mockResolveTenant.mockReturnValue({ tenantId: 'org-1' } as TenantResolutionResult);

    const user = buildUser({ role: 'ADMIN' });
    const methods = buildMethods();

    const result = await refreshChcContext(user, 'access-token', methods);

    expect(result).toEqual({ role: 'USER' });
    expect(mockRunAsTenant).toHaveBeenCalledWith('org-1', expect.any(Function));
    expect(methods.updateUser).toHaveBeenCalledWith('user-123', {
      idOnTheSource: 'chc-1',
      role: 'USER',
      resolvedAt: expect.any(Date) as Date,
      lastTenantId: 'org-1',
    });
  });

  it('skips DB write when role and lastTenantId unchanged', async () => {
    const cpContext = buildCpContext({ adminOrgIds: [] });
    mockGetCachedGUSD.mockReturnValue(cpContext);
    mockResolveTenant.mockReturnValue({ tenantId: 'org-1' } as TenantResolutionResult);

    const user = buildUser({ role: 'USER', lastTenantId: 'org-1' });
    const methods = buildMethods();

    const result = await refreshChcContext(user, 'access-token', methods);

    expect(result).toBeUndefined();
    expect(methods.updateUser).not.toHaveBeenCalled();
  });

  it('catches GUSD fetch errors without propagating', async () => {
    mockGetCachedGUSD.mockReturnValue(undefined);
    mockGetOrFetchGUSD.mockRejectedValue(new Error('network failure'));

    const user = buildUser();
    const methods = buildMethods();

    await expect(refreshChcContext(user, 'access-token', methods)).resolves.toBeUndefined();
    expect(methods.updateUser).not.toHaveBeenCalled();
  });
});

describe('setChcTokenCookie', () => {
  it('calls generateToken with correct user and maxAge', async () => {
    const user = buildUser();
    const res = { cookie: jest.fn() } as unknown as import('express').Response;
    const generateToken = jest.fn().mockResolvedValue('signed-token');
    const shouldUseSecureCookie = jest.fn().mockReturnValue(true);

    await setChcTokenCookie(user, res, { generateToken, shouldUseSecureCookie });

    expect(generateToken).toHaveBeenCalledWith(user, expect.any(Number) as number);
    const maxAge = generateToken.mock.calls[0][1] as number;
    expect(maxAge).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('sets cookie with httpOnly, secure, sameSite, maxAge', async () => {
    const user = buildUser();
    const res = { cookie: jest.fn() } as unknown as import('express').Response;
    const generateToken = jest.fn().mockResolvedValue('signed-token');
    const shouldUseSecureCookie = jest.fn().mockReturnValue(true);

    await setChcTokenCookie(user, res, { generateToken, shouldUseSecureCookie });

    expect(res.cookie).toHaveBeenCalledWith('token', 'signed-token', {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  });
});
