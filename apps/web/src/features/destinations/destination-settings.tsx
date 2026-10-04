import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DESTINATION_KIND_CAPABILITIES,
  DestinationKind,
  SOURCE_USE_RETENTION_MAX_DAYS,
  type DestinationHealth,
  type DestinationWriteSafety,
  type DestinationStatus,
  type SourceUse,
} from '@oremedia/contracts/destinations';
import type { ErrorDetail } from '@oremedia/contracts/errors';
import {
  ARTICLE_SELECTOR_MAX_CHARS,
  ArticleRegionSelector,
  DEFAULT_ARTICLE_REGION_SELECTORS,
} from '@oremedia/contracts/article';
import { Badge, Button, EmptyState, Field, Input, Skeleton, StatusBanner, type Tone } from '@oremedia/ui';
import { Dialog, DialogActions, DialogClose, DialogContent } from '../../components/dialog';
import { RequestError } from '../../components/request-state';
import { Section } from '../../components/section';
import { Select } from '../../components/select';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useDeploymentBrand } from '../../lib/deployment-brand';
import { useTRPC } from '../../lib/trpc';
import { useBrandContext } from '../brand/brand-context';
import {
  ACTIVATION_CHIP,
  activationReason,
  callbackError,
  callbackParams,
  connectRedirectUri,
  rememberConnect,
  unavailableReason,
} from '../publishing/channel-connect';
import { CapabilityCertifications } from '../settings/capability-certifications';
import { useProviders, type ProviderActivationDto } from '../settings/use-settings';
import {
  useDestinationSources,
  useDestinations,
  useSourceUsePolicies,
  type DestinationConnectChoiceDto,
  type DestinationDto,
  type DestinationSourceDto,
  type SourceUsePolicyDto,
} from './use-destinations';

const KINDS = DestinationKind.options;
const kindLabel = (kind: DestinationKind) => DESTINATION_KIND_CAPABILITIES[kind].label;
const kindOptions = KINDS.map((k) => ({ value: k, label: kindLabel(k) }));

/** The health a check last found, as the channel chips say a connection's state. */
const HEALTH_CHIP: Record<DestinationHealth, { tone: Tone; label: string }> = {
  unknown: { tone: 'neutral', label: 'Not checked' },
  healthy: { tone: 'good', label: 'Healthy' },
  degraded: { tone: 'warning', label: 'Degraded' },
  unreachable: { tone: 'critical', label: 'Unreachable' },
};
const STATUS_CHIP: Record<DestinationStatus, { tone: Tone; label: string }> = {
  active: { tone: 'good', label: 'Active' },
  disconnected: { tone: 'neutral', label: 'Disconnected' },
};
const USE_LABEL: Record<SourceUse, string> = { read: 'Read', retain: 'Retain', write: 'Write' };
/**
 * PR-03: what the last verification found about updating a published article safely (only shown once known: a
 * kind that never updates articles stays `unknown`).
 */
const WRITE_SAFETY_CHIP: Record<
  Exclude<DestinationWriteSafety, 'unknown'>,
  { tone: Tone; label: string; detail: string }
> = {
  conditional: {
    tone: 'good',
    label: 'Safe updates',
    detail:
      'The site applies an edit only if the article is still the version Oremedia last read; a change made on the site in the meantime is never overwritten.',
  },
  limited: {
    tone: 'warning',
    label: 'Limited mode',
    detail:
      'This site cannot guarantee that an edit does not overwrite a change made on the site, so Oremedia does not edit articles that already exist there: new drafts and publishes, reverting to a draft and deleting still work; edit existing articles on the site itself, or have the site administrator install the Oremedia conditional-write plugin.',
  },
};

/** Policy dates are days in UTC (the input sends midnight UTC), so the label reads them in UTC too. */
const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
/** A date input's value (`YYYY-MM-DD`) for an instant; the policy's due date is sent as midnight UTC of that day. */
const toDateInput = (iso: string) => iso.slice(0, 10);
const fromDateInput = (date: string) => `${date}T00:00:00.000Z`;
const defaultReviewDue = () => toDateInput(new Date(Date.now() + 90 * 86_400_000).toISOString());

function DisconnectButton({ destination }: { destination: DestinationDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [open, setOpen] = useState(false);
  const disconnect = useMutation(
    trpc.destinations.disconnect.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setOpen(false);
        void queryClient.invalidateQueries(trpc.destinations.pathFilter());
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
          title={`Disconnect ${destination.displayName}?`}
          description="Nothing is read from or written to this destination afterwards. What was already stored follows the source-use policy; the destination can be registered again later."
        >
          <DialogActions>
            <DialogClose asChild>
              <Button variant="ghost">Keep connected</Button>
            </DialogClose>
            <Button
              variant="danger"
              onClick={() =>
                disconnect.mutate({
                  brandId: destination.brandId,
                  destinationId: destination.id,
                  expectedVersion: destination.version,
                })
              }
              disabled={disconnect.isPending}
              data-testid="confirm-disconnect-destination"
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
          description={`${ui.message} Disconnecting needs destination.manage for this brand.`}
          data-testid="disconnect-denied"
        />
      )}
      {ui && ui.kind !== 'forbidden' && (
        <RequestError error={disconnect.error} title="The destination was not disconnected" />
      )}
    </>
  );
}

