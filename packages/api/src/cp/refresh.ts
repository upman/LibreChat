import jwt from 'jsonwebtoken';
import { runAsSystem, runAsTenant, logger } from '@librechat/data-schemas';

import type { Response } from 'express';
import type { IUser } from '@librechat/data-schemas';

import { fetchUserSessionDetails } from './client';
import { resolveGUSD } from './resolve';
import { resolveTenant } from './tenant';
import { getCachedGUSD, getOrFetchGUSD } from './cache';

/** 7 days in milliseconds — matches typical OpenID refresh token lifetime. */
const CHC_TOKEN_COOKIE_MAX_AGE =
  Number(process.env.CHC_TOKEN_COOKIE_MAX_AGE) || 7 * 24 * 60 * 60 * 1000;

export interface RefreshUserMethods {
  getUserById: (id: string, projection: string) => Promise<IUser | null>;
  updateUser: (id: string, data: Partial<IUser>) => Promise<IUser | null>;
}

/**
 * Set (or refresh) the CHC `token` cookie that carries the per-tenant user `_id`.
 *
 * The refresh controller uses this cookie to unambiguously resolve the
 * active session's per-tenant user doc. Must be called on login AND
 * on org-switch so the cookie always points to the current tenant user.
 *
 * Cookie lifetime defaults to 7 days (configurable via `CHC_TOKEN_COOKIE_MAX_AGE`)
 * to outlive the short-lived access token and survive browser restarts.
 */
export async function setChcTokenCookie(
  user: IUser,
  res: Response,
  deps: {
    generateToken: (user: IUser, expiresIn?: number) => Promise<string>;
    shouldUseSecureCookie: () => boolean;
  },
): Promise<void> {
  const lcToken = await deps.generateToken(user, CHC_TOKEN_COOKIE_MAX_AGE);
  res.cookie('token', lcToken, {
    httpOnly: true,
    secure: deps.shouldUseSecureCookie(),
    sameSite: 'strict',
    maxAge: CHC_TOKEN_COOKIE_MAX_AGE,
  });
}

/**
 * Resolve the per-tenant user from a LibreChat JWT cookie.
 *
 * In CHC mode, per-tenant user docs share the same openidId, so
 * `findOpenIDUser` is ambiguous. Instead, decode the LibreChat JWT
 * (ignoring expiration — the OpenID refresh grant already validated
 * the session) to extract the per-tenant user `_id`.
 */
export async function resolveChcRefreshUser(
  tokenCookie: string | undefined,
  jwtSecret: string,
  methods: RefreshUserMethods,
): Promise<IUser | null> {
  if (!tokenCookie) {
    return null;
  }

  let payload: { id?: string } | null = null;
  try {
    payload = jwt.verify(tokenCookie, jwtSecret, { ignoreExpiration: true }) as { id?: string };
  } catch (err) {
    logger.error('[resolveChcRefreshUser] Token verification failed', err);
    return null;
  }

  const userId = payload?.id;
  if (!userId) {
    return null;
  }

  try {
    return await runAsSystem(() =>
      methods.getUserById(userId, '-password -__v -totpSecret -backupCodes'),
    );
  } catch (err) {
    logger.error(`[resolveChcRefreshUser] User lookup failed for id=${userId}`, err);
    return null;
  }
}

/**
 * Re-derive role and tenant from fresh (or cached) GUSD data and
 * persist any changes to the per-tenant user doc.
 *
 * Uses the shared 60s GUSD cache — no extra CP call if the cache
 * is warm from recent per-request middleware activity. Always runs
 * the role derivation (even on cache hit) so admin promotions and
 * demotions propagate at every token refresh.
 */
export async function refreshChcContext(
  user: IUser,
  accessToken: string,
  methods: RefreshUserMethods,
): Promise<{ role?: string } | undefined> {
  const userTenantId = user.tenantId || user.lastTenantId;
  if (!userTenantId || !user.idOnTheSource) {
    return undefined;
  }

  try {
    const cpContext =
      getCachedGUSD(user.idOnTheSource) ??
      (await getOrFetchGUSD(user.idOnTheSource, async () => {
        const gusd = await fetchUserSessionDetails(accessToken);
        return resolveGUSD(gusd);
      }));

    const tenant = resolveTenant({
      lastTenantId: user.lastTenantId,
      eligibleOrgIds: cpContext.eligibleOrgIds,
    });

    const newRole = cpContext.adminOrgIds.includes(userTenantId) ? 'ADMIN' : 'USER';
    const roleChanged = user.role !== newRole;
    const tenantChanged = !!tenant.tenantId && user.lastTenantId !== tenant.tenantId;

    if (!roleChanged && !tenantChanged) {
      return undefined;
    }

    const updatePayload: Partial<IUser> = {
      idOnTheSource: cpContext.cpUserId,
      role: newRole,
      resolvedAt: new Date(cpContext.resolvedAt),
      ...(tenant.tenantId ? { lastTenantId: tenant.tenantId } : {}),
    };

    await runAsTenant(userTenantId, () => methods.updateUser(user._id.toString(), updatePayload));

    logger.debug(
      `[refreshChcContext] Updated user=${user.email} role=${newRole} tenantId=${tenant.tenantId ?? 'none'}`,
    );

    return { role: newRole };
  } catch (err) {
    logger.error('[refreshChcContext] GUSD call failed during refresh:', err);
    return undefined;
  }
}
