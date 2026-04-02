const mongoose = require('mongoose');
const { createMethods, getEncryptionService, getTenantId } = require('@librechat/data-schemas');
const { matchModelName, findMatchingPattern } = require('@librechat/api');
const getLogStores = require('~/cache/getLogStores');

const methods = createMethods(mongoose, {
  matchModelName,
  findMatchingPattern,
  getCache: getLogStores,
});

const seedDatabase = async () => {
  await methods.initializeRoles();
  await methods.seedDefaultRoles();
  await methods.ensureDefaultCategories();
  await methods.seedSystemGrants();

  const tenantId = getTenantId();
  const service = getEncryptionService();
  if (service && tenantId) {
    await service.createKey({ tenantId });
  }
};

module.exports = {
  ...methods,
  seedDatabase,
};
