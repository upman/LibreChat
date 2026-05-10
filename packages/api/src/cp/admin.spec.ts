import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';

import type { IUser } from '@librechat/data-schemas';
import type { JwtPayload } from 'jsonwebtoken';
import type { RefreshTokenset } from '~/auth/refresh';
import type { ChcAdminSession, ChcAdminSessionStore } from './admin';

import {
  buildChcAdminRefreshHooks,
  mintChcAdminSessionToken,
  resolveChcAdminSessionUser,
} from './admin';

const mockRunAsSystem = jest.fn((fn: () => Promise<unknown>) => fn());
const mockRefreshChcContext = jest.fn<Promise<void>, [IUser, string, unknown]>(
  async () => undefined,
);

jest.mock(
  '@librechat/data-schemas',
  () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    runAsSystem: (fn: () => Promise<unknown>) => mockRunAsSystem(fn),
  }),
  { virtual: true },
);

jest.mock(
  'librechat-data-provider',
  () => ({
    ErrorTypes: { AUTH_FAILED: 'AUTH_FAILED' },
  }),
  { virtual: true },
);

jest.mock('./refresh', () => ({
  refreshChcContext: (user: IUser, accessToken: string, methods: unknown) =>
    mockRefreshChcContext(user, accessToken, methods),
}));

const JWT_SECRET = 'test-secret';
const FUTURE_EXP_S = Math.floor(Date.now() / 1000) + 3600;

interface StoredSession {
  value: ChcAdminSession;
  ttl?: number;
}

function makeStore() {
  const entries = new Map<string, StoredSession>();
  const store: ChcAdminSessionStore = {
    get: jest.fn(async (key: string) => entries.get(key)?.value),
    set: jest.fn(async (key: string, value: ChcAdminSession, ttl?: number) => {
      entries.set(key, { value, ttl });
      return true;
    }),
  };
  return { store, entries };
}

function makeUser(overrides: Partial<IUser> = {}): IUser {
  const _id = overrides._id ?? new Types.ObjectId();
  return {
    _id,
    email: 'admin@example.com',
    name: 'Admin User',
    username: 'admin',
    role: 'ADMIN',
    provider: 'openid',
    openidId: 'sub-1',
    tenantId: 'org-1',
    idOnTheSource: 'cp-user-1',
    ...overrides,
  } as unknown as IUser;
}

function makeTokenset(
  overrides: Partial<
    RefreshTokenset & { id_token?: string; expires_at?: number; expires_in?: number }
  > = {},
) {
  return {
    access_token: 'cp-access',
    refresh_token: 'refresh-1',
    id_token: 'id-token-1',
    claims: () => ({ sub: 'sub-1', exp: FUTURE_EXP_S }),
    ...overrides,
  };
}

