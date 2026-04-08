import { requireChcIdentity } from './identity';
import { _clearGUSDCache, setCachedGUSD } from './cache';
import { GUSDAuthError } from './client';
import { registerInlineRefreshHandler, _resetRefreshState } from './refresh';

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

jest.mock('./client', () => {
  const actual = jest.requireActual('./client');
  return {
    ...actual,
    fetchUserSessionDetails: jest.fn(),
  };
});

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

function createMockReq(user = {}, session = {}): ServerRequest {
  return { user, session } as unknown as ServerRequest;
}

function createMockRes(): Response {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    cookie: jest.fn(),
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
    _resetRefreshState();
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

  describe('proactive token refresh', () => {
    it('refreshes stale token before calling GUSD', async () => {
      const { fetchUserSessionDetails } = jest.requireMock('./client') as {
        fetchUserSessionDetails: jest.Mock;
      };
      const { resolveGUSD } = jest.requireMock('./resolve') as { resolveGUSD: jest.Mock };
      const freshContext = buildCpContext();
      fetchUserSessionDetails.mockResolvedValue({});
      resolveGUSD.mockReturnValue(freshContext);

      registerInlineRefreshHandler(async () => ({ accessToken: 'fresh-token' }));

      const req = createMockReq(
        {
          idOnTheSource: 'cp-user-1',
          tenantId: 'org-a',
          federatedTokens: { access_token: 'stale-token' },
        },
        {
          openidTokens: {
            receivedAt: Date.now() - 4000 * 1000,
            tokenLifetime: 3600,
          },
        },
      );
      const res = createMockRes();
      const next: NextFunction = jest.fn();

      await requireChcIdentity(req, res, next);

      expect(fetchUserSessionDetails).toHaveBeenCalledWith('fresh-token');
      expect(next).toHaveBeenCalled();
    });

    it('proceeds with stale token when refresh fails', async () => {
      const { fetchUserSessionDetails } = jest.requireMock('./client') as {
        fetchUserSessionDetails: jest.Mock;
      };
      const { resolveGUSD } = jest.requireMock('./resolve') as { resolveGUSD: jest.Mock };
      const freshContext = buildCpContext();
      fetchUserSessionDetails.mockResolvedValue({});
      resolveGUSD.mockReturnValue(freshContext);

      registerInlineRefreshHandler(async () => null);

      const req = createMockReq(
        {
          idOnTheSource: 'cp-user-1',
          tenantId: 'org-a',
          federatedTokens: { access_token: 'stale-token' },
        },
        {
          openidTokens: {
            receivedAt: Date.now() - 4000 * 1000,
            tokenLifetime: 3600,
          },
        },
      );
      const res = createMockRes();
      const next: NextFunction = jest.fn();

      await requireChcIdentity(req, res, next);

      expect(fetchUserSessionDetails).toHaveBeenCalledWith('stale-token');
      expect(next).toHaveBeenCalled();
    });
  });

  describe('reactive 401 refresh', () => {
    it('retries GUSD after refreshing on 401', async () => {
      const { fetchUserSessionDetails } = jest.requireMock('./client') as {
        fetchUserSessionDetails: jest.Mock;
      };
      const { resolveGUSD } = jest.requireMock('./resolve') as { resolveGUSD: jest.Mock };
      const freshContext = buildCpContext();

      fetchUserSessionDetails
        .mockRejectedValueOnce(new GUSDAuthError('GUSD request failed with status 401'))
        .mockResolvedValueOnce({});
      resolveGUSD.mockReturnValue(freshContext);

      registerInlineRefreshHandler(async () => ({ accessToken: 'fresh-token' }));

      const req = createMockReq({
        idOnTheSource: 'cp-user-1',
        tenantId: 'org-a',
        federatedTokens: { access_token: 'stale-token' },
      });
      const res = createMockRes();
      const next: NextFunction = jest.fn();

      await requireChcIdentity(req, res, next);

      expect(fetchUserSessionDetails).toHaveBeenCalledTimes(2);
      expect(fetchUserSessionDetails).toHaveBeenNthCalledWith(2, 'fresh-token');
      expect(next).toHaveBeenCalled();
    });

    it('returns 503 when refresh returns null on 401', async () => {
      const { fetchUserSessionDetails } = jest.requireMock('./client') as {
        fetchUserSessionDetails: jest.Mock;
      };
      fetchUserSessionDetails.mockRejectedValue(
        new GUSDAuthError('GUSD request failed with status 401'),
      );

      registerInlineRefreshHandler(async () => null);

      const req = createMockReq({
        idOnTheSource: 'cp-user-1',
        federatedTokens: { access_token: 'stale-token' },
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

    it('returns 503 on 401 when no handler registered (backward compat)', async () => {
      const { fetchUserSessionDetails } = jest.requireMock('./client') as {
        fetchUserSessionDetails: jest.Mock;
      };
      fetchUserSessionDetails.mockRejectedValue(
        new GUSDAuthError('GUSD request failed with status 401'),
      );

      const req = createMockReq({
        idOnTheSource: 'cp-user-1',
        federatedTokens: { access_token: 'stale-token' },
      });
      const res = createMockRes();
      const next: NextFunction = jest.fn();

      await requireChcIdentity(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('does not attempt refresh on non-401 GUSD error', async () => {
      const { fetchUserSessionDetails } = jest.requireMock('./client') as {
        fetchUserSessionDetails: jest.Mock;
      };
      fetchUserSessionDetails.mockRejectedValue(new Error('GUSD request failed with status 500'));

      const handler = jest.fn();
      registerInlineRefreshHandler(handler);

      const req = createMockReq({
        idOnTheSource: 'cp-user-1',
        federatedTokens: { access_token: 'test-token' },
      });
      const res = createMockRes();
      const next: NextFunction = jest.fn();

      await requireChcIdentity(req, res, next);

      expect(handler).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
    });
  });
});
