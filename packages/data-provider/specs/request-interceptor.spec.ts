/**
 * @jest-environment @happy-dom/jest-environment
 */
import axios from 'axios';
import { setTokenHeader } from '../src/headers-helpers';

/**
 * The response interceptor in request.ts registers at import time when
 * `typeof window !== 'undefined'` (happy-dom provides window).
 *
 * We use axios's built-in request adapter mock to avoid real HTTP calls,
 * and verify the interceptor's behavior by observing whether a 401 triggers
 * a refresh POST or is immediately rejected.
 *
 * happy-dom is used instead of jsdom because it allows overriding
 * window.location via Object.defineProperty, which jsdom 26+ blocks.
 */

const mockAdapter = jest.fn();
let originalAdapter: typeof axios.defaults.adapter;
let savedLocation: Location;
let normalizeChcLoginUrl: (loginUrl: unknown) => string;

beforeAll(async () => {
  originalAdapter = axios.defaults.adapter;
  axios.defaults.adapter = mockAdapter;

  const requestModule = await import('../src/request');
  normalizeChcLoginUrl = requestModule.normalizeChcLoginUrl;
});

beforeEach(() => {
  mockAdapter.mockReset();
  savedLocation = window.location;
});

afterAll(() => {
  axios.defaults.adapter = originalAdapter;
});

afterEach(() => {
  delete axios.defaults.headers.common['Authorization'];
  sessionStorage.clear();
  Object.defineProperty(window, 'location', {
    value: savedLocation,
    writable: true,
    configurable: true,
  });
});

function setWindowLocation(overrides: Partial<Location>) {
  Object.defineProperty(window, 'location', {
    value: { ...window.location, ...overrides },
    writable: true,
    configurable: true,
  });
}

describe('axios 401 interceptor — Authorization header guard', () => {
  it('skips refresh and rejects when Authorization header is cleared', async () => {
    expect.assertions(1);
    setTokenHeader(undefined);

    mockAdapter.mockRejectedValueOnce({
      response: { status: 401 },
      config: { url: '/api/messages', headers: {} },
    });

    try {
      await axios.get('/api/messages');
    } catch {
      // expected rejection
    }

    expect(mockAdapter).toHaveBeenCalledTimes(1);
  });

  it('attempts refresh on shared link page even without Authorization header', async () => {
    expect.assertions(2);
    setTokenHeader(undefined);

    setWindowLocation({
      href: 'http://localhost/share/abc123',
      pathname: '/share/abc123',
      search: '',
      hash: '',
    } as Partial<Location>);

    mockAdapter.mockRejectedValueOnce({
      response: { status: 401 },
      config: { url: '/api/share/abc123', headers: {} },
    });

    mockAdapter.mockResolvedValueOnce({
      data: { token: 'new-token' },
      status: 200,
      headers: {},
      config: {},
    });

    mockAdapter.mockResolvedValueOnce({
      data: { sharedLink: {} },
      status: 200,
      headers: {},
      config: {},
    });

    try {
      await axios.get('/api/share/abc123');
    } catch {
      // may reject depending on exact flow
    }

    expect(mockAdapter.mock.calls.length).toBe(3);

    const refreshCall = mockAdapter.mock.calls[1];
    expect(refreshCall[0].url).toContain('api/auth/refresh');
  });

  it('does not bypass guard when share/ appears only in query params', async () => {
    expect.assertions(1);
    setTokenHeader(undefined);

    setWindowLocation({
      href: 'http://localhost/c/chat?ref=share/token',
      pathname: '/c/chat',
      search: '?ref=share/token',
      hash: '',
    } as Partial<Location>);

    mockAdapter.mockRejectedValueOnce({
      response: { status: 401 },
      config: { url: '/api/messages', headers: {} },
    });

    try {
      await axios.get('/api/messages');
    } catch {
      // expected rejection
    }

    expect(mockAdapter).toHaveBeenCalledTimes(1);
  });

  it('redirects to login with redirect_to when unauthenticated on share page and refresh fails', async () => {
    expect.assertions(1);
    setTokenHeader(undefined);

    setWindowLocation({
      href: 'http://localhost/share/abc123',
      pathname: '/share/abc123',
      search: '',
      hash: '',
    } as Partial<Location>);

    mockAdapter.mockRejectedValueOnce({
      response: { status: 401 },
      config: { url: '/api/share/abc123', headers: {} },
    });

    mockAdapter.mockResolvedValueOnce({
      data: { token: '' },
      status: 200,
      headers: {},
      config: {},
    });

    try {
      await axios.get('/api/share/abc123');
    } catch {
      // expected rejection
    }

    expect(window.location.href).toBe('/login?redirect_to=%2Fshare%2Fabc123');
  });

  it('redirects to login with redirect_to when authenticated and refresh returns no token on share page', async () => {
    expect.assertions(1);
    setTokenHeader('some-token');

    setWindowLocation({
      href: 'http://localhost/share/abc123',
      pathname: '/share/abc123',
      search: '',
      hash: '',
    } as Partial<Location>);

    mockAdapter.mockRejectedValueOnce({
      response: { status: 401 },
      config: { url: '/api/share/abc123', headers: {} },
    });

    mockAdapter.mockResolvedValueOnce({
      data: { token: '' },
      status: 200,
      headers: {},
      config: {},
    });

    try {
      await axios.get('/api/share/abc123');
    } catch {
      // expected rejection
    }

    expect(window.location.href).toBe('/login?redirect_to=%2Fshare%2Fabc123');
  });

  it('redirects to login with redirect_to when refresh returns no token on regular page', async () => {
    expect.assertions(1);
    setTokenHeader('some-token');

    setWindowLocation({
      href: 'http://localhost/c/some-conversation',
      pathname: '/c/some-conversation',
      search: '',
      hash: '',
    } as Partial<Location>);

    mockAdapter.mockRejectedValueOnce({
      response: { status: 401 },
      config: { url: '/api/messages', headers: {} },
    });

    mockAdapter.mockResolvedValueOnce({
      data: { token: '' },
      status: 200,
      headers: {},
      config: {},
    });

    try {
      await axios.get('/api/messages');
    } catch {
      // expected rejection
    }

    expect(window.location.href).toBe('/login?redirect_to=%2Fc%2Fsome-conversation');
  });

  it('redirects to plain /login without redirect_to when already on a login path', async () => {
    expect.assertions(1);
    setTokenHeader('some-token');

    setWindowLocation({
      href: 'http://localhost/login/2fa',
      pathname: '/login/2fa',
      search: '',
      hash: '',
    } as Partial<Location>);

    mockAdapter.mockRejectedValueOnce({
      response: { status: 401 },
      config: { url: '/api/messages', headers: {} },
    });

    mockAdapter.mockResolvedValueOnce({
      data: { token: '' },
      status: 200,
      headers: {},
      config: {},
    });

    try {
      await axios.get('/api/messages');
    } catch {
      // expected rejection
    }

    expect(window.location.href).toBe('/login');
  });

  it('attempts refresh when Authorization header is present', async () => {
    expect.assertions(2);
    setTokenHeader('valid-token');

    mockAdapter.mockRejectedValueOnce({
      response: { status: 401 },
      config: { url: '/api/messages', headers: {}, _retry: false },
    });

    mockAdapter.mockResolvedValueOnce({
      data: { token: 'new-token' },
      status: 200,
      headers: {},
      config: {},
    });

    mockAdapter.mockResolvedValueOnce({
      data: { messages: [] },
      status: 200,
      headers: {},
      config: {},
    });

    try {
      await axios.get('/api/messages');
    } catch {
      // may reject depending on exact flow
    }

    expect(mockAdapter.mock.calls.length).toBe(3);

    const refreshCall = mockAdapter.mock.calls[1];
    expect(refreshCall[0].url).toContain('api/auth/refresh');
  });
});

