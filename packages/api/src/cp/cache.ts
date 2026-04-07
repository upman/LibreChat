import type { ResolvedCpContext } from './types';

const GUSD_TTL_MS = 60_000;
const GUSD_CACHE_MAX_SIZE = 10_000;
const gusdCache = new Map<string, { data: ResolvedCpContext; expiresAt: number }>();
const gusdInflight = new Map<string, Promise<ResolvedCpContext>>();

export function getCachedGUSD(cpUserId: string): ResolvedCpContext | undefined {
  const entry = gusdCache.get(cpUserId);
  if (!entry) {
    return undefined;
  }
  if (Date.now() > entry.expiresAt) {
    gusdCache.delete(cpUserId);
    return undefined;
  }
  return entry.data;
}

export function setCachedGUSD(cpUserId: string, data: ResolvedCpContext): void {
  if (!gusdCache.has(cpUserId) && gusdCache.size >= GUSD_CACHE_MAX_SIZE) {
    const firstKey = gusdCache.keys().next().value;
    if (firstKey) {
      gusdCache.delete(firstKey);
    }
  }
  gusdCache.set(cpUserId, { data, expiresAt: Date.now() + GUSD_TTL_MS });
}

/**
 * Coalesce concurrent GUSD fetches for the same user.
 * If a fetch is already in flight, returns the existing promise.
 * Otherwise starts a new fetch and caches the result.
 */
export function getOrFetchGUSD(
  cpUserId: string,
  fetchFn: () => Promise<ResolvedCpContext>,
): Promise<ResolvedCpContext> {
  const existing = gusdInflight.get(cpUserId);
  if (existing) {
    return existing;
  }
  const work = fetchFn()
    .then((result) => {
      setCachedGUSD(cpUserId, result);
      return result;
    })
    .finally(() => {
      gusdInflight.delete(cpUserId);
    });
  gusdInflight.set(cpUserId, work);
  return work;
}

/** Exported for testing only. */
export function _clearGUSDCache(): void {
  gusdCache.clear();
  gusdInflight.clear();
}
