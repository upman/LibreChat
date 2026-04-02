require('dotenv').config();
const { isEnabled } = require('@librechat/api');
const {
  logger,
  getAutoEncryptionOptions,
  bootstrapEncryption,
} = require('@librechat/data-schemas');

const mongoose = require('mongoose');
const MONGO_URI = process.env.MONGO_URI;
const BOOTSTRAP_RETRY_MS = 5_000;

if (!MONGO_URI) {
  throw new Error('Please define the MONGO_URI environment variable');
}
/** The maximum number of connections in the connection pool. */
const maxPoolSize = parseInt(process.env.MONGO_MAX_POOL_SIZE) || undefined;
/** The minimum number of connections in the connection pool. */
const minPoolSize = parseInt(process.env.MONGO_MIN_POOL_SIZE) || undefined;
/** The maximum number of connections that may be in the process of being established concurrently by the connection pool. */
const maxConnecting = parseInt(process.env.MONGO_MAX_CONNECTING) || undefined;
/** The maximum number of milliseconds that a connection can remain idle in the pool before being removed and closed. */
const maxIdleTimeMS = parseInt(process.env.MONGO_MAX_IDLE_TIME_MS) || undefined;
/** The maximum time in milliseconds that a thread can wait for a connection to become available. */
const waitQueueTimeoutMS = parseInt(process.env.MONGO_WAIT_QUEUE_TIMEOUT_MS) || undefined;
/** Set to false to disable automatic index creation for all models associated with this connection. */
const autoIndex =
  process.env.MONGO_AUTO_INDEX != undefined
    ? isEnabled(process.env.MONGO_AUTO_INDEX) || false
    : undefined;

/** Set to `false` to disable Mongoose automatically calling `createCollection()` on every model created on this connection. */
const autoCreate =
  process.env.MONGO_AUTO_CREATE != undefined
    ? isEnabled(process.env.MONGO_AUTO_CREATE) || false
    : undefined;
/**
 * Global is used here to maintain a cached connection across hot reloads
 * in development. This prevents connections growing exponentially
 * during API Route usage.
 */
let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

mongoose.connection.on('error', (err) => {
  logger.error('[connectDb] MongoDB connection error:', err);
});

async function connectDb() {
  const encryption = getAutoEncryptionOptions();

  if (cached.conn && cached.conn?._readyState === 1) {
    if (!encryption || cached.encryptionReady) {
      return cached.conn;
    }
    // Connection is live but bootstrap hasn't completed — fall through to retry
  }
  const disconnected = cached.conn && cached.conn?._readyState !== 1;
  if (!cached.promise || disconnected) {
    cached.encryptionReady = false;
    cached.lastBootstrapError = null;
    const opts = {
      bufferCommands: false,
      ...(maxPoolSize ? { maxPoolSize } : {}),
      ...(minPoolSize ? { minPoolSize } : {}),
      ...(maxConnecting ? { maxConnecting } : {}),
      ...(maxIdleTimeMS ? { maxIdleTimeMS } : {}),
      ...(waitQueueTimeoutMS ? { waitQueueTimeoutMS } : {}),
      ...(autoIndex != undefined ? { autoIndex } : {}),
      ...(autoCreate != undefined ? { autoCreate } : {}),
      ...(encryption ? { autoEncryption: encryption.options } : {}),
    };
    logger.info('Mongo Connection options');
    const loggableOpts = encryption
      ? {
          ...opts,
          autoEncryption: {
            ...opts.autoEncryption,
            kmsProviders: '[REDACTED]',
          },
        }
      : opts;
    logger.info(JSON.stringify(loggableOpts, null, 2));
    mongoose.set('strictQuery', true);
    cached.promise = mongoose.connect(MONGO_URI, opts);
  }
  cached.conn = await cached.promise;

  if (encryption && !cached.encryptionReady) {
    if (cached.lastBootstrapError && Date.now() - cached.lastBootstrapError < BOOTSTRAP_RETRY_MS) {
      throw new Error('[connectDb] Encryption bootstrap unavailable — retry deferred');
    }
    if (!cached.bootstrapPromise) {
      const client = cached.conn.connection.getClient();
      cached.bootstrapPromise = bootstrapEncryption(client, encryption.config)
        .then(() => {
          cached.encryptionReady = true;
          cached.lastBootstrapError = null;
        })
        .catch((err) => {
          cached.lastBootstrapError = Date.now();
          throw err;
        })
        .finally(() => {
          cached.bootstrapPromise = null;
        });
    }
    await cached.bootstrapPromise;
  }

  return cached.conn;
}

module.exports = {
  connectDb,
};
