import { useState, type FormEvent, type LiHTMLAttributes, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  EmptyState,
  Skeleton,
  StatusBanner,
  StatusDot,
  toneGlyph,
  type Tone,
} from '@oremedia/ui';
import { Dialog, DialogActions, DialogClose, DialogContent } from '../../components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/dropdown-menu';
import { RequestError } from '../../components/request-state';
import { GroupHeader } from '../../components/section';
import { useDeploymentBrand } from '../../lib/deployment-brand';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import type { inferOutput } from '@trpc/tanstack-react-query';
import { useTRPC, type Trpc } from '../../lib/trpc';
import { useBrandContext } from '../brand/brand-context';
import { CapabilityCertifications } from '../settings/capability-certifications';
import { useProviders, type ProviderActivationDto } from '../settings/use-settings';
import {
  ACTIVATION_CHIP,
  activationReason,
  callbackError,
  callbackParams,
  channelLimitsLine,
  providerLabel,
  connectRedirectUri,
  rememberConnect,
  RELEASE_1_PROVIDERS,
  unavailableReason,
} from './channel-connect';
import { CHANNEL_CHIP, CHANNEL_HEALTH_CHIP, channelNeedsAction } from './publication-state';
import { useChannelLimits, useChannels, type ChannelDto, type ConnectResultDto } from './use-publishing';

type ConnectChoice = Extract<ConnectResultDto, { outcome: 'choose' }>;
type ConnectedChannel = Extract<ConnectResultDto, { outcome: 'connected' }>;

/**
 * Spec 14.7 connect start: the server returns the provider's authorisation URL; it opens in a new tab as a link (never
 * an iframe, the provider's consent screen must be top-level). An uncertified provider is refused with its reason.
 * One mutation per row (and one for the "Connect a channel" menu), started with the provider's key.
 */
function useConnectStart({
  brandId,
  onUnavailable,
}: {
  brandId: string;
  onUnavailable?: (providerKey: string, reason: string) => void;
}) {
  const trpc = useTRPC();
  const { companyId } = useBrandContext();
  const intent = useIntentKey();
  return useMutation(
    trpc.publishing.channels.connect.start.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (data) => {
        intent.renew();
        // The provider returns to the shared callback; this is how it finds its way back to this brand.
        rememberConnect(data.state, { companyId, brandId, expiresAt: data.expiresAt });
      },
      onError: (err, variables) => {
        const reason = unavailableReason(toUiError(err).details);
        if (reason) onUnavailable?.(variables.providerKey, reason);
      },
    }),
  );
}
type ConnectStart = ReturnType<typeof useConnectStart>;

/** The row's connect control; `label` is its accessible name, `text` what the row shows when it is shorter. */
function ConnectButton({
  start,
  brandId,
  providerKey,
  redirectUri,
  label,
  text,
  unavailable,
}: {
  start: ConnectStart;
  brandId: string;
  providerKey: string;
  redirectUri: string;
  label: string;
  text?: string;
  unavailable?: string | null;
}) {
  return (
    <Button
      size="sm"
      variant="secondary"
      aria-label={text && text !== label ? label : undefined}
      onClick={() => start.mutate({ brandId, providerKey, redirectUri })}
      disabled={start.isPending || Boolean(unavailable)}
      disabledReason={unavailable ?? undefined}
    >
      {start.isPending ? 'Starting…' : (text ?? label)}
    </Button>
  );
}

