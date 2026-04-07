const mockRunAsTenant = jest.fn((_tenantId: string, fn: () => Promise<void>) => fn());
const mockGetEncryptionService = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  runAsTenant: (tenantId: string, fn: () => Promise<void>) => mockRunAsTenant(tenantId, fn),
  getEncryptionService: () => mockGetEncryptionService(),
}));

import { provisionTenant, _resetProvisioningState } from './provision';

import type { ProvisionDeps } from './provision';

function buildDeps(overrides: Partial<ProvisionDeps> = {}): ProvisionDeps {
  return {
    initializeRoles: jest.fn().mockResolvedValue(undefined),
    seedDefaultRoles: jest.fn().mockResolvedValue(undefined),
    ensureDefaultCategories: jest.fn().mockResolvedValue(true),
    seedSystemGrants: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('provisionTenant', () => {
  beforeEach(() => {
    _resetProvisioningState();
    mockRunAsTenant.mockClear();
    mockRunAsTenant.mockImplementation((_tenantId: string, fn: () => Promise<void>) => fn());
    mockGetEncryptionService.mockReturnValue(null);
  });

  it('calls initializeRoles before the parallel seed group', async () => {
    const callOrder: string[] = [];
    const deps = buildDeps({
      initializeRoles: jest.fn(async () => {
        callOrder.push('initializeRoles');
      }),
      seedDefaultRoles: jest.fn(async () => {
        callOrder.push('seedDefaultRoles');
      }),
      ensureDefaultCategories: jest.fn(async () => {
        callOrder.push('ensureDefaultCategories');
        return true;
      }),
      seedSystemGrants: jest.fn(async () => {
        callOrder.push('seedSystemGrants');
      }),
    });

    await provisionTenant('tenant-1', deps);

    expect(callOrder[0]).toBe('initializeRoles');
    expect(deps.initializeRoles).toHaveBeenCalledTimes(1);
    expect(deps.seedDefaultRoles).toHaveBeenCalledTimes(1);
    expect(deps.ensureDefaultCategories).toHaveBeenCalledTimes(1);
    expect(deps.seedSystemGrants).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent calls for the same tenant', async () => {
    let resolveProvision: () => void;
    const gate = new Promise<void>((r) => {
      resolveProvision = r;
    });

    const deps = buildDeps({
      initializeRoles: jest.fn(async () => {
        await gate;
      }),
    });

    const p1 = provisionTenant('tenant-1', deps);
    const p2 = provisionTenant('tenant-1', deps);

    resolveProvision!();
    await Promise.all([p1, p2]);

    expect(deps.initializeRoles).toHaveBeenCalledTimes(1);
  });

  it('short-circuits via provisionedTenants Set on sequential calls', async () => {
    const deps = buildDeps();

    await provisionTenant('tenant-1', deps);
    await provisionTenant('tenant-1', deps);

    expect(deps.initializeRoles).toHaveBeenCalledTimes(1);
  });

  it('propagates DEK creation failure and clears inflight state for retry', async () => {
    const dekError = new Error('DEK creation failed');
    mockGetEncryptionService.mockReturnValue({
      createKey: jest.fn().mockRejectedValue(dekError),
    });
    const deps = buildDeps();

    await expect(provisionTenant('tenant-1', deps)).rejects.toThrow('DEK creation failed');

    mockGetEncryptionService.mockReturnValue(null);
    await expect(provisionTenant('tenant-1', deps)).resolves.toBeUndefined();
  });

  it('_resetProvisioningState clears both Set and Map', async () => {
    const deps = buildDeps();
    await provisionTenant('tenant-1', deps);

    _resetProvisioningState();

    await provisionTenant('tenant-1', deps);
    expect(deps.initializeRoles).toHaveBeenCalledTimes(2);
  });
});
