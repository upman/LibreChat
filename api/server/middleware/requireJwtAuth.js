const cookies = require('cookie');
const passport = require('passport');
const { logger } = require('@librechat/data-schemas');
const { isEnabled, tenantContextMiddleware, requireChcContext } = require('@librechat/api');

/**
 * Authenticates an OpenID JWT and chains into the given CHC middleware.
 * Shared between `requireJwtAuth` (uses `requireChcContext`) and
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
    return authenticateOpenIdJwt(requireChcContext, req, res, next);
  }

  const cookieHeader = req.headers.cookie;
  const tokenProvider = cookieHeader ? cookies.parse(cookieHeader).token_provider : null;

  const strategy =
    tokenProvider === 'openid' && isEnabled(process.env.OPENID_REUSE_TOKENS) ? 'openidJwt' : 'jwt';

  passport.authenticate(strategy, { session: false })(req, res, (err) => {
    if (err) {
      return next(err);
    }
    // req.user is now populated by passport — set up tenant ALS context
    tenantContextMiddleware(req, res, next);
  });
};

module.exports = requireJwtAuth;
module.exports.authenticateOpenIdJwt = authenticateOpenIdJwt;
