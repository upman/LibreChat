/* ── CHC (ClickHouse Cloud) Shared Types ──────────────────────────── */

/**
 * Shared types for CHC integration, consumed by both `@librechat/data-schemas`
 * (IUser schema) and `@librechat/api` (CP client/middleware).
 *
 * These mirror the relevant subset of the CP RBAC and organization models.
 * Keep in sync with:
 *   - control-plane/packages/cp-common/src/protocol/Account.ts (OrganizationSummary)
 *   - control-plane/packages/cp-common/src/protocol/Authorization.ts (RBACPolicy, RBACRole)
 */

export interface CpRBACPolicy {
  id: string;
  roleId: string;
  tenantId: string;
  allowDeny: 'ALLOW' | 'DENY';
  permissions: string[];
  resources: string[];
  tags?: { grants?: string[]; roleV2?: string };
}

export interface CpRBACRole {
  id: string;
  tenantId: string;
  ownerId: string;
  name: string;
  actors: string[];
  policies: CpRBACPolicy[];
  createdAt?: string;
  updatedAt?: string;
}

export interface CpOrganizationSummary {
  id: string;
  name: string;
  users: Record<string, unknown>;
  tier: string;
  roleV2Migrated: boolean;
  isAiSupportCaseDeflectionDisabled?: boolean;
  isAiO11yOptedOut?: boolean;
}

/** Subset of GUSD data cached on per-tenant user docs. */
export interface ChcSessionDetails {
  organizations: Record<string, CpOrganizationSummary>;
  orgFeatures: Record<string, string[]>;
  orgRolesV2: Record<string, CpRBACRole[]>;
}

/** Lightweight UI-facing slice of CpOrganizationSummary, enriched with `isCurrent`. */
export interface CpOrg {
  id: string;
  name: string;
  isCurrent: boolean;
}

export interface CpOrgsResponse {
  orgs: CpOrg[];
}

export interface CpTenantUserSummary {
  id: string;
  name: string;
  email: string;
  role: string;
  tenantId: string;
}

export interface CpSwitchOrgResponse {
  user: CpTenantUserSummary;
}
