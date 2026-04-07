import { getCachedGUSD, setCachedGUSD, getOrFetchGUSD, _clearGUSDCache } from './cache';

import type { ResolvedCpContext } from './types';

function buildContext(overrides: Partial<ResolvedCpContext> = {}): ResolvedCpContext {
  return {
    cpUserId: 'chc-1',
    email: 'user@example.com',
    name: 'Test User',
    chcSessionDetails: { organizations: {}, orgFeatures: {}, orgRolesV2: {} },
    eligibleOrgIds: ['org-1'],
    adminOrgIds: [],
    resolvedAt: Date.now(),
    ...overrides,
  } as ResolvedCpContext;
}

describe('getCachedGUSD / setCachedGUSD', () => {
  beforeEach(() => {
    _clearGUSDCache();
    jest.restoreAllMocks();
  });

  it('returns undefined on cache miss', () => {
    expect(getCachedGUSD('nonexistent')).toBeUndefined();
  });

  it('returns data on cache hit within TTL', () => {
    const ctx = buildContext();
    setCachedGUSD('chc-1', ctx);

    expect(getCachedGUSD('chc-1')).toBe(ctx);
  });

  it('returns undefined when cache entry has expired', () => {
    const ctx = buildContext();
    setCachedGUSD('chc-1', ctx);

    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);

    expect(getCachedGUSD('chc-1')).toBeUndefined();
  });

  it('evicts oldest entry via FIFO when at max size', () => {
    for (let i = 0; i < 10_000; i++) {
      setCachedGUSD(`user-${i}`, buildContext({ cpUserId: `user-${i}` }));
    }

    expect(getCachedGUSD('user-0')).toBeDefined();

    setCachedGUSD('user-new', buildContext({ cpUserId: 'user-new' }));

    expect(getCachedGUSD('user-0')).toBeUndefined();
    expect(getCachedGUSD('user-new')).toBeDefined();
  });

  it('does NOT evict when refreshing an existing key at max capacity', () => {
    for (let i = 0; i < 10_000; i++) {
      setCachedGUSD(`user-${i}`, buildContext({ cpUserId: `user-${i}` }));
    }

    setCachedGUSD('user-5000', buildContext({ cpUserId: 'user-5000-refreshed' }));

    expect(getCachedGUSD('user-0')).toBeDefined();
    expect(getCachedGUSD('user-5000')?.cpUserId).toBe('user-5000-refreshed');
  });
});

describe('getOrFetchGUSD', () => {
  beforeEach(() => {
    _clearGUSDCache();
  });

  it('coalesces concurrent calls with only one fetchFn invocation', async () => {
    const ctx = buildContext();
    let resolveGate: (v: ResolvedCpContext) => void;
    const gate = new Promise<ResolvedCpContext>((r) => {
      resolveGate = r;
    });
    const fetchFn = jest.fn().mockReturnValue(gate);

    const p1 = getOrFetchGUSD('chc-1', fetchFn);
    const p2 = getOrFetchGUSD('chc-1', fetchFn);

    resolveGate!(ctx);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(r1).toBe(ctx);
    expect(r2).toBe(ctx);
  });

  it('caches result after successful fetch', async () => {
    const ctx = buildContext();
    const fetchFn = jest.fn().mockResolvedValue(ctx);

    await getOrFetchGUSD('chc-1', fetchFn);

    expect(getCachedGUSD('chc-1')).toBe(ctx);
  });

  it('clears inflight entry on failure so retry works', async () => {
    const fetchFn = jest
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(buildContext());

    await expect(getOrFetchGUSD('chc-1', fetchFn)).rejects.toThrow('network');
    await expect(getOrFetchGUSD('chc-1', fetchFn)).resolves.toBeDefined();

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
