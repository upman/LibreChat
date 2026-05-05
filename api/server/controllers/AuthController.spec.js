jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), debug: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock('~/server/services/GraphTokenService', () => ({
  getGraphApiToken: jest.fn(),
}));
jest.mock('~/server/services/AuthService', () => ({
  requestPasswordReset: jest.fn(),
  setOpenIDAuthTokens: jest.fn(),
  resetPassword: jest.fn(),
  setAuthTokens: jest.fn(),
  registerUser: jest.fn(),
}));
jest.mock('~/strategies', () => ({ getOpenIdConfig: jest.fn(), getOpenIdEmail: jest.fn() }));
jest.mock('openid-client', () => ({ refreshTokenGrant: jest.fn() }));
jest.mock('~/models', () => ({
  deleteAllUserSessions: jest.fn(),
  generateToken: jest.fn().mockResolvedValue('mock-chc-token'),
  getUserById: jest.fn(),
  findSession: jest.fn(),
  updateUser: jest.fn(),
  findUser: jest.fn(),
}));
jest.mock('@librechat/api', () => ({
  isEnabled: jest.fn(),
  findOpenIDUser: jest.fn(),
  getOpenIdIssuer: jest.fn(() => 'https://issuer.example.com'),
  resolveChcRefreshUser: jest.fn(),
  refreshChcContext: jest.fn().mockResolvedValue(undefined),
  setChcTokenCookie: jest.fn().mockResolvedValue(undefined),
  shouldUseSecureCookie: jest.fn().mockReturnValue(false),
}));

const openIdClient = require('openid-client');
const {
  isEnabled,
  findOpenIDUser,
  resolveChcRefreshUser,
  refreshChcContext,
} = require('@librechat/api');
const { graphTokenController, refreshController } = require('./AuthController');
const { getGraphApiToken } = require('~/server/services/GraphTokenService');
const { setOpenIDAuthTokens } = require('~/server/services/AuthService');
const { getOpenIdConfig, getOpenIdEmail } = require('~/strategies');
const { updateUser } = require('~/models');