describe('axios CHC reauth interceptor', () => {
  it('falls back for protocol-relative login URLs', () => {
    expect(normalizeChcLoginUrl('//evil.example/login')).toBe('/oauth/openid?prompt=login');
  });

  it('redirects to provided OpenID login URL and preserves the current path', async () => {
    setTokenHeader('valid-token');

    setWindowLocation({
      href: 'http://localhost/c/some-conversation?model=gpt-4#turn',
      pathname: '/c/some-conversation',
      search: '?model=gpt-4',
      hash: '#turn',
    } as Partial<Location>);

    mockAdapter.mockRejectedValueOnce({
      response: {
        status: 401,
        data: {
          error_code: 'CHC_REAUTH_REQUIRED',
          login_url: '/oauth/openid?prompt=login',
        },
      },
      config: { url: '/api/agents/chat', headers: {} },
    });

    const outcome = await Promise.race([
      axios.post('/api/agents/chat', {}).then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
    ]);

    expect(outcome).toBe('pending');
    expect(mockAdapter).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe('/oauth/openid?prompt=login');
    expect(sessionStorage.getItem('post_login_redirect_to')).toBe(
      '/c/some-conversation?model=gpt-4#turn',
    );
  });
});

/**
 * Tests are ordered deliberately: the redirect test sets a module-level
 * _isRedirectingForAuthError flag that persists for the process lifetime.
 * Non-redirect tests run first to avoid being affected by it.
 */
describe('axios 403 MFA interceptor', () => {
  it('rejects normally on mfa_required without Authorization header (fresh page load)', async () => {
    setTokenHeader(undefined);

    mockAdapter.mockRejectedValueOnce({
      response: { status: 403, data: { error_code: 'mfa_required' } },
      config: { url: '/api/auth/refresh', headers: {} },
    });

    try {
      await axios.get('/api/auth/refresh');
    } catch {
      // expected — no auth header means the error rejects normally
    }

    expect(mockAdapter).toHaveBeenCalledTimes(1);
    expect(window.location.href).not.toContain('mfa_required');
  });

  it('does not trigger MFA redirect for non-MFA 403 errors', async () => {
    setTokenHeader('valid-token');

    mockAdapter.mockRejectedValueOnce({
      response: { status: 403, data: { error_code: 'some_other_error' } },
      config: { url: '/api/messages', headers: {} },
    });

    try {
      await axios.get('/api/messages');
    } catch {
      // expected rejection
    }

    expect(mockAdapter).toHaveBeenCalledTimes(1);
    expect(window.location.href).not.toContain('mfa_required');
  });

  it('redirects to login with mfa_required when user was previously authenticated', async () => {
    setTokenHeader('valid-token');

    mockAdapter.mockRejectedValueOnce({
      response: { status: 403, data: { error_code: 'mfa_required' } },
      config: { url: '/api/auth/refresh', headers: {} },
    });

    const outcome = await Promise.race([
      axios.get('/api/auth/refresh').then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
    ]);

    expect(outcome).toBe('pending');
    expect(window.location.href).toContain('error=mfa_required');
    expect(window.location.href).toContain('redirect=false');
  });

  it('suppresses duplicate redirects for concurrent mfa_required errors', async () => {
    setTokenHeader('valid-token');

    mockAdapter.mockRejectedValueOnce({
      response: { status: 403, data: { error_code: 'mfa_required' } },
      config: { url: '/api/messages', headers: {} },
    });

    try {
      await axios.get('/api/messages');
    } catch {
      // _isRedirectingForAuthError is already true — 403 block skipped, error rejects normally
    }

    expect(mockAdapter).toHaveBeenCalledTimes(1);
  });
});
