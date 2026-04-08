const mongoose = require('mongoose');

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
  getAutoEncryptionOptions: jest.fn(() => undefined),
  bootstrapEncryption: jest.fn(),
}));

jest.mock('@librechat/api', () => ({
  isEnabled: jest.fn((val) => val === 'true' || val === true),
}));

/**
 * Simulate a Mongoose instance's connection.readyState.
 * This is what getReadyState() reads in connect.js.
 */
function setReadyState(instance, state) {
  if (instance && instance.connection) {
    Object.defineProperty(instance.connection, 'readyState', {
      value: state,
      writable: true,
      configurable: true,
    });
  }
}

describe('connectDb()', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    delete global.mongoose;
    process.env = { ...ORIGINAL_ENV };
    process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/test-writer';
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  afterAll(async () => {
    delete global.mongoose;
    try {
      await mongoose.disconnect();
    } catch {
      // ignore
    }
  });

  test('readerMongoose aliases writerMongoose when MONGO_READER_URI is not set', () => {
    delete process.env.MONGO_READER_URI;
    const { writerMongoose, readerMongoose } = require('./connect');
    expect(readerMongoose).toBe(writerMongoose);
  });

  test('readerMongoose aliases writerMongoose when MONGO_READER_URI equals MONGO_URI', () => {
    process.env.MONGO_READER_URI = process.env.MONGO_URI;
    const { writerMongoose, readerMongoose } = require('./connect');
    expect(readerMongoose).toBe(writerMongoose);
  });

  test('readerMongoose is a separate instance when MONGO_READER_URI differs', () => {
    process.env.MONGO_READER_URI = 'mongodb://127.0.0.1:27017/test-reader';
    const { writerMongoose, readerMongoose } = require('./connect');
    expect(readerMongoose).not.toBe(writerMongoose);
  });

  test('reader connection failure does not prevent writer startup', async () => {
    process.env.MONGO_READER_URI = 'mongodb://invalid-host:99999/nope';
    const connectModule = require('./connect');

    const writerConnectSpy = jest
      .spyOn(connectModule.writerMongoose, 'connect')
      .mockImplementation(async () => {
        setReadyState(connectModule.writerMongoose, 1);
        return connectModule.writerMongoose;
      });

    const readerError = new Error('Reader DNS lookup failed');
    const readerConnectSpy = jest
      .spyOn(connectModule.readerMongoose, 'connect')
      .mockRejectedValue(readerError);

    const result = await connectModule.connectDb();

    expect(result).toBe(connectModule.writerMongoose);
    expect(writerConnectSpy).toHaveBeenCalledTimes(1);
    expect(readerConnectSpy).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[connectDb] Reader connection failed, dbReader methods will be unavailable:',
      readerError,
    );

    writerConnectSpy.mockRestore();
    readerConnectSpy.mockRestore();
  });

  test('writer reconnect does not disturb reader promise', async () => {
    process.env.MONGO_READER_URI = 'mongodb://127.0.0.1:27017/test-reader';
    const connectModule = require('./connect');

    const writerConnectSpy = jest
      .spyOn(connectModule.writerMongoose, 'connect')
      .mockImplementation(async () => {
        setReadyState(connectModule.writerMongoose, 1);
        return connectModule.writerMongoose;
      });

    const readerConnectSpy = jest
      .spyOn(connectModule.readerMongoose, 'connect')
      .mockImplementation(async () => {
        setReadyState(connectModule.readerMongoose, 1);
        return connectModule.readerMongoose;
      });

    await connectModule.connectDb();
    expect(writerConnectSpy).toHaveBeenCalledTimes(1);
    expect(readerConnectSpy).toHaveBeenCalledTimes(1);

    // Simulate writer disconnect (readyState 0), reader still up (readyState 1)
    setReadyState(connectModule.writerMongoose, 0);

    await connectModule.connectDb();

    expect(writerConnectSpy).toHaveBeenCalledTimes(2);
    expect(readerConnectSpy).toHaveBeenCalledTimes(1);

    writerConnectSpy.mockRestore();
    readerConnectSpy.mockRestore();
  });

  test('writer connection failure propagates to caller', async () => {
    const connectModule = require('./connect');
    const writerError = new Error('Writer connection refused');
    jest.spyOn(connectModule.writerMongoose, 'connect').mockRejectedValue(writerError);
    await expect(connectModule.connectDb()).rejects.toThrow('Writer connection refused');
  });

  test('reader reconnect is deferred within backoff window after failure', async () => {
    process.env.MONGO_READER_URI = 'mongodb://invalid-host:99999/nope';
    const connectModule = require('./connect');
    const mockNow = jest.spyOn(Date, 'now');

    const writerConnectSpy = jest
      .spyOn(connectModule.writerMongoose, 'connect')
      .mockImplementation(async () => {
        setReadyState(connectModule.writerMongoose, 1);
        return connectModule.writerMongoose;
      });

    const readerError = new Error('Reader DNS lookup failed');
    const readerConnectSpy = jest
      .spyOn(connectModule.readerMongoose, 'connect')
      .mockRejectedValue(readerError);

    // Call 1 at T=1000000 — reader fails, sets lastReaderError
    mockNow.mockReturnValue(1_000_000);
    await connectModule.connectDb();
    expect(readerConnectSpy).toHaveBeenCalledTimes(1);

    // Call 2 at T=1001000 (1s later) — within 5s backoff, reader deferred
    mockNow.mockReturnValue(1_001_000);
    const result = await connectModule.connectDb();
    expect(result).toBe(connectModule.writerMongoose);
    expect(readerConnectSpy).toHaveBeenCalledTimes(1);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      '[connectDb] Reader reconnect deferred — backoff active',
    );

    mockNow.mockRestore();
    writerConnectSpy.mockRestore();
    readerConnectSpy.mockRestore();
  });

  test('reader backoff clears after successful reconnect', async () => {
    process.env.MONGO_READER_URI = 'mongodb://127.0.0.1:27017/test-reader';
    const connectModule = require('./connect');

    const writerConnectSpy = jest
      .spyOn(connectModule.writerMongoose, 'connect')
      .mockImplementation(async () => {
        setReadyState(connectModule.writerMongoose, 1);
        return connectModule.writerMongoose;
      });

    const readerError = new Error('Reader DNS lookup failed');
    const readerConnectSpy = jest
      .spyOn(connectModule.readerMongoose, 'connect')
      .mockRejectedValue(readerError);

    // Call 1: reader fails → lastReaderError set
    await connectModule.connectDb();
    expect(readerConnectSpy).toHaveBeenCalledTimes(1);
    expect(global.mongoose.lastReaderError).not.toBeNull();

    // Expire backoff (old timestamp well past the 5s window) and make reader succeed
    global.mongoose.lastReaderError = Date.now() - 10_000;
    readerConnectSpy.mockImplementation(async () => {
      setReadyState(connectModule.readerMongoose, 1);
      return connectModule.readerMongoose;
    });

    // Call 2: reader succeeds → lastReaderError cleared
    await connectModule.connectDb();
    expect(readerConnectSpy).toHaveBeenCalledTimes(2);
    expect(global.mongoose.lastReaderError).toBeNull();

    // Simulate reader disconnect, make it fail again
    setReadyState(connectModule.readerMongoose, 0);
    readerConnectSpy.mockRejectedValue(new Error('Reader failed again'));

    // Call 3: should NOT be deferred — backoff was cleared by prior success
    await connectModule.connectDb();
    expect(readerConnectSpy).toHaveBeenCalledTimes(3);

    writerConnectSpy.mockRestore();
    readerConnectSpy.mockRestore();
  });
});