describe('CHC admin OAuth session helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('mints a session-bound bearer and resolves it back to a user with federated tokens', async () => {
    const { store, entries } = makeStore();
    const user = makeUser();
    const getUserById = jest.fn().mockResolvedValue({ ...user });

    const minted = await mintChcAdminSessionToken(user, makeTokenset(), {
      store,
      jwtSecret: JWT_SECRET,
    });

    const payload = jwt.verify(minted.token, JWT_SECRET) as JwtPayload;
    expect(typeof payload.chcAdminSessionId).toBe('string');
    expect(entries.size).toBe(1);
    expect([...entries.values()][0].value).toMatchObject({
      userId: user._id!.toString(),
      accessToken: 'cp-access',
      expiresAt: FUTURE_EXP_S * 1000,
    });
    expect([...entries.values()][0].value).not.toHaveProperty('refreshToken');
    expect([...entries.values()][0].value).not.toHaveProperty('idToken');
    expect([...entries.values()][0].ttl).toBeGreaterThan(0);

    const resolved = await resolveChcAdminSessionUser(minted.token, {
      store,
      jwtSecret: JWT_SECRET,
      getUserById,
      updateUser: jest.fn(),
    });

    expect(mockRunAsSystem).toHaveBeenCalledTimes(1);
    expect(getUserById).toHaveBeenCalledWith(
      user._id!.toString(),
      '-password -__v -totpSecret -backupCodes',
    );
    expect(resolved?.federatedTokens).toEqual({
      access_token: 'cp-access',
      expires_at: FUTURE_EXP_S,
    });
  });

  it('does not resolve a normal LibreChat JWT without a CHC admin session id', async () => {
    const { store } = makeStore();
    const token = jwt.sign({ id: 'user-1' }, JWT_SECRET);

    await expect(
      resolveChcAdminSessionUser(token, {
        store,
        jwtSecret: JWT_SECRET,
        getUserById: jest.fn(),
        updateUser: jest.fn(),
      }),
    ).resolves.toBeNull();
  });

  it('does not resolve when the backing session is absent', async () => {
    const { store } = makeStore();
    const token = jwt.sign({ id: 'user-1', chcAdminSessionId: 'missing' }, JWT_SECRET);

    await expect(
      resolveChcAdminSessionUser(token, {
        store,
        jwtSecret: JWT_SECRET,
        getUserById: jest.fn(),
        updateUser: jest.fn(),
      }),
    ).resolves.toBeNull();
  });

  it('uses the CP access-token expiry for the admin bearer when the access token is a JWT', async () => {
    const { store, entries } = makeStore();
    const user = makeUser();
    const accessExp = FUTURE_EXP_S + 600;
    const accessToken = jwt.sign({ exp: accessExp }, 'access-secret');

    const minted = await mintChcAdminSessionToken(
      user,
      makeTokenset({ access_token: accessToken }),
      {
        store,
        jwtSecret: JWT_SECRET,
      },
    );

    expect(minted.expiresAt).toBe(accessExp * 1000);
    expect([...entries.values()][0].value.expiresAt).toBe(accessExp * 1000);
  });

  it('caps the admin bearer lifetime to the configured session max age', async () => {
    const now = 1700000000000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const { store } = makeStore();

      const minted = await mintChcAdminSessionToken(makeUser(), makeTokenset(), {
        store,
        jwtSecret: JWT_SECRET,
        maxAgeMs: 60_000,
      });

      expect(minted.expiresAt).toBe(now + 60_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('uses expires_in without requiring token claims for bearer expiry', async () => {
    const now = 1700000000000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const { store } = makeStore();

      const minted = await mintChcAdminSessionToken(
        makeUser(),
        makeTokenset({
          expires_in: 120,
          claims: () => {
            throw new Error('claims unavailable');
          },
        }),
        {
          store,
          jwtSecret: JWT_SECRET,
        },
      );

      expect(minted.expiresAt).toBe(now + 120_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('rejects tokensets without an expiry claim', async () => {
    const { store } = makeStore();

    await expect(
      mintChcAdminSessionToken(makeUser(), makeTokenset({ claims: () => ({ sub: 'sub-1' }) }), {
        store,
        jwtSecret: JWT_SECRET,
      }),
    ).rejects.toMatchObject({ code: 'CLAIMS_INCOMPLETE' });
  });

  it('refresh hooks mint a bearer and reconcile CHC context with the access token', async () => {
    const { store } = makeStore();
    const deps = {
      store,
      jwtSecret: JWT_SECRET,
      getUserById: jest.fn(),
      updateUser: jest.fn(),
    };
    const hooks = buildChcAdminRefreshHooks(deps);
    const user = makeUser();
    const tokenset = makeTokenset();

    const minted = await hooks.mintToken(user, tokenset);
    await hooks.onRefreshSuccess(user, tokenset);

    expect(jwt.verify(minted.token, JWT_SECRET)).toMatchObject({
      id: user._id!.toString(),
      email: user.email,
    });
    expect(mockRefreshChcContext).toHaveBeenCalledWith(user, 'cp-access', deps);
  });
});
