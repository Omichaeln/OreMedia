import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, Field, Input, Panel, StatusBanner } from '@oremedia/ui';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordPolicyIssue,
  type PasswordAuthErrorCode,
} from '@oremedia/contracts/access';
import { PASSWORD_POLICY_MESSAGE as POLICY_MESSAGE } from '../../features/session/account-password';
import { TopBar } from '../root';
import { DeploymentLogo } from '../../components/deployment-logo';
import { PageHeading } from '../../components/request-state';
import { useDeploymentBrand } from '../../lib/deployment-brand';
import { PASSWORD_SETUP_PATH, postPasswordAuth } from '../../lib/session';

const SETUP_ERROR: Record<Exclude<PasswordAuthErrorCode, 'password_rejected'>, string> = {
  link_invalid:
    'This link is no longer valid: it was used, it expired or a newer one was issued. Ask an owner or admin of your company for a new link.',
  too_many_attempts: 'Too many attempts from this network. Wait a minute, then try again.',
  origin_rejected: 'This form must be used from the app itself. Open the link again.',
  invalid_credentials: 'The password was not set. Ask an owner or admin of your company for a new link.',
  sign_in_failed: 'The password was not set. Try again.',
  busy: 'The server is busy. Wait a moment, then try again.',
};

/**
 * The one-time link's token, read once from the URL fragment (it never reaches a server: fragments are not sent) and
 * then removed from the address bar and the history entry, so it is not left behind in the browser.
 */
function takeTokenFromFragment(): string | null {
  if (typeof window === 'undefined') return null;
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (window.location.hash)
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  return token?.trim() || null;
}

/**
 * `/set-password#token=…`: the page a password setup link opens (issued by an owner or admin in Settings → Members;
 * it is also how a forgotten password is reset). Choosing a password signs the person in.
 */
export function SetPasswordRoute() {
  const brand = useDeploymentBrand();
  const navigate = useNavigate();
  const [token] = useState(takeTokenFromFragment);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setFailure(null);
    const issue = passwordPolicyIssue(password, null);
    setFieldError(issue ? POLICY_MESSAGE[issue] : null);
    setConfirmError(password === confirm ? null : 'The two passwords do not match.');
    if (issue || password !== confirm) return;
    setBusy(true);
    const result = await postPasswordAuth(PASSWORD_SETUP_PATH, { token, password });
    setBusy(false);
    if (result.ok) {
      navigate('/portfolio', { replace: true });
      return;
    }
    if (result.error === 'password_rejected') {
      setFieldError(result.issue ? POLICY_MESSAGE[result.issue] : 'Choose a different password.');
      return;
    }
    setFailure(SETUP_ERROR[result.error]);
  };

  return (
    <>
      <TopBar title="Set a password" />
      <main id="main" className="mx-auto w-full max-w-lg p-6">
        <DeploymentLogo className="mb-6 h-20" />
        <PageHeading
          title="Set your password"
          description={`Choose a password to sign in to ${brand.name} with your email address. At least ${PASSWORD_MIN_LENGTH} characters; a few unrelated words work well.`}
        />
        {!token ? (
          <StatusBanner
            tone="critical"
            title="This page needs your setup link"
            description="Open the complete link an owner or admin of your company gave you. Each link works once."
            data-testid="set-password-missing"
          />
        ) : (
          <>
            {failure && (
              <StatusBanner
                tone="critical"
                title="The password was not set"
                description={failure}
                className="mb-4"
                data-testid="set-password-failure"
              />
            )}
            <Panel title="Choose a password">
              <form
                onSubmit={(e) => void submit(e)}
                className="flex flex-col gap-3"
                noValidate
                aria-busy={busy}
                data-testid="set-password"
              >
                <Field
                  label="New password"
                  htmlFor="new-password"
                  hint={`${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters, not containing your email address.`}
                  error={fieldError ?? undefined}
                >
                  <Input
                    id="new-password"
                    name="new-password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field
                  label="Confirm new password"
                  htmlFor="confirm-password"
                  error={confirmError ?? undefined}
                >
                  <Input
                    id="confirm-password"
                    name="confirm-password"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    disabled={busy}
                  />
                </Field>
                <div>
                  <Button type="submit" variant="primary" disabled={busy}>
                    {busy ? 'Setting password…' : 'Set password and sign in'}
                  </Button>
                </div>
              </form>
            </Panel>
          </>
        )}
        <p className="mt-4 text-sm text-muted-foreground">
          <Link to="/sign-in" className="underline underline-offset-2">
            Back to sign-in
          </Link>
        </p>
      </main>
    </>
  );
}
