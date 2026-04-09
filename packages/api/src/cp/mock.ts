import type { GUSDResponse, CpInstanceSummary } from './types';

const MOCK_ORG_ID = 'mock-org-id';
const MOCK_SERVICE_ID = 'mock-service-01';

export function getMockGUSDResponse(): GUSDResponse {
  return {
    userId: 'mock-cp-user-id',
    name: 'Local Developer',
    email: 'dev@localhost',
    userFeatures: [],
    orgFeatures: {
      [MOCK_ORG_ID]: ['FT_ORG_LIBRECHAT'],
    },
    orgRoles: {
      [MOCK_ORG_ID]: 'ADMIN',
    },
    orgRolesV2: {
      [MOCK_ORG_ID]: [
        {
          id: 'mock-role-id',
          tenantId: `organization/${MOCK_ORG_ID}`,
          ownerId: `organization/${MOCK_ORG_ID}`,
          name: 'Admin',
          actors: ['mock-cp-user-id'],
          policies: [
            {
              id: 'mock-policy-id',
              roleId: 'mock-role-id',
              tenantId: `organization/${MOCK_ORG_ID}`,
              allowDeny: 'ALLOW',
              permissions: ['control-plane:organization:manage'],
              resources: [`organization/${MOCK_ORG_ID}`],
            },
          ],
        },
      ],
    },
    organizations: {
      [MOCK_ORG_ID]: {
        id: MOCK_ORG_ID,
        name: 'Local Dev Org',
        users: {},
        tier: 'DEVELOPMENT',
        roleV2Migrated: true,
      },
    },
    instances: {
      [MOCK_SERVICE_ID]: {
        id: MOCK_SERVICE_ID,
        name: 'Local Dev Service',
        organizationId: MOCK_ORG_ID,
        regionId: 'us-east-1',
        state: 'running',
        instanceTier: 'Development',
        clickhouseVersion: '24.6',
        endpoints: {
          https: { hostname: 'localhost', port: 8443 },
          nativesecure: { hostname: 'localhost', port: 9440 },
        },
        database: 'default',
        isPrimary: true,
        dataWarehouseId: 'mock-dw-01',
      } satisfies CpInstanceSummary,
    },
    roleMappings: [],
    pendingActions: [],
    dashboardRolesV2: [],
  };
}
