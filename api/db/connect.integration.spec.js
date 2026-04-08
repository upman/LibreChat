/**
 * Integration tests for the dual-connection setup using a real in-memory MongoDB.
 *
 * Verifies that:
 * - Two independent Mongoose instances can connect to the same server
 * - Model copying from writer to reader produces functional models
 * - Data written via the writer is readable via the reader
 * - createMethods produces working methods on both instances
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels, createMethods } = require('@librechat/data-schemas');

describe('dual-connection integration', () => {
  let mongoServer;
  let writerMongoose;
  let readerMongoose;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();

    writerMongoose = new mongoose.Mongoose();
    readerMongoose = new mongoose.Mongoose();

    await Promise.all([writerMongoose.connect(uri), readerMongoose.connect(uri)]);

    // Register models on writer (applies plugins once)
    createModels(writerMongoose);

    // Copy models to reader without re-running createModels (same as api/db/index.js)
    for (const [name, model] of Object.entries(writerMongoose.models)) {
      if (!readerMongoose.models[name]) {
        readerMongoose.model(name, model.schema);
      }
    }
  });

  afterAll(async () => {
    await writerMongoose.disconnect();
    await readerMongoose.disconnect();
    await mongoServer.stop();
  });

  afterEach(async () => {
    for (const name of Object.keys(writerMongoose.connection.collections)) {
      await writerMongoose.connection.collections[name].deleteMany({});
    }
  });

  test('both instances have the same model names registered', () => {
    const writerNames = Object.keys(writerMongoose.models).sort();
    const readerNames = Object.keys(readerMongoose.models).sort();
    expect(readerNames).toEqual(writerNames);
    expect(writerNames.length).toBeGreaterThan(0);
  });

  test('model registries are independent (different Model objects, same schema)', () => {
    const writerUser = writerMongoose.models.User;
    const readerUser = readerMongoose.models.User;
    expect(writerUser).not.toBe(readerUser);
    expect(writerUser.schema).toBe(readerUser.schema);
  });

  test('data written via writer is readable via reader', async () => {
    const WriterUser = writerMongoose.models.User;
    const ReaderUser = readerMongoose.models.User;

    const created = await WriterUser.create({
      name: 'Test User',
      username: 'testuser',
      email: 'test@example.com',
      provider: 'local',
      emailVerified: false,
      role: 'USER',
    });

    const found = await ReaderUser.findById(created._id).lean();
    expect(found).toBeTruthy();
    expect(found.email).toBe('test@example.com');
    expect(found.username).toBe('testuser');
  });

  test('createMethods produces working methods on both instances', async () => {
    const writerMethods = createMethods(writerMongoose);
    const readerMethods = createMethods(readerMongoose);

    // Writer creates a user (returns ObjectId by default; 4th arg = returnUser not needed)
    const userId = await writerMethods.createUser({
      email: 'methods@test.com',
      username: 'mtest',
    });
    expect(userId).toBeTruthy();

    // Reader finds the same user via its own methods (bound to readerMongoose)
    const found = await readerMethods.findUser({ email: 'methods@test.com' });
    expect(found).toBeTruthy();
    expect(found._id.toString()).toBe(userId.toString());
    expect(found.email).toBe('methods@test.com');
  });
});
