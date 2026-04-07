import { runAsSystem } from '@librechat/data-schemas';

import type { IUser } from '@librechat/data-schemas';

export interface StrategyUserMethods {
  findUser: (
    criteria: Record<string, unknown>,
    fields?: string | string[] | null,
  ) => Promise<IUser | null>;
  findUsers: (
    criteria: Record<string, unknown>,
    fields?: string | string[] | null,
    options?: { limit?: number; sort?: Record<string, 1 | -1> },
  ) => Promise<IUser[]>;
}

export interface StrategyLookupResult {
  user: IUser | null;
  error: string | null;
  migration: boolean;
}

/**
 * CHC-aware user lookup for the OpenID JWT strategy.
 *
 * Always uses a deterministic sorted query (`updatedAt desc`) to select
 * the most recently active per-tenant doc. This ensures that after an
 * org switch (which bumps `updatedAt` on the target tenant's user doc),
 * the next authenticated request binds to the correct tenant — not
 * whichever doc MongoDB's query planner happens to return first.
 *
 * Falls back to `findOpenIDUser` only when no per-tenant docs exist
 * (first-time login before `findOrCreateTenantUser` runs in oauth.js).
 */
export async function resolveChcStrategyUser(
  findOpenIDUser: (opts: {
    findUser: StrategyUserMethods['findUser'];
    email?: string;
    openidId?: string;
    idOnTheSource?: string;
    strategyName?: string;
  }) => Promise<StrategyLookupResult>,
  lookupOpts: {
    findUser: StrategyUserMethods['findUser'];
    findUsers: StrategyUserMethods['findUsers'];
    email?: string;
    openidId?: string;
    idOnTheSource?: string;
  },
): Promise<StrategyLookupResult> {
  if (lookupOpts.openidId) {
    const [perTenantUser] = await runAsSystem(() =>
      lookupOpts.findUsers({ openidId: lookupOpts.openidId, tenantId: { $exists: true } }, null, {
        sort: { updatedAt: -1 },
        limit: 1,
      }),
    );
    if (perTenantUser) {
      return { user: perTenantUser, error: null, migration: false };
    }
  }

  return runAsSystem(() =>
    findOpenIDUser({
      findUser: lookupOpts.findUser,
      email: lookupOpts.email,
      openidId: lookupOpts.openidId,
      idOnTheSource: lookupOpts.idOnTheSource,
      strategyName: 'openIdJwtLogin',
    }),
  );
}