/**
 * PR-04: where this website's theme puts an article's body, for rendered-article verification (simple selectors
 * such as `.entry-content` or `div.post-body`; empty uses the common WordPress defaults). destination.manage.
 */
function ArticleSelectorForm({ destination }: { destination: DestinationDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [value, setValue] = useState(destination.articleSelector ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation(
    trpc.destinations.setArticleSelector.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setError(null);
        void queryClient.invalidateQueries(trpc.destinations.pathFilter());
      },
      onError: (err) => setError(toUiError(err).message),
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed !== '' && !ArticleRegionSelector.safeParse(trimmed).success) {
      setError(
        'Use simple selectors only, separated by commas: a tag, #id, .class or [attribute], e.g. div.post-body.',
      );
      return;
    }
    save.mutate({
      brandId: destination.brandId,
      destinationId: destination.id,
      articleSelector: trimmed === '' ? null : trimmed,
      expectedVersion: destination.version,
    });
  };
  const id = `article-selector-${destination.id}`;
  return (
    <form
      onSubmit={submit}
      className="flex flex-wrap items-end gap-2"
      noValidate
      data-testid="article-selector-form"
    >
      <Field
        label="Article region selector"
        htmlFor={id}
        hint={`Where the theme puts an article's body, checked first when a published page is verified; empty uses the defaults (${DEFAULT_ARTICLE_REGION_SELECTORS.join(', ')}).`}
        error={error ?? undefined}
      >
        <Input
          id={id}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={ARTICLE_SELECTOR_MAX_CHARS}
          placeholder=".entry-content"
        />
      </Field>
      <Button type="submit" size="sm" variant="secondary" disabled={save.isPending}>
        {save.isPending ? 'Saving…' : 'Save selector'}
      </Button>
    </form>
  );
}

function DestinationRow({
  destination,
  canManageDestinations,
}: {
  destination: DestinationDto;
  canManageDestinations: boolean;
}) {
  const health = HEALTH_CHIP[destination.health];
  const status = STATUS_CHIP[destination.status];
  const safety = destination.writeSafety === 'unknown' ? null : WRITE_SAFETY_CHIP[destination.writeSafety];
  return (
    <li
      className="flex flex-col gap-2 py-3"
      data-testid={`destination-${destination.id}`}
      data-destination-health={destination.health}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{destination.displayName}</span>
        <code className="text-xs text-muted-foreground">{destination.externalId}</code>
        <Badge tone={health.tone}>{health.label}</Badge>
        {destination.status !== 'active' && <Badge tone={status.tone}>{status.label}</Badge>}
        {safety && (
          <Badge tone={safety.tone} data-testid="destination-write-safety">
            {safety.label}
          </Badge>
        )}
      </div>
      {safety && destination.writeSafety === 'limited' && destination.status === 'active' && (
        <StatusBanner
          tone="warning"
          title="Limited mode: existing articles are not edited from Oremedia"
          description={safety.detail}
          data-testid="destination-limited-mode"
        />
      )}
      {safety && destination.writeSafety === 'conditional' && (
        <p className="text-xs text-muted-foreground">{safety.detail}</p>
      )}
      <p className="text-xs text-muted-foreground">
        Owner <code>{destination.ownerUserId}</code> · capability v{destination.capabilityVersion}
        {destination.healthCheckedAt &&
          ` · checked ${new Date(destination.healthCheckedAt).toLocaleString()}`}
        {destination.grantedScopes.length > 0 && ` · scopes: ${destination.grantedScopes.join(', ')}`}
      </p>
      {destination.kind === 'cms_site' && destination.articleSelector && (
        <p className="text-xs text-muted-foreground" data-testid="destination-article-selector">
          Article region: <code>{destination.articleSelector}</code>
        </p>
      )}
      {canManageDestinations && destination.status === 'active' && destination.kind === 'cms_site' && (
        <ArticleSelectorForm destination={destination} />
      )}
      {canManageDestinations && destination.status === 'active' && (
        <div className="flex flex-wrap items-start gap-2">
          <DisconnectButton destination={destination} />
        </div>
      )}
    </li>
  );
}

/**
 * R2-1 connect start (as the channel flow): the server returns the vendor's authorisation URL; it opens in a new tab
 * as a link (never an iframe, the consent screen must be top-level). An uncertified source is refused with its
 * reason; one not enabled on this deployment is not offered at all.
 */
