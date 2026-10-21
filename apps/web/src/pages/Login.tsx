import { useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { api, ApiError, loginUrl, post } from '../lib/api';
import { useSession } from '../lib/session';
import { Button, InlineError, Spinner } from '../components/ui';
import { useAction } from '../lib/hooks';

const ERRORS: Record<string, string> = {
  not_authorized:
    'This account cannot use Chat360 Project Operations. Use your Chat360 work account, or ask IT to grant access.',
  account_inactive:
    'Your access has been deactivated. Contact an administrator if this is unexpected.',
  signin_expired: 'The sign-in attempt expired. Please try again.',
  consent_declined: 'Sign-in was cancelled.',
  signin_failed: 'Sign-in failed. Please try again.',
  signin_mismatch:
    'You signed in with a different account than the one connected. Please try again.',
  unauthenticated: 'Sign-in could not be verified. Please try again.',
};

export function LoginPage() {
  const [params] = useSearchParams();
  const { status, refresh } = useSession();
  const returnTo = params.get('returnTo') ?? '/';
  const [config, setConfig] = useState<{ devAuth: boolean; entraConfigured: boolean } | null>(null);
  const [unconfigured, setUnconfigured] = useState(false);
  const [devUsers, setDevUsers] = useState<{ id: string; displayName: string; roles: string[] }[]>(
    [],
  );
  const devLogin = useAction(async (userId: string) => {
    await post('/api/auth/dev-login', { userId });
    await refresh();
  });

  useEffect(() => {
    document.title = 'Sign in · Chat360 Ops';
    void api<{ devAuth: boolean; entraConfigured: boolean }>('/api/auth/config')
      .then(async (c) => {
        setConfig(c);
        if (c.devAuth)
          setDevUsers((await api<{ users: typeof devUsers }>('/api/auth/dev-users')).users);
      })
      .catch((e: unknown) => {
        // A misconfigured server answers 503; say so instead of offering a sign-in that fails.
        if (e instanceof ApiError && e.code === 'service_misconfigured') setUnconfigured(true);
        setConfig({
          devAuth: false,
          entraConfigured: !(e instanceof ApiError && e.code === 'service_misconfigured'),
        });
      });
  }, []);

  if (status === 'authenticated')
    return (
      <Navigate
        to={returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/'}
        replace
      />
    );
  const error = params.get('error');

  return (
    <div className="login">
      <div className="login-card card">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>Chat360 Project Operations</h1>
            <p className="muted">
              Projects, trackers, daily confirmations and handovers in one place.
            </p>
          </div>
        </div>
        {params.get('signedOut') && <p className="notice">You have signed out.</p>}
        {error && (
          <p className="inline-error" role="alert">
            {ERRORS[error] ?? ERRORS.signin_failed}
          </p>
        )}
        {unconfigured && (
          <p className="inline-error" role="alert">
            The service is not fully set up yet: an administrator still needs to add the Microsoft
            365 and security settings in Cloudflare.
          </p>
        )}
        {!config ? (
          <Spinner label="Loading sign-in options…" />
        ) : (
          <>
            {config.entraConfigured ? (
              <a className="btn btn-primary btn-block" href={loginUrl(returnTo)}>
                Sign in with your Chat360 Microsoft account
              </a>
            ) : (
              !config.devAuth &&
              !unconfigured && (
                <p className="inline-error">
                  Microsoft sign-in is not configured for this environment.
                </p>
              )
            )}
            <p className="hint">
              Use your @chat.io work account. Access is granted by your administrator; no separate
              password is needed.
            </p>
            {config.devAuth && (
              <section className="dev-login" aria-labelledby="dev-login-title">
                <h2 id="dev-login-title">Developer sign-in</h2>
                <p className="hint">
                  Local development only. These are fictional demo users with in-memory data.
                </p>
                <InlineError error={devLogin.error} />
                <div className="dev-users">
                  {devUsers.map((u) => (
                    <Button
                      key={u.id}
                      onClick={() => devLogin.run(u.id)}
                      loading={devLogin.pending}
                    >
                      {u.displayName}
                    </Button>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
