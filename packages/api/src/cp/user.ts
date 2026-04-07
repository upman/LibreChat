import { runAsTenant, runAsSystem, logger } from '@librechat/data-schemas';
import { getBalanceConfig } from '~/app/config';

import type { Types } from 'mongoose';
import type { IUser } from '@librechat/data-schemas';
import type { ResolvedCpContext } from './types';

export interface TenantUserInput {
  cpUserId: string;
  email: string;
  name: string;
  openidId: string;
  tenantId: string;
  role: string;
  resolvedAt: Date;
}

export interface UserMethods {
  findUser: (
    criteria: Record<string, unknown>,
    fields?: string | string[] | null,
  ) => Promise<IUser | null>;
  findUsers: (
    criteria: Record<string, unknown>,
    fields?: string | string[] | null,
    options?: { limit?: number; offset?: number; sort?: Record<string, 1 | -1> },
  ) => Promise<IUser[]>;
  createUser: (
    data: Record<string, unknown>,
    balanceConfig?: unknown,
    disableTTL?: boolean,
    returnUser?: boolean,
  ) => Promise<Types.ObjectId | Partial<IUser>>;
  updateUser: (userId: string, data: Partial<IUser>) => Promise<IUser | null>;
}

function deriveUsername(name: string, email: string): string {
  const slug = (name || email.split('@')[0] || 'user')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_.-]/g, '');
  return slug || 'user';
}

/**
 * Find or create the per-tenant user document for a CHC identity.
 *
 * Runs inside `runAsTenant` so the Mongoose tenant isolation plugin
 * scopes all queries to the target tenant.
 */
export async function findOrCreateTenantUser(
  input: TenantUserInput,
  methods: UserMethods,
): Promise<IUser> {
  return runAsTenant(input.tenantId, async () => {
    let user = await methods.findUser({ idOnTheSource: input.cpUserId });

    if (!user) {
      const emailMatch = await methods.findUser({ email: input.email });
      if (
        emailMatch &&
        emailMatch.provider === 'openid' &&
        (!emailMatch.idOnTheSource || emailMatch.idOnTheSource === input.cpUserId) &&
        (!emailMatch.openidId || emailMatch.openidId === input.openidId)
      ) {
        user = emailMatch;
      }
    }

    if (user) {
      const updated = await methods.updateUser(user._id.toString(), {
        openidId: input.openidId,
        idOnTheSource: input.cpUserId,
        name: input.name,
        role: input.role,
        resolvedAt: input.resolvedAt,
        lastTenantId: input.tenantId,
      });
      return updated ?? user;
    }

    let created: Partial<IUser> | undefined;
    try {
      const balanceConfig = getBalanceConfig();
      created = (await methods.createUser(
        {
          provider: 'openid',
          openidId: input.openidId,
          idOnTheSource: input.cpUserId,
          email: input.email,
          name: input.name,
          username: deriveUsername(input.name, input.email),
          emailVerified: true,
          role: input.role,
          tenantId: input.tenantId,
          resolvedAt: input.resolvedAt,
          lastTenantId: input.tenantId,
        },
        balanceConfig,
        true,
        true,
      )) as Partial<IUser>;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        const existing = await methods.findUser({ idOnTheSource: input.cpUserId });
        if (existing) {
          return existing;
        }
      }
      throw err;
    }

    if (!created || !('email' in created)) {
      throw new Error('[findOrCreateTenantUser] createUser returned unexpected type');
    }

    logger.info(
      `[findOrCreateTenantUser] Created user for cpUserId=${input.cpUserId} tenant=${input.tenantId}`,
    );

    return created as IUser;
  });
}

/**
 * Cross-tenant lookup: find the last-used tenantId for a CP identity.
 * Runs as system to bypass tenant isolation — reads across all tenants.
 * Sorts by updatedAt descending to return the most recently active doc.
 */
export async function findLastTenantForCpUser(
  cpUserId: string,
  findUsers: UserMethods['findUsers'],
): Promise<string | undefined> {
  return runAsSystem(async () => {
    const users = await findUsers({ idOnTheSource: cpUserId }, 'lastTenantId updatedAt', {
      sort: { updatedAt: -1 },
      limit: 1,
    });
    return users[0]?.lastTenantId;
  });
}

/**
 * Build a `TenantUserInput` from a resolved CP context and tenant selection.
 *
 * Admin detection: if the user has `control-plane:organization:manage`
 * (ALLOW) for this org, they get `role: 'ADMIN'`. Otherwise `role: 'USER'`.
 * No separate `isSuperAdmin` field — the role IS the authority.
 *
 * CHC session data (orgFeatures, orgRolesV2, organizations) is NOT stored
 * on the user doc. It lives only in the 60s in-memory cache from live GUSD
 * calls. Zero staleness, zero sync overhead.
 */
export function buildTenantUserInput(
  cpContext: ResolvedCpContext,
  tenantId: string,
  openidId: string,
): TenantUserInput {
  const isAdmin = cpContext.adminOrgIds.includes(tenantId);
  return {
    cpUserId: cpContext.cpUserId,
    email: cpContext.email,
    name: cpContext.name,
    openidId,
    tenantId,
    role: isAdmin ? 'ADMIN' : 'USER',
    resolvedAt: new Date(cpContext.resolvedAt),
  };
}
