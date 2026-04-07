import { tenantStorage, logger } from '@librechat/data-schemas';

import type { Response, NextFunction } from 'express';
import type { ResolvedCpContext } from './types';
import type { ServerRequest } from '~/types/http';

import { fetchUserSessionDetails } from './client';
import { resolveGUSD, LIBRECHAT_ORG_FEATURE } from './resolve';
import { getCachedGUSD, getOrFetchGUSD } from './cache';

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

  const tenantId = user.tenantId || user.lastTenantId;
  if (!tenantId) {
    logger.warn(`[requireChcContext] No tenant resolved for cpUserId=${user.idOnTheSource}`);
    invalidateSession(req, res);
    res.status(403).json({
      error: 'No organization resolved for this user',
      error_code: 'TENANT_NOT_RESOLVED',
    });
    return;
  }

  let cpContext = getCachedGUSD(user.idOnTheSource);

  if (!cpContext) {
    const accessToken = user.federatedTokens?.access_token ?? user.openidTokens?.access_token;
    if (accessToken) {
      try {
        cpContext = await getOrFetchGUSD(user.idOnTheSource, async () => {
          const gusd = await fetchUserSessionDetails(accessToken);
          return resolveGUSD(gusd);
        });
      } catch (err) {
        logger.error('[requireChcContext] GUSD call failed — no fallback', {
          cpUserId: user.idOnTheSource,
          error: (err as Error).message,
        });
        res.status(503).json({
          error: 'Identity service unavailable',
          error_code: 'GUSD_UNAVAILABLE',
        });
        return;
      }
    }
  }

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
      `[requireChcContext] Tenant ${tenantId} does not have ${LIBRECHAT_ORG_FEATURE} for cpUserId=${user.idOnTheSource}`,
    );
    invalidateSession(req, res);
    res.status(403).json({
      error: 'LibreChat is not enabled for the current organization',
      error_code: 'TENANT_NOT_ELIGIBLE',
    });
    return;
  }

  req.chcUserId = user.idOnTheSource;
  req.tenantId = tenantId;
  req.cpContext = cpContext;

  return void tenantStorage.run({ tenantId }, async () => {
    next();
  });
}
