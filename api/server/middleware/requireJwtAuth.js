const cookies = require('cookie');
const passport = require('passport');
const { CacheKeys } = require('librechat-data-provider');
const { logger } = require('@librechat/data-schemas');
const {
  isEnabled,
  tenantContextMiddleware,
  requireChcContext,
  switchOrg,
  isSwitchError,
  invalidateSession,
  resolveChcAdminSessionUser,
} = require('@librechat/api');
const {
  findUser,
  findUsers,
  createUser,
  updateUser,
  getUserById,
  provisionDeps,
} = require('~/models');
const getLogStores = require('~/cache/getLogStores');

const userMethods = { findUser, findUsers, createUser, updateUser };

/**
 * Re-resolve `req.user` against `req.tenantId` when the two disagree — e.g.
 * when `x-chc-org-id` switched tenants or a headless Bearer caller has no
 * persisted tenantId yet. Must run after `requireChcContext`, which populates
 * `req.tenantId` and `req.cpContext`.
 */
async function chcSwitchOrg(req, res, next) {
  const { tenantId, cpContext, chcUserId, user } = req;
  if (!user || user.tenantId === tenantId) {
    return next();
  }
  if (!user.openidId) {
    logger.warn(`[chcSwitchOrg] Cannot re-resolve user without openidId cpUserId=${chcUserId}`);
    invalidateSession(req, res);
    return res.status(401).json({
      error: 'CHC identity incomplete',
      error_code: 'OPENID_IDENTITY_MISSING',
    });
  }
  try {
    const result = await switchOrg(user, tenantId, {
      provision: provisionDeps,
      user: userMethods,
      freshContext: cpContext,
    });
    if (isSwitchError(result)) {
      logger.warn(
        `[chcSwitchOrg] switchOrg failed tenant=${tenantId} cpUserId=${chcUserId} code=${result.errorCode}`,
      );
      return res.status(403).json({ error: result.error, error_code: result.errorCode });
    }
    const resolved = result.tenantUser;
    // Keep the original Bearer token on the new user. The user loaded from
    // Mongo doesn't have it, but later code (token refresh, GUSD) still needs it.
    req.user = {
      ...resolved,
      id: resolved._id.toString(),
      federatedTokens: user.federatedTokens ?? resolved.federatedTokens,
    };
    return next();
  } catch (err) {
    logger.error(
      `[chcSwitchOrg] Failed to re-resolve user for tenant=${tenantId} cpUserId=${chcUserId}`,
      err,
    );
    return res.status(500).json({
      error: 'Failed to resolve tenant context',
      error_code: 'TENANT_RESOLUTION_FAILED',
    });
  }
}

/** Run `requireChcContext`, then `chcSwitchOrg` if the former calls `next()`. */
const chcContextPipeline = (req, res, next) =>
  requireChcContext(req, res, (err) => {
    if (err) {
      return next(err);
    }
    chcSwitchOrg(req, res, next).catch(next);
  });

/**
 * Authenticates an OpenID JWT and chains into the given CHC middleware.
 * Shared between `requireJwtAuth` (uses `chcContextPipeline`) and
 * `authenticateChcIdentity` in the CP routes (uses `requireChcIdentity`).
 */
function authenticateOpenIdJwt(chcMiddleware, req, res, next) {
  passport.authenticate('openidJwt', { session: false }, (err, user) => {
    if (err || !user) {
      logger.warn('[authenticateOpenIdJwt] CHC auth failed', { error: err?.message });
      return res.status(401).json({ error: 'Authentication failed', error_code: 'AUTH_FAILED' });
    }
    req.user = user;
    chcMiddleware(req, res, next).catch(next);
  })(req, res, next);
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== 'string') {
    return undefined;
  }
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

async function authenticateChcAdminSession(req, res, next) {
  let user;
  try {
    user = await resolveChcAdminSessionUser(getBearerToken(req), {
      store: getLogStores(CacheKeys.ADMIN_OAUTH_SESSION),
      jwtSecret: process.env.JWT_SECRET,
      getUserById,
      updateUser,
    });
  } catch (err) {
    logger.warn('[authenticateChcAdminSession] lookup failed; falling back to OpenID JWT auth', {
      error: err?.message,
    });
    return false;
  }

  if (!user) {
    return false;
  }
  req.user = user;
  await chcContextPipeline(req, res, next);
  return true;
}

const hasPassportStrategy = (strategy) =>
  typeof passport._strategy === 'function' && passport._strategy(strategy) != null;

/**
 * Custom Middleware to handle JWT authentication, with support for OpenID token reuse.
 * Switches between JWT, OpenID, and CHC authentication based on cookies and environment settings.
 *
 * After successful authentication (req.user populated), automatically chains into
 * `tenantContextMiddleware` to propagate `req.user.tenantId` into AsyncLocalStorage
 * for downstream Mongoose tenant isolation.
 */
const requireJwtAuth = (req, res, next) => {
  /** CHC mode is exclusive — skip local JWT and OpenID cookie-based auth */
  if (isEnabled(process.env.CHC_INT_ENABLED)) {
    authenticateChcAdminSession(req, res, next)
      .then((handled) => {
        if (!handled && !res.headersSent) {
          authenticateOpenIdJwt(chcContextPipeline, req, res, next);
        }
      })
      .catch(next);
    return;
  }

  const cookieHeader = req.headers.cookie;
  const tokenProvider = cookieHeader ? cookies.parse(cookieHeader).token_provider : null;
  const openidReuseEnabled = isEnabled(process.env.OPENID_REUSE_TOKENS);
  const openidJwtAvailable = openidReuseEnabled && hasPassportStrategy('openidJwt');
  const strategies =
    tokenProvider === 'openid' && openidJwtAvailable
      ? ['openidJwt', 'jwt']
      : ['jwt', ...(openidJwtAvailable ? ['openidJwt'] : [])];

  const authenticateWithStrategy = (index) => {
    const strategy = strategies[index];
    passport.authenticate(strategy, { session: false }, (err, user, info, status) => {
      if (err) {
        return next(err);
      }
      if (!user) {
        if (index + 1 < strategies.length) {
          return authenticateWithStrategy(index + 1);
        }
        return res.status(status || 401).json({
          message: info?.message || 'Unauthorized',
        });
      }
      req.user = user;
      req.authStrategy = strategy;
      // req.user is now populated by passport — set up tenant ALS context
      tenantContextMiddleware(req, res, next);
    })(req, res, next);
  };

  authenticateWithStrategy(0);
};

module.exports = requireJwtAuth;
module.exports.authenticateOpenIdJwt = authenticateOpenIdJwt;
module.exports.chcSwitchOrg = chcSwitchOrg;
module.exports.chcContextPipeline = chcContextPipeline;
