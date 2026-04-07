const { CacheKeys } = require('librechat-data-provider');
const { logger, DEFAULT_SESSION_EXPIRY } = require('@librechat/data-schemas');
const {
  isEnabled,
  getAdminPanelUrl,
  isAdminPanelRedirect,
  generateAdminExchangeCode,
  shouldUseSecureCookie,
  handleChcLogin,
  isChcLoginError,
  setChcTokenCookie,
  invalidateSession,
  fetchUserSessionDetails,
  resolveGUSD,
  resolveTenant,
} = require('@librechat/api');
const { syncUserEntraGroupMemberships } = require('~/server/services/PermissionService');
const { setAuthTokens, setOpenIDAuthTokens } = require('~/server/services/AuthService');
const getLogStores = require('~/cache/getLogStores');
const { checkBan } = require('~/server/middleware');
const {
  generateToken,
  updateUser,
  findUser,
  findUsers,
  createUser,
  provisionDeps,
} = require('~/models');

const domains = {
  client: process.env.DOMAIN_CLIENT,
  server: process.env.DOMAIN_SERVER,
};

const userMethods = { findUser, findUsers, createUser, updateUser };

function createOAuthHandler(redirectUri = domains.client) {
  return async (req, res, next) => {
    try {
      if (res.headersSent) {
        return;
      }

      await checkBan(req, res);
      if (req.banned) {
        return;
      }

      /** Check if this is an admin panel redirect (cross-origin) */
      if (isAdminPanelRedirect(redirectUri, getAdminPanelUrl(), domains.client)) {
        const cache = getLogStores(CacheKeys.ADMIN_OAUTH_EXCHANGE);
        const sessionExpiry = Number(process.env.SESSION_EXPIRY) || DEFAULT_SESSION_EXPIRY;
        const token = await generateToken(req.user, sessionExpiry);
        const refreshToken =
          req.user.tokenset?.refresh_token || req.user.federatedTokens?.refresh_token;

        const callbackUrl = new URL(redirectUri);
        const exchangeCode = await generateAdminExchangeCode(
          cache,
          req.user,
          token,
          refreshToken,
          callbackUrl.origin,
          req.pkceChallenge,
        );
        callbackUrl.searchParams.set('code', exchangeCode);
        logger.info(`[OAuth] Admin panel redirect with exchange code for user: ${req.user.email}`);
        return res.redirect(callbackUrl.toString());
      }

      const cpAccessToken =
        req.user?.tokenset?.access_token || req.user?.federatedTokens?.access_token;

      /** CHC mode: full tenant provisioning + per-tenant user creation */
      if (cpAccessToken && isEnabled(process.env.CHC_INT_ENABLED)) {
        try {
          const openidId = req.user.openidId || req.user?.tokenset?.claims?.()?.sub;
          if (!openidId) {
            logger.error('[OAuth] CHC mode: no openidId resolved from user or tokenset');
            throw new Error('Missing openidId for CHC login');
          }
          const requestedOrgId = typeof req.query?.orgId === 'string' ? req.query.orgId : undefined;

          const result = await handleChcLogin({
            cpAccessToken,
            requestedOrgId,
            openidId,
            provisionDeps,
            userMethods,
          });

          if (isChcLoginError(result)) {
            invalidateSession(req, res);
            const errorUrl = new URL('/login', redirectUri);
            errorUrl.searchParams.set('error', result.errorCode);
            errorUrl.searchParams.set('error_description', result.error);
            return res.redirect(errorUrl.toString());
          }

          /** Capture tokens BEFORE swapping req.user — tenantUser has no tokenset */
          const originalTokenset = req.user.tokenset;
          const originalFederatedTokens = req.user.federatedTokens;

          /** Swap req.user to the per-tenant doc — JWT will reference this user's _id */
          req.user = result.tenantUser;
          req.user.id = result.tenantUser._id.toString();
          req.user.tokenset = originalTokenset;
          req.user.federatedTokens = {
            access_token: cpAccessToken,
            id_token: originalTokenset?.id_token ?? originalFederatedTokens?.id_token,
            refresh_token:
              originalTokenset?.refresh_token ?? originalFederatedTokens?.refresh_token,
            expires_at: originalTokenset?.expires_at ?? originalFederatedTokens?.expires_at,
          };
        } catch (err) {
          logger.error('[OAuth] CHC provisioning failed:', err);
          invalidateSession(req, res);
          const errorUrl = new URL('/login', redirectUri);
          errorUrl.searchParams.set('error', 'chc_auth_failed');
          errorUrl.searchParams.set(
            'error_description',
            'Authentication with ClickHouse Cloud failed',
          );
          return res.redirect(errorUrl.toString());
        }
      } else if (cpAccessToken) {
        /**
         * Non-CHC mode with CP access token — original PoC behavior (no provisioning).
         * This path fires when CHC_INT_ENABLED is false but the OIDC provider attached
         * a CP-scoped access token. In practice, this only occurs in transitional or
         * experimental deployments. It persists idOnTheSource and resolvedAt without
         * tenant provisioning or per-tenant user creation.
         */
        try {
          const gusdResponse = await fetchUserSessionDetails(cpAccessToken);
          const cpContext = resolveGUSD(gusdResponse);
          const requestedOrgId = typeof req.query?.orgId === 'string' ? req.query.orgId : undefined;
          const tenant = resolveTenant({
            requestedOrgId,
            eligibleOrgIds: cpContext.eligibleOrgIds,
          });
          const updateData = {
            idOnTheSource: cpContext.cpUserId,
            resolvedAt: new Date(cpContext.resolvedAt),
          };
          if (tenant.tenantId) {
            updateData.lastTenantId = tenant.tenantId;
          }
          await updateUser(req.user._id.toString(), updateData);
        } catch (err) {
          logger.error('[OAuth] GUSD call failed, continuing without CP context:', err);
        }
      }

      /** Standard OAuth flow - set cookies and redirect */
      if (!res.headersSent) {
        if (
          req.user &&
          req.user.provider == 'openid' &&
          isEnabled(process.env.OPENID_REUSE_TOKENS) === true
        ) {
          if (!isEnabled(process.env.CHC_INT_ENABLED)) {
            await syncUserEntraGroupMemberships(req.user, req.user.tokenset?.access_token);
          }
          setOpenIDAuthTokens(
            req.user.tokenset || req.user.federatedTokens,
            req,
            res,
            req.user._id.toString(),
          );

          if (isEnabled(process.env.CHC_INT_ENABLED)) {
            await setChcTokenCookie(req.user, res, { generateToken, shouldUseSecureCookie });
          }
        } else {
          await setAuthTokens(req.user._id, res);
        }
      }
      if (!res.headersSent) {
        res.redirect(redirectUri);
      }
    } catch (err) {
      logger.error('Error in setting authentication tokens:', err);
      if (!res.headersSent) {
        next(err);
      }
    }
  };
}

module.exports = {
  createOAuthHandler,
};