/** RA-01: the activation chip and reason of a listed provider (owners and admins), beside the certification badge. */
function ActivationNote({ activation }: { activation: ProviderActivationDto | null }) {
  if (!activation) return null;
  const chip = ACTIVATION_CHIP[activation.state];
  const reason = activationReason(activation);
  return (
    <>
      <Badge tone={chip.tone}>{chip.label}</Badge>
      <CapabilityCertifications activation={activation} />
      {reason && (
        <p className="basis-full text-xs text-muted-foreground" data-testid="unavailable-reason">
          {reason}
        </p>
      )}
    </>
  );
}

function ConnectSourceButton({
  brandId,
  source,
  redirectUri,
  activation,
}: {
  brandId: string;
  source: DestinationSourceDto;
  redirectUri: string;
  activation: ProviderActivationDto | null;
}) {
  const trpc = useTRPC();
  const deployment = useDeploymentBrand();
  const { companyId } = useBrandContext();
  const intent = useIntentKey();
  const start = useMutation(
    trpc.destinations.connect.start.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (data) => {
        intent.renew();
        // The vendor returns to the shared callback; this is how it finds its way back to this brand's destinations.
        rememberConnect(data.state, { companyId, brandId, expiresAt: data.expiresAt, flow: 'destination' });
      },
    }),
  );
  const ui = start.isError ? toUiError(start.error) : null;
  const unavailable =
    (ui ? unavailableReason(ui.details) : null) ?? (activation ? activationReason(activation) : null);
  return (
    <li className="flex flex-col gap-2 py-3" data-testid={`source-${source.kind}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{source.label}</span>
        <code className="text-xs text-muted-foreground">{source.kind}</code>
        {!source.certified && !activation && <Badge tone="neutral">Not certified</Badge>}
        <ActivationNote activation={activation} />
      </div>
      <div>
        <Button
          size="sm"
          variant="primary"
          onClick={() => start.mutate({ brandId, kind: source.kind, redirectUri })}
          disabled={start.isPending || Boolean(unavailable)}
          disabledReason={unavailable ?? undefined}
        >
          {start.isPending ? 'Starting…' : `Connect ${source.label}`}
        </Button>
      </div>
      {start.data && (
        <StatusBanner
          tone="info"
          title={`Continue at ${source.vendor}`}
          description={
            <>
              Authorise {deployment.name} in {source.vendor}&apos;s own window, then return here to choose
              what it reads. The link expires {new Date(start.data.expiresAt).toLocaleTimeString()}.
            </>
          }
          actions={
            <Button size="sm" asChild>
              <a href={start.data.url} target="_blank" rel="noopener noreferrer" data-testid="authorise-link">
                Open {source.vendor} authorisation (new tab)
              </a>
            </Button>
          }
          data-testid="destination-connect-started"
        />
      )}
      {unavailable && !activation && (
        <p className="text-xs text-muted-foreground" data-testid="unavailable-reason">
          {unavailable}
        </p>
      )}
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Connecting a source needs destination.connect for this brand.`}
          data-testid="destination-connect-denied"
        />
      )}
      {ui && ui.kind !== 'forbidden' && !unavailable && (
        <RequestError error={start.error} title="The connection did not start" />
      )}
    </li>
  );
}

/**
 * R2-1 target choice: the grant can read several properties or sites, so the person confirms the one this brand
 * reads, even when there is only one. Nothing is registered until they do; cancelling discards the sealed grant.
 */
function ChooseTarget({ choice, onDone }: { choice: DestinationConnectChoiceDto; onDone: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [selected, setSelected] = useState<string | null>(
    choice.targets.length === 1 ? (choice.targets[0]?.externalId ?? null) : null,
  );
  const select = useMutation(
    trpc.destinations.connect.select.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.destinations.pathFilter());
      },
    }),
  );
  const cancel = useMutation(
    trpc.destinations.connect.cancel.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        onDone();
      },
    }),
  );
  const selectUi = select.isError ? toUiError(select.error) : null;
  const otherBrand = selectUi?.details.some(
    (d) => d.path === 'externalId' && d.issue === 'remote_identity_registered_to_another_brand',
  );
  if (select.data)
    return (
      <StatusBanner
        tone="good"
        title={`Connected: ${select.data.displayName} (${kindLabel(select.data.kind)})`}
        description="The grant is sealed and stored; the destination is listed above and its token is refreshed daily."
        actions={
          <Button size="sm" onClick={onDone}>
            Done
          </Button>
        }
        data-testid="destination-connect-completed"
      />
    );
  const busy = select.isPending || cancel.isPending;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (selected) select.mutate({ pendingId: choice.pendingId, externalId: selected });
  };
  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-3 rounded-md border border-border p-3"
      noValidate
      data-testid="destination-connect-choose"
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-semibold">Choose what this brand reads</legend>
        <p className="text-xs text-muted-foreground">
          Only the {kindLabel(choice.kind).toLowerCase()} you choose is connected; the choice expires{' '}
          {new Date(choice.expiresAt).toLocaleTimeString()}.
        </p>
        {choice.targets.map((target) => (
          <label key={target.externalId} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`destination-target-${choice.pendingId}`}
              value={target.externalId}
              checked={selected === target.externalId}
              onChange={() => setSelected(target.externalId)}
            />
            <span>
              {target.displayName} <code className="text-xs text-muted-foreground">{target.externalId}</code>
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
          disabledReason={selected ? undefined : 'Choose one first'}
        >
          {select.isPending ? 'Connecting…' : 'Confirm'}
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
      {selectUi && selectUi.kind === 'conflict' && (
        <StatusBanner
          tone="warning"
          title="Already registered"
          description="This brand holds this remote identity already; choose another or cancel."
          data-testid="destination-conflict"
        />
      )}
      {otherBrand && (
        <StatusBanner
          tone="warning"
          title="Registered to another brand"
          description="Another brand of this company holds this remote identity; a destination belongs to one brand."
          data-testid="destination-other-brand"
        />
      )}
      {selectUi && selectUi.kind !== 'conflict' && !otherBrand && (
        <RequestError error={select.error} title="The destination was not connected" />
      )}
      {cancel.isError && <RequestError error={cancel.error} title="The choice was not cancelled" />}
    </form>
  );
}

