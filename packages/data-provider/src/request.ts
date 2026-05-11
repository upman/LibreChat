/* eslint-disable @typescript-eslint/no-explicit-any */
import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { setTokenHeader } from './headers-helpers';
import * as endpoints from './api-endpoints';
import { ErrorTypes } from './config';
import type * as t from './types';

let _isRedirectingForAuthError = false;
let _isRedirectingForChcReauth = false;

const POST_LOGIN_REDIRECT_KEY = 'post_login_redirect_to';
const CHC_REAUTH_FALLBACK_LOGIN_URL = '/oauth/openid?prompt=login';

interface ChcReauthErrorBody {
  error_code?: unknown;
  login_url?: unknown;
  loginUrl?: unknown;
}

function asChcReauthErrorBody(value: unknown): ChcReauthErrorBody | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as ChcReauthErrorBody;
}

export function normalizeChcLoginUrl(loginUrl: unknown): string {
  if (typeof loginUrl !== 'string') {
    return CHC_REAUTH_FALLBACK_LOGIN_URL;
  }

  const trimmed = loginUrl.trim();
  if (!trimmed) {
    return CHC_REAUTH_FALLBACK_LOGIN_URL;
  }

  if (trimmed.startsWith('//')) {
    return CHC_REAUTH_FALLBACK_LOGIN_URL;
  }

  if (trimmed.startsWith('/') || /^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return CHC_REAUTH_FALLBACK_LOGIN_URL;
}

function persistCurrentRedirectTarget(): void {
  try {
    const loginRedirect = endpoints.buildLoginRedirectUrl();
    const queryIndex = loginRedirect.indexOf('?');
    const redirectTo =
      queryIndex === -1
        ? null
        : new URLSearchParams(loginRedirect.slice(queryIndex + 1)).get('redirect_to');
    if (redirectTo) {
      window.sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, redirectTo);
    }
  } catch {
    // Redirect preservation is best-effort; reauth should still proceed.
  }
}

function buildChcLoginHref(loginUrl: string): string {
  if (/^https?:\/\//i.test(loginUrl)) {
    return loginUrl;
  }
  return `${endpoints.apiBaseUrl()}${loginUrl}`;
}

export function maybeRedirectForChcReauth(errorData: unknown): boolean {
  const body = asChcReauthErrorBody(errorData);
  if (body?.error_code !== ErrorTypes.CHC_REAUTH_REQUIRED) {
    return false;
  }

  if (_isRedirectingForChcReauth) {
    return true;
  }

  _isRedirectingForChcReauth = true;
  persistCurrentRedirectTarget();
  window.location.href = buildChcLoginHref(normalizeChcLoginUrl(body.login_url ?? body.loginUrl));
  return true;
}

async function _get<T>(url: string, options?: AxiosRequestConfig): Promise<T> {
  const response = await axios.get(url, { ...options });
  return response.data;
}

async function _getResponse<T>(url: string, options?: AxiosRequestConfig): Promise<T> {
  return await axios.get(url, { ...options });
}

