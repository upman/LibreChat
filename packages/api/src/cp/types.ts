import type { CpRBACRole, CpOrganizationSummary, ChcSessionDetails } from 'librechat-data-provider';

/**
 * Re-export shared CHC types from data-provider (single source of truth).
 * These are also consumed by @librechat/data-schemas for IUser typing.
 */
export type {
  CpRBACPolicy,
  CpRBACRole,
  CpOrganizationSummary,
  ChcSessionDetails,
} from 'librechat-data-provider';

/* ── Opaque forward-compat types (not consumed yet) ───────────────── */

export type CpInstanceSummary = unknown;
export type CpRoleMapping = unknown;
export type CpPendingUserAction = unknown;

/**
 * Matches the full `GetUserSessionDetailsResponse` from
 * `control-plane/packages/cp-common/src/protocol/Account.ts`.
 */
export interface GUSDResponse {
  userId: string;
  name: string;
  email: string;
  userFeatures: string[];
  orgFeatures: Record<string, string[]>;
  orgRoles: Record<string, string>;
  orgRolesV2: Record<string, CpRBACRole[]>;
  organizations: Record<string, CpOrganizationSummary>;
  instances: Record<string, CpInstanceSummary>;
  roleMappings: CpRoleMapping[];
  pendingActions: CpPendingUserAction[];
  dashboardRolesV2: CpRBACRole[];
}

/* ── Resolved context from GUSD ───────────────────────────────────── */

export interface ResolvedCpContext {
  cpUserId: string;
  email: string;
  name: string;
  chcSessionDetails: ChcSessionDetails;
  eligibleOrgIds: string[];
  adminOrgIds: string[];
  resolvedAt: number;
}

/* ── Tenant resolution ────────────────────────────────────────────── */

export interface TenantResolutionInput {
  requestedOrgId?: string;
  lastTenantId?: string;
  eligibleOrgIds: string[];
}

export interface TenantResolutionResult {
  tenantId: string | null;
  error?: string;
}