/** What a connect start answered: the authorisation link to open, or why it was refused; spans the row below its controls. */
function ConnectResult({ start, providerKey }: { start: ConnectStart; providerKey: string }) {
  const deployment = useDeploymentBrand();
  const ui = start.isError ? toUiError(start.error) : null;
  const refusedAsUnavailable = ui !== null && unavailableReason(ui.details) !== null;
  if (!start.data && !ui) return null;
  return (
    <div className="order-last flex basis-full flex-col gap-2">
      {start.data && (
        <StatusBanner
          tone="info"
          title="Continue at the provider"
          description={
            <>
              Authorise {deployment.name} in the provider&apos;s own window, then return here to finish. The
              link expires {new Date(start.data.expiresAt).toLocaleTimeString()}.
            </>
          }
          actions={
            <Button size="sm" asChild>
              <a href={start.data.url} target="_blank" rel="noopener noreferrer" data-testid="authorise-link">
                Open {providerLabel(providerKey)} authorisation (new tab)
              </a>
            </Button>
          }
          data-testid="connect-started"
        />
      )}
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Connecting a channel needs channel.connect for this brand.`}
          data-testid="connect-denied"
        />
      )}
      {ui && ui.kind !== 'forbidden' && !refusedAsUnavailable && (
        <RequestError error={start.error} title="The connection did not start" />
      )}
    </div>
  );
}

type DisconnectResultDto = inferOutput<Trpc['publishing']['channels']['disconnect']>;

function DisconnectButton({
  channel,
  onDisconnected,
}: {
  channel: ChannelDto;
  onDisconnected: (result: DisconnectResultDto) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [open, setOpen] = useState(false);
  const disconnect = useMutation(
    trpc.publishing.channels.disconnect.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (data) => {
        intent.renew();
        setOpen(false);
        onDisconnected(data); // the row shows what happened once this button is gone with the connection
        void queryClient.invalidateQueries(trpc.publishing.pathFilter());
        void queryClient.invalidateQueries(trpc.content.calendar.pathFilter());
      },
    }),
  );
  const ui = disconnect.isError ? toUiError(disconnect.error) : null;
  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <Button size="sm" variant="danger" onClick={() => setOpen(true)}>
          Disconnect
        </Button>
        <DialogContent
          role="alertdialog"
          title={`Disconnect ${channel.displayName}?`}
          description="The stored credential is destroyed and every publication scheduled on this channel is held with reason channel_active until it is reconnected. Published posts are not touched."
        >
          <DialogActions>
            <DialogClose asChild>
              <Button variant="ghost">Keep connected</Button>
            </DialogClose>
            <Button
              variant="danger"
              onClick={() =>
                disconnect.mutate({ channelConnectionId: channel.id, expectedVersion: channel.version })
              }
              disabled={disconnect.isPending}
              data-testid="confirm-disconnect"
            >
              {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>

      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Disconnecting needs channel.manage for this channel.`}
          data-testid="disconnect-denied"
        />
      )}
      {ui && ui.kind !== 'forbidden' && (
        <RequestError error={disconnect.error} title="The channel was not disconnected" />
      )}
    </>
  );
}

/**
 * A row of the Channels list as the interface draws it: name and handle with the platform limits under them, a dot
 * and the state, the controls at the right end. Whatever a control opens (a banner, the Manage card) spans the full
 * width under the row. Below 640 px the name takes its own line and the state sits beside the controls.
 */
function ListRow({
  name,
  handle,
  limits,
  tone,
  status,
  detail,
  actions,
  children,
  ...attrs
}: {
  name: string;
  handle: string;
  limits: string | null;
  tone: Tone;
  status: string;
  detail?: ReactNode;
  actions: ReactNode;
  children?: ReactNode;
} & LiHTMLAttributes<HTMLLIElement>) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-border py-4" {...attrs}>
      <div className="flex min-w-0 basis-full flex-col gap-0.5 sm:flex-1 sm:basis-48">
        <p className="text-base font-bold leading-5">
          {name} <span className="text-xs font-normal tabular-nums text-muted-foreground">{handle}</span>
        </p>
        {limits && <p className="text-xs text-muted-foreground">{limits}</p>}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm text-muted-foreground sm:w-[200px] sm:flex-none">
        <span className="flex items-center gap-1.5">
          <StatusDot tone={tone} size="sm" />
          <span className="sr-only">{toneGlyph[tone]} </span>
          {status}
        </span>
        {detail && <span className="text-xs">{detail}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
      {children}
    </li>
  );
}

