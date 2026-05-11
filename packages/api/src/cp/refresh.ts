import jwt from 'jsonwebtoken';
import { ErrorTypes } from 'librechat-data-provider';
import { runAsSystem, runAsTenant, logger } from '@librechat/data-schemas';

import type { Response } from 'express';
import type { IUser } from '@librechat/data-schemas';
import type { ResolvedCpContext } from './types';
import type { ServerRequest } from '~/types/http';

import { fetchUserSessionDetails, GUSDAuthError } from './client';
import { resolveGUSD } from './resolve';
import { resolveTenant } from './tenant';
import { getCachedGUSD, getOrFetchGUSD, GUSD_TTL_S } from './cache';

export type InlineRefreshHandler = (
  req: ServerRequest,
  res: Response,
) => Promise<InlineRefreshResult | null>;

export const CHC_REAUTH_REQUIRED = ErrorTypes.CHC_REAUTH_REQUIRED;
export const CHC_REAUTH_LOGIN_URL = '/oauth/openid?prompt=login';
export const MFA_REQUIRED = ErrorTypes.MFA_REQUIRED;

interface InlineRefreshSuccess {
  accessToken: string;
}

/** Public result contract for inline refresh handlers. */
export type InlineRefreshResult = InlineRefreshSuccess;

interface ErrorShape {
  error?: unknown;
  error_code?: unknown;
  errorCode?: unknown;
  code?: unknown;
  cause?: unknown;
  reason?: unknown;
  login_url?: unknown;
  loginUrl?: unknown;
  response?: {
    data?: unknown;
  };
}

export class ChcReauthRequiredError extends Error {
  errorCode = CHC_REAUTH_REQUIRED;
  loginUrl = CHC_REAUTH_LOGIN_URL;
  reason: typeof MFA_REQUIRED;

  constructor(reason: typeof MFA_REQUIRED = MFA_REQUIRED, loginUrl = CHC_REAUTH_LOGIN_URL) {
    super('ClickHouse Cloud interactive reauthentication required');
    this.name = 'ChcReauthRequiredError';
    this.reason = reason;
    this.loginUrl = loginUrl;
    Object.setPrototypeOf(this, ChcReauthRequiredError.prototype);
  }
}

function asErrorShape(value: unknown): ErrorShape | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as ErrorShape;
}

function isMfaValue(value: unknown): value is typeof MFA_REQUIRED {
  return value === MFA_REQUIRED;
}

export function isMfaRequiredError(error: unknown, depth = 0): boolean {
  if (depth > 5) {
    return false;
  }

  const shape = asErrorShape(error);
  if (!shape) {
    return false;
  }

  if (isMfaValue(shape.error) || isMfaValue(shape.error_code) || isMfaValue(shape.code)) {
    return true;
  }

  if (shape.cause && isMfaRequiredError(shape.cause, depth + 1)) {
    return true;
  }

  return shape.response?.data ? isMfaRequiredError(shape.response.data, depth + 1) : false;
}

function isChcReauthCode(value: unknown): boolean {
  return value === CHC_REAUTH_REQUIRED;
}

function getChcReauthLoginUrl(shape: ErrorShape): string {
  const loginUrl = shape.loginUrl ?? shape.login_url;
  return typeof loginUrl === 'string' && loginUrl.trim() ? loginUrl : CHC_REAUTH_LOGIN_URL;
}

export function toChcReauthRequiredError(error: unknown): ChcReauthRequiredError | null {
  if (error instanceof ChcReauthRequiredError) {
    return error;
  }

  const shape = asErrorShape(error);
  if (!shape) {
    return null;
  }

  if (
    !isChcReauthCode(shape.errorCode) &&
    !isChcReauthCode(shape.error_code) &&
    !isChcReauthCode(shape.code)
  ) {
    return null;
  }

  const reason = isMfaValue(shape.reason) ? shape.reason : MFA_REQUIRED;
  return new ChcReauthRequiredError(reason, getChcReauthLoginUrl(shape));
}

export function isChcReauthRequiredError(error: unknown): boolean {
  return toChcReauthRequiredError(error) !== null;
}

export function sendChcReauthRequiredResponse(
  error: unknown,
  res: Response,
  logLabel: string,
  cpUserId: string,
): boolean {
  const reauthError = toChcReauthRequiredError(error);
  if (!reauthError) {
    return false;
  }

  logger.warn(`[${logLabel}] chc_reauth_required`, {
    cpUserId,
    reason: reauthError.reason,
  });
  res.status(401).json({
    error: 'Interactive ClickHouse Cloud reauthentication required',
    error_code: CHC_REAUTH_REQUIRED,
    login_url: reauthError.loginUrl ?? CHC_REAUTH_LOGIN_URL,
  });
  return true;
}

let _inlineRefreshHandler: InlineRefreshHandler | null = null;

export function registerInlineRefreshHandler(handler: InlineRefreshHandler): void {
  _inlineRefreshHandler = handler;
}

