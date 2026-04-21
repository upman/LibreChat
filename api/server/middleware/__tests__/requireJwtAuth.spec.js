/**
 * Integration test: verifies that requireJwtAuth chains tenantContextMiddleware
 * after successful passport authentication, so ALS tenant context is set for
 * all downstream middleware and route handlers.
 *
 * requireJwtAuth must chain tenantContextMiddleware after passport populates
 * req.user (not at global app.use() scope where req.user is undefined).
 * If the chaining is removed, these tests fail.
 */

const { getTenantId } = require('@librechat/data-schemas');

// ── Mocks ──────────────────────────────────────────────────────────────

let mockPassportError = null;

jest.mock('passport', () => ({
  authenticate: jest.fn(() => {
    return (req, _res, done) => {
      if (mockPassportError) {
        return done(mockPassportError);
      }
      if (req._mockUser) {
        req.user = req._mockUser;
      }
      done();
    };
  }),
}));

// Mock @librechat/api — the real tenantContextMiddleware is TS and cannot be
// required directly from CJS tests. This thin wrapper mirrors the real logic
// (read req.user.tenantId, call tenantStorage.run) using the same data-schemas
// primitives. The real implementation is covered by packages/api tenant.spec.ts.
jest.mock('@librechat/api', () => {
  const { tenantStorage } = require('@librechat/data-schemas');
  return {
    isEnabled: jest.fn(() => false),
    tenantContextMiddleware: (req, res, next) => {
      const tenantId = req.user?.tenantId;
      if (!tenantId) {
        return next();
      }
      return tenantStorage.run({ tenantId }, async () => next());
    },
    requireChcContext: jest.fn(),
    switchOrg: jest.fn(),
    isSwitchError: jest.fn((r) => r && typeof r.errorCode === 'string'),
    invalidateSession: jest.fn(),
  };
});

// `~/models` pulls in Redis/cache at module load; stub with the symbols
// requireJwtAuth.js imports at top-level.
jest.mock('~/models', () => ({
  findUser: jest.fn(),
  findUsers: jest.fn(),
  createUser: jest.fn(),
  updateUser: jest.fn(),
  provisionDeps: {},
}));

// ── Helpers ─────────────────────────────────────────────────────────────

const requireJwtAuth = require('../requireJwtAuth');
const { chcSwitchOrg, chcContextPipeline } = requireJwtAuth;
const { switchOrg, invalidateSession, requireChcContext } = require('@librechat/api');

function mockReq(user) {
  return { headers: {}, _mockUser: user };
}

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

/** Runs requireJwtAuth and returns the tenantId observed inside next(). */
function runAuth(user) {
  return new Promise((resolve) => {
    const req = mockReq(user);
    const res = mockRes();
    requireJwtAuth(req, res, () => {
      resolve(getTenantId());
    });
  });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('requireJwtAuth tenant context chaining', () => {
  afterEach(() => {
    mockPassportError = null;
  });

  it('forwards passport errors to next() without entering tenant middleware', async () => {
    mockPassportError = new Error('JWT signature invalid');
    const req = mockReq(undefined);
    const res = mockRes();
    const err = await new Promise((resolve) => {
      requireJwtAuth(req, res, (e) => resolve(e));
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('JWT signature invalid');
    expect(getTenantId()).toBeUndefined();
  });

  it('sets ALS tenant context after passport auth succeeds', async () => {
    const tenantId = await runAuth({ tenantId: 'tenant-abc', role: 'user' });
    expect(tenantId).toBe('tenant-abc');
  });

  it('ALS tenant context is NOT set when user has no tenantId', async () => {
    const tenantId = await runAuth({ role: 'user' });
    expect(tenantId).toBeUndefined();
  });

  it('ALS tenant context is NOT set when user is undefined', async () => {
    const tenantId = await runAuth(undefined);
    expect(tenantId).toBeUndefined();
  });

  it('concurrent requests get isolated tenant contexts', async () => {
    const results = await Promise.all(
      ['tenant-1', 'tenant-2', 'tenant-3'].map((tid) => runAuth({ tenantId: tid, role: 'user' })),
    );
    expect(results).toEqual(['tenant-1', 'tenant-2', 'tenant-3']);
  });

  it('ALS context is not set at top-level scope (outside any request)', () => {
    expect(getTenantId()).toBeUndefined();
  });
});

function switchReq(user, tenantId = 'org-b') {
  return {
    user,
    tenantId,
    cpContext: {},
    chcUserId: 'cp-user-1',
  };
}

function switchRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

describe('chcSwitchOrg', () => {
  beforeEach(() => {
    switchOrg.mockReset();
    invalidateSession.mockClear();
  });

  it('passes through when user.tenantId already matches req.tenantId', async () => {
    const next = jest.fn();
    await chcSwitchOrg(switchReq({ tenantId: 'org-b', openidId: 'oid-1' }), switchRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(switchOrg).not.toHaveBeenCalled();
  });

  it('returns 401 OPENID_IDENTITY_MISSING when user has no openidId', async () => {
    const res = switchRes();
    const next = jest.fn();
    await chcSwitchOrg(switchReq({ tenantId: 'org-a' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(invalidateSession).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error_code: 'OPENID_IDENTITY_MISSING' }),
    );
  });

  it('returns 403 when switchOrg reports a switch error', async () => {
    switchOrg.mockResolvedValue({ error: 'nope', errorCode: 'ORG_NOT_ELIGIBLE' });
    const res = switchRes();
    const next = jest.fn();
    await chcSwitchOrg(switchReq({ tenantId: 'org-a', openidId: 'oid-1' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'nope', error_code: 'ORG_NOT_ELIGIBLE' });
  });

  it('replaces req.user and preserves federatedTokens on success', async () => {
    const resolved = { _id: { toString: () => 'new-id' }, tenantId: 'org-b' };
    switchOrg.mockResolvedValue({ tenantUser: resolved, tenantId: 'org-b', role: 'USER' });
    const priorTokens = { access_token: 'tok' };
    const req = switchReq({ tenantId: 'org-a', openidId: 'oid-1', federatedTokens: priorTokens });
    const next = jest.fn();
    await chcSwitchOrg(req, switchRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(req.user).not.toBe(resolved);
    expect(req.user.tenantId).toBe('org-b');
    expect(req.user.federatedTokens).toBe(priorTokens);
    expect(req.user.id).toBe('new-id');
    expect(resolved.federatedTokens).toBeUndefined();
    expect(resolved.id).toBeUndefined();
  });

  it('returns 500 TENANT_RESOLUTION_FAILED when switchOrg throws', async () => {
    switchOrg.mockRejectedValue(new Error('boom'));
    const res = switchRes();
    const next = jest.fn();
    await chcSwitchOrg(switchReq({ tenantId: 'org-a', openidId: 'oid-1' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error_code: 'TENANT_RESOLUTION_FAILED' }),
    );
  });
});

describe('chcContextPipeline', () => {
  beforeEach(() => {
    switchOrg.mockReset();
    requireChcContext.mockReset();
  });

  it('propagates requireChcContext errors without invoking chcSwitchOrg', async () => {
    const ctxErr = new Error('ctx failed');
    requireChcContext.mockImplementation((_req, _res, cb) => cb(ctxErr));

    const req = switchReq({ tenantId: 'org-a', openidId: 'oid-1' });
    const next = jest.fn();
    await chcContextPipeline(req, switchRes(), next);

    expect(next).toHaveBeenCalledWith(ctxErr);
    expect(switchOrg).not.toHaveBeenCalled();
  });
});
