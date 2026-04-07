import type { TenantResolutionInput, TenantResolutionResult } from './types';

export function resolveTenant({
  requestedOrgId,
  lastTenantId,
  eligibleOrgIds,
}: TenantResolutionInput): TenantResolutionResult {
  if (requestedOrgId) {
    if (eligibleOrgIds.includes(requestedOrgId)) {
      return { tenantId: requestedOrgId };
    }
    return {
      tenantId: null,
      error: `Organization ${requestedOrgId} does not have LibreChat enabled`,
    };
  }

  if (lastTenantId && eligibleOrgIds.includes(lastTenantId)) {
    return { tenantId: lastTenantId };
  }

  if (eligibleOrgIds.length > 0) {
    return { tenantId: eligibleOrgIds[0] };
  }

  return {
    tenantId: null,
    error: 'LibreChat is not enabled for any of your organizations',
  };
}
