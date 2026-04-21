import { tenantStorage, logger } from '@librechat/data-schemas';

import type { Response, NextFunction } from 'express';
import type { ServerRequest } from '~/types/http';

import { LIBRECHAT_ORG_FEATURE } from './resolve';
import { getCachedGUSD } from './cache';
import { fetchGUSDWithRefresh } from './refresh';

/**
 * Reads and trims the `x-chc-org-id` request header. Returns undefined when the
 * header is absent, non-string, or only whitespace.
 */
export function readChcOrgHeader(req: ServerRequest): string | undefined {
  const raw = req.headers['x-chc-org-id'];
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

const SESSION_COOKIES = [
  'token',
  'refreshToken',
  'openid_access_token',
  'openid_id_token',
  'openid_user_id',
  'token_provider',
] as const;

export function invalidateSession(req: ServerRequest, res: Response): void {
  for (const name of SESSION_COOKIES) {
    res.clearCookie(name);
  }

  if (req.session?.openidTokens) {
    delete req.session.openidTokens;
  }

  try {
    req.session?.destroy?.(() => {});
  } catch {
    logger.debug('[invalidateSession] session.destroy() unavailable or failed');
  }
}

/**
 * Post-auth middleware that validates CHC tenant context on every request.
 *
 * Calls GUSD per-request (with 60 s in-memory dedup per user) to ensure
 * org eligibility is always fresh — if an org loses `FT_ORG_LIBRECHAT`,
 * access is denied within 60 seconds.
 *
 * Attaches `req.cpContext` so downstream route handlers can read fresh
 * GUSD data without a duplicate CP call.
 *
 * Wraps downstream handlers in `tenantStorage.run()` for Mongoose tenant
 * isolation via AsyncLocalStorage.
 */
export async function requireChcContext(
  req: ServerRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const user = req.user;

  if (!user?.idOnTheSource) {
    logger.warn('[requireChcContext] No idOnTheSource on authenticated user');
    invalidateSession(req, res);
    res.status(401).json({
      error: 'CHC identity not resolved. Please log in again.',
      error_code: 'CHC_IDENTITY_MISSING',
    });
    return;
  }

  const cpUserId = user.idOnTheSource;
  // x-chc-org-id overrides the persisted tenant on the user doc
  const tenantId = readChcOrgHeader(req) || user.tenantId || user.lastTenantId;
  if (!tenantId) {
    logger.warn(`[requireChcContext] No tenant resolved for cpUserId=${cpUserId}`);
    invalidateSession(req, res);
    res.status(403).json({
      error: 'No organization resolved for this user',
      error_code: 'TENANT_NOT_RESOLVED',
    });
    return;
  }

  const cpContext =
    getCachedGUSD(cpUserId) ??
    (await fetchGUSDWithRefresh(cpUserId, user, req, res, 'requireChcContext'));

  if (!cpContext) {
    res.status(503).json({
      error: 'Identity service unavailable',
      error_code: 'GUSD_UNAVAILABLE',
    });
    return;
  }

  const orgFeatures = cpContext.chcSessionDetails.orgFeatures;

  if (!orgFeatures[tenantId]?.includes(LIBRECHAT_ORG_FEATURE)) {
    logger.warn(
      `[requireChcContext] Tenant ${tenantId} does not have ${LIBRECHAT_ORG_FEATURE} for cpUserId=${cpUserId}`,
    );
    invalidateSession(req, res);
    res.status(403).json({
      error: 'LibreChat is not enabled for the current organization',
      error_code: 'TENANT_NOT_ELIGIBLE',
    });
    return;
  }

  req.chcUserId = cpUserId;
  req.tenantId = tenantId;
  req.cpContext = cpContext;

  return void tenantStorage.run({ tenantId }, async () => {
    next();
  });
}
