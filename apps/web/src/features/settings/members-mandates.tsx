import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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

/** Settings → Members (owners and admins): who belongs to the company, their role, status and brand scope. */
export function Members() {
  const members = useMembers(true);
  const brands = useBrands();
  const brandName = (id: string) => brands.data?.find((b) => b.id === id)?.name ?? id;
  return (
    <Section id="members-heading" title="Members" testId="members">
      <p className="text-xs text-muted-foreground">
        Everyone with access to this company. A role change signs the person out of every session.
      </p>
      {members.isPending && <Skeleton label="Loading members" lines={4} />}
      {members.isError && <RequestError error={members.error} onRetry={() => void members.refetch()} />}
      {members.data && members.data.items.length === 0 && (
        <EmptyState title="No members" description="Invite the first member below." />
      )}
      {members.data && members.data.items.length > 0 && (
        <ul className="flex flex-col divide-y divide-border" aria-label="Members">
          {members.data.items.map((m) => (
            <li
              key={m.membershipId}
              className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{m.name ?? m.email ?? m.userId}</p>
                {m.email && m.name && <p className="text-xs text-muted-foreground">{m.email}</p>}
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {m.allBrands
                    ? 'All brands'
                    : m.brandIds.length
                      ? m.brandIds.map(brandName).join(', ')
                      : 'No brands granted yet'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge glyph={false}>{roleLabel(m.role)}</Badge>
                <Badge tone={STATUS_TONE[m.status] ?? 'neutral'}>{roleLabel(m.status)}</Badge>
              </div>
            </li>
          ))}
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
        <ul className="flex flex-col divide-y divide-border" aria-label="Mandates">
          {mandates.data.items.map((m) => {
            const rules = [
              m.sourceRules.onlyApprovedFacts && 'approved facts only',
              m.sourceRules.onlyApprovedAssets && 'approved assets only',
              m.sourceRules.onlyApprovedTemplates && 'approved templates only',
              m.sourceRules.requireBrandReviewClean && 'clean brand review',
            ].filter(Boolean);
            const live = m.state === 'active' || m.state === 'paused';
            return (
              <li key={m.id} className="flex flex-col gap-2 py-3" data-testid="mandate">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    {day(m.windowStart)} to {day(m.windowEnd)}
                  </p>
                  <div className="flex items-center gap-2">
                    <Badge tone={MANDATE_TONE[m.state] ?? 'neutral'}>{roleLabel(m.state)}</Badge>
                    {canManage && m.state === 'active' && <MandateAction mandate={m} kind="pause" />}
                    {canManage && live && <MandateAction mandate={m} kind="revoke" />}
                  </div>
                </div>
                <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
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
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
