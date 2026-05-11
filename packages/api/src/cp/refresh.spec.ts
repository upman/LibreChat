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

import {
  resolveChcRefreshUser,
  refreshChcContext,
  setChcTokenCookie,
  isAccessTokenStale,
  coalescedInlineRefresh,
  registerInlineRefreshHandler,
  ChcReauthRequiredError,
  CHC_REAUTH_REQUIRED,
  MFA_REQUIRED,
  isMfaRequiredError,
  toChcReauthRequiredError,
  _resetRefreshState,
} from './refresh';
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

describe('isAccessTokenStale', () => {
  it('returns true when elapsed time exceeds lifetime minus buffer', () => {
    const req = {
      session: {
        openidTokens: {
          receivedAt: Date.now() - 3600 * 1000,
          tokenLifetime: 3600,
        },
      },
    } as unknown as import('~/types/http').ServerRequest;

    expect(isAccessTokenStale(req)).toBe(true);
  });

  it('returns false when token has significant time remaining', () => {
    const req = {
      session: {
        openidTokens: {
          receivedAt: Date.now() - 1000 * 1000,
          tokenLifetime: 3600,
        },
      },
    } as unknown as import('~/types/http').ServerRequest;

    expect(isAccessTokenStale(req)).toBe(false);
  });

  it('returns false when session data is missing (backward compat)', () => {
    const req = { session: {} } as unknown as import('~/types/http').ServerRequest;
    expect(isAccessTokenStale(req)).toBe(false);
  });

  it('returns false when receivedAt is missing', () => {
    const req = {
      session: { openidTokens: { tokenLifetime: 3600 } },
    } as unknown as import('~/types/http').ServerRequest;

    expect(isAccessTokenStale(req)).toBe(false);
  });

  it('returns false when tokenLifetime is missing', () => {
    const req = {
      session: { openidTokens: { receivedAt: Date.now() - 5000 * 1000 } },
    } as unknown as import('~/types/http').ServerRequest;

    expect(isAccessTokenStale(req)).toBe(false);
  });
});

describe('coalescedInlineRefresh', () => {
  beforeEach(() => {
    _resetRefreshState();
  });

  it('returns null when no handler is registered', async () => {
    const req = {} as unknown as import('~/types/http').ServerRequest;
    const res = {} as unknown as import('express').Response;

    const result = await coalescedInlineRefresh('user-1', req, res);
    expect(result).toBeNull();
  });

  it('coalesces concurrent calls for the same cpUserId', async () => {
    const handler = jest.fn().mockResolvedValue({ accessToken: 'new-token' });
    registerInlineRefreshHandler(handler);

    const req = {} as unknown as import('~/types/http').ServerRequest;
    const res = {} as unknown as import('express').Response;

    const [r1, r2] = await Promise.all([
      coalescedInlineRefresh('user-1', req, res),
      coalescedInlineRefresh('user-1', req, res),
    ]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(r1).toBe('new-token');
    expect(r2).toBe('new-token');
  });

  it('does not coalesce across different cpUserIds', async () => {
    const handler = jest.fn().mockResolvedValue({ accessToken: 'new-token' });
    registerInlineRefreshHandler(handler);

    const req = {} as unknown as import('~/types/http').ServerRequest;
    const res = {} as unknown as import('express').Response;

    await Promise.all([
      coalescedInlineRefresh('user-1', req, res),
      coalescedInlineRefresh('user-2', req, res),
    ]);

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('returns null when handler returns null', async () => {
    registerInlineRefreshHandler(async () => null);

    const req = {} as unknown as import('~/types/http').ServerRequest;
    const res = {} as unknown as import('express').Response;

    const result = await coalescedInlineRefresh('user-1', req, res);
    expect(result).toBeNull();
  });

  it('returns null when handler throws', async () => {
    registerInlineRefreshHandler(async () => {
      throw new Error('refresh failed');
    });

    const req = {} as unknown as import('~/types/http').ServerRequest;
    const res = {} as unknown as import('express').Response;

    const result = await coalescedInlineRefresh('user-1', req, res);
    expect(result).toBeNull();
  });

  it('re-throws ChcReauthRequiredError when handler throws directly', async () => {
    registerInlineRefreshHandler(async () => {
      throw new ChcReauthRequiredError();
    });

    const req = {} as unknown as import('~/types/http').ServerRequest;
    const res = {} as unknown as import('express').Response;

    await expect(coalescedInlineRefresh('user-1', req, res)).rejects.toBeInstanceOf(
      ChcReauthRequiredError,
    );
  });

  it('detects mfa_required in nested OpenID errors', () => {
    const error = new Error('refresh failed');
    error.cause = {
      error: 'mfa_required',
      error_description: 'Multifactor authentication required',
    };

    expect(isMfaRequiredError(error)).toBe(true);
  });

  it('detects mfa_required via error_code and code fields', () => {
    expect(isMfaRequiredError({ error_code: MFA_REQUIRED })).toBe(true);
    expect(isMfaRequiredError({ code: MFA_REQUIRED })).toBe(true);
  });

  it('detects mfa_required through response.data nesting', () => {
    expect(isMfaRequiredError({ response: { data: { error: MFA_REQUIRED } } })).toBe(true);
  });

  it('stops mfa_required recursion at the depth limit', () => {
    const circular: { cause?: unknown } = {};
    circular.cause = circular;

    expect(isMfaRequiredError(circular)).toBe(false);
  });

  it('normalizes duck-typed CHC reauth errors from errorCode to a concrete error', () => {
    const error = toChcReauthRequiredError({ errorCode: CHC_REAUTH_REQUIRED });

    expect(error).toBeInstanceOf(ChcReauthRequiredError);
    expect(error?.reason).toBe(MFA_REQUIRED);
    expect(error?.loginUrl).toBe('/oauth/openid?prompt=login');
  });

  it('normalizes duck-typed CHC reauth errors with custom login URLs', () => {
    const snakeCase = toChcReauthRequiredError({
      error_code: CHC_REAUTH_REQUIRED,
      login_url: '/custom-openid',
      reason: MFA_REQUIRED,
    });
    const camelCase = toChcReauthRequiredError({
      code: CHC_REAUTH_REQUIRED,
      loginUrl: '/custom-openid-camel',
    });

    expect(snakeCase?.loginUrl).toBe('/custom-openid');
    expect(snakeCase?.reason).toBe(MFA_REQUIRED);
    expect(camelCase?.loginUrl).toBe('/custom-openid-camel');
  });

  it('returns null for values that are not CHC reauth errors', () => {
    expect(toChcReauthRequiredError({ error: 'something_else' })).toBeNull();
    expect(toChcReauthRequiredError('string')).toBeNull();
    expect(toChcReauthRequiredError(null)).toBeNull();
  });
});
