import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { logger, runAsSystem } from '@librechat/data-schemas';

import type { JwtPayload } from 'jsonwebtoken';
import type { IUser } from '@librechat/data-schemas';
import type { MintedToken, RefreshTokenset } from '~/auth/refresh';
import type { RefreshUserMethods } from './refresh';

import { AdminRefreshError } from '~/auth/refresh';
import { refreshChcContext } from './refresh';

const SESSION_KEY_PREFIX = 'chc-admin-oauth:';
const SAFE_USER_PROJECTION = '-password -__v -totpSecret -backupCodes';

interface ChcRefreshTokenset extends RefreshTokenset {
  expires_at?: number;
  expires_in?: number;
  claims: () => { sub?: string; iss?: string; exp?: number };
}

export interface ChcAdminSession {
  userId: string;
  accessToken: string;
  expiresAt: number;
  receivedAt: number;
}

export interface ChcAdminSessionStore {
  get: (key: string) => Promise<ChcAdminSession | undefined>;
  set: (key: string, value: ChcAdminSession, ttl?: number) => Promise<unknown>;
}

export interface ChcAdminSessionDeps {
  store: ChcAdminSessionStore;
  jwtSecret: string;
  maxAgeMs?: number;
}

export interface ChcAdminSessionUserDeps extends ChcAdminSessionDeps, RefreshUserMethods {}

export interface ChcAdminRefreshHooks {
  mintToken: (user: IUser, tokenset: RefreshTokenset) => Promise<MintedToken>;
  onRefreshSuccess: (user: IUser, tokenset: RefreshTokenset) => Promise<void>;
}

function sessionKey(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}${sessionId}`;
}

function newSessionId(): string {
  return crypto.randomBytes(32).toString('hex');
}

function normalizeExpiresAt(expiresAt: number): number {
  return expiresAt < 100000000000 ? expiresAt * 1000 : expiresAt;
}

function readJwtExpiry(token: string | undefined): number | undefined {
  if (!token) {
    return undefined;
  }
  try {
    const decoded = jwt.decode(token);
    if (decoded && typeof decoded === 'object' && typeof decoded.exp === 'number') {
      return decoded.exp * 1000;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readTokensetExpiry(tokenset: ChcRefreshTokenset, maxAgeMs?: number): number {
  const providerExpiry =
    readJwtExpiry(tokenset.access_token) ??
    (typeof tokenset.expires_at === 'number'
      ? normalizeExpiresAt(tokenset.expires_at)
      : undefined) ??
    (typeof tokenset.expires_in === 'number' ? Date.now() + tokenset.expires_in * 1000 : undefined);

  let tokenExpiry = providerExpiry;
  if (typeof tokenExpiry !== 'number') {
    const exp = tokenset.claims?.()?.exp;
    tokenExpiry = typeof exp === 'number' ? exp * 1000 : undefined;
  }
  if (typeof tokenExpiry !== 'number') {
    throw new AdminRefreshError(
      'CLAIMS_INCOMPLETE',
      502,
      'IdP tokenset is missing the required access-token expiry',
    );
  }

  return maxAgeMs ? Math.min(tokenExpiry, Date.now() + maxAgeMs) : tokenExpiry;
}

function secondsUntil(expiresAt: number): number {
  return Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
}

async function writeSession(
  store: ChcAdminSessionStore,
  sessionId: string,
  session: ChcAdminSession,
): Promise<void> {
  await store.set(sessionKey(sessionId), session, Math.max(1000, session.expiresAt - Date.now()));
}

function signSessionBearer(user: IUser, sessionId: string, expiresAt: number, jwtSecret: string) {
  return jwt.sign(
    {
      id: user._id?.toString(),
      username: user.username,
      provider: user.provider,
      email: user.email,
      chcAdminSessionId: sessionId,
    },
    jwtSecret,
    { expiresIn: secondsUntil(expiresAt) },
  );
}

export async function mintChcAdminSessionToken(
  user: IUser,
  tokenset: RefreshTokenset,
  deps: ChcAdminSessionDeps,
): Promise<MintedToken> {
  if (!deps.jwtSecret) {
    throw new AdminRefreshError(
      'JWT_SECRET_MISSING',
      500,
      'JWT_SECRET is required to mint CHC admin session bearers',
    );
  }

  const ts = tokenset as ChcRefreshTokenset;
  const userId = user._id?.toString();
  if (!userId) {
    throw new AdminRefreshError(
      'USER_INCOMPLETE',
      500,
      'Cannot mint CHC admin session bearer without user._id',
    );
  }

  const accessToken = ts.access_token;
  if (!accessToken) {
    throw new AdminRefreshError(
      'IDP_INCOMPLETE',
      502,
      'IdP tokenset is missing access_token (required in CHC mode)',
    );
  }

  const expiresAt = readTokensetExpiry(ts, deps.maxAgeMs);
  const sessionId = newSessionId();
  await writeSession(deps.store, sessionId, {
    userId,
    accessToken,
    expiresAt,
    receivedAt: Date.now(),
  });

  logger.debug('[admin/oauth] CHC mode: minted session-bound admin bearer');
  return { token: signSessionBearer(user, sessionId, expiresAt, deps.jwtSecret), expiresAt };
}

interface ChcAdminSessionPayload extends JwtPayload {
  id?: string;
  chcAdminSessionId?: string;
}

function verifySessionBearer(token: string, jwtSecret: string): ChcAdminSessionPayload | null {
  try {
    const payload = jwt.verify(token, jwtSecret) as ChcAdminSessionPayload | string;
    if (typeof payload === 'string') {
      return null;
    }
    if (!payload.id || !payload.chcAdminSessionId) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export async function resolveChcAdminSessionUser(
  bearerToken: string | undefined,
  deps: ChcAdminSessionUserDeps,
): Promise<IUser | null> {
  if (!bearerToken) {
    return null;
  }

  const payload = verifySessionBearer(bearerToken, deps.jwtSecret);
  if (!payload) {
    return null;
  }

  const session = await deps.store.get(sessionKey(payload.chcAdminSessionId!));
  if (!session || session.userId !== payload.id || Date.now() > session.expiresAt) {
    return null;
  }

  const user = await runAsSystem(() => deps.getUserById(payload.id!, SAFE_USER_PROJECTION));
  if (!user) {
    return null;
  }

  user.id = user._id.toString();
  user.federatedTokens = {
    access_token: session.accessToken,
    expires_at: Math.floor(session.expiresAt / 1000),
  };
  return user;
}

export function buildChcAdminRefreshHooks(deps: ChcAdminSessionUserDeps): ChcAdminRefreshHooks {
  return {
    mintToken: (user, tokenset) => mintChcAdminSessionToken(user, tokenset, deps),
    onRefreshSuccess: async (user, tokenset) => {
      const accessToken = (tokenset as ChcRefreshTokenset).access_token;
      if (!accessToken) {
        return;
      }
      await refreshChcContext(user, accessToken, deps);
    },
  };
}