describe('graphTokenController', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    isEnabled.mockReturnValue(true);

    req = {
      user: {
        openidId: 'oid-123',
        provider: 'openid',
        federatedTokens: {
          access_token: 'federated-access-token',
          id_token: 'federated-id-token',
        },
      },
      headers: { authorization: 'Bearer app-jwt-which-is-id-token' },
      query: { scopes: 'https://graph.microsoft.com/.default' },
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    getGraphApiToken.mockResolvedValue({
      access_token: 'graph-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });
  });

  it('should pass federatedTokens.access_token as OBO assertion, not the auth header bearer token', async () => {
    await graphTokenController(req, res);

    expect(getGraphApiToken).toHaveBeenCalledWith(
      req.user,
      'federated-access-token',
      'https://graph.microsoft.com/.default',
    );
    expect(getGraphApiToken).not.toHaveBeenCalledWith(
      expect.anything(),
      'app-jwt-which-is-id-token',
      expect.anything(),
    );
  });

  it('should return the graph token response on success', async () => {
    await graphTokenController(req, res);

    expect(res.json).toHaveBeenCalledWith({
      access_token: 'graph-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });
  });

  it('should return 403 when user is not authenticated via Entra ID', async () => {
    req.user.provider = 'google';
    req.user.openidId = undefined;

    await graphTokenController(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(getGraphApiToken).not.toHaveBeenCalled();
  });

  it('should return 403 when OPENID_REUSE_TOKENS is not enabled', async () => {
    isEnabled.mockReturnValue(false);

    await graphTokenController(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(getGraphApiToken).not.toHaveBeenCalled();
  });

  it('should return 400 when scopes query param is missing', async () => {
    req.query.scopes = undefined;

    await graphTokenController(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(getGraphApiToken).not.toHaveBeenCalled();
  });

  it('should return 401 when federatedTokens.access_token is missing', async () => {
    req.user.federatedTokens = {};

    await graphTokenController(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(getGraphApiToken).not.toHaveBeenCalled();
  });

  it('should return 401 when federatedTokens is absent entirely', async () => {
    req.user.federatedTokens = undefined;

    await graphTokenController(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(getGraphApiToken).not.toHaveBeenCalled();
  });

  it('should return 500 when getGraphApiToken throws', async () => {
    getGraphApiToken.mockRejectedValue(new Error('OBO exchange failed'));

    await graphTokenController(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Failed to obtain Microsoft Graph token',
    });
  });
});

describe('refreshController – OpenID path', () => {
  const mockTokenset = {
    claims: jest.fn(),
    access_token: 'new-access',
    id_token: 'new-id',
    refresh_token: 'new-refresh',
  };

  const baseClaims = {
    iss: 'https://issuer.example.com',
    sub: 'oidc-sub-123',
    oid: 'oid-456',
    email: 'user@example.com',
    exp: 9999999999,
  };

  const defaultUser = {
    _id: 'user-db-id',
    email: baseClaims.email,
    openidId: baseClaims.sub,
    password: '$2b$10$hashedpassword',
    __v: 0,
    totpSecret: 'encrypted-totp-secret',
    backupCodes: ['hashed-code-1', 'hashed-code-2'],
  };

  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();

    /**
     * isEnabled returns true for OPENID_REUSE_TOKENS (to enter the OpenID refresh path)
     * but false for CHC_INT_ENABLED (these tests exercise the standard non-CHC flow).
     * CHC_INT_ENABLED is not set in the test env, so it's undefined.
     */
    process.env.OPENID_REUSE_TOKENS = 'true';
    delete process.env.CHC_INT_ENABLED;
    isEnabled.mockImplementation(
      (val) => val !== undefined && val !== null && val !== '' && val !== 'false',
    );
    getOpenIdConfig.mockReturnValue({ some: 'config' });
    openIdClient.refreshTokenGrant.mockResolvedValue(mockTokenset);
    mockTokenset.claims.mockReturnValue(baseClaims);
    getOpenIdEmail.mockReturnValue(baseClaims.email);
    setOpenIDAuthTokens.mockReturnValue('new-app-token');
    findOpenIDUser.mockResolvedValue({ user: { ...defaultUser }, error: null, migration: false });
    updateUser.mockResolvedValue({});

    req = {
      headers: { cookie: 'token_provider=openid; refreshToken=stored-refresh' },
      session: {},
    };

    res = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      redirect: jest.fn(),
    };
  });

  afterEach(() => {
    delete process.env.OPENID_REUSE_TOKENS;
    delete process.env.CHC_INT_ENABLED;
  });

  it('should call getOpenIdEmail with token claims and use result for findOpenIDUser', async () => {
    await refreshController(req, res);

    expect(getOpenIdEmail).toHaveBeenCalledWith(baseClaims);
    expect(findOpenIDUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: baseClaims.email,
        openidIssuer: baseClaims.iss,
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('should use OPENID_EMAIL_CLAIM-resolved value when claim is present in token', async () => {
    const claimsWithUpn = { ...baseClaims, upn: 'user@corp.example.com' };
    mockTokenset.claims.mockReturnValue(claimsWithUpn);
    getOpenIdEmail.mockReturnValue('user@corp.example.com');

    const user = {
      _id: 'user-db-id',
      email: 'user@corp.example.com',
      openidId: baseClaims.sub,
    };
    findOpenIDUser.mockResolvedValue({ user, error: null, migration: false });

    await refreshController(req, res);

    expect(getOpenIdEmail).toHaveBeenCalledWith(claimsWithUpn);
    expect(findOpenIDUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'user@corp.example.com',
        openidIssuer: baseClaims.iss,
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('should fall back to claims.email when configured claim is absent from token claims', async () => {
    getOpenIdEmail.mockReturnValue(baseClaims.email);

    await refreshController(req, res);

    expect(findOpenIDUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: baseClaims.email,
        openidIssuer: baseClaims.iss,
      }),
    );
  });

  it('should not expose sensitive fields or federatedTokens in refresh response', async () => {
    await refreshController(req, res);

    const sentPayload = res.send.mock.calls[0][0];
    expect(sentPayload).toEqual({
      token: 'new-app-token',
      user: expect.objectContaining({
        _id: 'user-db-id',
        email: baseClaims.email,
        openidId: baseClaims.sub,
      }),
    });
    expect(sentPayload.user).not.toHaveProperty('federatedTokens');
    expect(sentPayload.user).not.toHaveProperty('password');
    expect(sentPayload.user).not.toHaveProperty('totpSecret');
    expect(sentPayload.user).not.toHaveProperty('backupCodes');
    expect(sentPayload.user).not.toHaveProperty('__v');
  });

  it('should update openidId when migration is triggered on refresh', async () => {
    const user = { _id: 'user-db-id', email: baseClaims.email, openidId: null };
    findOpenIDUser.mockResolvedValue({ user, error: null, migration: true });

    await refreshController(req, res);

    expect(updateUser).toHaveBeenCalledWith(
      'user-db-id',
      expect.objectContaining({
        provider: 'openid',
        openidId: baseClaims.sub,
        openidIssuer: baseClaims.iss,
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('should return 401 and redirect to /login when findOpenIDUser returns no user', async () => {
    findOpenIDUser.mockResolvedValue({ user: null, error: null, migration: false });

    await refreshController(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.redirect).toHaveBeenCalledWith('/login');
  });

  it('should return 401 and redirect when findOpenIDUser returns an error', async () => {
    findOpenIDUser.mockResolvedValue({ user: null, error: 'AUTH_FAILED', migration: false });

    await refreshController(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.redirect).toHaveBeenCalledWith('/login');
  });

  it('should skip OpenID path when token_provider is not openid', async () => {
    req.headers.cookie = 'token_provider=local; refreshToken=some-token';

    await refreshController(req, res);

    expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
  });

  it('should skip OpenID path when OPENID_REUSE_TOKENS is disabled', async () => {
    isEnabled.mockReturnValue(false);

    await refreshController(req, res);

    expect(openIdClient.refreshTokenGrant).not.toHaveBeenCalled();
  });

  it('should return 200 with token not provided when refresh token is absent', async () => {
    req.headers.cookie = 'token_provider=openid';
    req.session = {};

    await refreshController(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('Refresh token not provided');
  });

  describe('CHC mode', () => {
    beforeEach(() => {
      process.env.CHC_INT_ENABLED = 'true';
    });

    afterEach(() => {
      delete process.env.CHC_INT_ENABLED;
    });

    it('rejects with 401 when cookie user openidId mismatches claims.sub', async () => {
      resolveChcRefreshUser.mockResolvedValue({
        _id: 'user-db-id',
        openidId: 'auth0|user-A',
        role: 'USER',
      });
      mockTokenset.claims.mockReturnValue({ ...baseClaims, sub: 'auth0|user-B' });

      await refreshController(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.redirect).toHaveBeenCalledWith('/login');
    });

    it('proceeds when cookie user openidId matches claims.sub', async () => {
      resolveChcRefreshUser.mockResolvedValue({
        ...defaultUser,
        openidId: baseClaims.sub,
      });
      refreshChcContext.mockResolvedValue({ role: 'USER' });

      await refreshController(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('proceeds when cookie user has no openidId (legacy doc)', async () => {
      resolveChcRefreshUser.mockResolvedValue({
        ...defaultUser,
        openidId: undefined,
      });
      refreshChcContext.mockResolvedValue(undefined);

      await refreshController(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('applies refreshed role to response body', async () => {
      resolveChcRefreshUser.mockResolvedValue({
        ...defaultUser,
        openidId: baseClaims.sub,
        role: 'USER',
      });
      refreshChcContext.mockResolvedValue({ role: 'ADMIN' });

      await refreshController(req, res);

      const sentPayload = res.send.mock.calls[0][0];
      expect(sentPayload.user.role).toBe('ADMIN');
    });
  });

  describe('MFA required error handling', () => {
    it('returns 403 with error_code mfa_required when error.cause.error is mfa_required', async () => {
      const mfaError = new Error('token refresh failed');
      mfaError.cause = {
        error: 'mfa_required',
        error_description: 'Multifactor authentication required',
      };
      openIdClient.refreshTokenGrant.mockRejectedValue(mfaError);

      await refreshController(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error_code: 'mfa_required' });
      expect(res.send).not.toHaveBeenCalled();
    });

    it('returns 403 with error_code mfa_required when error.error is mfa_required', async () => {
      const mfaError = new Error('token refresh failed');
      mfaError.error = 'mfa_required';
      openIdClient.refreshTokenGrant.mockRejectedValue(mfaError);

      await refreshController(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error_code: 'mfa_required' });
      expect(res.send).not.toHaveBeenCalled();
    });

    it('returns generic 403 string for non-MFA refresh errors', async () => {
      openIdClient.refreshTokenGrant.mockRejectedValue(new Error('invalid_grant'));

      await refreshController(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.send).toHaveBeenCalledWith('Invalid OpenID refresh token');
      expect(res.json).not.toHaveBeenCalled();
    });
  });
});
