import { requireChcContext } from './middleware';
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
  LIBRECHAT_ORG_FEATURE: 'FT_ORG_LIBRECHAT',
}));

function createMockReq(user = {}, session = {}): ServerRequest {
  return { user, session } as unknown as ServerRequest;
}

function createMockRes(): Response {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    clearCookie: jest.fn(),
    cookie: jest.fn(),
  };
  return res as unknown as Response;
}

function buildCachedContext(overrides: Partial<ResolvedCpContext> = {}): ResolvedCpContext {
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

describe('requireChcContext', () => {
  beforeEach(() => {
    _clearGUSDCache();
    _resetRefreshState();
    mockRun.mockClear();
    mockRun.mockImplementation((_ctx: { tenantId: string }, fn: () => Promise<void>) => fn());
  });

  it('injects tenantId and chcUserId when GUSD cache is warm', async () => {
    setCachedGUSD('cp-user-1', buildCachedContext());
    const req = createMockReq({
      idOnTheSource: 'cp-user-1',
      tenantId: 'org-a',
    });
    const res = createMockRes();
    const next: NextFunction = jest.fn();

    await requireChcContext(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.chcUserId).toBe('cp-user-1');
    expect(req.tenantId).toBe('org-a');
  });

  it('wraps next() in tenantStorage.run() with correct tenantId', async () => {
    setCachedGUSD('cp-user-1', buildCachedContext());
    const req = createMockReq({
      idOnTheSource: 'cp-user-1',
      tenantId: 'org-a',
    });
    const res = createMockRes();
    const next: NextFunction = jest.fn();

    await requireChcContext(req, res, next);

    expect(mockRun).toHaveBeenCalledWith({ tenantId: 'org-a' }, expect.any(Function));
    expect(next).toHaveBeenCalled();
  });

  it('returns 401 when user has no idOnTheSource', async () => {
    const req = createMockReq({ email: 'test@example.com' });
    const res = createMockRes();
    const next: NextFunction = jest.fn();

    await requireChcContext(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error_code: 'CHC_IDENTITY_MISSING' }),
    );
  });

  it('returns 401 when req.user is undefined', async () => {
    const req = createMockReq(undefined);
    const res = createMockRes();
    const next: NextFunction = jest.fn();

    await requireChcContext(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 403 when user has no tenantId or lastTenantId', async () => {
    const req = createMockReq({
      idOnTheSource: 'cp-user-1',
      tenantId: null,
      lastTenantId: null,
    });
    const res = createMockRes();
    const next: NextFunction = jest.fn();

    await requireChcContext(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error_code: 'TENANT_NOT_RESOLVED' }),
    );
  });

  it('returns 403 when tenant lost FT_ORG_LIBRECHAT in fresh GUSD data', async () => {
    setCachedGUSD(
      'cp-user-1',
      buildCachedContext({
        chcSessionDetails: {
          organizations: {},
          orgFeatures: { 'org-a': ['FT_OTHER'] },
          orgRolesV2: {},
        },
      }),
    );
    const req = createMockReq({
      idOnTheSource: 'cp-user-1',
      tenantId: 'org-a',
    });
    const res = createMockRes();
    const next: NextFunction = jest.fn();

    await requireChcContext(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error_code: 'TENANT_NOT_ELIGIBLE' }),
    );
  });

  it('returns 503 when no GUSD data and no access token', async () => {
    const req = createMockReq({
      idOnTheSource: 'cp-user-1',
      tenantId: 'org-a',
    });
    const res = createMockRes();
    const next: NextFunction = jest.fn();

    await requireChcContext(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error_code: 'GUSD_UNAVAILABLE' }),
    );
  });

  it('fetches GUSD on cold cache when access token is available', async () => {
    const { fetchUserSessionDetails } = jest.requireMock('./client') as {
      fetchUserSessionDetails: jest.Mock;
    };
    const { resolveGUSD } = jest.requireMock('./resolve') as { resolveGUSD: jest.Mock };
    const freshContext = buildCachedContext();
    fetchUserSessionDetails.mockResolvedValue({});
    resolveGUSD.mockReturnValue(freshContext);

    const req = createMockReq({
      idOnTheSource: 'cp-user-1',
      tenantId: 'org-a',
      federatedTokens: { access_token: 'test-token' },
    });
    const res = createMockRes();
    const next: NextFunction = jest.fn();

    await requireChcContext(req, res, next);

    expect(fetchUserSessionDetails).toHaveBeenCalledWith('test-token');
    expect(next).toHaveBeenCalled();
    expect(req.cpContext).toBe(freshContext);
  });

  it('returns 503 when cold-cache GUSD fetch fails', async () => {
    const { fetchUserSessionDetails } = jest.requireMock('./client') as {
      fetchUserSessionDetails: jest.Mock;
    };
    fetchUserSessionDetails.mockRejectedValue(new Error('CP API down'));

    const req = createMockReq({
      idOnTheSource: 'cp-user-1',
      tenantId: 'org-a',
      federatedTokens: { access_token: 'test-token' },
    });
    const res = createMockRes();
    const next: NextFunction = jest.fn();

    await requireChcContext(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  describe('proactive token refresh', () => {
    it('refreshes stale token before calling GUSD', async () => {
      const { fetchUserSessionDetails } = jest.requireMock('./client') as {
        fetchUserSessionDetails: jest.Mock;
      };
      const { resolveGUSD } = jest.requireMock('./resolve') as { resolveGUSD: jest.Mock };
      const freshContext = buildCachedContext();
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

      await requireChcContext(req, res, next);

      expect(fetchUserSessionDetails).toHaveBeenCalledWith('fresh-token');
      expect(next).toHaveBeenCalled();
    });

    it('proceeds with stale token when refresh fails', async () => {
      const { fetchUserSessionDetails } = jest.requireMock('./client') as {
        fetchUserSessionDetails: jest.Mock;
      };
      const { resolveGUSD } = jest.requireMock('./resolve') as { resolveGUSD: jest.Mock };
      const freshContext = buildCachedContext();
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

      await requireChcContext(req, res, next);

      expect(fetchUserSessionDetails).toHaveBeenCalledWith('stale-token');
      expect(next).toHaveBeenCalled();
    });
  });

  describe('composite proactive + reactive path', () => {
    it('handles proactive refresh followed by reactive 401 retry', async () => {
      const { fetchUserSessionDetails } = jest.requireMock('./client') as {
        fetchUserSessionDetails: jest.Mock;
      };
      const { resolveGUSD } = jest.requireMock('./resolve') as { resolveGUSD: jest.Mock };
      const freshContext = buildCachedContext();

      fetchUserSessionDetails.mockReset();
      fetchUserSessionDetails
        .mockRejectedValueOnce(new GUSDAuthError('GUSD request failed with status 401'))
        .mockResolvedValueOnce({});
      resolveGUSD.mockReturnValue(freshContext);

      const handler = jest
        .fn()
        .mockResolvedValueOnce({ accessToken: 'fresh-token-1' })
        .mockResolvedValueOnce({ accessToken: 'fresh-token-2' });
      registerInlineRefreshHandler(handler);

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

      await requireChcContext(req, res, next);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(fetchUserSessionDetails).toHaveBeenCalledTimes(2);
      expect(fetchUserSessionDetails).toHaveBeenNthCalledWith(1, 'fresh-token-1');
      expect(fetchUserSessionDetails).toHaveBeenNthCalledWith(2, 'fresh-token-2');
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('reactive 401 refresh', () => {
    it('retries GUSD after refreshing on 401', async () => {
      const { fetchUserSessionDetails } = jest.requireMock('./client') as {
        fetchUserSessionDetails: jest.Mock;
      };
      const { resolveGUSD } = jest.requireMock('./resolve') as { resolveGUSD: jest.Mock };
      const freshContext = buildCachedContext();

      fetchUserSessionDetails.mockReset();
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

      await requireChcContext(req, res, next);

      expect(fetchUserSessionDetails).toHaveBeenCalledTimes(2);
      expect(fetchUserSessionDetails).toHaveBeenNthCalledWith(1, 'stale-token');
      expect(fetchUserSessionDetails).toHaveBeenNthCalledWith(2, 'fresh-token');
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
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
        tenantId: 'org-a',
        federatedTokens: { access_token: 'stale-token' },
      });
      const res = createMockRes();
      const next: NextFunction = jest.fn();

      await requireChcContext(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error_code: 'GUSD_UNAVAILABLE' }),
      );
    });

    it('returns 503 on 401 when no handler is registered (backward compat)', async () => {
      const { fetchUserSessionDetails } = jest.requireMock('./client') as {
        fetchUserSessionDetails: jest.Mock;
      };
      fetchUserSessionDetails.mockRejectedValue(
        new GUSDAuthError('GUSD request failed with status 401'),
      );

      const req = createMockReq({
        idOnTheSource: 'cp-user-1',
        tenantId: 'org-a',
        federatedTokens: { access_token: 'stale-token' },
      });
      const res = createMockRes();
      const next: NextFunction = jest.fn();

      await requireChcContext(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('does not attempt refresh on non-401 GUSD error (e.g. 500)', async () => {
      const { fetchUserSessionDetails } = jest.requireMock('./client') as {
        fetchUserSessionDetails: jest.Mock;
      };
      fetchUserSessionDetails.mockRejectedValue(new Error('GUSD request failed with status 500'));

      const handler = jest.fn();
      registerInlineRefreshHandler(handler);

      const req = createMockReq({
        idOnTheSource: 'cp-user-1',
        tenantId: 'org-a',
        federatedTokens: { access_token: 'test-token' },
      });
      const res = createMockRes();
      const next: NextFunction = jest.fn();

      await requireChcContext(req, res, next);

      expect(handler).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
    });
  });
});
