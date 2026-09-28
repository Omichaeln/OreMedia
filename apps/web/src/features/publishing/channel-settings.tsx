import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Skeleton, StatusBanner } from '@oremedia/ui';
import { Dialog, DialogActions, DialogClose, DialogContent } from '../../components/dialog';
import { RequestError } from '../../components/request-state';
import { Section } from '../../components/section';
import { useDeploymentBrand } from '../../lib/deployment-brand';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { useBrandContext } from '../brand/brand-context';
import {
  callbackError,
  callbackParams,
  providerLabel,
  connectRedirectUri,
  rememberConnect,
  RELEASE_1_PROVIDERS,
  unavailableReason,
} from './channel-connect';
import { CHANNEL_CHIP } from './publication-state';
import { useChannels, type ChannelDto, type ConnectResultDto } from './use-publishing';

type ConnectChoice = Extract<ConnectResultDto, { outcome: 'choose' }>;
type ConnectedChannel = Extract<ConnectResultDto, { outcome: 'connected' }>;

/**
 * Spec 14.7 connect start: the server returns the provider's authorisation URL; it opens in a new tab as a link (never
 * an iframe, the provider's consent screen must be top-level). An uncertified provider is refused with its reason.
 */
function ConnectButton({
  brandId,
  providerKey,
  redirectUri,
  label,
  onUnavailable,
  unavailable,
}: {
  brandId: string;
  providerKey: string;
  redirectUri: string;
  label: string;
  onUnavailable?: (reason: string) => void;
  unavailable?: string | null;
}) {
  const trpc = useTRPC();
  const deployment = useDeploymentBrand();
  const { companyId } = useBrandContext();
  const intent = useIntentKey();
  const start = useMutation(
    trpc.publishing.channels.connect.start.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (data) => {
        intent.renew();
        // The provider returns to the shared callback; this is how it finds its way back to this brand.
        rememberConnect(data.state, { companyId, brandId, expiresAt: data.expiresAt });
      },
      onError: (err) => {
        const reason = unavailableReason(toUiError(err).details);
        if (reason) onUnavailable?.(reason);
      },
    }),
  );
  const ui = start.isError ? toUiError(start.error) : null;
  const refusedAsUnavailable = ui !== null && unavailableReason(ui.details) !== null;
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          size="sm"
          variant="primary"
          onClick={() => start.mutate({ brandId, providerKey, redirectUri })}
          disabled={start.isPending || Boolean(unavailable)}
          disabledReason={unavailable ?? undefined}
        >
          {start.isPending ? 'Starting…' : label}
        </Button>
      </div>
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

function DisconnectButton({ channel }: { channel: ChannelDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [open, setOpen] = useState(false);
  const disconnect = useMutation(
    trpc.publishing.channels.disconnect.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setOpen(false);
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
      {disconnect.data && disconnect.data.heldPublicationIds.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="held-after-disconnect">
          {disconnect.data.heldPublicationIds.length} scheduled publication
          {disconnect.data.heldPublicationIds.length === 1 ? ' is' : 's are'} now held.
        </p>
      )}
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

function ChannelRow({
  channel,
  brandId,
  redirectUri,
}: {
  channel: ChannelDto;
  brandId: string;
  redirectUri: string;
}) {
  const chip = CHANNEL_CHIP[channel.status];
  const reconnect = channel.status !== 'active';
  return (
    <li
      className="flex flex-col gap-2 py-3"
      data-testid={`channel-${channel.id}`}
      data-channel-status={channel.status}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">
          {channel.displayName} ({channel.providerKey})
        </span>
        <Badge tone={chip.tone}>{chip.label}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        {chip.detail}
        {channel.tokenExpiresAt &&
          ` Token ${new Date(channel.tokenExpiresAt).getTime() < Date.now() ? 'expired' : 'expires'} ${new Date(channel.tokenExpiresAt).toLocaleString()}.`}
        {channel.missingScopes.length > 0 && ` Missing scopes: ${channel.missingScopes.join(', ')}.`}
      </p>
      <div className="flex flex-wrap items-start gap-2">
        {reconnect && (
          <ConnectButton
            brandId={brandId}
            providerKey={channel.providerKey}
            redirectUri={redirectUri}
            label={channel.status === 'disabled' ? 'Connect again' : 'Reconnect'}
          />
        )}
        {channel.status !== 'disabled' && <DisconnectButton channel={channel} />}
      </div>
    </li>
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
      className="flex flex-col gap-3 rounded-md border border-border p-3"
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

/**
 * Spec 21.1 `settings/` channels (spec 14.7): each connection with its status as text, connect and reconnect through
 * the provider's authorisation page, completion on return, disconnect with confirmation. The Settings screen shows
 * it as its Channels tab.
 */
export function ChannelSettings() {
  const { brandId, brand } = useBrandContext();
  const channels = useChannels(brandId);
  const [params, setParams] = useSearchParams();
  const callback = callbackParams(params.toString());
  const providerError = callbackError(params.toString());
  const [unavailable, setUnavailable] = useState<Record<string, string>>({});
  const redirectUri = connectRedirectUri(window.location.origin);
  const clearCallback = () => setParams({}, { replace: true });
  const listUi = channels.isError ? toUiError(channels.error) : null;

  return (
    <div className="flex flex-col gap-8">
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
      <Section
        id="channels-heading"
        title="Connected channels"
        testId="channels"
        action={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void channels.refetch()}
            disabled={channels.isFetching}
          >
            {channels.isFetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      >
        <p className="text-xs text-muted-foreground">
          The social accounts {brand.name} publishes to. Credentials are sealed server-side and never shown.
        </p>
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
            description="Connect a provider below to publish to it."
          />
        )}
        {channels.isSuccess && channels.data.length > 0 && (
          <ul className="divide-y divide-border" aria-label="Channels">
            {channels.data.map((c) => (
              <ChannelRow key={c.id} channel={c} brandId={brandId} redirectUri={redirectUri} />
            ))}
          </ul>
        )}
      </Section>
      {listUi?.kind !== 'forbidden' && (
        <Section id="providers-heading" title="Connect a channel" testId="providers">
          <p className="text-xs text-muted-foreground">
            Only providers certified after their platform review can be connected; the server refuses the
            others and the reason is shown here.
          </p>
          <ul className="divide-y divide-border" aria-label="Providers">
            {RELEASE_1_PROVIDERS.map((p) => {
              const reason = unavailable[p.key] ?? null;
              return (
                <li key={p.key} className="flex flex-col gap-2 py-3" data-testid={`provider-${p.key}`}>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{p.label}</span>
                    <code className="text-xs text-muted-foreground">{p.key}</code>
                    {reason && <Badge tone="neutral">Unavailable</Badge>}
                  </div>
                  {reason && (
                    <p className="text-xs text-muted-foreground" data-testid="unavailable-reason">
                      {reason}
                    </p>
                  )}
                  <ConnectButton
                    brandId={brandId}
                    providerKey={p.key}
                    redirectUri={redirectUri}
                    label={`Connect ${p.label}`}
                    unavailable={reason}
                    onUnavailable={(r) => setUnavailable((u) => ({ ...u, [p.key]: r }))}
                  />
                </li>
              );
            })}
          </ul>
        </Section>
      )}
    </div>
  );
}
