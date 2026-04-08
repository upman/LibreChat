require('dotenv').config();
const { isEnabled } = require('@librechat/api');
const {
  logger,
  getAutoEncryptionOptions,
  bootstrapEncryption,
} = require('@librechat/data-schemas');

const mongoose = require('mongoose');
const MONGO_URI = process.env.MONGO_URI;
const MONGO_READER_URI = process.env.MONGO_READER_URI || MONGO_URI;
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

/** Whether a separate reader endpoint is configured. */
const hasReaderEndpoint = Boolean(process.env.MONGO_READER_URI) && MONGO_READER_URI !== MONGO_URI;

/** Writer uses the global mongoose singleton (backward compatible with all existing code and tests). */
const writerMongoose = mongoose;

/** Shared connection pool options (used by both writer and reader). */
const poolOpts = {
  bufferCommands: false,
  ...(maxPoolSize ? { maxPoolSize } : {}),
  ...(minPoolSize ? { minPoolSize } : {}),
  ...(maxConnecting ? { maxConnecting } : {}),
  ...(maxIdleTimeMS ? { maxIdleTimeMS } : {}),
  ...(waitQueueTimeoutMS ? { waitQueueTimeoutMS } : {}),
};

/**
 * Global is used here to maintain a cached connection across hot reloads
 * in development. This prevents connections growing exponentially
 * during API Route usage.
 *
 * Both the writer connection state and the reader Mongoose instance are
 * stored on `global` so they survive module re-evaluation during hot reloads.
 */
let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = {
    conn: null,
    reader: null,
    writerPromise: null,
    readerPromise: null,
    writerListenerAttached: false,
    readerListenerAttached: false,
    encryptionReady: false,
    lastBootstrapError: null,
    lastReaderError: null,
    bootstrapPromise: null,
    readerConfigLogged: false,
  };
}

/**
 * Reader is an independent instance for routing reads to a replica endpoint.
 * When no separate reader URI is configured, reuses the writer to avoid
 * duplicate connection pools in local dev.
 * Cached on global to survive hot reloads.
 */
const readerMongoose = hasReaderEndpoint
  ? cached.reader || (cached.reader = new mongoose.Mongoose())
  : mongoose;

// Attach error listeners once (guarded to prevent accumulation on hot reload)
if (!cached.writerListenerAttached) {
  mongoose.connection.on('error', (err) => {
    logger.error('[connectDb] MongoDB writer connection error:', err);
  });
  cached.writerListenerAttached = true;
}

if (hasReaderEndpoint && !cached.readerListenerAttached) {
  readerMongoose.connection.on('error', (err) => {
    logger.error('[connectDb] MongoDB reader connection error:', err);
  });
  cached.readerListenerAttached = true;
}

readerMongoose.set('strictQuery', true);

/** Returns the connection.readyState for a Mongoose instance (0=disconnected, 1=connected, 2=connecting, 3=disconnecting). */
function getReadyState(instance) {
  return instance && instance.connection ? instance.connection.readyState : 0;
}

async function connectDb() {
  if (!cached.readerConfigLogged) {
    cached.readerConfigLogged = true;
    if (hasReaderEndpoint) {
      logger.info('Mongo reader endpoint configured (separate from writer)');
    } else if (process.env.MONGO_READER_URI) {
      logger.info('Mongo reader endpoint: explicitly set to same URI as writer');
    } else {
      logger.info('Mongo reader endpoint: using writer (MONGO_READER_URI not configured)');
    }
  }

  const encryption = getAutoEncryptionOptions();

  const writerReady = cached.writerPromise && getReadyState(writerMongoose) === 1;
  const readerReady = !hasReaderEndpoint || getReadyState(readerMongoose) === 1;

  // Both connections ready; return early unless encryption bootstrap is pending
  if (writerReady && readerReady) {
    if (!encryption || cached.encryptionReady) {
      return cached.conn;
    }
    // Connections live but encryption bootstrap pending — fall through
  }

  // State 0 = truly disconnected; state 2 (connecting) is in-flight and should not trigger a new connect
  const writerDisconnected = cached.writerPromise && getReadyState(writerMongoose) === 0;
  const readerDisconnected = hasReaderEndpoint && getReadyState(readerMongoose) === 0;

  // Connect or reconnect writer independently
  if (!cached.writerPromise || writerDisconnected) {
    cached.encryptionReady = false;
    cached.lastBootstrapError = null;

    const encryptionOpts = encryption ? { autoEncryption: encryption.options } : {};
    const writerOpts = {
      ...poolOpts,
      ...(autoIndex != undefined ? { autoIndex } : {}),
      ...(autoCreate != undefined ? { autoCreate } : {}),
      ...encryptionOpts,
    };

    logger.info('Mongo Connection options (writer)');
    const loggableOpts = encryption
      ? {
          ...writerOpts,
          autoEncryption: {
            ...writerOpts.autoEncryption,
            kmsProviders: '[REDACTED]',
          },
        }
      : writerOpts;
    logger.info(JSON.stringify(loggableOpts, null, 2));

    mongoose.set('strictQuery', true);
    cached.writerPromise = mongoose.connect(MONGO_URI, writerOpts);
  }

  // Connect or reconnect reader independently (non-fatal — reader unavailability must not block startup)
  if (hasReaderEndpoint && (!cached.readerPromise || readerDisconnected)) {
    if (cached.lastReaderError && Date.now() - cached.lastReaderError < BOOTSTRAP_RETRY_MS) {
      logger.debug('[connectDb] Reader reconnect deferred — backoff active');
    } else {
      const encryptionOpts = encryption ? { autoEncryption: encryption.options } : {};
      const readerOpts = {
        ...poolOpts,
        ...encryptionOpts,
        readPreference: 'secondaryPreferred',
        autoIndex: false,
        autoCreate: false,
      };

      cached.readerPromise = readerMongoose
        .connect(MONGO_READER_URI, readerOpts)
        .then((conn) => {
          cached.lastReaderError = null;
          return conn;
        })
        .catch((err) => {
          cached.lastReaderError = Date.now();
          logger.warn(
            '[connectDb] Reader connection failed, dbReader methods will be unavailable:',
            err,
          );
        });
    }
  }

  cached.conn = await cached.writerPromise;

  // Encryption key bootstrap is writer-only; reader auto-decrypts via autoEncryption opts
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
  writerMongoose,
  readerMongoose,
};
