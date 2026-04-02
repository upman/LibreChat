import { AsyncLocalStorage } from 'async_hooks';

export interface TenantContext {
  tenantId?: string;
}

/** Sentinel value for deliberate cross-tenant system operations */
export const SYSTEM_TENANT_ID = '__SYSTEM__';

/**
 * AsyncLocalStorage instance for propagating tenant context.
 * Callbacks passed to `tenantStorage.run()` must be `async` for the context to propagate
 * through Mongoose query execution. Sync callbacks returning a Mongoose thenable will lose context.
 */
export const tenantStorage = new AsyncLocalStorage<TenantContext>();

/**
 * Returns the current tenant ID from async context.
 * Falls back to `DEFAULT_TENANT_ID` env var for single-tenant deployments
 * or local testing without the full multi-tenancy auth stack.
 */
export function getTenantId(): string | undefined {
  return tenantStorage.getStore()?.tenantId ?? process.env.DEFAULT_TENANT_ID;
}

/**
 * Runs a function in an explicit tenant context.
 * Used for tenant provisioning at startup when `DEFAULT_TENANT_ID` is set.
 */
export function runAsTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantStorage.run({ tenantId }, fn);
}

/**
 * Runs a function in an explicit cross-tenant system context (bypasses tenant filtering).
 * The callback MUST be async — sync callbacks returning Mongoose thenables will lose context.
 */
export function runAsSystem<T>(fn: () => Promise<T>): Promise<T> {
  return tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, fn);
}

/**
 * Appends `:${tenantId}` to a cache key when a non-system tenant context is active.
 * Returns the base key unchanged when no ALS context is set or when running
 * inside `runAsSystem()` (SYSTEM_TENANT_ID context).
 */
export function scopedCacheKey(baseKey: string): string {
  const tenantId = getTenantId();
  if (!tenantId || tenantId === SYSTEM_TENANT_ID) {
    return baseKey;
  }
  return `${baseKey}:${tenantId}`;
}
