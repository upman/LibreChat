const express = require('express');
const {
  isEnabled,
  switchOrg,
  isSwitchError,
  requireChcIdentity,
  setChcTokenCookie,
  shouldUseSecureCookie,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { setAuthTokens, setOpenIDAuthTokens } = require('~/server/services/AuthService');
const { authenticateOpenIdJwt } = require('~/server/middleware/requireJwtAuth');
const {
  findUser,
  findUsers,
  createUser,
  updateUser,
  generateToken,
  provisionDeps,
} = require('~/models');

const router = express.Router();
const userMethods = { findUser, findUsers, createUser, updateUser };

/**
 * Authenticate CHC identity WITHOUT current-tenant eligibility enforcement.
 * Users whose current org lost FT_ORG_LIBRECHAT can still list/switch orgs.
 */
const authenticateChcIdentity = (req, res, next) =>
  authenticateOpenIdJwt(requireChcIdentity, req, res, next);

/**
 * GET /api/cp/orgs
 * Returns the authenticated user's eligible organizations (those with FT_ORG_LIBRECHAT).
 * Uses fresh GUSD data from requireChcIdentity (req.cpContext).
 */
router.get('/orgs', authenticateChcIdentity, async (req, res) => {
  try {
    const { cpContext } = req;
    const currentTenantId = req.user?.tenantId || req.user?.lastTenantId;
    const organizations = cpContext.chcSessionDetails.organizations;
    const orgs = cpContext.eligibleOrgIds.map((orgId) => ({
      id: orgId,
      name: organizations[orgId]?.name ?? orgId,
      isCurrent: orgId === currentTenantId,
    }));

    return res.json({ orgs });
  } catch (err) {
    logger.error('[CP] GET /orgs failed:', err);
    return res.status(500).json({ error: 'Failed to retrieve organizations' });
  }
});

/**
 * POST /api/cp/switch-org
 * Switches the user to a different eligible organization.
 * Returns new auth tokens referencing the target tenant's user document.
 */
router.post('/switch-org', authenticateChcIdentity, async (req, res) => {
  try {
    const user = req.user;
    const { targetOrgId } = req.body;

    if (!targetOrgId || typeof targetOrgId !== 'string') {
      return res.status(400).json({ error: 'targetOrgId is required' });
    }

    const result = await switchOrg(user, targetOrgId, {
      provision: provisionDeps,
      user: userMethods,
      freshContext: req.cpContext,
    });

    if (isSwitchError(result)) {
      const statusMap = {
        CP_IDENTITY_MISSING: 401,
        OPENID_IDENTITY_MISSING: 401,
        GUSD_UNAVAILABLE: 503,
      };
      const status = statusMap[result.errorCode] ?? 403;
      return res.status(status).json({ error: result.error, error_code: result.errorCode });
    }

    const { tenantUser, tenantId, role } = result;

    if (user.provider === 'openid' && isEnabled(process.env.OPENID_REUSE_TOKENS) === true) {
      const tokenset = user.federatedTokens || user.openidTokens;
      setOpenIDAuthTokens(tokenset, req, res, tenantUser._id.toString());
    } else {
      await setAuthTokens(tenantUser._id, res);
    }

    /** Reissue the CHC token cookie for the new tenant user */
    await setChcTokenCookie(tenantUser, res, { generateToken, shouldUseSecureCookie });

    return res.json({
      user: {
        id: tenantUser._id.toString(),
        name: tenantUser.name,
        email: tenantUser.email,
        role,
        tenantId,
      },
    });
  } catch (err) {
    logger.error('[CP] POST /switch-org failed:', err);
    return res.status(500).json({ error: 'Failed to switch organization' });
  }
});

module.exports = router;
