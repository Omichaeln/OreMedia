import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { MembershipRole } from '@oremedia/contracts/tenancy';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Skeleton,
  StatusBanner,
  Textarea,
  type Tone,
} from '@oremedia/ui';
import { Dialog, DialogActions, DialogClose, DialogContent } from '../../components/dialog';
import { RequestError } from '../../components/request-state';
import { Section } from '../../components/section';
import { Select } from '../../components/select';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { useBrandContext } from '../brand/brand-context';
import { initialsOf } from '../session/account-menu';
import { useSessionUser } from '../session/use-session-user';
import { useBrands } from '../brand/use-brand';
import { useChannels } from '../publishing/use-publishing';
import { useMandates, useMembers } from './use-settings';

const roleLabel = (r: string) => r.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const STATUS_TONE: Record<string, Tone> = { active: 'good', invited: 'info', disabled: 'neutral' };

function InviteMember() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('creator');
  const [allBrands, setAllBrands] = useState(false);
  const invite = useMutation(
    trpc.access.members.invite.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setEmail('');
        void queryClient.invalidateQueries(trpc.access.members.pathFilter());
      },
    }),
  );
  const ui = invite.isError ? toUiError(invite.error) : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (email.trim()) invite.mutate({ email: email.trim(), role: MembershipRole.parse(role), allBrands });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 border-t border-border pt-4" noValidate>
      <p className="text-sm font-medium">Invite a member</p>
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <Field
          label="Email"
          htmlFor="invite-email"
          error={
            ui?.details.find((d) => d.path === 'email')?.issue === 'already_member'
              ? 'Already a member'
              : undefined
          }
        >
          <Input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Role" htmlFor="invite-role">
          <Select
            id="invite-role"
            value={role}
            onValueChange={setRole}
            options={MembershipRole.options.map((r) => ({ value: r, label: roleLabel(r) }))}
          />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={allBrands} onChange={(e) => setAllBrands(e.target.checked)} />
        Every brand of the company (otherwise brands are granted one by one)
      </label>
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner tone="critical" title="Permission denied" description={ui.message} />
      )}
      {ui && ui.kind !== 'forbidden' && !ui.details.length && (
        <RequestError error={invite.error} title="The invitation was not sent" />
      )}
      {invite.isSuccess && (
        <p className="text-xs text-muted-foreground" data-testid="invite-sent">
          Invited. The person joins when they first sign in with that email.
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={!email.trim() || invite.isPending}>
          {invite.isPending ? 'Inviting…' : 'Invite'}
        </Button>
      </div>
    </form>
  );
}

const expiryText = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * A one-time password setup link for one member (there is no mailer: the owner or admin hands it over). The link is
 * shown once, with a copy button and its expiry; issuing another replaces it. It is also how a forgotten password is
 * reset. The API refuses a person who also belongs to another company (they set a password in Settings → Appearance),
 * a link for an owner or admin unless an owner asks, and a link for yourself (not offered on your own row).
 */
function IssuePasswordLink({ membershipId, who }: { membershipId: string; who: string }) {
  const trpc = useTRPC();
  const intent = useIntentKey();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const issue = useMutation(
    trpc.access.members.issuePasswordSetup.mutationOptions(mutationIntent(intent.key)),
  );
  const ui = issue.isError ? toUiError(issue.error) : null;
  const link = issue.data
    ? { url: new URL(issue.data.url, window.location.origin).href, expiresAt: issue.data.expiresAt }
    : null;
  const inputId = `password-link-${membershipId}`;
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      // The link is shown once: closing forgets it, and the next issue is a new intent (a new link).
      issue.reset();
      intent.renew();
      setCopied(false);
    }
  };
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      document.getElementById(inputId)?.focus();
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => setOpen(true)}
        aria-label={`Password link for ${who}`}
      >
        Password link
      </Button>
      <DialogContent
        title={`Password link for ${who}`}
        description="A one-time link to set or reset their password. It works once, for 72 hours, and replaces any link issued before. Give it to them directly; it is shown only now."
      >
        {link ? (
          <div className="flex flex-col gap-3" data-testid="password-link">
            <Field label="Link" htmlFor={inputId} hint={`Expires ${expiryText(link.expiresAt)}.`}>
              <Input
                id={inputId}
                readOnly
                value={link.url}
                spellCheck={false}
                onFocus={(e) => e.currentTarget.select()}
              />
            </Field>
            {copied && (
              <p className="text-xs text-muted-foreground" role="status">
                Copied to the clipboard.
              </p>
            )}
          </div>
        ) : (
          ui && (
            <StatusBanner
              tone="critical"
              title={ui.kind === 'forbidden' ? 'No link was issued' : 'The link was not issued'}
              description={ui.message}
            />
          )
        )}
        <DialogActions>
          <DialogClose asChild>
            <Button variant="ghost">{link ? 'Done' : 'Cancel'}</Button>
          </DialogClose>
          {link ? (
            <Button variant="primary" onClick={() => void copy()}>
              Copy link
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={issue.isPending}
              data-testid="issue-password-link"
              onClick={() => issue.mutate({ membershipId })}
            >
              {issue.isPending ? 'Issuing…' : 'Issue link'}
            </Button>
          )}
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

