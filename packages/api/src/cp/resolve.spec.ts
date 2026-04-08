import {
  LIBRECHAT_ORG_FEATURE,
  ORG_MANAGE_PERMISSION,
  V1_ADMIN_ROLE,
  resolveGUSD,
} from './resolve';

import type { GUSDResponse, CpRBACPolicy, CpRBACRole, CpOrganizationSummary } from './types';

function buildPolicy(overrides: Partial<CpRBACPolicy> = {}): CpRBACPolicy {
  return {
    id: 'policy-1',
    roleId: 'role-1',
    tenantId: 'organization/org-1',
    allowDeny: 'ALLOW',
    permissions: [],
    resources: [],
    ...overrides,
  };
}

function buildRole(
  overrides: Omit<Partial<CpRBACRole>, 'policies'> & { policies?: Partial<CpRBACPolicy>[] } = {},
): CpRBACRole {
  const { policies: policyOverrides, ...rest } = overrides;
  return {
    id: 'role-1',
    tenantId: 'organization/org-1',
    ownerId: 'organization/org-1',
    name: 'Role',
    actors: [],
    policies: policyOverrides?.map((p) => buildPolicy(p)) ?? [],
    ...rest,
  };
}

function buildOrg(overrides: Partial<CpOrganizationSummary> = {}): CpOrganizationSummary {
  return {
    id: 'org-1',
    name: 'Test Org',
    users: {},
    tier: 'PRODUCTION',
    roleV2Migrated: true,
    ...overrides,
  };
}

function buildResponse(overrides: Partial<GUSDResponse> = {}): GUSDResponse {
  return {
    userId: 'user-123',
    name: 'Test User',
    email: 'test@example.com',
    userFeatures: [],
    orgFeatures: {},
    orgRoles: {},
    orgRolesV2: {},
    organizations: {},
    instances: {},
    roleMappings: [],
    pendingActions: [],
    dashboardRolesV2: [],
    ...overrides,
  };
}

