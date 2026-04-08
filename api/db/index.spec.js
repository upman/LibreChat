describe('api/db/index.js', () => {
  test('createModels called once on writer, models copied to reader before indexSync loads', () => {
    jest.resetModules();

    const callOrder = [];
    const mockSchema = { name: 'mockSchema' };
    const mockWriterInstance = {
      models: {},
      model: jest.fn(),
    };
    const mockReaderInstance = {
      models: {},
      model: jest.fn(),
    };

    jest.doMock('@librechat/data-schemas', () => ({
      createModels: jest.fn((m) => {
        callOrder.push('createModels');
        m.models.Message = { name: 'Message', schema: mockSchema };
        m.models.Conversation = { name: 'Conversation', schema: mockSchema };
      }),
    }));

    jest.doMock('./indexSync', () => {
      callOrder.push('indexSync');
      return jest.fn();
    });

    jest.doMock('./connect', () => ({
      connectDb: jest.fn(),
      writerMongoose: mockWriterInstance,
      readerMongoose: mockReaderInstance,
    }));

    require('./index');

    const { createModels } = require('@librechat/data-schemas');
    // createModels called only once (on writer), not twice
    expect(createModels).toHaveBeenCalledTimes(1);
    expect(createModels.mock.calls[0][0]).toBe(mockWriterInstance);
    // Models copied to reader via readerMongoose.model(name, schema)
    expect(mockReaderInstance.model).toHaveBeenCalledWith('Message', mockSchema);
    expect(mockReaderInstance.model).toHaveBeenCalledWith('Conversation', mockSchema);
    // All happens before indexSync
    expect(callOrder).toEqual(['createModels', 'indexSync']);
  });

  test('createModels called once, no copy when reader aliases writer', () => {
    jest.resetModules();

    const callOrder = [];
    const mockSharedInstance = {
      models: {},
      model: jest.fn(),
    };

    jest.doMock('@librechat/data-schemas', () => ({
      createModels: jest.fn((m) => {
        callOrder.push('createModels');
        m.models.Message = { name: 'Message' };
        m.models.Conversation = { name: 'Conversation' };
      }),
    }));

    jest.doMock('./indexSync', () => {
      callOrder.push('indexSync');
      return jest.fn();
    });

    jest.doMock('./connect', () => ({
      connectDb: jest.fn(),
      writerMongoose: mockSharedInstance,
      readerMongoose: mockSharedInstance,
    }));

    require('./index');

    const { createModels } = require('@librechat/data-schemas');
    expect(callOrder).toEqual(['createModels', 'indexSync']);
    expect(createModels).toHaveBeenCalledTimes(1);
    // No model copying since reader === writer
    expect(mockSharedInstance.model).not.toHaveBeenCalled();
  });
});
