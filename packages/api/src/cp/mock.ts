import type { GUSDResponse } from './types';

const MOCK_ORG_ID = 'mock-org-id';

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
    instances: {},
    roleMappings: [],
    pendingActions: [],
    dashboardRolesV2: [],
  };
}
