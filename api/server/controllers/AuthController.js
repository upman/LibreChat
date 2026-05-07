const cookies = require('cookie');
const jwt = require('jsonwebtoken');
const openIdClient = require('openid-client');
const { logger } = require('@librechat/data-schemas');
const {
  isEnabled,
  findOpenIDUser,
  getOpenIdIssuer,
  resolveChcRefreshUser,
  refreshChcContext,
  setChcTokenCookie,
  shouldUseSecureCookie,
} = require('@librechat/api');
const {
  requestPasswordReset,
  setOpenIDAuthTokens,
  resetPassword,
  setAuthTokens,
  registerUser,
} = require('~/server/services/AuthService');
const {
  deleteAllUserSessions,
  generateToken,
  getUserById,
  findSession,
  updateUser,
  findUser,
} = require('~/models');
const { getGraphApiToken } = require('~/server/services/GraphTokenService');
const { getOpenIdConfig, getOpenIdEmail } = require('~/strategies');
const jwtDecode = require('jsonwebtoken/decode');

const registrationController = async (req, res) => {
  try {
    const response = await registerUser(req.body);
    const { status, message } = response;
    res.status(status).send({ message });
  } catch (err) {
    logger.error('[registrationController]', err);
    return res.status(500).json({ message: err.message });
  }
};

const resetPasswordRequestController = async (req, res) => {
  try {
    const resetService = await requestPasswordReset(req);
    if (resetService instanceof Error) {
      return res.status(400).json(resetService);
    } else {
      return res.status(200).json(resetService);
    }
  } catch (e) {
    logger.error('[resetPasswordRequestController]', e);
    return res.status(400).json({ message: e.message });
  }
};

const resetPasswordController = async (req, res) => {
  try {
    const resetPasswordService = await resetPassword(
      req.body.userId,
      req.body.token,
      req.body.password,
    );
    if (resetPasswordService instanceof Error) {
      return res.status(400).json(resetPasswordService);
    } else {
      await deleteAllUserSessions({ userId: req.body.userId });
      return res.status(200).json(resetPasswordService);
    }
  } catch (e) {
    logger.error('[resetPasswordController]', e);
    return res.status(400).json({ message: e.message });
  }
};