/** The card a row's Manage / Details opens: columns of labelled facts, as the interface lays them out. */
const DETAIL_CARD =
  'om-in grid basis-full grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-7 gap-y-4 rounded-xl border border-border bg-card px-[18px] py-4';

function DetailColumn({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 className="om-label">{label}</h4>
      {children}
    </div>
  );
}

function DetailRows({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="flex flex-col gap-1.5 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-2.5">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="text-right text-xs tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function ChannelRow({
  channel,
  brandId,
  redirectUri,
  limits,
  activation,
}: {
  channel: ChannelDto;
  brandId: string;
  redirectUri: string;
  limits: string | null;
  activation: ProviderActivationDto | null;
}) {
  const chip = CHANNEL_CHIP[channel.status];
  const health = CHANNEL_HEALTH_CHIP[channel.health];
  const live = channel.status !== 'disabled';
  const reconnect = channel.status !== 'active' || channelNeedsAction(channel);
  // The dot carries the state that needs the person: the connection's, else the access's, else the connection's.
  const tone: Tone = chip.needsAction || !live ? chip.tone : health.needsAction ? health.tone : chip.tone;
  const [open, setOpen] = useState(false);
  /** What the disconnect of this row did (held publications, the remote side), shown after the button is gone. */
  const [disconnected, setDisconnected] = useState<DisconnectResultDto | null>(null);
  const start = useConnectStart({ brandId });
  const checked = live && channel.healthCheckedAt ? `Checked ${when(channel.healthCheckedAt)}.` : null;
  const token = channel.tokenExpiresAt
    ? `Token ${new Date(channel.tokenExpiresAt).getTime() < Date.now() ? 'expired' : 'expires'} ${when(channel.tokenExpiresAt)}.`
    : null;
  const missing =
    channel.missingScopes.length > 0 ? `Missing scopes: ${channel.missingScopes.join(', ')}.` : null;
  const cardId = `channel-manage-${channel.id}`;
  return (
    <ListRow
      data-testid={`channel-${channel.id}`}
      data-channel-status={channel.status}
      data-channel-health={channel.health}
      name={channel.displayName}
      handle={providerLabel(channel.providerKey)}
      limits={limits}
      tone={tone}
      status={live ? `${chip.label} · ${health.label}` : chip.label}
      detail={[checked, token, missing].filter(Boolean).join(' ') || undefined}
      actions={
        <>
          {reconnect && (
            <ConnectButton
              start={start}
              brandId={brandId}
              providerKey={channel.providerKey}
              redirectUri={redirectUri}
              label={channel.status === 'disabled' ? 'Connect again' : 'Reconnect'}
            />
          )}
          <Button
            size="sm"
            variant="secondary"
            aria-expanded={open}
            aria-controls={cardId}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Close' : 'Manage'}
          </Button>
        </>
      }
    >
      <ConnectResult start={start} providerKey={channel.providerKey} />
      {open && (
        <div id={cardId} className={DETAIL_CARD}>
          <DetailColumn label="Health">
            <DetailRows
              rows={[
                ['Connection', chip.label],
                ['Access', live ? health.label : '—'],
                ['Checked', channel.healthCheckedAt && live ? when(channel.healthCheckedAt) : '—'],
                [
                  'Token',
                  channel.tokenExpiresAt
                    ? `${new Date(channel.tokenExpiresAt).getTime() < Date.now() ? 'Expired' : 'Expires'} ${when(channel.tokenExpiresAt)}`
                    : 'No expiry recorded',
                ],
              ]}
            />
            <p className="text-xs text-muted-foreground">
              {chip.detail}
              {live && ` ${health.detail}`}
            </p>
          </DetailColumn>
          <DetailColumn label="Permissions granted">
            {channel.grantedScopes.length === 0 && channel.missingScopes.length === 0 ? (
              <p className="text-xs text-muted-foreground">No scopes recorded for this connection.</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-sm" aria-label="Scopes">
                {channel.grantedScopes.map((scope) => (
                  <li key={scope} className="flex gap-2">
                    <span aria-hidden="true" className="text-status-good">
                      ✓
                    </span>
                    <span className="sr-only">granted </span>
                    <code className="text-xs">{scope}</code>
                  </li>
                ))}
                {channel.missingScopes.map((scope) => (
                  <li key={scope} className="flex gap-2 text-muted-foreground">
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">missing </span>
                    <code className="text-xs">{scope}</code>
                  </li>
                ))}
              </ul>
            )}
          </DetailColumn>
          <DetailColumn label="Publishing">
            <DetailRows
              rows={[
                ['Can publish', channel.usable ? 'Yes' : 'No'],
                ['Capability version', String(channel.capabilityVersion)],
                ['Per-post settings', channel.settingsSchema ? 'Offered in the editor' : 'None'],
              ]}
            />
            {activation && <CapabilityCertifications activation={activation} />}
            {live && (
              <div className="mt-1.5 flex flex-col gap-2">
                <DisconnectButton channel={channel} onDisconnected={setDisconnected} />
              </div>
            )}
          </DetailColumn>
        </div>
      )}
      {disconnected && disconnected.heldPublicationIds.length > 0 && (
        <p className="basis-full text-xs text-muted-foreground" data-testid="held-after-disconnect">
          {disconnected.heldPublicationIds.length} scheduled publication
          {disconnected.heldPublicationIds.length === 1 ? ' is' : 's are'} now held.
        </p>
      )}
      {disconnected && (
        <p className="basis-full text-xs text-muted-foreground" data-testid="remote-revoke">
          {disconnected.remoteRevoke === 'requested'
            ? 'The platform is being asked to revoke the access; the stored credential is destroyed right after, whatever it answers.'
            : 'This provider has no remote revoke; the stored credential was destroyed. Remove the app from the account at the platform if you want the access gone there too.'}
        </p>
      )}
    </ListRow>
  );
}

