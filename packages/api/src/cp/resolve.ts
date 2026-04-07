import type { GUSDResponse, ResolvedCpContext } from './types';

export const LIBRECHAT_ORG_FEATURE = 'FT_ORG_LIBRECHAT';
export const ORG_MANAGE_PERMISSION = 'control-plane:organization:manage';

export function resolveGUSD(response: GUSDResponse): ResolvedCpContext {
  const eligibleOrgIds: string[] = [];

  for (const [orgId, features] of Object.entries(response.orgFeatures)) {
    if (features.includes(LIBRECHAT_ORG_FEATURE)) {
      eligibleOrgIds.push(orgId);
    }
  }

  const eligibleSet = new Set(eligibleOrgIds);
  const adminOrgIds: string[] = [];

  for (const [orgId, roles] of Object.entries(response.orgRolesV2)) {
    if (!eligibleSet.has(orgId)) {
      continue;
    }
    const hasManagePermission = roles.some((role) =>
      role.policies.some(
        (policy) =>
          policy.allowDeny === 'ALLOW' && policy.permissions.includes(ORG_MANAGE_PERMISSION),
      ),
    );
    if (hasManagePermission) {
      adminOrgIds.push(orgId);
    }
  }

  return {
    cpUserId: response.userId,
    email: response.email,
    name: response.name,
    chcSessionDetails: {
      organizations: response.organizations,
      orgFeatures: response.orgFeatures,
      orgRolesV2: response.orgRolesV2,
    },
    eligibleOrgIds,
    adminOrgIds,
    resolvedAt: Date.now(),
  };
}
