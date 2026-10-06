import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PasswordPolicyIssue,
  passwordPolicyIssue,
} from '@oremedia/contracts/access';
import { Button, Field, Input, Skeleton, StatusBanner } from '@oremedia/ui';
import { Dialog, DialogActions, DialogClose, DialogContent } from '../../components/dialog';
import { RequestError } from '../../components/request-state';
import { Section } from '../../components/section';
import { toUiError } from '../../lib/errors';
import { signOut } from '../../lib/session';
import { useTRPC } from '../../lib/trpc';
import { useSessionUser } from './use-session-user';
import { useSignInMethods } from './use-sign-in-methods';

/** What each password policy issue tells the person (the API applies the same rules, packages/contracts/access). */
export const PASSWORD_POLICY_MESSAGE: Record<PasswordPolicyIssue, string> = {
  too_short: `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
  too_long: `Use at most ${PASSWORD_MAX_LENGTH} characters.`,
  contains_email: 'Choose a password that does not contain your email address.',
};

const CURRENT_MESSAGE: Record<string, string> = {
  required: 'Enter your current password.',
  incorrect: 'That is not your current password.',
};

function SetPasswordForm({ hasPassword, email }: { hasPassword: boolean; email: string | null }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [local, setLocal] = useState<{ next?: string; confirm?: string }>({});
  const save = useMutation(
    trpc.access.account.setPassword.mutationOptions({
      onSuccess: () => {
        setCurrent('');
        setNext('');
        setConfirm('');
        void queryClient.invalidateQueries(trpc.access.account.signInMethods.queryFilter());
      },
    }),
  );
  const ui = save.isError ? toUiError(save.error) : null;
  const detail = (path: string) => ui?.details.find((d) => d.path === path)?.issue;
  const policy = PasswordPolicyIssue.safeParse(detail('newPassword'));
  const currentIssue = detail('currentPassword');
  const staleSession = detail('session') === 'recent_sign_in_required';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const issue = passwordPolicyIssue(next, email);
    const errors = {
      next: issue ? PASSWORD_POLICY_MESSAGE[issue] : undefined,
      confirm: next === confirm ? undefined : 'The two passwords do not match.',
    };
    setLocal(errors);
    if (errors.next || errors.confirm) return;
    save.mutate({ newPassword: next, ...(hasPassword ? { currentPassword: current } : {}) });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate data-testid="account-password-form">
      {/* Lets a password manager tie the new password to the account's address. */}
      {email && <input type="hidden" name="username" autoComplete="username" value={email} readOnly />}
      {hasPassword && (
        <Field
          label="Current password"
          htmlFor="account-current-password"
          error={currentIssue ? (CURRENT_MESSAGE[currentIssue] ?? 'Check your current password.') : undefined}
        >
          <Input
            id="account-current-password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            disabled={save.isPending}
          />
        </Field>
      )}
      <Field
        label="New password"
        htmlFor="account-new-password"
        hint={`${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters, not containing your email address.`}
        error={local.next ?? (policy.success ? PASSWORD_POLICY_MESSAGE[policy.data] : undefined)}
      >
        <Input
          id="account-new-password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          disabled={save.isPending}
        />
      </Field>
      <Field label="Confirm new password" htmlFor="account-confirm-password" error={local.confirm}>
        <Input
          id="account-confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          disabled={save.isPending}
        />
      </Field>
      {staleSession && (
        <StatusBanner
          tone="warning"
          title="Sign in again to set a password"
          description="Setting a first password needs a sign-in from the last 15 minutes. Sign out, sign in with Google, then come back to Settings → Appearance."
          data-testid="recent-sign-in-required"
          actions={
            <Button size="sm" variant="secondary" onClick={() => void signOut()}>
              Sign out and sign in again
            </Button>
          }
        />
      )}
      {ui?.kind === 'rate_limited' && (
        <StatusBanner
          tone="critical"
          title="Too many attempts"
          description="Wait fifteen minutes before trying your current password again."
        />
      )}
      {ui && ui.kind !== 'rate_limited' && ui.kind !== 'validation' && (
        <RequestError error={save.error} title="The password was not saved" />
      )}
      {save.isSuccess && (
        <p className="text-xs text-muted-foreground" data-testid="password-saved" role="status">
          Password saved. Every other session of yours was signed out.
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : hasPassword ? 'Change password' : 'Set password'}
        </Button>
      </div>
    </form>
  );
}

function RemovePassword() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const remove = useMutation(
    trpc.access.account.removePassword.mutationOptions({
      onSuccess: () => {
        setOpen(false);
        setCurrent('');
        void queryClient.invalidateQueries(trpc.access.account.signInMethods.queryFilter());
      },
    }),
  );
  const ui = remove.isError ? toUiError(remove.error) : null;
  const currentIssue = ui?.details.find((d) => d.path === 'currentPassword')?.issue;
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setCurrent('');
      remove.reset();
    }
  };
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <Dialog open={open} onOpenChange={onOpenChange}>
        <div>
          <Button variant="secondary" onClick={() => setOpen(true)}>
            Remove password
          </Button>
        </div>
        <DialogContent
          role="alertdialog"
          title="Remove your password?"
          description="You will sign in with Google only. You can set a password again at any time."
        >
          <form
            className="flex flex-col gap-3"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (current) remove.mutate({ currentPassword: current });
            }}
          >
            <Field
              label="Current password"
              htmlFor="remove-current-password"
              error={
                currentIssue
                  ? (CURRENT_MESSAGE[currentIssue] ?? 'Check your current password.')
                  : ui?.kind === 'rate_limited'
                    ? 'Too many attempts. Wait fifteen minutes, then try again.'
                    : undefined
              }
            >
              <Input
                id="remove-current-password"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                disabled={remove.isPending}
              />
            </Field>
            {ui && !currentIssue && ui.kind !== 'rate_limited' && (
              <RequestError error={remove.error} title="The password was not removed" />
            )}
            <DialogActions>
              <DialogClose asChild>
                <Button type="button" variant="ghost">
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="submit"
                variant="danger"
                disabled={remove.isPending || !current}
                data-testid="confirm-remove-password"
              >
                {remove.isPending ? 'Removing…' : 'Remove password'}
              </Button>
            </DialogActions>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Settings → Appearance, Account: the signed-in person's own password, the second sign-in method next to Google. Setting or
 * changing it signs out every other session; removing it is offered only while Google is linked, so nobody is left
 * without a way in.
 */
export function AccountPassword() {
  const methods = useSignInMethods();
  const user = useSessionUser(true);
  return (
    <Section id="account-password-heading" title="Password" testId="account-password">
      {methods.isPending && <Skeleton label="Loading sign-in methods" lines={3} />}
      {methods.isError && <RequestError error={methods.error} onRetry={() => void methods.refetch()} />}
      {methods.data && (
        <>
          <p className="text-sm text-muted-foreground" data-testid="sign-in-methods">
            {methods.data.hasPassword && methods.data.hasGoogle
              ? 'You sign in with Google or with your email and password.'
              : methods.data.hasPassword
                ? 'You sign in with your email and password.'
                : 'You sign in with Google. Set a password to also sign in with your email address.'}
          </p>
          <SetPasswordForm hasPassword={methods.data.hasPassword} email={user.data?.email ?? null} />
          {methods.data.hasPassword && methods.data.hasGoogle && <RemovePassword />}
          {methods.data.hasPassword && !methods.data.hasGoogle && (
            <p className="text-xs text-muted-foreground">
              Your password is your only sign-in method, so it cannot be removed.
            </p>
          )}
        </>
      )}
    </Section>
  );
}
