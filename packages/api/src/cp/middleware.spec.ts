import { requireChcContext } from './middleware';
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
  LIBRECHAT_ORG_FEATURE: 'FT_ORG_LIBRECHAT',
}));

function createMockReq(user = {}): ServerRequest {
  return { user } as ServerRequest;
}

function createMockRes(): Response {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    clearCookie: jest.fn(),
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
});
