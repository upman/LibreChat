import { requireChcIdentity } from './identity';
import { _clearGUSDCache, setCachedGUSD } from './cache';

import type { Response, NextFunction } from 'express';
import type { ResolvedCpContext } from './types';
import type { ServerRequest } from '~/types/http';

const mockRun = jest.fn((_ctx: { tenantId: string }, fn: () => Promise<void>) => fn());

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
  tenantStorage: {
    run: (ctx: { tenantId: string }, fn: () => Promise<void>) => mockRun(ctx, fn),
  },
}));

jest.mock('./client', () => ({
  fetchUserSessionDetails: jest.fn(),
}));

jest.mock('./resolve', () => ({
  resolveGUSD: jest.fn(),
}));

jest.mock('./cache', () => {
  const actual = jest.requireActual('./cache') as typeof import('./cache');
  return {
    ...actual,
    getCachedGUSD: jest.fn(actual.getCachedGUSD),
    getOrFetchGUSD: jest.fn(actual.getOrFetchGUSD),
  };
});

function createMockReq(user = {}): ServerRequest {
  return { user } as ServerRequest;
}

function createMockRes(): Response {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

function buildCpContext(overrides: Partial<ResolvedCpContext> = {}): ResolvedCpContext {
  return {
    cpUserId: 'cp-user-1',
    email: 'test@test.com',
    name: 'Test',
    chcSessionDetails: {
      organizations: {},
      orgFeatures: { 'org-a': ['FT_ORG_LIBRECHAT'] },
      orgRolesV2: {},
    },
    eligibleOrgIds: ['org-a'],
    adminOrgIds: [],
    resolvedAt: Date.now(),
    ...overrides,
  };
}

describe('requireChcIdentity', () => {
  beforeEach(() => {
    _clearGUSDCache();
    mockRun.mockClear();
    mockRun.mockImplementation((_ctx: { tenantId: string }, fn: () => Promise<void>) => fn());
    jest.clearAllMocks();
  });

  it('returns 401 when user has no idOnTheSource', async () => {
    const req = createMockReq({ email: 'test@example.com' });
    const res = createMockRes();
    const next: NextFunction = jest.fn();

    await requireChcIdentity(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error_code: 'CHC_IDENTITY_MISSING' }),
    );
  });

  it('returns 503 when GUSD is unavailable (no access token, cache cold)', async () => {
    const req = createMockReq({ idOnTheSource: 'cp-user-1' });
    const res = createMockRes();
    const next: NextFunction = jest.fn();

    await requireChcIdentity(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error_code: 'GUSD_UNAVAILABLE' }),
    );
  });

  it('returns 503 when GUSD fetch fails with access token present', async () => {
    const { fetchUserSessionDetails } = jest.requireMock('./client') as {
      fetchUserSessionDetails: jest.Mock;
    };
    fetchUserSessionDetails.mockRejectedValue(new Error('CP API down'));

    const req = createMockReq({
      idOnTheSource: 'cp-user-1',
      federatedTokens: { access_token: 'test-token' },
    });
    const res = createMockRes();
    const next: NextFunction = jest.fn();

    await requireChcIdentity(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error_code: 'GUSD_UNAVAILABLE' }),
    );
  });

  it('sets req.cpContext and req.chcUserId on success', async () => {
    const context = buildCpContext();
    setCachedGUSD('cp-user-1', context);

    const req = createMockReq({
      idOnTheSource: 'cp-user-1',
      tenantId: 'org-a',
    });
    const res = createMockRes();
    const next: NextFunction = jest.fn();

    await requireChcIdentity(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.chcUserId).toBe('cp-user-1');
    expect(req.cpContext).toBe(context);
  });

  it('wraps in tenantStorage.run when user has tenantId', async () => {
    setCachedGUSD('cp-user-1', buildCpContext());

    const req = createMockReq({
      idOnTheSource: 'cp-user-1',
      tenantId: 'org-a',
    });
    const res = createMockRes();
    const next: NextFunction = jest.fn();

    await requireChcIdentity(req, res, next);

    expect(mockRun).toHaveBeenCalledWith({ tenantId: 'org-a' }, expect.any(Function));
    expect(next).toHaveBeenCalled();
  });

  it('proceeds without ALS when user has no tenantId (recovery path)', async () => {
    setCachedGUSD('cp-user-1', buildCpContext());

    const req = createMockReq({
      idOnTheSource: 'cp-user-1',
    });
    const res = createMockRes();
    const next: NextFunction = jest.fn();

    await requireChcIdentity(req, res, next);

    expect(mockRun).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
    expect(req.chcUserId).toBe('cp-user-1');
    expect(req.cpContext).toBeDefined();
  });

  it('uses cached GUSD when cache is warm (no fetch call)', async () => {
    const { fetchUserSessionDetails } = jest.requireMock('./client') as {
      fetchUserSessionDetails: jest.Mock;
    };
    const context = buildCpContext();
    setCachedGUSD('cp-user-1', context);

    const req = createMockReq({
      idOnTheSource: 'cp-user-1',
      federatedTokens: { access_token: 'test-token' },
      tenantId: 'org-a',
    });
    const res = createMockRes();
    const next: NextFunction = jest.fn();

    await requireChcIdentity(req, res, next);

    expect(fetchUserSessionDetails).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
    expect(req.cpContext).toBe(context);
  });
});
