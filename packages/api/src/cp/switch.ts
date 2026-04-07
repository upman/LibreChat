import { logger } from '@librechat/data-schemas';
import { LIBRECHAT_ORG_FEATURE } from './resolve';
import { provisionTenant } from './provision';
import { findOrCreateTenantUser, buildTenantUserInput } from './user';

import type { IUser } from '@librechat/data-schemas';
import type { ProvisionDeps } from './provision';
import type { UserMethods } from './user';
import type { ResolvedCpContext } from './types';

export interface OrgSwitchResult {
  tenantUser: IUser;
  tenantId: string;
  role: string;
}

export interface OrgSwitchError {
  error: string;
  errorCode: string;
}

/**
 * Switch the current user to a different eligible organization.
 *
 * Provisions the target tenant if needed, creates/updates a per-tenant
 * user document, and returns it so the caller can issue a new JWT.
 *
 * `freshContext` is required — callers must provide the GUSD-resolved
 * context from `req.cpContext` to ensure decisions use live CP data.
 */
export async function switchOrg(
  currentUser: IUser,
  targetOrgId: string,
  deps: {
    provision: ProvisionDeps;
    user: UserMethods;
    freshContext: ResolvedCpContext;
  },
): Promise<OrgSwitchResult | OrgSwitchError> {
  const cpContext = deps.freshContext;
  if (!cpContext) {
    return {
      error: 'Unable to validate org eligibility — identity service unavailable',
      errorCode: 'GUSD_UNAVAILABLE',
    };
  }
  const orgFeatures = cpContext.chcSessionDetails.orgFeatures;

  if (!orgFeatures[targetOrgId]?.includes(LIBRECHAT_ORG_FEATURE)) {
    return {
      error: `Organization ${targetOrgId} does not have LibreChat enabled`,
      errorCode: 'ORG_NOT_ELIGIBLE',
    };
  }

  if (!currentUser.idOnTheSource) {
    return { error: 'CHC identity not resolved', errorCode: 'CP_IDENTITY_MISSING' };
  }

  const openidId = currentUser.openidId;
  if (!openidId) {
    return { error: 'User identity incomplete', errorCode: 'OPENID_IDENTITY_MISSING' };
  }

  await provisionTenant(targetOrgId, deps.provision);
  const input = buildTenantUserInput(cpContext, targetOrgId, openidId);
  const tenantUser = await findOrCreateTenantUser(input, deps.user);

  logger.info(
    `[switchOrg] Switched cpUserId=${currentUser.idOnTheSource} to tenant=${targetOrgId} role=${tenantUser.role}`,
  );

  return {
    tenantUser,
    tenantId: targetOrgId,
    role: tenantUser.role ?? 'USER',
  };
}

/** Type guard to distinguish success from error. */
export function isSwitchError(result: OrgSwitchResult | OrgSwitchError): result is OrgSwitchError {
  return 'errorCode' in result;
}