/** R2-1 completion: the vendor sent the person back with `state` and `code`; exchanging them is explicit. */
function FinishDestinationConnect({
  state,
  code,
  onDone,
}: {
  state: string;
  code: string;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  const intent = useIntentKey();
  const complete = useMutation(
    trpc.destinations.connect.complete.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => intent.renew(),
    }),
  );
  if (complete.data) return <ChooseTarget choice={complete.data} onDone={onDone} />;
  return (
    <div className="flex flex-col gap-2">
      <StatusBanner
        tone="info"
        title="Finish connecting the source"
        description="The provider sent you back with an authorisation code. Finishing exchanges it once and lists what the grant can read; the code is never stored."
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
        data-testid="destination-connect-callback"
      />
      {complete.isError && <RequestError error={complete.error} title="The connection was not completed" />}
    </div>
  );
}

/** The sources this deployment can connect: one button per enabled kind (R2-1); none enabled, nothing is shown. */
/**
 * R2-3 (D-16): a website connected with its address and an integration identity's secret (an application
 * password), typed once into a password field and never shown again: the server seals it and the worker verifies
 * it, so the row appears as "Not checked" until the check ran. Writes land as drafts unless live publishing is
 * granted here.
 */
function ConnectWebsiteForm({
  brandId,
  source,
  activation,
}: {
  brandId: string;
  source: DestinationSourceDto;
  activation: ProviderActivationDto | null;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [siteUrl, setSiteUrl] = useState('');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [allowPublish, setAllowPublish] = useState(false);
  const [connected, setConnected] = useState<string | null>(null);
  const credentialLabel = source.credential?.label ?? 'Secret';
  const connect = useMutation(
    trpc.destinations.connect.withSecret.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (data) => {
        intent.renew();
        setConnected(data.displayName);
        setSiteUrl('');
        setUsername('');
        setSecret('');
        setDisplayName('');
        setAllowPublish(false);
        void queryClient.invalidateQueries(trpc.destinations.pathFilter());
      },
    }),
  );
  // Once the mutation settled as a success its cache still holds the variables (the secret): drop them.
  const { isSuccess, reset } = connect;
  useEffect(() => {
    if (isSuccess) reset();
  }, [isSuccess, reset]);
  const ui = connect.isError ? toUiError(connect.error) : null;
  const siteIssue = ui?.details.find((d) => d.path === 'siteUrl')?.issue;
  const blocked = activation ? activationReason(activation) : null;
  const ready = !blocked && siteUrl.trim().startsWith('https://') && username.trim() !== '' && secret !== '';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready)
      connect.mutate({
        brandId,
        kind: 'cms_site',
        siteUrl: siteUrl.trim(),
        username: username.trim(),
        secret,
        allowPublish,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
  };
  return (
    <li className="flex flex-col gap-2 py-3" data-testid={`source-${source.kind}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Connect a website ({source.vendor})</span>
        <code className="text-xs text-muted-foreground">{source.kind}</code>
        {!source.certified && !activation && <Badge tone="neutral">Not certified</Badge>}
        <ActivationNote activation={activation} />
      </div>
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate data-testid="connect-website">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Site address"
            htmlFor="website-url"
            hint="The site's https origin, for example https://www.example.com."
            error={
              siteIssue === 'site_url_not_allowed'
                ? 'The address must be https on a public host'
                : siteIssue === 'site_url_not_an_origin'
                  ? 'Give the address without a path'
                  : undefined
            }
          >
            <Input
              id="website-url"
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              placeholder="https://"
              maxLength={200}
              autoComplete="off"
            />
          </Field>
          <Field label="Website name (optional)" htmlFor="website-name">
            <Input
              id="website-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={200}
            />
          </Field>
          <Field
            label="Username"
            htmlFor="website-username"
            hint={`The site user the ${credentialLabel.toLowerCase()} belongs to.`}
          >
            <Input
              id="website-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              maxLength={200}
              autoComplete="off"
            />
          </Field>
          <Field label={credentialLabel} htmlFor="website-secret" hint={source.credential?.hint}>
            <Input
              id="website-secret"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              maxLength={500}
              autoComplete="new-password"
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={allowPublish} onChange={(e) => setAllowPublish(e.target.checked)} />
          Allow live publishing (otherwise every article lands as a draft to preview first)
        </label>
        {connected !== null && (
          <StatusBanner
            tone="good"
            title={`Connected: ${connected}`}
            description="The secret is sealed and never shown again. The website is checked in the background; its health updates here once the check ran."
            data-testid="website-connected"
          />
        )}
        {ui && ui.kind === 'forbidden' && (
          <StatusBanner
            tone="critical"
            title="Permission denied"
            description={`${ui.message} Connecting a website needs destination.connect for this brand.`}
          />
        )}
        {ui && ui.kind === 'conflict' && (
          <StatusBanner
            tone="warning"
            title="Already connected"
            description="This brand holds this website already; it is listed above."
            data-testid="website-conflict"
          />
        )}
        {ui && ui.kind !== 'forbidden' && ui.kind !== 'conflict' && !siteIssue && (
          <RequestError error={connect.error} title="The website was not connected" />
        )}
        <div>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={!ready || connect.isPending}
            disabledReason={ready ? undefined : 'Give the https site address, the username and the secret'}
          >
            {connect.isPending ? 'Connecting…' : 'Connect website'}
          </Button>
        </div>
      </form>
    </li>
  );
}

function ConnectSources({ brandId }: { brandId: string }) {
  const sources = useDestinationSources();
  const providers = useProviders();
  const redirectUri = connectRedirectUri(window.location.origin);
  // RA-01: owners and admins also see the kinds this deployment has not enabled, with the reason; the others
  // see the enabled kinds only, as before.
  const activationOf = (kind: string) =>
    providers.data?.items.find((p) => p.kind !== 'channel' && p.key === kind) ?? null;
  const enabled = (sources.data?.items ?? []).filter((s) => s.enabled || activationOf(s.kind) !== null);
  const secretLabel = enabled.find((s) => s.connect === 'secret')?.credential?.label ?? 'a credential';
  if (!sources.isSuccess || enabled.length === 0) return null;
  return (
    <Section id="destination-sources-heading" title="Connect a source" testId="destination-sources">
      <p className="text-xs text-muted-foreground">
        Authorise an account at the source&apos;s vendor, then choose which property or site this brand reads;
        a website is connected with its address and {secretLabel.toLowerCase()} instead. Only sources
        certified after their platform review can be connected; the server refuses the others and the reason
        is shown here.
      </p>
      <ul className="divide-y divide-border" aria-label="Sources">
        {enabled.map((source) =>
          source.connect === 'secret' ? (
            <ConnectWebsiteForm
              key={source.kind}
              brandId={brandId}
              source={source}
              activation={activationOf(source.kind)}
            />
          ) : (
            <ConnectSourceButton
              key={source.kind}
              brandId={brandId}
              source={source}
              redirectUri={redirectUri}
              activation={activationOf(source.kind)}
            />
          ),
        )}
      </ul>
    </Section>
  );
}

/** Registers a remote identity for the brand (destination.connect); a credential is attached by a connect flow later. */
function RegisterDestination({ brandId }: { brandId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [kind, setKind] = useState<DestinationKind>('ga4_property');
  const [externalId, setExternalId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const register = useMutation(
    trpc.destinations.register.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setExternalId('');
        setDisplayName('');
        void queryClient.invalidateQueries(trpc.destinations.pathFilter());
      },
    }),
  );
  const ui = register.isError ? toUiError(register.error) : null;
  const otherBrand = ui?.details.some(
    (d) => d.path === 'externalId' && d.issue === 'remote_identity_registered_to_another_brand',
  );
  const ready = externalId.trim().length > 0 && displayName.trim().length > 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready)
      register.mutate({ brandId, kind, externalId: externalId.trim(), displayName: displayName.trim() });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate data-testid="register-destination">
      <div className="grid gap-3 sm:grid-cols-[14rem_1fr_1fr]">
        <Field label="Kind" htmlFor="destination-kind">
          <Select
            id="destination-kind"
            value={kind}
            onValueChange={(v) => setKind(DestinationKind.parse(v))}
            options={kindOptions}
          />
        </Field>
        <Field
          label="External id"
          htmlFor="destination-external-id"
          hint="The property, site, location, CMS or webhook id as the provider names it."
        >
          <Input
            id="destination-external-id"
            value={externalId}
            onChange={(e) => setExternalId(e.target.value)}
            maxLength={200}
          />
        </Field>
        <Field label="Display name" htmlFor="destination-display-name">
          <Input
            id="destination-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={200}
          />
        </Field>
      </div>
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Registering needs destination.connect for this brand.`}
          data-testid="register-denied"
        />
      )}
      {ui && ui.kind === 'conflict' && (
        <StatusBanner
          tone="warning"
          title="Already registered"
          description="This brand holds this remote identity already; it is listed above."
          data-testid="destination-conflict"
        />
      )}
      {otherBrand && (
        <StatusBanner
          tone="warning"
          title="Registered to another brand"
          description="Another brand of this company holds this remote identity; a destination belongs to one brand."
          data-testid="destination-other-brand"
        />
      )}
      {ui && ui.kind !== 'forbidden' && ui.kind !== 'conflict' && !otherBrand && (
        <RequestError error={register.error} title="The destination was not registered" />
      )}
      <div>
        <Button
          type="submit"
          variant="primary"
          disabled={!ready || register.isPending}
          disabledReason={ready ? undefined : 'Name the destination and its external id first'}
        >
          {register.isPending ? 'Registering…' : 'Register destination'}
        </Button>
      </div>
    </form>
  );
}