type MemberRow = NonNullable<ReturnType<typeof useMembers>['data']>['items'][number];

/**
 * G03: a member's role and brand scope (access.members.setRole, access.brandGrants.set / remove). The role and the
 * every-brand switch are saved together and sign the person out of every session; a brand is granted or taken away
 * as its box is ticked. The API decides who may change whom (an owner's or admin's role only from an owner).
 */
function ManageMember({ member, who }: { member: MemberRow; who: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const roleIntent = useIntentKey();
  const grantIntent = useIntentKey();
  const brands = useBrands();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<string>(member.role);
  const [allBrands, setAllBrands] = useState(member.allBrands);
  const refresh = () => void queryClient.invalidateQueries(trpc.access.members.pathFilter());
  const saveRole = useMutation(
    trpc.access.members.setRole.mutationOptions({
      ...mutationIntent(roleIntent.key),
      onSuccess: () => {
        roleIntent.renew();
        refresh();
      },
    }),
  );
  const onGrantSettled = () => {
    grantIntent.renew();
    refresh();
  };
  const grant = useMutation(
    trpc.access.brandGrants.set.mutationOptions({
      ...mutationIntent(grantIntent.key),
      onSettled: onGrantSettled,
    }),
  );
  const ungrant = useMutation(
    trpc.access.brandGrants.remove.mutationOptions({
      ...mutationIntent(grantIntent.key),
      onSettled: onGrantSettled,
    }),
  );
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setRole(member.role);
      setAllBrands(member.allBrands);
      saveRole.reset();
      grant.reset();
      ungrant.reset();
    }
  };
  const changed = role !== member.role || allBrands !== member.allBrands;
  const grantError = grant.error ?? ungrant.error;
  const roleUi = saveRole.isError ? toUiError(saveRole.error) : null;
  const grantUi = grantError ? toUiError(grantError) : null;
  const grantPending = grant.isPending || ungrant.isPending;
  const toggleBrand = (brandId: string, granted: boolean) =>
    granted
      ? ungrant.mutate({ membershipId: member.membershipId, brandId })
      : grant.mutate({ membershipId: member.membershipId, brandId, roles: [] });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Button size="sm" variant="secondary" onClick={() => onOpenChange(true)} aria-label={`Manage ${who}`}>
        Manage
      </Button>
      <DialogContent
        title={`Manage ${who}`}
        description="Saving a role or the every-brand switch signs them out of every session. Brands restricted one by one change as you tick them."
      >
        <div className="flex flex-col gap-3">
          <Field label="Role" htmlFor={`member-role-${member.membershipId}`}>
            <Select
              id={`member-role-${member.membershipId}`}
              value={role}
              onValueChange={setRole}
              options={MembershipRole.options.map((r) => ({ value: r, label: roleLabel(r) }))}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allBrands} onChange={(e) => setAllBrands(e.target.checked)} />
            Every brand of the company
          </label>
          {roleUi && (
            <StatusBanner
              tone="critical"
              title={roleUi.kind === 'forbidden' ? 'Permission denied' : 'The role did not change'}
              description={roleUi.message}
            />
          )}
          {saveRole.isSuccess && !changed && (
            <p className="text-xs text-muted-foreground" role="status">
              Saved. They were signed out of every session.
            </p>
          )}
          <div>
            <Button
              size="sm"
              variant="primary"
              disabled={!changed || saveRole.isPending}
              data-testid="save-member-role"
              onClick={() =>
                saveRole.mutate({
                  membershipId: member.membershipId,
                  expectedVersion: member.version,
                  role: MembershipRole.parse(role),
                  allBrands,
                })
              }
            >
              {saveRole.isPending ? 'Saving…' : 'Save role'}
            </Button>
          </div>
          {!member.allBrands && (
            <fieldset className="flex flex-col gap-1 border-t border-border pt-3" disabled={grantPending}>
              <legend className="text-xs font-medium text-muted-foreground">Brands they can see</legend>
              {(brands.data ?? []).map((b) => {
                const granted = member.brandIds.includes(b.id);
                return (
                  <label key={b.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={granted}
                      onChange={() => toggleBrand(b.id, granted)}
                      data-testid={`member-brand-${b.id}`}
                    />
                    {b.name}
                  </label>
                );
              })}
              {grantUi && (
                <StatusBanner
                  tone="critical"
                  title={grantUi.kind === 'forbidden' ? 'Permission denied' : 'The brand did not change'}
                  description={grantUi.message}
                />
              )}
            </fieldset>
          )}
        </div>
        <DialogActions>
          <DialogClose asChild>
            <Button variant="ghost">Done</Button>
          </DialogClose>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

/**
 * G03: switches a member's access to this company off (access.members.disable, behind a confirmation: their sessions
 * end at once) or back on (access.members.enable). Never offered on your own row; the API also keeps the last owner.
 */
function MemberStatusAction({ member, who }: { member: MemberRow; who: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [open, setOpen] = useState(false);
  const kind = member.status === 'disabled' ? 'enable' : 'disable';
  const onSuccess = () => {
    intent.renew();
    setOpen(false);
    void queryClient.invalidateQueries(trpc.access.members.pathFilter());
  };
  const disable = useMutation(
    trpc.access.members.disable.mutationOptions({ ...mutationIntent(intent.key), onSuccess }),
  );
  const enable = useMutation(
    trpc.access.members.enable.mutationOptions({ ...mutationIntent(intent.key), onSuccess }),
  );
  const m = kind === 'disable' ? disable : enable;
  const ui = m.isError ? toUiError(m.error) : null;
  const input = { membershipId: member.membershipId, expectedVersion: member.version };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) m.reset();
      }}
    >
      <Button
        size="sm"
        variant={kind === 'disable' ? 'danger' : 'secondary'}
        onClick={() => setOpen(true)}
        aria-label={`${kind === 'disable' ? 'Disable' : 'Enable'} ${who}`}
      >
        {kind === 'disable' ? 'Disable' : 'Enable'}
      </Button>
      <DialogContent
        role="alertdialog"
        title={kind === 'disable' ? `Disable ${who}?` : `Enable ${who}?`}
        description={
          kind === 'disable'
            ? 'They are signed out of every session at once and cannot open this company until enabled again. Their work stays; their other companies are not affected.'
            : 'They can sign in to this company again with their role and brands as they were.'
        }
      >
        {ui && (
          <StatusBanner
            tone="critical"
            title={ui.kind === 'forbidden' ? 'Permission denied' : 'Nothing changed'}
            description={ui.message}
          />
        )}
        <DialogActions>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button
            variant={kind === 'disable' ? 'danger' : 'primary'}
            disabled={m.isPending}
            data-testid={`confirm-${kind}-member`}
            onClick={() => (kind === 'disable' ? disable.mutate(input) : enable.mutate(input))}
          >
            {m.isPending ? 'Saving…' : kind === 'disable' ? 'Disable' : 'Enable'}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

