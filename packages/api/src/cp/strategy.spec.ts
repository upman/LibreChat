import { resolveChcStrategyUser } from './strategy';

import type { IUser } from '@librechat/data-schemas';
import type { StrategyUserMethods, StrategyLookupResult } from './strategy';

jest.mock('@librechat/data-schemas', () => ({
  runAsSystem: (fn: () => unknown) => fn(),
}));

function buildUser(overrides: Partial<IUser> = {}): IUser {
  return {
    _id: 'user-1',
    email: 'alice@example.com',
    emailVerified: true,
    provider: 'openid',
    openidId: 'oid-123',
    ...overrides,
  } as unknown as IUser;
}

function buildMethods(overrides: Partial<StrategyUserMethods> = {}): StrategyUserMethods {
  return {
    findUser: jest
      .fn<Promise<IUser | null>, [Record<string, unknown>, (string | string[] | null)?]>()
      .mockResolvedValue(null),
    findUsers: jest
      .fn<
        Promise<IUser[]>,
        [
          Record<string, unknown>,
          (string | string[] | null)?,
          { limit?: number; sort?: Record<string, 1 | -1> }?,
        ]
      >()
      .mockResolvedValue([]),
    ...overrides,
  };
}

describe('resolveChcStrategyUser', () => {
  it('returns per-tenant doc from sorted query without calling findOpenIDUser', async () => {
    const tenantUser = buildUser({ email: 'alice@example.com' });
    const methods = buildMethods({
      findUsers: jest.fn().mockResolvedValue([tenantUser]),
    });
    const findOpenIDUser = jest.fn<Promise<StrategyLookupResult>, [Record<string, unknown>]>();

    const result = await resolveChcStrategyUser(findOpenIDUser, {
      ...methods,
      email: 'alice@example.com',
      openidId: 'oid-123',
    });

    expect(result).toEqual({ user: tenantUser, error: null, migration: false });
    expect(findOpenIDUser).not.toHaveBeenCalled();
  });

  it('falls through to findOpenIDUser when sorted query returns empty (first-time login)', async () => {
    const fallbackUser = buildUser({ email: 'bob@example.com' });
    const methods = buildMethods({
      findUsers: jest.fn().mockResolvedValue([]),
    });
    const findOpenIDUser = jest
      .fn<Promise<StrategyLookupResult>, [Record<string, unknown>]>()
      .mockResolvedValue({ user: fallbackUser, error: null, migration: false });

    const result = await resolveChcStrategyUser(findOpenIDUser, {
      ...methods,
      email: 'bob@example.com',
      openidId: 'oid-456',
    });

    expect(result).toEqual({ user: fallbackUser, error: null, migration: false });
    expect(findOpenIDUser).toHaveBeenCalledTimes(1);
    expect(findOpenIDUser).toHaveBeenCalledWith(
      expect.objectContaining({
        findUser: methods.findUser,
        email: 'bob@example.com',
        openidId: 'oid-456',
        strategyName: 'openIdJwtLogin',
      }),
    );
  });

  it('returns user from findOpenIDUser on fallback path', async () => {
    const fallbackUser = buildUser();
    const methods = buildMethods();
    const findOpenIDUser = jest
      .fn<Promise<StrategyLookupResult>, [Record<string, unknown>]>()
      .mockResolvedValue({ user: fallbackUser, error: null, migration: false });

    const result = await resolveChcStrategyUser(findOpenIDUser, {
      ...methods,
      email: 'alice@example.com',
      openidId: 'oid-123',
    });

    expect(result.user).toBe(fallbackUser);
    expect(result.error).toBeNull();
  });

  it('returns null user when both paths find nothing', async () => {
    const methods = buildMethods();
    const findOpenIDUser = jest
      .fn<Promise<StrategyLookupResult>, [Record<string, unknown>]>()
      .mockResolvedValue({ user: null, error: null, migration: false });

    const result = await resolveChcStrategyUser(findOpenIDUser, {
      ...methods,
      email: 'nobody@example.com',
      openidId: 'oid-nope',
    });

    expect(result).toEqual({ user: null, error: null, migration: false });
  });

  it('passes through error from findOpenIDUser on fallback path', async () => {
    const methods = buildMethods();
    const findOpenIDUser = jest
      .fn<Promise<StrategyLookupResult>, [Record<string, unknown>]>()
      .mockResolvedValue({ user: null, error: 'User blocked', migration: false });

    const result = await resolveChcStrategyUser(findOpenIDUser, {
      ...methods,
      email: 'blocked@example.com',
      openidId: 'oid-blocked',
    });

    expect(result).toEqual({ user: null, error: 'User blocked', migration: false });
  });

  it('propagates errors thrown by findUsers', async () => {
    const dbError = new Error('connection lost');
    const methods = buildMethods({
      findUsers: jest.fn().mockRejectedValue(dbError),
    });
    const findOpenIDUser = jest.fn<Promise<StrategyLookupResult>, [Record<string, unknown>]>();

    await expect(
      resolveChcStrategyUser(findOpenIDUser, {
        ...methods,
        email: 'alice@example.com',
        openidId: 'oid-123',
      }),
    ).rejects.toThrow('connection lost');
  });

  it('skips sorted query and goes straight to findOpenIDUser when no openidId is provided', async () => {
    const fallbackUser = buildUser({ email: 'nooid@example.com' });
    const methods = buildMethods();
    const findOpenIDUser = jest
      .fn<Promise<StrategyLookupResult>, [Record<string, unknown>]>()
      .mockResolvedValue({ user: fallbackUser, error: null, migration: false });

    const result = await resolveChcStrategyUser(findOpenIDUser, {
      ...methods,
      email: 'nooid@example.com',
    });

    expect(methods.findUsers).not.toHaveBeenCalled();
    expect(findOpenIDUser).toHaveBeenCalledTimes(1);
    expect(result.user).toBe(fallbackUser);
  });

  it('uses sort: { updatedAt: -1 } and limit: 1 in the sorted query', async () => {
    const tenantUser = buildUser();
    const findUsersSpy = jest.fn().mockResolvedValue([tenantUser]);
    const methods = buildMethods({ findUsers: findUsersSpy });
    const findOpenIDUser = jest.fn<Promise<StrategyLookupResult>, [Record<string, unknown>]>();

    await resolveChcStrategyUser(findOpenIDUser, {
      ...methods,
      email: 'alice@example.com',
      openidId: 'oid-123',
      idOnTheSource: 'src-1',
    });

    expect(findUsersSpy).toHaveBeenCalledWith(
      { openidId: 'oid-123', tenantId: { $exists: true } },
      null,
      { sort: { updatedAt: -1 }, limit: 1 },
    );
  });
});