/** What a policy row edits; the row's own values until the person changes them. */
interface PolicyDraft {
  uses: SourceUse[];
  retentionDays: string;
  reviewDue: string;
}
const draftOf = (p: SourceUsePolicyDto): PolicyDraft => ({
  uses: p.allowedUses,
  retentionDays: p.retentionDays ? String(p.retentionDays) : '',
  reviewDue: toDateInput(p.reviewDueAt),
});

/** The allowed-use boxes a kind offers (D-17: a Business Profile location never offers retain or write). */
function UseBoxes({
  kind,
  idPrefix,
  draft,
  onChange,
  disabled,
}: {
  kind: DestinationKind;
  idPrefix: string;
  draft: PolicyDraft;
  onChange: (next: PolicyDraft) => void;
  disabled: boolean;
}) {
  const toggle = (use: SourceUse, on: boolean) =>
    onChange({
      ...draft,
      uses: on ? [...new Set([...draft.uses, use])] : draft.uses.filter((u) => u !== use),
      retentionDays: use === 'retain' && !on ? '' : draft.retentionDays,
    });
  return (
    <fieldset className="flex flex-wrap gap-3" disabled={disabled}>
      <legend className="sr-only">Allowed uses</legend>
      {DESTINATION_KIND_CAPABILITIES[kind].uses.map((use) => (
        <label key={use} className="flex items-center gap-1 text-sm">
          <input
            type="checkbox"
            id={`${idPrefix}-${use}`}
            checked={draft.uses.includes(use)}
            onChange={(e) => toggle(use, e.target.checked)}
          />
          {USE_LABEL[use]}
        </label>
      ))}
    </fieldset>
  );
}

