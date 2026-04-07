const mongoose = require('mongoose');
const {
  isEnabled,
  matchModelName,
  findMatchingPattern,
  provisionTenant,
} = require('@librechat/api');
const {
  getTenantId,
  createMethods,
  SYSTEM_TENANT_ID,
  getEncryptionService,
} = require('@librechat/data-schemas');
const getLogStores = require('~/cache/getLogStores');

const methods = createMethods(mongoose, {
  matchModelName,
  findMatchingPattern,
  getCache: getLogStores,
});

const provisionDeps = {
  initializeRoles: methods.initializeRoles,
  seedDefaultRoles: methods.seedDefaultRoles,
  ensureDefaultCategories: methods.ensureDefaultCategories,
  seedSystemGrants: methods.seedSystemGrants,
};

const seedDatabase = async () => {
  const tenantId = getTenantId();
  if (tenantId && tenantId !== SYSTEM_TENANT_ID) {
    await provisionTenant(tenantId, provisionDeps);
    return;
  }

  if (isEnabled(process.env.TENANT_ISOLATION_STRICT) && !process.env.DEFAULT_TENANT_ID) {
    return;
  }

  await methods.initializeRoles();
  await methods.seedDefaultRoles();
  await methods.ensureDefaultCategories();
  await methods.seedSystemGrants();

  const service = getEncryptionService();
  if (service && tenantId) {
    await service.createKey({ tenantId });
  }
};

module.exports = {
  ...methods,
  seedDatabase,
  provisionDeps,
};
