import { runAsTenant, getEncryptionService, logger } from '@librechat/data-schemas';

export interface ProvisionDeps {
  initializeRoles: () => Promise<void>;
  seedDefaultRoles: () => Promise<void>;
  ensureDefaultCategories: () => Promise<boolean>;
  seedSystemGrants: () => Promise<void>;
}

/** Tenants whose provisioning has completed successfully. */
const provisionedTenants = new Set<string>();
/** In-flight provisioning work — coalesces concurrent calls for the same tenant. */
const inflightWork = new Map<string, Promise<void>>();

async function doProvision(tenantId: string, deps: ProvisionDeps): Promise<void> {
  logger.info(`[provisionTenant] Provisioning tenant ${tenantId}`);

  await runAsTenant(tenantId, async () => {
    await deps.initializeRoles();
    await Promise.all([
      deps.seedDefaultRoles(),
      deps.ensureDefaultCategories(),
      deps.seedSystemGrants(),
    ]);

    const service = getEncryptionService();
    if (service) {
      await service.createKey({ tenantId });
    }
  });

  logger.info(`[provisionTenant] Tenant ${tenantId} provisioned`);
}

/**
 * Provision all required database scaffolding for a tenant.
 *
 * Idempotent — every seed function uses upserts, so concurrent calls
 * from multiple pods are safe. Within a pod:
 * - `provisionedTenants` Set tracks completed tenants (instant short-circuit)
 * - `inflightWork` Map coalesces concurrent in-flight calls
 * - Failures clear the inflight entry (Set is never written on failure),
 *   allowing retry on the next login attempt
 *
 * DEK creation failure propagates to the caller.
 */
export function provisionTenant(tenantId: string, deps: ProvisionDeps): Promise<void> {
  if (provisionedTenants.has(tenantId)) {
    return Promise.resolve();
  }

  const inflight = inflightWork.get(tenantId);
  if (inflight) {
    return inflight;
  }

  const work = doProvision(tenantId, deps)
    .then(() => {
      provisionedTenants.add(tenantId);
      inflightWork.delete(tenantId);
    })
    .catch((err) => {
      inflightWork.delete(tenantId);
      throw err;
    });
  inflightWork.set(tenantId, work);
  return work;
}

/** Exported for testing only. */
export function _resetProvisioningState(): void {
  provisionedTenants.clear();
  inflightWork.clear();
}