/**
 * Clock-skew-resistant check for access-token staleness.
 *
 * Uses two values that each come from a **single** clock:
 * - `tokenLifetime` = `exp − iat` (provider clock only — skew cancels)
 * - elapsed = `Date.now() − receivedAt` (our clock only — skew cancels)
 *
 * Returns `false` when session data is missing (backward compat — the
 * reactive 401 path catches those cases).
 */
const STALE_BUFFER_S = GUSD_TTL_S;

export function isAccessTokenStale(req: ServerRequest): boolean {
  const { receivedAt, tokenLifetime } = req.session?.openidTokens ?? {};
  if (!receivedAt || !tokenLifetime) {
    return false;
  }
  const elapsedSeconds = (Date.now() - receivedAt) / 1000;
  return elapsedSeconds >= tokenLifetime - STALE_BUFFER_S;
}

/**
 * Coalesce concurrent inline refresh attempts for the same CP user.
 *
 * Only the first caller's req/res receives the updated session and cookies.
 * Coalesced joiners receive the accessToken string and complete their
 * current request, but their sessions are not updated. They self-correct
 * on the next request via the proactive staleness check, since receivedAt
 * was not updated in their session.
 */
const refreshInflight = new Map<string, Promise<string | null>>();

export async function coalescedInlineRefresh(
  cpUserId: string,
  req: ServerRequest,
  res: Response,
): Promise<string | null> {
  const handler = _inlineRefreshHandler;
  if (!handler) {
    return null;
  }

  const existing = refreshInflight.get(cpUserId);
  if (existing) {
    return existing;
  }

  const work = handler(req, res)
    .then((result) => {
      if (!result) {
        return null;
      }
      return result.accessToken;
    })
    .catch((err) => {
      const reauthError = toChcReauthRequiredError(err);
      if (reauthError) {
        throw reauthError;
      }
      logger.error('[coalescedInlineRefresh] handler threw', err);
      return null;
    })
    .finally(() => {
      refreshInflight.delete(cpUserId);
    });

  refreshInflight.set(cpUserId, work);
  return work;
}

function updateUserAccessToken(user: NonNullable<ServerRequest['user']>, token: string): void {
  if (user.federatedTokens) {
    user.federatedTokens.access_token = token;
  }
  if (user.openidTokens) {
    user.openidTokens.access_token = token;
  }
}

/**
 * Fetch GUSD with proactive staleness check and reactive 401 retry.
 *
 * Proactive: if the access token appears expired (clock-skew-resistant check),
 * refresh it before calling GUSD to avoid a wasted round-trip.
 *
 * Reactive: if GUSD returns 401 anyway (revoked token, clock skew, missing
 * session data for the proactive check), refresh and retry once.
 *
 * Returns `null` on any failure — callers should respond with 503.
 *
 * Worst case: 4 sequential network calls (proactive refresh, GUSD 401,
 * reactive refresh, GUSD retry) before giving up.
 */
export async function fetchGUSDWithRefresh(
  cpUserId: string,
  user: NonNullable<ServerRequest['user']>,
  req: ServerRequest,
  res: Response,
  logLabel: string,
): Promise<ResolvedCpContext | null> {
  const handler = _inlineRefreshHandler;
  let accessToken = user.federatedTokens?.access_token ?? user.openidTokens?.access_token;

  if (accessToken && handler && isAccessTokenStale(req)) {
    const refreshed = await coalescedInlineRefresh(cpUserId, req, res);
    if (refreshed) {
      updateUserAccessToken(user, refreshed);
      accessToken = refreshed;
    }
  }

  if (!accessToken) {
    return null;
  }

  const token = accessToken;
  try {
    return await getOrFetchGUSD(cpUserId, async () => {
      const gusd = await fetchUserSessionDetails(token);
      return resolveGUSD(gusd);
    });
  } catch (err) {
    if (err instanceof GUSDAuthError && handler) {
      const refreshed = await coalescedInlineRefresh(cpUserId, req, res);
      if (refreshed) {
        updateUserAccessToken(user, refreshed);
        try {
          return await getOrFetchGUSD(cpUserId, async () => {
            const gusd = await fetchUserSessionDetails(refreshed);
            return resolveGUSD(gusd);
          });
        } catch (retryErr) {
          logger.warn(`[${logLabel}] GUSD retry after refresh also failed`, {
            cpUserId,
            originalError: (err as Error).message,
            retryError: (retryErr as Error).message,
          });
        }
      } else {
        logger.error(`[${logLabel}] Inline refresh returned null after GUSD 401`, { cpUserId });
      }
    } else {
      logger.error(`[${logLabel}] GUSD call failed — no fallback`, {
        cpUserId,
        error: (err as Error).message,
      });
    }
    return null;
  }
}

/** Resets inflight-dedup map and registered handler. For testing only. */
export function _resetRefreshState(): void {
  refreshInflight.clear();
  _inlineRefreshHandler = null;
}

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
