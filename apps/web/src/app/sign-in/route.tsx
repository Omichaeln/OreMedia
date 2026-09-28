import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Button, Field, Input, Panel, StatusBanner } from '@oremedia/ui';
import { SignInErrorCode, type PasswordAuthErrorCode } from '@oremedia/contracts/access';
import { TopBar } from '../root';
import { DeploymentLogo } from '../../components/deployment-logo';
import { PageHeading } from '../../components/request-state';
import { useDeploymentBrand } from '../../lib/deployment-brand';
import { useTRPCClient } from '../../lib/trpc';
import { toUiError } from '../../lib/errors';
import {
  clearBearerToken,
  googleSignInHref,
  hasCredential,
  PASSWORD_SIGN_IN_PATH,
  postPasswordAuth,
  setBearerToken,
  tokenSignInAvailable,
} from '../../lib/session';

/** What each refusal code from the callback (`/sign-in?error=…`) tells the person, and what to do next. */
const refusals = (product: string): Record<SignInErrorCode, { title: string; description: string }> => ({
  not_invited: {
    title: 'This Google account has not been invited',
    description: `${product} has no self sign-up. Ask a company owner to invite the email address of the Google account you chose, then continue with Google again.`,
  },
  domain_not_allowed: {
    title: 'This Google account is not from an allowed domain',
    description: `Sign in with the Google Workspace account your organisation uses for ${product}.`,
  },
  email_not_verified: {
    title: 'Google has not verified this email address',
    description: 'Verify the address with Google, or choose another account.',
  },
  account_disabled: {
    title: 'This account is disabled',
    description: 'Contact an owner of your company to have access restored.',
  },
  email_not_authoritative: {
    title: "Use your organisation's Google account",
    description:
      "This Google account is not managed for its email address (it is a personal Google account on a work address). Choose your company's Google Workspace account, or a Gmail address you were invited with.",
  },
  sign_in_failed: {
    title: 'Sign-in did not complete',
    description: 'Something went wrong while signing in with Google. Continue with Google to try again.',
  },
  unavailable: {
    title: 'Google sign-in is not available',
    description: 'Google sign-in is not configured on this server. Contact your administrator.',
  },
});

/**
 * What a refused password sign-in tells the person. Every credential failure reads the same (the API never says
 * whether an account exists); only the setup route answers link or policy codes, which this form never gets.
 */
const passwordSignInMessage = (code: PasswordAuthErrorCode): string => {
  switch (code) {
    case 'invalid_credentials':
      return 'That email and password do not match an account that can sign in with a password.';
    case 'too_many_attempts':
      return 'Too many attempts. Wait fifteen minutes, then try again, or continue with Google.';
    case 'busy':
      return 'The server is busy. Wait a moment, then try again.';
    case 'origin_rejected':
      return 'This sign-in form must be used from the app itself. Reload the page and try again.';
    default:
      return 'Sign-in did not complete. Try again.';
  }
};

/** Only a same-origin path is carried to the API as returnTo (the API re-checks it). */
const safeNext = (value: string | null): string =>
  value && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : '/portfolio';

/**
 * D-03: Google authenticates (OpenID Connect); Oremedia authorises. "Continue with Google" is a plain link to the
 * API's /auth/google/start (a navigation, not a request), and the callback comes back here with a refusal code
 * when sign-in is refused. The pasted-token form exists only for development and the browser suites.
 */
export function SignInRoute() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const parsed = SignInErrorCode.safeParse(params.get('error'));
  const brand = useDeploymentBrand();
  const refusal =
    params.get('error') === null
      ? null
      : refusals(brand.name)[parsed.success ? parsed.data : 'sign_in_failed'];

  return (
    <>
      <TopBar title="Sign in" />
      <main id="main" className="mx-auto w-full max-w-lg p-6">
        <DeploymentLogo className="mb-6 h-20" />
        <PageHeading
          title={`Sign in to ${brand.name}`}
          description={`Use the Google account your company invited, or your email and password if you have set one. Your company's owners decide what you can do in ${brand.name}.`}
        />
        {refusal && (
          <StatusBanner
            tone="critical"
            title={refusal.title}
            description={refusal.description}
            className="mb-4"
            data-testid="sign-in-refusal"
            data-refusal={parsed.success ? parsed.data : 'sign_in_failed'}
          />
        )}
        <Panel title="Google account" className="mb-4" bodyClassName="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            You will choose an account at Google and come back here. Only invited people can sign in.
          </p>
          <div>
            <Button asChild variant="primary">
              <a href={googleSignInHref(next)}>Continue with Google</a>
            </Button>
          </div>
        </Panel>
        <PasswordSignInForm next={next} />
        {tokenSignInAvailable() && <TokenSignIn next={next} />}
      </main>
    </>
  );
}

/**
 * Email and password (the second sign-in method). The API sets the same session cookies as Google and answers JSON;
 * the page then navigates. A password is set from a one-time link an owner or admin issues, or in Settings.
 */
function PasswordSignInForm({ next }: { next: string }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Enter your email address and password.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await postPasswordAuth(PASSWORD_SIGN_IN_PATH, { email: email.trim(), password });
    setBusy(false);
    if (result.ok) {
      navigate(next, { replace: true });
      return;
    }
    setPassword('');
    setError(passwordSignInMessage(result.error));
  };

  return (
    <Panel title="Email and password" className="mb-4">
      <form
        onSubmit={(e) => void submit(e)}
        className="flex flex-col gap-3"
        noValidate
        aria-busy={busy}
        data-testid="password-sign-in"
      >
        <Field label="Email" htmlFor="sign-in-email">
          <Input
            id="sign-in-email"
            name="email"
            type="email"
            autoComplete="email"
            spellCheck={false}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
          />
        </Field>
        <Field label="Password" htmlFor="sign-in-password" error={error ?? undefined}>
          <Input
            id="sign-in-password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </Field>
        <p className="text-xs text-muted-foreground">
          No password yet? Ask an owner or admin of your company for a password setup link.
        </p>
        <div>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

/** Development only (loopback or the Vite dev server): sign in with a session token issued for your user. */
function TokenSignIn({ next }: { next: string }) {
  const client = useTRPCClient();
  const navigate = useNavigate();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const verifyAndContinue = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.access.listCompanies.query();
      navigate(next, { replace: true });
    } catch (err) {
      const ui = toUiError(err);
      clearBearerToken();
      setError(
        ui.kind === 'sign_in'
          ? 'That token is not a valid, unexpired session token.'
          : ui.kind === 'forbidden'
            ? `${ui.message} Only a user session (ses_…) has a portfolio.`
            : ui.message,
      );
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim()) {
      setError('Paste a session token first.');
      return;
    }
    setBearerToken(token);
    void verifyAndContinue();
  };

  return (
    <Panel title="Development sign-in">
      <p className="mb-3 text-sm text-muted-foreground">
        Shown only on a local address. The API accepts a session token issued for your user; it is kept only
        in this browser tab.
      </p>
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <Field label="Session token" htmlFor="token" hint="Starts with ses_" error={error ?? undefined}>
          <Input
            id="token"
            name="token"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ses_…"
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? 'Checking…' : 'Continue'}
          </Button>
          {hasCredential() && !token && (
            <Button type="button" onClick={() => void verifyAndContinue()} disabled={busy}>
              Continue with the existing session
            </Button>
          )}
        </div>
      </form>
    </Panel>
  );
}