function PolicyFields({
  kind,
  idPrefix,
  draft,
  onChange,
  disabled,
  details,
}: {
  kind: DestinationKind;
  idPrefix: string;
  draft: PolicyDraft;
  onChange: (next: PolicyDraft) => void;
  disabled: boolean;
  details: ErrorDetail[];
}) {
  const issue = (path: string) => details.find((d) => d.path === path)?.issue;
  const retains = draft.uses.includes('retain');
  return (
    <div className="flex flex-wrap items-end gap-3">
      <UseBoxes kind={kind} idPrefix={idPrefix} draft={draft} onChange={onChange} disabled={disabled} />
      <Field
        label="Retention (days)"
        htmlFor={`${idPrefix}-retention`}
        error={issue('retentionDays') ? 'Needed when data is retained' : undefined}
        className="w-36"
      >
        <Input
          id={`${idPrefix}-retention`}
          type="number"
          min={1}
          max={SOURCE_USE_RETENTION_MAX_DAYS}
          value={draft.retentionDays}
          onChange={(e) => onChange({ ...draft, retentionDays: e.target.value })}
          disabled={disabled || !retains}
        />
      </Field>
      <Field
        label="Review due"
        htmlFor={`${idPrefix}-review-due`}
        error={issue('reviewDueAt') ? 'Must be ahead of today' : undefined}
        className="w-44"
      >
        <Input
          id={`${idPrefix}-review-due`}
          type="date"
          value={draft.reviewDue}
          onChange={(e) => onChange({ ...draft, reviewDue: e.target.value })}
          disabled={disabled}
        />
      </Field>
    </div>
  );
}

const toSetInput = (brandId: string, kind: DestinationKind, dataType: string, draft: PolicyDraft) => ({
  brandId,
  destinationKind: kind,
  dataType,
  allowedUses: draft.uses,
  retentionDays: draft.uses.includes('retain') && draft.retentionDays ? Number(draft.retentionDays) : null,
  reviewDueAt: fromDateInput(draft.reviewDue),
});