/** Settings → Members (owners and admins): who belongs to the company, their role, status and brand scope. */
export function Members() {
  const members = useMembers(true);
  // Your own password is set in Settings → Appearance (behind the current password), never through a link.
  const me = useSessionUser(true).data?.userId ?? null;
  const brands = useBrands();
  const brandName = (id: string) => brands.data?.find((b) => b.id === id)?.name ?? id;
  return (
    <Section id="members-heading" title="Members" testId="members">
      <p className="text-xs text-muted-foreground">
        Everyone with access to this company. A role change signs the person out of every session, and
        disabling a member ends their sessions at once. A password link lets a member set or reset a password
        for signing in with their email address.
      </p>
      {members.isPending && <Skeleton label="Loading members" lines={4} />}
      {members.isError && <RequestError error={members.error} onRetry={() => void members.refetch()} />}
      {members.data && members.data.items.length === 0 && (
        <EmptyState title="No members" description="Invite the first member below." />
      )}
      {members.data && members.data.items.length > 0 && (
        <ul className="flex flex-col" aria-label="Members">
          {members.data.items.map((m) => {
            const who = m.name ?? m.email ?? m.userId;
            return (
              <li
                key={m.membershipId}
                className="grid grid-cols-[28px_minmax(0,1fr)] items-center gap-x-3.5 gap-y-2 border-t border-border py-3 sm:grid-cols-[32px_minmax(0,1fr)_170px_90px]"
              >
                <span
                  aria-hidden="true"
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-secondary text-xs font-medium"
                >
                  {initialsOf(who)}
                </span>
                <div className="min-w-0">
                  <p className="text-base">{who}</p>
                  {m.email && m.name && <p className="text-xs text-muted-foreground">{m.email}</p>}
                </div>
                <div className="col-start-2 flex flex-wrap items-center gap-2 text-sm sm:col-start-auto">
                  <span>{roleLabel(m.role)}</span>
                  <Badge tone={STATUS_TONE[m.status] ?? 'neutral'}>{roleLabel(m.status)}</Badge>
                </div>
                <p className="col-start-2 text-xs text-muted-foreground sm:col-start-auto sm:text-right">
                  {m.allBrands
                    ? 'All brands'
                    : m.brandIds.length
                      ? m.brandIds.map(brandName).join(', ')
                      : 'No brands granted yet'}
                </p>
                <div className="col-start-2 flex flex-wrap items-center gap-2 sm:col-span-3">
                  {m.status !== 'disabled' && m.userId !== me && (
                    <IssuePasswordLink membershipId={m.membershipId} who={who} />
                  )}
                  {m.userId !== me && <ManageMember member={m} who={who} />}
                  {m.userId !== me && m.status !== 'invited' && <MemberStatusAction member={m} who={who} />}
                  {m.userId === me && (
                    <Link
                      to="?tab=appearance"
                      className="text-xs text-muted-foreground underline underline-offset-2"
                      data-testid="own-password-settings"
                    >
                      Your password: Settings → Appearance
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <InviteMember />
    </Section>
  );
}

const MANDATE_TONE: Record<string, Tone> = {
  active: 'good',
  paused: 'warning',
  revoked: 'neutral',
  expired: 'neutral',
};

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function MandateAction({
  mandate,
  kind,
}: {
  mandate: { id: string; version: number };
  kind: 'pause' | 'revoke';
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const onSuccess = () => {
    intent.renew();
    setOpen(false);
    void queryClient.invalidateQueries(trpc.review.mandates.pathFilter());
  };
  const pause = useMutation(
    trpc.review.mandates.pause.mutationOptions({ ...mutationIntent(intent.key), onSuccess }),
  );
  const revoke = useMutation(
    trpc.review.mandates.revoke.mutationOptions({ ...mutationIntent(intent.key), onSuccess }),
  );
  const m = kind === 'pause' ? pause : revoke;
  const ui = m.isError ? toUiError(m.error) : null;
  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <Button size="sm" variant={kind === 'revoke' ? 'danger' : 'secondary'} onClick={() => setOpen(true)}>
          {kind === 'pause' ? 'Pause' : 'Revoke'}
        </Button>
        <DialogContent
          role="alertdialog"
          title={kind === 'pause' ? 'Pause this mandate?' : 'Revoke this mandate?'}
          description={
            kind === 'pause'
              ? 'Posts under it are held at release until it is active again. Nothing already published changes.'
              : 'It can never be used again; posts under it are held at release. Nothing already published changes.'
          }
        >
          {kind === 'revoke' && (
            <Field label="Reason" htmlFor={`revoke-reason-${mandate.id}`}>
              <Textarea
                id={`revoke-reason-${mandate.id}`}
                rows={2}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          )}
          <DialogActions>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button
              variant={kind === 'revoke' ? 'danger' : 'primary'}
              disabled={m.isPending}
              data-testid={`confirm-${kind}-mandate`}
              onClick={() =>
                kind === 'pause'
                  ? pause.mutate({ mandateId: mandate.id, expectedVersion: mandate.version })
                  : revoke.mutate({
                      mandateId: mandate.id,
                      expectedVersion: mandate.version,
                      reason: reason.trim() || undefined,
                    })
              }
            >
              {m.isPending ? 'Saving…' : kind === 'pause' ? 'Pause' : 'Revoke'}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
      {ui && (
        <StatusBanner
          tone="critical"
          title={ui.kind === 'forbidden' ? 'Permission denied' : 'The mandate did not change'}
          description={ui.message}
        />
      )}
    </>
  );
}

/**
 * Settings → Mandates (spec 13.4): what agents may publish without a per-post approval, and within which limits.
 * The release policy re-checks every limit at dispatch. Owners and admins pause or revoke; a paused mandate cannot be
 * resumed from here because the API has no resume action.
 */
export function Mandates({ canManage }: { canManage: boolean }) {
  const { brandId } = useBrandContext();
  const mandates = useMandates(brandId);
  const channels = useChannels(brandId);
  const channelName = (id: string) => channels.data?.find((c) => c.id === id)?.displayName ?? id;
  return (
    <Section id="mandates-heading" title="Mandates" testId="mandates">
      <p className="text-xs text-muted-foreground">
        A mandate lets an agent publish within strict limits without a per-post approval. The release policy
        re-checks every limit at dispatch, and the mandate-publishing kill switch holds all of them at once.
      </p>
      {mandates.isPending && <Skeleton label="Loading mandates" lines={3} />}
      {mandates.isError && <RequestError error={mandates.error} onRetry={() => void mandates.refetch()} />}
      {mandates.data && mandates.data.items.length === 0 && (
        <EmptyState
          title="No mandates"
          description="Every post needs a person's approval. Mandates are created by an owner or admin through the API while managed autopublish is enabled for the company."
        />
      )}
      {mandates.data && mandates.data.items.length > 0 && (
        <ul className="flex flex-col gap-4" aria-label="Mandates">
          {mandates.data.items.map((m) => {
            const rules = [
              m.sourceRules.onlyApprovedFacts && 'approved facts only',
              m.sourceRules.onlyApprovedAssets && 'approved assets only',
              m.sourceRules.onlyApprovedTemplates && 'approved templates only',
              m.sourceRules.requireBrandReviewClean && 'clean brand review',
            ].filter(Boolean);
            const live = m.state === 'active' || m.state === 'paused';
            return (
              <li
                key={m.id}
                className="flex flex-col gap-3 rounded-xl border border-border bg-card px-5 py-[18px]"
                data-testid="mandate"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-md font-bold">
                    {day(m.windowStart)} to {day(m.windowEnd)}
                  </p>
                  <Badge tone={MANDATE_TONE[m.state] ?? 'neutral'}>{roleLabel(m.state)}</Badge>
                </div>
                <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[140px_minmax(0,1fr)]">
                  <dt className="text-muted-foreground">Channels</dt>
                  <dd>{m.channelConnectionIds.map(channelName).join(', ')}</dd>
                  <dt className="text-muted-foreground">Content classes</dt>
                  <dd>{m.allowedContentClasses.join(', ')}</dd>
                  <dt className="text-muted-foreground">Daily quota</dt>
                  <dd>{m.maxPostsPerDay} posts</dd>
                  <dt className="text-muted-foreground">Source rules</dt>
                  <dd>{rules.length ? rules.join(' · ') : 'None'}</dd>
                  <dt className="text-muted-foreground">Agent principal</dt>
                  <dd>
                    <code className="text-xs">{m.servicePrincipalId}</code>
                  </dd>
                </dl>
                {canManage && live && (
                  <div className="flex flex-wrap gap-1.5">
                    {m.state === 'active' && <MandateAction mandate={m} kind="pause" />}
                    <MandateAction mandate={m} kind="revoke" />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