describe('resolveGUSD', () => {
  it('identifies eligible orgs with FT_ORG_LIBRECHAT feature', () => {
    const orgFeatures = {
      'org-a': [LIBRECHAT_ORG_FEATURE, 'FT_OTHER'],
      'org-b': ['FT_OTHER'],
      'org-c': [LIBRECHAT_ORG_FEATURE],
    };
    const response = buildResponse({ orgFeatures });

    const result = resolveGUSD(response);

    expect(result.eligibleOrgIds).toEqual(['org-a', 'org-c']);
    expect(result.chcSessionDetails.orgFeatures).toEqual(orgFeatures);
  });

  it('identifies admin orgs with organization:manage permission', () => {
    const response = buildResponse({
      orgFeatures: { 'org-a': [LIBRECHAT_ORG_FEATURE], 'org-b': [LIBRECHAT_ORG_FEATURE] },
      orgRolesV2: {
        'org-a': [
          buildRole({
            name: 'Admin',
            policies: [{ permissions: [ORG_MANAGE_PERMISSION, 'organization:view'] }],
          }),
        ],
        'org-b': [
          buildRole({
            id: 'role-2',
            name: 'Viewer',
            policies: [{ permissions: ['organization:view'] }],
          }),
        ],
      },
    });

    const result = resolveGUSD(response);

    expect(result.adminOrgIds).toEqual(['org-a']);
  });

  it('returns empty arrays when no orgs match', () => {
    const response = buildResponse({
      orgFeatures: { 'org-a': ['FT_OTHER'] },
      orgRolesV2: {
        'org-a': [buildRole({ name: 'Viewer', policies: [{ permissions: ['view'] }] })],
      },
    });

    const result = resolveGUSD(response);

    expect(result.eligibleOrgIds).toEqual([]);
    expect(result.adminOrgIds).toEqual([]);
  });

  it('handles empty response gracefully', () => {
    const result = resolveGUSD(buildResponse());

    expect(result.cpUserId).toBe('user-123');
    expect(result.eligibleOrgIds).toEqual([]);
    expect(result.adminOrgIds).toEqual([]);
    expect(result.chcSessionDetails).toEqual({
      organizations: {},
      orgFeatures: {},
      orgRolesV2: {},
    });
    expect(result.resolvedAt).toBeLessThanOrEqual(Date.now());
    expect(result.resolvedAt).toBeGreaterThan(Date.now() - 1000);
  });

  it('maps cpUserId from response userId and includes session details', () => {
    const organizations = { 'org-1': buildOrg() };
    const response = buildResponse({ userId: 'cp-user-456', organizations });

    const result = resolveGUSD(response);

    expect(result.cpUserId).toBe('cp-user-456');
    expect(result.chcSessionDetails.organizations).toEqual(organizations);
  });

  it('detects admin across multiple policies in a single role', () => {
    const response = buildResponse({
      orgFeatures: { 'org-a': [LIBRECHAT_ORG_FEATURE] },
      orgRolesV2: {
        'org-a': [
          buildRole({
            name: 'Custom',
            policies: [
              { permissions: ['organization:view'] },
              { permissions: [ORG_MANAGE_PERMISSION] },
            ],
          }),
        ],
      },
    });

    const result = resolveGUSD(response);

    expect(result.adminOrgIds).toEqual(['org-a']);
  });

  it('detects admin across multiple roles for an org', () => {
    const response = buildResponse({
      orgFeatures: { 'org-a': [LIBRECHAT_ORG_FEATURE] },
      orgRolesV2: {
        'org-a': [
          buildRole({ name: 'Viewer', policies: [{ permissions: ['view'] }] }),
          buildRole({
            id: 'role-2',
            name: 'Admin',
            policies: [{ permissions: [ORG_MANAGE_PERMISSION] }],
          }),
        ],
      },
    });

    const result = resolveGUSD(response);

    expect(result.adminOrgIds).toEqual(['org-a']);
  });

  it('does not grant admin when policy has allowDeny DENY', () => {
    const response = buildResponse({
      orgFeatures: { 'org-a': [LIBRECHAT_ORG_FEATURE] },
      orgRolesV2: {
        'org-a': [
          buildRole({
            name: 'DeniedAdmin',
            policies: [{ allowDeny: 'DENY', permissions: [ORG_MANAGE_PERMISSION] }],
          }),
        ],
      },
    });

    const result = resolveGUSD(response);

    expect(result.adminOrgIds).toEqual([]);
  });

  describe('V1 orgRoles fallback', () => {
    it('falls back to V1 ADMIN role for non-migrated org when orgRolesV2 has no entry', () => {
      const response = buildResponse({
        orgFeatures: { 'org-a': [LIBRECHAT_ORG_FEATURE] },
        orgRoles: { 'org-a': V1_ADMIN_ROLE },
        orgRolesV2: {},
        organizations: { 'org-a': buildOrg({ roleV2Migrated: false }) },
      });

      const result = resolveGUSD(response);

      expect(result.adminOrgIds).toEqual(['org-a']);
    });

    it('does not promote non-ADMIN V1 roles', () => {
      const response = buildResponse({
        orgFeatures: { 'org-a': [LIBRECHAT_ORG_FEATURE] },
        orgRoles: { 'org-a': 'DEVELOPER' },
        orgRolesV2: {},
      });

      const result = resolveGUSD(response);

      expect(result.adminOrgIds).toEqual([]);
    });

    it('V2 takes precedence when orgRolesV2 has an entry for the org, even without manage permission', () => {
      const response = buildResponse({
        orgFeatures: { 'org-a': [LIBRECHAT_ORG_FEATURE] },
        orgRoles: { 'org-a': V1_ADMIN_ROLE },
        orgRolesV2: {
          'org-a': [
            buildRole({ name: 'Viewer', policies: [{ permissions: ['organization:view'] }] }),
          ],
        },
      });

      const result = resolveGUSD(response);

      expect(result.adminOrgIds).toEqual([]);
    });

    it('does not promote via V1 when V2 has an explicit DENY for manage permission', () => {
      const response = buildResponse({
        orgFeatures: { 'org-a': [LIBRECHAT_ORG_FEATURE] },
        orgRoles: { 'org-a': V1_ADMIN_ROLE },
        orgRolesV2: {
          'org-a': [
            buildRole({
              name: 'DeniedAdmin',
              policies: [{ allowDeny: 'DENY', permissions: [ORG_MANAGE_PERMISSION] }],
            }),
          ],
        },
      });

      const result = resolveGUSD(response);

      expect(result.adminOrgIds).toEqual([]);
    });

    it('blocks V1 fallback when orgRolesV2 has an empty roles array for the org', () => {
      const response = buildResponse({
        orgFeatures: { 'org-a': [LIBRECHAT_ORG_FEATURE] },
        orgRoles: { 'org-a': V1_ADMIN_ROLE },
        orgRolesV2: { 'org-a': [] },
      });

      const result = resolveGUSD(response);

      expect(result.adminOrgIds).toEqual([]);
    });

    it('suppresses V1 fallback for V2-migrated orgs absent from orgRolesV2', () => {
      const response = buildResponse({
        orgFeatures: { 'org-a': [LIBRECHAT_ORG_FEATURE] },
        orgRoles: { 'org-a': V1_ADMIN_ROLE },
        orgRolesV2: {},
        organizations: { 'org-a': buildOrg({ roleV2Migrated: true }) },
      });

      const result = resolveGUSD(response);

      expect(result.adminOrgIds).toEqual([]);
    });

    it('allows V1 fallback for non-V2-migrated orgs', () => {
      const response = buildResponse({
        orgFeatures: { 'org-a': [LIBRECHAT_ORG_FEATURE] },
        orgRoles: { 'org-a': V1_ADMIN_ROLE },
        orgRolesV2: {},
        organizations: { 'org-a': buildOrg({ roleV2Migrated: false }) },
      });

      const result = resolveGUSD(response);

      expect(result.adminOrgIds).toEqual(['org-a']);
    });

    it('mixes V2 and V1 across different orgs', () => {
      const response = buildResponse({
        orgFeatures: {
          'org-a': [LIBRECHAT_ORG_FEATURE],
          'org-b': [LIBRECHAT_ORG_FEATURE],
          'org-c': [LIBRECHAT_ORG_FEATURE],
        },
        orgRoles: { 'org-a': 'DEVELOPER', 'org-b': V1_ADMIN_ROLE, 'org-c': V1_ADMIN_ROLE },
        orgRolesV2: {
          'org-a': [
            buildRole({
              name: 'Admin',
              policies: [{ permissions: [ORG_MANAGE_PERMISSION] }],
            }),
          ],
        },
      });

      const result = resolveGUSD(response);

      expect(result.adminOrgIds).toHaveLength(3);
      expect(result.adminOrgIds).toEqual(expect.arrayContaining(['org-a', 'org-b', 'org-c']));
    });

    it('does not use V1 fallback for ineligible orgs', () => {
      const response = buildResponse({
        orgFeatures: { 'org-a': ['FT_OTHER'] },
        orgRoles: { 'org-a': V1_ADMIN_ROLE },
        orgRolesV2: {},
      });

      const result = resolveGUSD(response);

      expect(result.adminOrgIds).toEqual([]);
    });
  });
});
