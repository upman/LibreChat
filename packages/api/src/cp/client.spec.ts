import { getMockGUSDResponse } from './mock';

import type { GUSDResponse } from './types';

const mockLogger = {
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};

jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
}));

describe('fetchUserSessionDetails', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.CP_API_BASE_URL;
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  async function loadClient() {
    const { fetchUserSessionDetails } = await import('./client');
    return fetchUserSessionDetails;
  }

  it('returns mock response when CP_API_BASE_URL is not set in non-production', async () => {
    process.env.NODE_ENV = 'development';
    const fetchUserSessionDetails = await loadClient();

    const result = await fetchUserSessionDetails('any-token');

    expect(result).toEqual(getMockGUSDResponse());
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('CP_API_BASE_URL not set'),
    );
  });

  it('throws when CP_API_BASE_URL is not set in production', async () => {
    process.env.NODE_ENV = 'production';
    const fetchUserSessionDetails = await loadClient();

    await expect(fetchUserSessionDetails('any-token')).rejects.toThrow(
      'CP_API_BASE_URL is required in production',
    );
  });

  it('calls CP API with correct request shape', async () => {
    process.env.CP_API_BASE_URL = 'https://cp.example.com';

    const mockResponse: GUSDResponse = {
      userId: 'user-1',
      name: 'Test',
      email: 'test@test.com',
      userFeatures: [],
      orgFeatures: {},
      orgRoles: {},
      orgRolesV2: {},
      organizations: {},
      instances: {},
      roleMappings: [],
      pendingActions: [],
      dashboardRolesV2: [],
    };

    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const fetchUserSessionDetails = await loadClient();
    const result = await fetchUserSessionDetails('my-jwt-token');

    expect(fetchSpy).toHaveBeenCalledWith('https://cp.example.com/api/account', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer my-jwt-token',
      },
      body: JSON.stringify({ rpcAction: 'getUserSessionDetails' }),
      signal: expect.any(AbortSignal),
    });
    expect(result).toEqual(mockResponse);

    fetchSpy.mockRestore();
  });

  it('throws GUSDAuthError on 401 response', async () => {
    process.env.CP_API_BASE_URL = 'https://cp.example.com';

    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    } as Response);

    const fetchUserSessionDetails = await loadClient();
    const { GUSDAuthError } = await import('./client');

    const error = await fetchUserSessionDetails('bad-token').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GUSDAuthError);
    expect((error as Error).message).toBe('GUSD request failed with status 401');
    expect((error as Error).name).toBe('GUSDAuthError');
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('GUSD request failed (401)'),
    );

    fetchSpy.mockRestore();
  });

  it('throws plain Error on non-401 failure (e.g. 500)', async () => {
    process.env.CP_API_BASE_URL = 'https://cp.example.com';

    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    } as Response);

    const fetchUserSessionDetails = await loadClient();
    const { GUSDAuthError } = await import('./client');

    const err = await fetchUserSessionDetails('any-token').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(GUSDAuthError);
    expect((err as Error).message).toBe('GUSD request failed with status 500');

    fetchSpy.mockRestore();
  });

  it('throws on network error', async () => {
    process.env.CP_API_BASE_URL = 'https://cp.example.com';

    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('Network unreachable'));

    const fetchUserSessionDetails = await loadClient();

    await expect(fetchUserSessionDetails('any-token')).rejects.toThrow('Network unreachable');

    fetchSpy.mockRestore();
  });
});
