import { tenantStorage, logger } from '@librechat/data-schemas';

import type { Response, NextFunction } from 'express';
import type { ResolvedCpContext } from './types';
import type { ServerRequest } from '~/types/http';

import { getCachedGUSD } from './cache';
import { fetchGUSDWithRefresh, sendChcReauthRequiredResponse } from './refresh';

/**
 * Lighter CHC middleware for org-recovery endpoints (`/api/cp/orgs`, `/api/cp/switch-org`).
 *
 * Validates the CHC identity (idOnTheSource must exist) and fetches fresh GUSD data
 * (sharing the 60 s in-memory cache with `requireChcContext`), but does NOT
 * enforce current-tenant `FT_ORG_LIBRECHAT` eligibility — so a user whose
 * current org lost access can still list/switch to other eligible orgs.
 *
 * If the user has a valid tenantId, wraps downstream in ALS context.
 * If not (e.g., no org resolved yet), proceeds without ALS (recovery path).
 */
export async function requireChcIdentity(
  req: ServerRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const user = req.user;

  if (!user?.idOnTheSource) {
    logger.warn('[requireChcIdentity] No idOnTheSource on authenticated user');
    res.status(401).json({
      error: 'CHC identity not resolved. Please log in again.',
      error_code: 'CHC_IDENTITY_MISSING',
    });
    return;
  }

  const cpUserId = user.idOnTheSource;
  let cpContext: ResolvedCpContext | null | undefined;
  try {
    cpContext =
      getCachedGUSD(cpUserId) ??
      (await fetchGUSDWithRefresh(cpUserId, user, req, res, 'requireChcIdentity'));
  } catch (err) {
    if (sendChcReauthRequiredResponse(err, res, 'requireChcIdentity', cpUserId)) {
      return;
    }
    throw err;
  }

  if (!cpContext) {
    res.status(503).json({
      error: 'Identity service unavailable',
      error_code: 'GUSD_UNAVAILABLE',
    });
    return;
  }

  req.chcUserId = cpUserId;
  req.cpContext = cpContext;

  const tenantId = user.tenantId || user.lastTenantId;
  if (tenantId) {
    req.tenantId = tenantId;
    return void tenantStorage.run({ tenantId }, async () => {
      next();
    });
  }

  next();
}