/** One (kind, data type) policy: its version and review, edited in place and saved as the next version. */
function PolicyRow({ policy, canManage }: { policy: SourceUsePolicyDto; canManage: boolean }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const current = draft ?? draftOf(policy);
  const set = useMutation(
    trpc.destinations.sourceUse.set.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setDraft(null);
        void queryClient.invalidateQueries(trpc.destinations.sourceUse.pathFilter());
      },
      // The policy moved on under this row: the list is refreshed so the next save names the current version.
      onError: (err) => {
        if (toUiError(err).kind === 'conflict')
          void queryClient.invalidateQueries(trpc.destinations.sourceUse.pathFilter());
      },
    }),
  );
  const ui = set.isError ? toUiError(set.error) : null;
  const idPrefix = `policy-${policy.id}`;
  return (
    <li className="flex flex-col gap-2 py-3" data-testid={`source-use-${policy.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p>
          <span className="font-medium">{kindLabel(policy.destinationKind)}</span>{' '}
          <code className="text-xs">{policy.dataType}</code>
        </p>
        <p className="text-xs text-muted-foreground" data-testid="policy-version">
          Version {policy.version} · reviewed {day(policy.reviewedAt)} · due {day(policy.reviewDueAt)}
          {new Date(policy.reviewDueAt).getTime() < Date.now() && (
            <>
              {' '}
              <Badge tone="warning">Review overdue</Badge>
            </>
          )}
        </p>
      </div>
      {canManage ? (
        <form
          className="flex flex-wrap items-end gap-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            set.mutate({
              ...toSetInput(policy.brandId, policy.destinationKind, policy.dataType, current),
              expectedVersion: policy.version,
            });
          }}
        >
          <PolicyFields
            kind={policy.destinationKind}
            idPrefix={idPrefix}
            draft={current}
            onChange={setDraft}
            disabled={set.isPending}
            details={ui?.details ?? []}
          />
          <Button type="submit" size="sm" disabled={set.isPending || draft === null}>
            {set.isPending ? 'Saving…' : 'Save'}
          </Button>
        </form>
      ) : (
        <p className="text-sm">
          {policy.allowedUses.map((u) => USE_LABEL[u]).join(', ') || 'No use allowed'}
          {policy.retentionDays !== null && ` · kept ${policy.retentionDays} days`}
        </p>
      )}
      {ui && ui.kind === 'conflict' && (
        <StatusBanner
          tone="warning"
          title="The policy moved on"
          description="Someone saved another version of this policy; the list shows the current one."
        />
      )}
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Changing the policy needs source_use.manage for this brand.`}
          data-testid="source-use-denied"
        />
      )}
      {ui && ui.kind !== 'conflict' && ui.kind !== 'forbidden' && !ui.details.length && (
        <RequestError error={set.error} title="The policy was not saved" />
      )}
    </li>
  );
}

/** A new (kind, data type) policy, version 1. */
function AddPolicy({ brandId }: { brandId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [kind, setKind] = useState<DestinationKind>('ga4_property');
  const [dataType, setDataType] = useState('');
  const [draft, setDraft] = useState<PolicyDraft>({
    uses: [],
    retentionDays: '',
    reviewDue: defaultReviewDue(),
  });
  const set = useMutation(
    trpc.destinations.sourceUse.set.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setDataType('');
        setDraft({ uses: [], retentionDays: '', reviewDue: defaultReviewDue() });
        void queryClient.invalidateQueries(trpc.destinations.sourceUse.pathFilter());
      },
      // A row for this kind and data type exists already: the list is refreshed so it shows up to edit.
      onError: (err) => {
        if (toUiError(err).kind === 'conflict')
          void queryClient.invalidateQueries(trpc.destinations.sourceUse.pathFilter());
      },
    }),
  );
  const ui = set.isError ? toUiError(set.error) : null;
  const ready = dataType.trim().length > 0 && draft.uses.length > 0 && draft.reviewDue.length > 0;
  return (
    <form
      className="flex flex-col gap-3 border-t border-border pt-4"
      noValidate
      data-testid="source-use-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) set.mutate(toSetInput(brandId, kind, dataType.trim(), draft));
      }}
    >
      <p className="text-sm font-medium">Add a data type</p>
      <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
        <Field label="Destination kind" htmlFor="policy-new-kind">
          <Select
            id="policy-new-kind"
            value={kind}
            onValueChange={(v) => {
              const next = DestinationKind.parse(v);
              setKind(next);
              // Only the uses the new kind offers survive the change.
              setDraft((d) => ({
                ...d,
                uses: d.uses.filter((u) => DESTINATION_KIND_CAPABILITIES[next].uses.includes(u)),
              }));
            }}
            options={kindOptions}
          />
        </Field>
        <Field
          label="Data type"
          htmlFor="policy-new-data-type"
          hint="Namespaced by its source, for example ga4.reports or gbp.reviews."
          error={
            ui?.details.find((d) => d.path === 'dataType') ? 'Lower-case words joined by dots' : undefined
          }
        >
          <Input
            id="policy-new-data-type"
            value={dataType}
            onChange={(e) => setDataType(e.target.value)}
            maxLength={80}
          />
        </Field>
      </div>
      <PolicyFields
        kind={kind}
        idPrefix="policy-new"
        draft={draft}
        onChange={setDraft}
        disabled={set.isPending}
        details={ui?.details ?? []}
      />
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={ui.message}
          data-testid="source-use-denied"
        />
      )}
      {ui && ui.kind === 'conflict' && (
        <StatusBanner
          tone="warning"
          title="Already recorded"
          description="A policy for this kind and data type exists; edit it in its row."
        />
      )}
      {ui && ui.kind !== 'forbidden' && ui.kind !== 'conflict' && !ui.details.length && (
        <RequestError error={set.error} title="The policy was not saved" />
      )}
      <div>
        <Button
          type="submit"
          variant="primary"
          disabled={!ready || set.isPending}
          disabledReason={ready ? undefined : 'Name the data type and tick at least one use'}
        >
          {set.isPending ? 'Saving…' : 'Save policy'}
        </Button>
      </div>
    </form>
  );
}

