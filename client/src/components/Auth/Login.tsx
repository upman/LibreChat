import { useEffect, useState } from 'react';
import { ErrorTypes, registerPage } from 'librechat-data-provider';
import { useToastContext } from '@librechat/client';
import { useOutletContext, useSearchParams, useLocation } from 'react-router-dom';
import type { TLoginLayoutContext } from '~/common';
import { getLoginError, persistRedirectToSession } from '~/utils';
import { ErrorMessage } from '~/components/Auth/ErrorMessage';
import { useAuthContext } from '~/hooks/AuthContext';
import { useLocalize } from '~/hooks';
import LoginForm from './LoginForm';

const CHC_ERROR_CODES = new Set([
  ErrorTypes.NO_ELIGIBLE_ORG,
  ErrorTypes.CHC_AUTH_FAILED,
  ErrorTypes.TENANT_NOT_ELIGIBLE,
]);

interface LoginLocationState {
  redirect_to?: string;
}

function Login() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { error, setError, login } = useAuthContext();
  const { startupConfig } = useOutletContext<TLoginLayoutContext>();

  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const disableAutoRedirect = searchParams.get('redirect') === 'false';

  const initialOauthError = searchParams.get('error');
  const hasChcError = !!initialOauthError && CHC_ERROR_CODES.has(initialOauthError as ErrorTypes);

  const [pendingMfaRedirect, setPendingMfaRedirect] = useState(
    initialOauthError === ErrorTypes.MFA_REQUIRED,
  );
  const [isAutoRedirectDisabled, setIsAutoRedirectDisabled] = useState(
    disableAutoRedirect || hasChcError,
  );
  const [chcError, setChcError] = useState<{ code: string; description: string } | null>(() => {
    if (!hasChcError) {
      return null;
    }
    return {
      code: initialOauthError,
      description:
        searchParams.get('error_description') ??
        'LibreChat is not enabled for the current organization',
    };
  });

  useEffect(() => {
    const redirectTo = searchParams.get('redirect_to');
    if (redirectTo) {
      persistRedirectToSession(redirectTo);
    } else {
      const state = location.state as LoginLocationState | null;
      if (state?.redirect_to) {
        persistRedirectToSession(state.redirect_to);
      }
    }

    const oauthError = searchParams?.get('error');
    if (!oauthError) {
      return;
    }

    if (CHC_ERROR_CODES.has(oauthError as ErrorTypes)) {
      if (!chcError) {
        setChcError({
          code: oauthError,
          description:
            searchParams.get('error_description') ?? localize('com_auth_error_chc_no_eligible_org'),
        });
      }
      setIsAutoRedirectDisabled(true);
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('error');
      newParams.delete('error_description');
      setSearchParams(newParams, { replace: true });
      return;
    }

    if (oauthError === ErrorTypes.MFA_REQUIRED) {
      setPendingMfaRedirect(true);
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('error');
      newParams.delete('redirect');
      setSearchParams(newParams, { replace: true });
      return;
    }

    if (oauthError === ErrorTypes.AUTH_FAILED) {
      showToast({
        message: localize('com_auth_error_oauth_failed'),
        status: 'error',
      });
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('error');
      setSearchParams(newParams, { replace: true });
    }
  }, [searchParams, setSearchParams, showToast, localize, location.state, chcError]);

  useEffect(() => {
    if (!pendingMfaRedirect) {
      return;
    }
    if (startupConfig?.serverDomain) {
      window.location.href = `${startupConfig.serverDomain}/oauth/openid?prompt=login`;
      return;
    }
    const timeout = setTimeout(() => {
      setPendingMfaRedirect(false);
      showToast({ message: localize('com_auth_error_oauth_failed'), status: 'error' });
    }, 5000);
    return () => clearTimeout(timeout);
  }, [pendingMfaRedirect, startupConfig, showToast, localize]);

  useEffect(() => {
    if (disableAutoRedirect) {
      setIsAutoRedirectDisabled(true);
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('redirect');
      setSearchParams(newParams, { replace: true });
    }
  }, [disableAutoRedirect, searchParams, setSearchParams]);

  const shouldAutoRedirect =
    !chcError &&
    startupConfig?.openidLoginEnabled &&
    startupConfig?.openidAutoRedirect &&
    startupConfig?.serverDomain &&
    !isAutoRedirectDisabled;

  useEffect(() => {
    if (shouldAutoRedirect) {
      window.location.href = `${startupConfig.serverDomain}/oauth/openid`;
    }
  }, [shouldAutoRedirect, startupConfig]);

  if (chcError) {
    return (
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
          <svg
            className="h-6 w-6 text-red-600 dark:text-red-400"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth="1.5"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
            />
          </svg>
        </div>
        <h2 className="mb-2 text-lg font-semibold text-gray-900 dark:text-white">
          {localize('com_auth_error_chc_title')}
        </h2>
        <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">{chcError.description}</p>
        <p className="mb-6 text-xs text-gray-500 dark:text-gray-500">
          {localize('com_auth_error_chc_enable_hint')}{' '}
          <a
            href="https://clickhouse.cloud"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-green-600 underline hover:text-green-700 dark:text-green-500 dark:hover:text-green-400"
          >
            {localize('com_auth_error_chc_console_link')}
          </a>
          .
        </p>
        <button
          onClick={() => {
            setChcError(null);
            setIsAutoRedirectDisabled(true);
          }}
          className="w-full rounded-lg bg-green-600 px-6 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 dark:bg-green-700 dark:hover:bg-green-600"
        >
          {localize('com_auth_back_to_login')}
        </button>
      </div>
    );
  }

  if (pendingMfaRedirect || shouldAutoRedirect) {
    return (
      <p className="text-center text-sm text-gray-500 dark:text-gray-400">
        {localize('com_ui_redirecting_to_provider', { 0: startupConfig?.openidLabel ?? 'OpenID' })}
      </p>
    );
  }

  return (
    <>
      {error != null && <ErrorMessage>{localize(getLoginError(error))}</ErrorMessage>}
      {startupConfig?.emailLoginEnabled === true && (
        <LoginForm
          onSubmit={login}
          startupConfig={startupConfig}
          error={error}
          setError={setError}
        />
      )}
      {startupConfig?.registrationEnabled === true && (
        <p className="my-4 text-center text-sm font-light text-gray-700 dark:text-white">
          {' '}
          {localize('com_auth_no_account')}{' '}
          <a
            href={registerPage()}
            className="inline-flex p-1 text-sm font-medium text-green-600 underline decoration-transparent transition-all duration-200 hover:text-green-700 hover:decoration-green-700 focus:text-green-700 focus:decoration-green-700 dark:text-green-500 dark:hover:text-green-400 dark:hover:decoration-green-400 dark:focus:text-green-400 dark:focus:decoration-green-400"
          >
            {localize('com_auth_sign_up')}
          </a>
        </p>
      )}
    </>
  );
}

export default Login;