async function _post(url: string, data?: any) {
  const response = await axios.post(url, JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
  return response.data;
}

async function _postMultiPart(url: string, formData: FormData, options?: AxiosRequestConfig) {
  const response = await axios.post(url, formData, {
    ...options,
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return response.data;
}

async function _postTTS(url: string, formData: FormData, options?: AxiosRequestConfig) {
  const response = await axios.post(url, formData, {
    ...options,
    headers: { 'Content-Type': 'multipart/form-data' },
    responseType: 'arraybuffer',
  });
  return response.data;
}

async function _put(url: string, data?: any) {
  const response = await axios.put(url, JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
  return response.data;
}

async function _delete<T>(url: string): Promise<T> {
  const response = await axios.delete(url);
  return response.data;
}

async function _deleteWithOptions<T>(url: string, options?: AxiosRequestConfig): Promise<T> {
  const response = await axios.delete(url, { ...options });
  return response.data;
}

async function _patch(url: string, data?: any) {
  const response = await axios.patch(url, JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
  return response.data;
}

let isRefreshing = false;
let failedQueue: { resolve: (value?: any) => void; reject: (reason?: any) => void }[] = [];

const refreshToken = (retry?: boolean): Promise<t.TRefreshTokenResponse | undefined> =>
  _post(endpoints.refreshToken(retry));

const dispatchTokenUpdatedEvent = (token: string) => {
  setTokenHeader(token);
  window.dispatchEvent(new CustomEvent('tokenUpdated', { detail: token }));
};

const processQueue = (error: AxiosError | null, token: string | null = null) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

if (typeof window !== 'undefined') {
  axios.interceptors.response.use(
    (response) => response,
    async (error) => {
      const originalRequest = error.config;
      if (!error.response) {
        return Promise.reject(error);
      }

      if (originalRequest.url?.includes('/api/auth/2fa') === true) {
        return Promise.reject(error);
      }
      if (originalRequest.url?.includes('/api/auth/logout') === true) {
        return Promise.reject(error);
      }

      if (error.response.status === 401 && maybeRedirectForChcReauth(error.response.data)) {
        return new Promise(() => {});
      }

      if (error.response.status === 403 && !_isRedirectingForAuthError) {
        const errorCode = error.response.data?.error_code;
        const base = endpoints.apiBaseUrl();
        if (errorCode === 'TENANT_NOT_ELIGIBLE') {
          _isRedirectingForAuthError = true;
          window.location.href =
            base +
            '/login?redirect=false&error=tenant_not_eligible&error_description=' +
            encodeURIComponent(
              error.response.data?.error || 'LibreChat is not enabled for the current organization',
            );
          return new Promise(() => {});
        }
        if (
          errorCode === ErrorTypes.MFA_REQUIRED &&
          axios.defaults.headers.common['Authorization']
        ) {
          _isRedirectingForAuthError = true;
          const loginUrl = endpoints.buildLoginRedirectUrl({ disableAutoRedirect: true });
          const sep = loginUrl.includes('?') ? '&' : '?';
          window.location.href = `${base}${loginUrl}${sep}error=${ErrorTypes.MFA_REQUIRED}`;
          return new Promise(() => {});
        }
      }

      /** Skip refresh when the Authorization header has been cleared (e.g. during logout),
       *  but allow shared link requests to proceed so auth recovery/redirect can happen */
      if (
        !axios.defaults.headers.common['Authorization'] &&
        !window.location.pathname.startsWith('/share/')
      ) {
        return Promise.reject(error);
      }

      if (error.response.status === 401 && !originalRequest._retry) {
        console.warn('401 error, refreshing token');
        originalRequest._retry = true;

        if (isRefreshing) {
          try {
            const token = await new Promise((resolve, reject) => {
              failedQueue.push({ resolve, reject });
            });
            originalRequest.headers['Authorization'] = 'Bearer ' + token;
            return await axios(originalRequest);
          } catch (err) {
            return Promise.reject(err);
          }
        }

        isRefreshing = true;

        try {
          const response = await refreshToken(
            // Retry flag prevents blank screen when a refresh-on-refresh 401 occurs
            originalRequest.url?.includes('api/auth/refresh') === true ? true : false,
          );

          const token = response?.token ?? '';

          if (token) {
            originalRequest.headers['Authorization'] = 'Bearer ' + token;
            dispatchTokenUpdatedEvent(token);
            processQueue(null, token);
            return await axios(originalRequest);
          } else {
            processQueue(error, null);
            window.location.href = endpoints.apiBaseUrl() + endpoints.buildLoginRedirectUrl();
          }
        } catch (err) {
          processQueue(err as AxiosError, null);
          return Promise.reject(err);
        } finally {
          isRefreshing = false;
        }
      }

      return Promise.reject(error);
    },
  );
}

export default {
  get: _get,
  getResponse: _getResponse,
  post: _post,
  postMultiPart: _postMultiPart,
  postTTS: _postTTS,
  put: _put,
  delete: _delete,
  deleteWithOptions: _deleteWithOptions,
  patch: _patch,
  refreshToken,
  dispatchTokenUpdatedEvent,
};