const refreshController = async (req, res) => {
  const parsedCookies = req.headers.cookie ? cookies.parse(req.headers.cookie) : {};
  const token_provider = parsedCookies.token_provider;

  if (token_provider === 'openid' && isEnabled(process.env.OPENID_REUSE_TOKENS)) {
    /** For OpenID users, read refresh token from session to avoid large cookie issues */
    const refreshToken = req.session?.openidTokens?.refreshToken || parsedCookies.refreshToken;

    if (!refreshToken) {
      return res.status(200).send('Refresh token not provided');
    }

    /**
     * When the IdP requires MFA with allowRememberBrowser: false, refreshTokenGrant
     * always fails with mfa_required (server-to-server call has no browser MFA state).
     * The OAuth callback already stored valid tokens in the session — reuse them when
     * they haven't expired instead of hitting the token endpoint.
     */
    const sessionTokens = req.session?.openidTokens;
    const tokenAgeSec =
      sessionTokens?.receivedAt && sessionTokens?.tokenLifetime
        ? (Date.now() - sessionTokens.receivedAt) / 1000
        : Infinity;
    const SESSION_REUSE_BUFFER_SEC = 30;

    if (
      sessionTokens?.idToken &&
      tokenAgeSec < sessionTokens.tokenLifetime - SESSION_REUSE_BUFFER_SEC
    ) {
      try {
        const claims = jwtDecode(sessionTokens.idToken);
        if (claims?.sub) {
          let user;
          if (isEnabled(process.env.CHC_INT_ENABLED)) {
            user = await resolveChcRefreshUser(parsedCookies.token, process.env.JWT_SECRET, {
              getUserById,
              updateUser,
            });
          } else {
            const result = await findOpenIDUser({
              findUser,
              email: getOpenIdEmail(claims),
              openidId: claims.sub,
              idOnTheSource: claims.oid,
              strategyName: 'refreshController',
            });
            if (!result.error && result.user) {
              user = result.user;
            }
          }

          if (user) {
            logger.debug(
              '[refreshController] Reusing valid session tokens (skipping refreshTokenGrant)',
            );
            const appAuthToken = sessionTokens.idToken || sessionTokens.accessToken;
            const {
              password: _pw,
              __v: _v,
              totpSecret: _ts,
              backupCodes: _bc,
              idOnTheSource: _idos,
              resolvedAt: _ra,
              lastTenantId: _lt,
              ...safeUser
            } = user;
            return res.status(200).send({ token: appAuthToken, user: safeUser });
          }
        }
      } catch (_sessionErr) {
        logger.warn(
          '[refreshController] Session token reuse failed, proceeding with token refresh',
        );
      }
    }

    try {
      const openIdConfig = getOpenIdConfig();
      const refreshParams = process.env.OPENID_SCOPE ? { scope: process.env.OPENID_SCOPE } : {};
      const tokenset = await openIdClient.refreshTokenGrant(
        openIdConfig,
        refreshToken,
        refreshParams,
      );
      const claims = tokenset.claims();
      const openidIssuer = getOpenIdIssuer(claims, openIdConfig);

      let user;

      if (isEnabled(process.env.CHC_INT_ENABLED)) {
        user = await resolveChcRefreshUser(parsedCookies.token, process.env.JWT_SECRET, {
          getUserById,
          updateUser,
        });

        if (!user) {
          logger.warn('[refreshController] CHC mode: no valid session, redirecting to login');
          return res.status(401).redirect('/login');
        }

        if (user.openidId && user.openidId !== claims.sub) {
          logger.warn(
            `[refreshController] CHC mode: identity mismatch — cookie user openidId=${user.openidId} vs claims.sub=${claims.sub}`,
          );
          return res.status(401).redirect('/login');
        }
      } else {
        const result = await findOpenIDUser({
          findUser,
          email: getOpenIdEmail(claims),
          openidId: claims.sub,
          openidIssuer,
          idOnTheSource: claims.oid,
          strategyName: 'refreshController',
        });

        logger.debug(
          `[refreshController] findOpenIDUser result: user=${result.user?.email ?? 'null'}, error=${result.error ?? 'null'}, migration=${result.migration}, claimsSub=${claims.sub}`,
        );

        if (result.error || !result.user) {
          logger.warn(
            `[refreshController] Redirecting to /login: error=${result.error ?? 'null'}, user=${result.user ? 'exists' : 'null'}`,
          );
          return res.status(401).redirect('/login');
        }

        user = result.user;

        if (result.migration || user.openidId !== claims.sub) {
          const reason = result.migration ? 'migration' : 'openidId mismatch';
          await updateUser(user._id.toString(), {
            provider: 'openid',
            openidId: claims.sub,
            ...(openidIssuer ? { openidIssuer } : {}),
          });
          logger.info(
            `[refreshController] Updated user ${user.email} openidId (${reason}): ${user.openidId ?? 'null'} -> ${claims.sub}`,
          );
        }
      }

      /** Refresh cached GUSD data and re-derive role from live CP state */
      if (isEnabled(process.env.CHC_INT_ENABLED) && tokenset.access_token) {
        const refreshResult = await refreshChcContext(user, tokenset.access_token, {
          getUserById,
          updateUser,
        });
        if (refreshResult?.role) {
          user.role = refreshResult.role;
        }
      }

      const token = setOpenIDAuthTokens(tokenset, req, res, {
        userId: user._id.toString(),
        existingRefreshToken: refreshToken,
        tenantId: user.tenantId,
      });

      if (isEnabled(process.env.CHC_INT_ENABLED)) {
        await setChcTokenCookie(user, res, { generateToken, shouldUseSecureCookie });
      }

      const {
        password: _pw,
        __v: _v,
        totpSecret: _ts,
        backupCodes: _bc,
        idOnTheSource: _idos,
        resolvedAt: _ra,
        lastTenantId: _lt,
        ...safeUser
      } = user;
      return res.status(200).send({ token, user: safeUser });
    } catch (error) {
      logger.error('[refreshController] OpenID token refresh error', error);
      const isMfaRequired =
        error?.cause?.error === 'mfa_required' || error?.error === 'mfa_required';
      if (isMfaRequired) {
        return res.status(403).json({ error_code: 'mfa_required' });
      }
      return res.status(403).send('Invalid OpenID refresh token');
    }
  }

  /** For non-OpenID users, read refresh token from cookies */
  const refreshToken = parsedCookies.refreshToken;
  if (!refreshToken) {
    return res.status(200).send('Refresh token not provided');
  }

  try {
    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const user = await getUserById(
      payload.id,
      '-password -__v -totpSecret -backupCodes -resolvedAt -lastTenantId',
    );
    if (!user) {
      return res.status(401).redirect('/login');
    }

    const userId = payload.id;

    if (process.env.NODE_ENV === 'CI') {
      const token = await setAuthTokens(userId, res, null, req);
      return res.status(200).send({ token, user });
    }

    /** Session with the hashed refresh token */
    const session = await findSession(
      {
        userId: userId,
        refreshToken: refreshToken,
      },
      { lean: false },
    );

    if (session && session.expiration > new Date()) {
      const token = await setAuthTokens(userId, res, session, req);

      res.status(200).send({ token, user });
    } else if (req?.query?.retry) {
      // Retrying from a refresh token request that failed (401)
      res.status(403).send('No session found');
    } else if (payload.exp < Date.now() / 1000) {
      res.status(403).redirect('/login');
    } else {
      res.status(401).send('Refresh token expired or not found for this user');
    }
  } catch (err) {
    logger.error(`[refreshController] Invalid refresh token:`, err);
    res.status(403).send('Invalid refresh token');
  }
};

const graphTokenController = async (req, res) => {
  try {
    // Validate user is authenticated via Entra ID
    if (!req.user.openidId || req.user.provider !== 'openid') {
      return res.status(403).json({
        message: 'Microsoft Graph access requires Entra ID authentication',
      });
    }

    // Check if OpenID token reuse is active (required for on-behalf-of flow)
    if (!isEnabled(process.env.OPENID_REUSE_TOKENS)) {
      return res.status(403).json({
        message: 'SharePoint integration requires OpenID token reuse to be enabled',
      });
    }

    const scopes = req.query.scopes;
    if (!scopes) {
      return res.status(400).json({
        message: 'Graph API scopes are required as query parameter',
      });
    }

    const accessToken = req.user.federatedTokens?.access_token;
    if (!accessToken) {
      return res.status(401).json({
        message: 'No federated access token available for token exchange',
      });
    }

    const tokenResponse = await getGraphApiToken(req.user, accessToken, scopes);

    res.json(tokenResponse);
  } catch (error) {
    logger.error('[graphTokenController] Failed to obtain Graph API token:', error);
    res.status(500).json({
      message: 'Failed to obtain Microsoft Graph token',
    });
  }
};

module.exports = {
  refreshController,
  registrationController,
  resetPasswordController,
  resetPasswordRequestController,
  graphTokenController,
};
