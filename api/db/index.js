const { createModels } = require('@librechat/data-schemas');
const { connectDb, writerMongoose, readerMongoose } = require('./connect');

// createModels MUST run before requiring indexSync.
// indexSync.js captures mongoose.models.Message and mongoose.models.Conversation
// at module load time. If those models are not registered first, all MeiliSearch
// sync operations will silently fail on every startup.
createModels(writerMongoose);

// Register models on the reader WITHOUT re-running createModels. Schemas are
// module-level singletons, so calling createModels again would re-apply plugins
// (mongoMeili, tenantIsolation, encryption) to the same schema objects, causing
// duplicate hooks. Instead, copy the already-compiled models from the writer.
if (readerMongoose !== writerMongoose) {
  for (const [name, model] of Object.entries(writerMongoose.models)) {
    if (!readerMongoose.models[name]) {
      readerMongoose.model(name, model.schema);
    }
  }
}

const indexSync = require('./indexSync');

module.exports = { connectDb, indexSync };