/**
 * A provider that can be connected (RA-01): its state on this deployment and why it cannot be connected as the row's
 * text; its credential references (by name only) and the certification of each capability (PR-06) behind Details.
 */
function ProviderRow({
  provider,
  brandId,
  redirectUri,
  limits,
  connected,
  reason,
  onUnavailable,
}: {
  provider: { key: string; label: string; activation: ProviderActivationDto | null };
  brandId: string;
  redirectUri: string;
  limits: string | null;
  connected: number;
  reason: string | null;
  onUnavailable: (providerKey: string, reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const start = useConnectStart({ brandId, onUnavailable });
  const activation = provider.activation ? ACTIVATION_CHIP[provider.activation.state] : null;
  const unavailable = (activation && activation.label !== 'Ready') || (!activation && reason !== null);
  const status = unavailable
    ? `Unavailable${activation ? `: ${activation.label.toLowerCase()}` : ''}`
    : connected > 0
      ? `${connected} connected`
      : 'Not connected';
  const cardId = `provider-details-${provider.key}`;
  return (
    <ListRow
      data-testid={`provider-${provider.key}`}
      data-provider-state={provider.activation?.state ?? 'unknown'}
      name={provider.label}
      handle="—"
      limits={limits}
      tone={unavailable && activation ? activation.tone : 'neutral'}
      status={status}
      detail={reason ? <span data-testid="unavailable-reason">{reason}</span> : undefined}
      actions={
        <>
          <Button
            size="sm"
            variant="secondary"
            aria-expanded={open}
            aria-controls={cardId}
            aria-label={`Details of ${provider.label}`}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Close' : 'Details'}
          </Button>
          <ConnectButton
            start={start}
            brandId={brandId}
            providerKey={provider.key}
            redirectUri={redirectUri}
            label={`Connect ${provider.label}`}
            text="Connect"
            unavailable={reason}
          />
        </>
      }
    >
      <ConnectResult start={start} providerKey={provider.key} />
      {open && (
        <div id={cardId} className={DETAIL_CARD}>
          <DetailColumn label="Activation">
            {activation ? (
              <Badge tone={activation.tone}>{activation.label}</Badge>
            ) : (
              <p className="text-xs text-muted-foreground">
                The activation state is read by owners and admins; the server decides when you connect.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Provider key <code>{provider.key}</code>
            </p>
            {provider.activation && provider.activation.credentialRefs.length > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="credential-refs">
                Credential references:{' '}
                {provider.activation.credentialRefs
                  .map((c) => `${c.name} (${c.present ? 'set' : 'not set'})`)
                  .join(', ')}
                .
              </p>
            )}
          </DetailColumn>
          {provider.activation && provider.activation.capabilities.length > 0 && (
            <DetailColumn label="Capability certification">
              <CapabilityCertifications activation={provider.activation} />
            </DetailColumn>
          )}
        </div>
      )}
    </ListRow>
  );
}

/** The connection a completed flow made (or rotated), with the scopes the grant is missing. */
function ConnectedBanner({ channel, onDone }: { channel: ConnectedChannel; onDone: () => void }) {
  return (
    <StatusBanner
      tone="good"
      title={`Connected: ${channel.displayName} (${channel.providerKey})`}
      description={
        channel.missingScopes.length
          ? `The grant is missing scopes: ${channel.missingScopes.join(', ')}.`
          : 'The credential is sealed and stored; the channel can publish.'
      }
      actions={
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      }
      data-testid="connect-completed"
    />
  );
}

/**
 * Spec 14.7 account choice: the login manages several accounts, so the person picks the one this brand connects.
 * Nothing is connected until they do; cancelling discards the sealed grants.
 */
function ChooseAccount({ choice, onDone }: { choice: ConnectChoice; onDone: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [selected, setSelected] = useState<string | null>(null);
  const select = useMutation(
    trpc.publishing.channels.connect.select.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.publishing.channels.pathFilter());
      },
    }),
  );
  const cancel = useMutation(
    trpc.publishing.channels.connect.cancel.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        onDone();
      },
    }),
  );
  if (select.data) return <ConnectedBanner channel={select.data} onDone={onDone} />;
  const kind = providerLabel(choice.providerKey);
  const busy = select.isPending || cancel.isPending;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (selected) select.mutate({ pendingId: choice.pendingId, remoteAccountId: selected });
  };
  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
      noValidate
      data-testid="connect-choose"
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-semibold">Choose the account this brand connects</legend>
        <p className="text-xs text-muted-foreground">
          Only the account you choose is connected; the choice expires{' '}
          {new Date(choice.expiresAt).toLocaleTimeString()}.
          {choice.unavailable > 0 &&
            ` ${choice.unavailable} more ${choice.unavailable === 1 ? 'account' : 'accounts'} could not be read from the provider; start again to retry.`}
        </p>
        {choice.options.map((option) => (
          <label key={option.remoteAccountId} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`connect-account-${choice.pendingId}`}
              value={option.remoteAccountId}
              checked={selected === option.remoteAccountId}
              onChange={() => setSelected(option.remoteAccountId)}
            />
            <span>
              {option.displayName} <span className="text-muted-foreground">({kind})</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          type="submit"
          disabled={busy || !selected}
          disabledReason={selected ? undefined : 'Choose an account first'}
        >
          {select.isPending ? 'Connecting…' : 'Connect selected'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => cancel.mutate({ pendingId: choice.pendingId })}
          disabled={busy}
        >
          Cancel
        </Button>
      </div>
      {select.isError && <RequestError error={select.error} title="The account was not connected" />}
      {cancel.isError && <RequestError error={cancel.error} title="The choice was not cancelled" />}
    </form>
  );
}

