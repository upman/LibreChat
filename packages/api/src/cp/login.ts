import { logger } from '@librechat/data-schemas';

import type { IUser } from '@librechat/data-schemas';
import type { ProvisionDeps } from './provision';
import type { UserMethods } from './user';

import { fetchUserSessionDetails } from './client';
import { resolveGUSD } from './resolve';
import { resolveTenant } from './tenant';
import { provisionTenant } from './provision';
import { setCachedGUSD } from './cache';
import { findOrCreateTenantUser, findLastTenantForCpUser, buildTenantUserInput } from './user';

export interface ChcLoginResult {
  tenantUser: IUser;
  tenantId: string;
}

export interface ChcLoginError {
  error: string;
  errorCode: string;
}

export interface ChcLoginInput {
  cpAccessToken: string;
  requestedOrgId?: string;
  openidId: string;
  provisionDeps: ProvisionDeps;
  userMethods: UserMethods;
}

/**
 * Orchestrates the full CHC login flow:
 * GUSD → tenant resolution → provision → per-tenant user creation.
 *
 * Called from the OAuth callback handler. Returns the per-tenant user
 * document and resolved tenantId, or an error for redirect.
 */
export async function handleChcLogin(
  input: ChcLoginInput,
): Promise<ChcLoginResult | ChcLoginError> {
  const gusdResponse = await fetchUserSessionDetails(input.cpAccessToken);
  const cpContext = resolveGUSD(gusdResponse);
  setCachedGUSD(cpContext.cpUserId, cpContext);

  const lastTenantId = await findLastTenantForCpUser(
    cpContext.cpUserId,
    input.userMethods.findUsers,
  );
  const tenant = resolveTenant({
    requestedOrgId: input.requestedOrgId,
    lastTenantId,
    eligibleOrgIds: cpContext.eligibleOrgIds,
  });

  if (!tenant.tenantId) {
    return {
      error: tenant.error || 'LibreChat is not enabled for any of your organizations',
      errorCode: 'no_eligible_org',
    };
  }

  await provisionTenant(tenant.tenantId, input.provisionDeps);

  const tenantUserInput = buildTenantUserInput(cpContext, tenant.tenantId, input.openidId);
  const tenantUser = await findOrCreateTenantUser(tenantUserInput, input.userMethods);

  logger.info(
    `[handleChcLogin] user=${tenantUser.email} cpUserId=${cpContext.cpUserId} ` +
      `tenantId=${tenant.tenantId} role=${tenantUser.role} ` +
      `eligibleOrgs=[${cpContext.eligibleOrgIds.join(', ')}]`,
  );

  return { tenantUser, tenantId: tenant.tenantId };
}

/** Type guard to distinguish error from success. */
export function isChcLoginError(result: ChcLoginResult | ChcLoginError): result is ChcLoginError {
  return 'errorCode' in result;
}