/**
 * Settings → Destinations (R2-0): the brand's non-social destinations grouped by kind with their health and
 * owner, registration for those who hold destination.connect, and the source-use policy table (D-17) an admin
 * edits: one row per kind and data type, uses limited to what the kind offers, retention only when data is
 * retained, a review date, each save the next version. R2-1: a source connected through the flow (start, the
 * vendor's consent, finish on return, confirm a target), for the kinds enabled on this deployment.
 */
export function DestinationSettings({
  canManage,
  canConnectDestinations,
  canManageDestinations,
}: {
  /** source_use.manage: edits the policy table (owners and admins). */
  canManage: boolean;
  /** destination.connect: registers a destination. */
  canConnectDestinations: boolean;
  /** destination.manage: disconnects one. */
  canManageDestinations: boolean;
}) {
  const { brandId, brand } = useBrandContext();
  const destinations = useDestinations(brandId);
  const policies = useSourceUsePolicies(brandId);
  const [params, setParams] = useSearchParams();
  const callback = callbackParams(params.toString());
  const providerError = callbackError(params.toString());
  // The vendor's answer is read from the query; dismissing it keeps this tab open.
  const clearCallback = () => setParams({ tab: 'destinations' }, { replace: true });
  const listUi = destinations.isError ? toUiError(destinations.error) : null;
  const byKind = KINDS.map((kind) => ({
    kind,
    items: (destinations.data?.items ?? []).filter((d) => d.kind === kind),
  })).filter((g) => g.items.length > 0);
  return (
    <div className="flex flex-col gap-8">
      {callback && canConnectDestinations && (
        <FinishDestinationConnect state={callback.state} code={callback.code} onDone={clearCallback} />
      )}
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
          data-testid="destination-provider-error"
        />
      )}
      <Section id="destinations-heading" title="Destinations" testId="destinations">
        <p className="text-xs text-muted-foreground">
          Where {brand.name} reads performance from and publishes beyond social: analytics, search, its
          Business Profile, its website and announcement webhooks. Credentials are sealed server-side and
          never shown.
        </p>
        {destinations.isPending && <Skeleton label="Loading destinations" lines={3} />}
        {destinations.isError && (
          <RequestError
            error={destinations.error}
            onRetry={() => void destinations.refetch()}
            title={listUi?.kind === 'forbidden' ? 'Permission denied' : undefined}
          />
        )}
        {destinations.isSuccess && byKind.length === 0 && (
          <EmptyState title="No destinations" description="Register one below to read from or write to it." />
        )}
        {byKind.map((group) => (
          <div key={group.kind} className="flex flex-col gap-1" data-testid={`destinations-${group.kind}`}>
            <h3 className="text-sm font-semibold">{kindLabel(group.kind)}</h3>
            <ul className="divide-y divide-border" aria-label={kindLabel(group.kind)}>
              {group.items.map((d) => (
                <DestinationRow key={d.id} destination={d} canManageDestinations={canManageDestinations} />
              ))}
            </ul>
          </div>
        ))}
        {canConnectDestinations && <RegisterDestination brandId={brandId} />}
      </Section>
      {canConnectDestinations && <ConnectSources brandId={brandId} />}
      <Section id="source-use-heading" title="Source-use policy" testId="source-use">
        <p className="text-xs text-muted-foreground">
          What the product may do with each source&apos;s data: read it through a restricted view, keep a copy
          for a bounded time, or write back. A use without a current policy, or past its review date, is
          refused.
          {!canManage && ' Only an owner or admin changes it.'}
        </p>
        {policies.isPending && <Skeleton label="Loading the source-use policy" lines={3} />}
        {policies.isError && <RequestError error={policies.error} onRetry={() => void policies.refetch()} />}
        {policies.isSuccess && policies.data.items.length === 0 && (
          <EmptyState
            title="No policy recorded"
            description="Nothing is read or retained until a policy says so."
          />
        )}
        {policies.isSuccess && policies.data.items.length > 0 && (
          <ul className="divide-y divide-border" aria-label="Source-use policies">
            {policies.data.items.map((p) => (
              <PolicyRow key={p.id} policy={p} canManage={canManage} />
            ))}
          </ul>
        )}
        {canManage && <AddPolicy brandId={brandId} />}
      </Section>
    </div>
  );
}