/** Spec 14.7 completion: the provider sent the person back here with `state` and `code`; exchanging them is explicit. */
function FinishConnect({ state, code, onDone }: { state: string; code: string; onDone: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const complete = useMutation(
    trpc.publishing.channels.connect.complete.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.publishing.channels.pathFilter());
      },
    }),
  );
  if (complete.data?.outcome === 'choose') return <ChooseAccount choice={complete.data} onDone={onDone} />;
  if (complete.data) return <ConnectedBanner channel={complete.data} onDone={onDone} />;
  return (
    <div className="flex flex-col gap-2">
      <StatusBanner
        tone="info"
        title="Finish connecting the channel"
        description="The provider sent you back with an authorisation code. Finishing exchanges it once; the code is never stored."
        actions={
          <>
            <Button
              size="sm"
              variant="primary"
              onClick={() => complete.mutate({ state, code })}
              disabled={complete.isPending}
            >
              {complete.isPending ? 'Finishing…' : 'Finish connecting'}
            </Button>
            <Button size="sm" variant="ghost" onClick={onDone}>
              Discard
            </Button>
          </>
        }
        data-testid="connect-callback"
      />
      {complete.isError && <RequestError error={complete.error} title="The connection was not completed" />}
    </div>
  );
}

type Listed = { key: string; label: string; activation: ProviderActivationDto | null };

/**
 * "Connect a channel": the platform is chosen from a menu (the interface's first step) and the server's
 * authorisation link appears under the heading; a platform that cannot be connected here says why instead.
 */
function ConnectChannelMenu({
  providers,
  reasonFor,
  start,
  brandId,
  redirectUri,
}: {
  providers: readonly Listed[];
  reasonFor: (p: Listed) => string | null;
  start: ConnectStart;
  brandId: string;
  redirectUri: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="primary" disabled={start.isPending}>
          {start.isPending ? 'Starting…' : 'Connect a channel'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {providers.map((p) => {
          const reason = reasonFor(p);
          return (
            <DropdownMenuItem
              key={p.key}
              disabled={reason !== null}
              title={reason ?? undefined}
              onSelect={() => start.mutate({ brandId, providerKey: p.key, redirectUri })}
            >
              <span className="flex-1">{p.label}</span>
              {reason && <span className="text-xs text-muted-foreground">unavailable</span>}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Spec 21.1 `settings/` channels (spec 14.7), as the interface's Channels tab: one list of the brand's connections
 * (state as text with a dot, Reconnect when the access is dead, Manage for the health, scopes and publishing
 * detail with Disconnect) followed by the platforms that can be connected (Details for the activation and the
 * certification of each capability). Connect and reconnect go through the provider's authorisation page,
 * completion on return, disconnect with confirmation.
 */
export function ChannelSettings() {
  const { brandId } = useBrandContext();
  const channels = useChannels(brandId);
  const limits = useChannelLimits(brandId);
  const [params, setParams] = useSearchParams();
  const callback = callbackParams(params.toString());
  const providerError = callbackError(params.toString());
  const [unavailable, setUnavailable] = useState<Record<string, string>>({});
  const redirectUri = connectRedirectUri(window.location.origin);
  const clearCallback = () => setParams({}, { replace: true });
  const listUi = channels.isError ? toUiError(channels.error) : null;
  // RA-01: owners and admins see every registered channel provider with why it cannot be connected here; the
  // others get the Release 1 list and the server's refusal, as before.
  const providers = useProviders();
  const listed: readonly Listed[] = providers.data
    ? providers.data.items
        .filter((p) => p.kind === 'channel')
        .map((p) => ({ key: p.key, label: providerLabel(p.key), activation: p }))
    : RELEASE_1_PROVIDERS.map((p) => ({ ...p, activation: null }));
  const activationOf = (key: string) => listed.find((p) => p.key === key)?.activation ?? null;
  const reasonFor = (p: Listed) =>
    unavailable[p.key] ?? (p.activation ? activationReason(p.activation) : null);
  const limitsFor = (key: string) => {
    const limit = limits.data?.items.find((l) => l.providerKey === key);
    return limit ? channelLimitsLine(limit) : null;
  };
  const onUnavailable = (key: string, reason: string) => setUnavailable((u) => ({ ...u, [key]: reason }));
  const headerStart = useConnectStart({ brandId, onUnavailable });
  const connected = channels.data?.filter((c) => c.status !== 'disabled') ?? [];
  const attention = connected.filter(channelNeedsAction).length;
  const summary = channels.isPending
    ? 'Loading the connections…'
    : channels.isError
      ? 'The connections could not be read.'
      : `${connected.length} connected${attention > 0 ? ` · ${attention} need${attention === 1 ? 's' : ''} attention` : ''}`;
  const connectedByKey = (key: string) => connected.filter((c) => c.providerKey === key).length;

  return (
    <div className="flex flex-col gap-5">
      {callback && <FinishConnect state={callback.state} code={callback.code} onDone={clearCallback} />}
      {providerError && (
        <StatusBanner
          tone="warning"
          title="The provider did not authorise the connection"
          description={providerError}
          actions={
            <Button size="sm" onClick={clearCallback}>
              Dismiss
            </Button>
          }
          data-testid="provider-error"
        />
      )}
      <section aria-labelledby="channels-heading" className="flex flex-col gap-5" data-testid="channels">
        <GroupHeader
          id="channels-heading"
          title="Connected channels"
          description={summary}
          action={
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void channels.refetch()}
                disabled={channels.isFetching}
              >
                {channels.isFetching ? 'Refreshing…' : 'Refresh'}
              </Button>
              {listUi?.kind !== 'forbidden' && (
                <ConnectChannelMenu
                  providers={listed}
                  reasonFor={reasonFor}
                  start={headerStart}
                  brandId={brandId}
                  redirectUri={redirectUri}
                />
              )}
            </>
          }
        />
        <ConnectResult start={headerStart} providerKey={headerStart.variables?.providerKey ?? ''} />
        {channels.isPending && <Skeleton label="Loading channels" lines={3} />}
        {channels.isError && (
          <RequestError
            error={channels.error}
            onRetry={() => void channels.refetch()}
            title={listUi?.kind === 'forbidden' ? 'Permission denied' : undefined}
          />
        )}
        {channels.isSuccess && channels.data.length === 0 && (
          <EmptyState
            title="No channels connected"
            description="Connect a platform from the list below to publish to it."
          />
        )}
        <div className="flex flex-col">
          {channels.isSuccess && channels.data.length > 0 && (
            <ul className="flex flex-col" aria-label="Channels">
              {channels.data.map((c) => (
                <ChannelRow
                  key={c.id}
                  channel={c}
                  brandId={brandId}
                  redirectUri={redirectUri}
                  limits={limitsFor(c.providerKey)}
                  activation={activationOf(c.providerKey)}
                />
              ))}
            </ul>
          )}
          {listUi?.kind !== 'forbidden' && (
            <ul className="flex flex-col" aria-label="Providers" data-testid="providers">
              {listed.map((p) => (
                <ProviderRow
                  key={p.key}
                  provider={p}
                  brandId={brandId}
                  redirectUri={redirectUri}
                  limits={limitsFor(p.key)}
                  connected={connectedByKey(p.key)}
                  reason={reasonFor(p)}
                  onUnavailable={onUnavailable}
                />
              ))}
            </ul>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Tokens are envelope-encrypted and never shown. Only certified providers can publish; the server
          refuses the others, and the reason is behind each platform&apos;s Details.
        </p>
      </section>
    </div>
  );
}
