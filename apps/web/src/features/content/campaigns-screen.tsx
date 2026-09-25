import { useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Field, Input, Skeleton, StatusBanner, Textarea } from '@oremedia/ui';
import { AddToggle, ColumnHeader, listButton } from '../../components/column-header';
import { RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { useBrandContext } from '../brand/brand-context';
import { localInputToIso } from '../publishing/publication-state';
import { useChannels, type ChannelDto } from '../publishing/use-publishing';
import { BriefDetail } from './brief-detail';
import {
  briefChip,
  briefGaps,
  campaignChip,
  isSuggested,
  missedDate,
  packageWindow,
} from './content-helpers';
import { PackageDetail } from './package-detail';
import { useBriefs, useCampaigns, useRecentPackages } from './use-content';

function CreateCampaignForm({ brandId, onCreated }: { brandId: string; onCreated: (id: string) => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [name, setName] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const create = useMutation(
    trpc.content.campaigns.create.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        setName('');
        void queryClient.invalidateQueries(trpc.content.campaigns.pathFilter());
        onCreated(res.campaignId);
      },
    }),
  );
  const from = localInputToIso(startsAt);
  const to = localInputToIso(endsAt);
  const ready = name.trim() !== '' && from !== null && to !== null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready && from && to) create.mutate({ brandId, name: name.trim(), startsAt: from, endsAt: to });
  };
  const ui = create.isError ? toUiError(create.error) : null;
  const issue = (path: string) => ui?.details.find((d) => d.path === path)?.issue;
  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-2 border-b border-border bg-muted px-4 py-3"
      noValidate
    >
      <Field label="Campaign name" htmlFor="campaign-name">
        <Input id="campaign-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
      </Field>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Starts" htmlFor="campaign-starts">
          <Input
            id="campaign-starts"
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
        </Field>
        <Field label="Ends" htmlFor="campaign-ends" error={issue('endsAt')}>
          <Input
            id="campaign-ends"
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
          />
        </Field>
      </div>
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Planning campaigns needs content.plan.`}
        />
      )}
      {ui && ui.kind !== 'forbidden' && !issue('endsAt') && (
        <RequestError error={create.error} title="The campaign was not created" />
      )}
      <div>
        <Button
          type="submit"
          size="sm"
          disabled={create.isPending || !ready}
          disabledReason={ready ? undefined : 'Give a name, a start and an end'}
        >
          {create.isPending ? 'Creating…' : 'Create campaign'}
        </Button>
      </div>
    </form>
  );
}

function CreateBriefForm({
  brandId,
  campaignId,
  channels,
  onCreated,
}: {
  brandId: string;
  campaignId: string | null;
  channels: readonly ChannelDto[];
  onCreated: (id: string) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [audience, setAudience] = useState('');
  const [message, setMessage] = useState('');
  const [constraints, setConstraints] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const create = useMutation(
    trpc.content.briefs.create.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        setAudience('');
        setMessage('');
        setConstraints('');
        setSelected([]);
        void queryClient.invalidateQueries(trpc.content.briefs.pathFilter());
        onCreated(res.briefId);
      },
    }),
  );
  const toggle = (id: string) =>
    setSelected((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({
      brandId,
      ...(campaignId ? { campaignId } : {}),
      audience: audience.trim(),
      message: message.trim(),
      channelConnectionIds: selected,
      constraints: constraints
        .split('\n')
        .map((c) => c.trim())
        .filter(Boolean),
    });
  };
  const ui = create.isError ? toUiError(create.error) : null;
  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-2 border-b border-border bg-muted px-4 py-3"
      noValidate
    >
      <p className="text-xs text-muted-foreground">
        {campaignId
          ? 'The brief belongs to the selected campaign.'
          : 'No campaign selected: the brief stands alone.'}
      </p>
      <Field label="Audience" htmlFor="brief-audience">
        <Input
          id="brief-audience"
          value={audience}
          onChange={(e) => setAudience(e.target.value)}
          maxLength={1000}
        />
      </Field>
      <Field label="Message" htmlFor="brief-message">
        <Textarea id="brief-message" value={message} onChange={(e) => setMessage(e.target.value)} rows={2} />
      </Field>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium text-muted-foreground">Planned channels</legend>
        {channels.length === 0 && <p className="text-xs text-muted-foreground">No channels connected.</p>}
        {channels.map((c) => (
          <label key={c.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} />
            <span>
              {c.displayName} ({c.providerKey})
            </span>
          </label>
        ))}
      </fieldset>
      <Field label="Constraints" htmlFor="brief-constraints" hint="One per line.">
        <Textarea
          id="brief-constraints"
          value={constraints}
          onChange={(e) => setConstraints(e.target.value)}
          rows={2}
        />
      </Field>
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Briefs need content.plan.`}
        />
      )}
      {ui && ui.kind !== 'forbidden' && (
        <RequestError error={create.error} title="The brief was not created" />
      )}
      <div>
        <Button type="submit" size="sm" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create brief'}
        </Button>
      </div>
    </form>
  );
}

/**
 * Spec 21.1 `campaigns/`: planner from brief to plan to assigned work (spec 13 content packages and revisions,
 * channel variants). Spec 21.2 states: incomplete brief, suggested plan, accepted plan, missed date; plus the
 * revision states and invalid variants. Campaign, brief and package selections live in the URL.
 */
export function CampaignsScreen() {
  const { companyId, brandId, brand } = useBrandContext();
  const [params, setParams] = useSearchParams();
  const campaignId = params.get('campaign');
  const briefId = params.get('brief');
  const packageId = params.get('package');
  const [pkgWindow] = useState(() => packageWindow());
  const campaigns = useCampaigns(brandId);
  const briefs = useBriefs(brandId, campaignId);
  const packages = useRecentPackages(brandId, pkgWindow.from, pkgWindow.to);
  const channels = useChannels(brandId);
  const channelMap = useMemo(
    () => new Map<string, ChannelDto>((channels.data ?? []).map((c) => [c.id, c])),
    [channels.data],
  );
  const update = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    setParams(p, { replace: true });
  };
  const windowText = `between ${new Date(pkgWindow.from).toLocaleDateString()} and ${new Date(pkgWindow.to).toLocaleDateString()}`;
  const forbidden = campaigns.isError && toUiError(campaigns.error).kind === 'forbidden';
  const [creating, setCreating] = useState<'campaign' | 'brief' | null>(null);

  return (
    <main id="main" className="flex min-h-full flex-col lg:flex-row">
      <section
        aria-labelledby="campaigns-title"
        className="flex shrink-0 flex-col border-border lg:w-64 lg:border-r"
        data-testid="campaigns"
      >
        <ColumnHeader
          id="campaigns-title"
          title="Campaigns"
          level={1}
          action={
            !forbidden && (
              <AddToggle
                open={creating === 'campaign'}
                label="New campaign"
                onToggle={() => setCreating(creating === 'campaign' ? null : 'campaign')}
              />
            )
          }
        />
        {creating === 'campaign' && (
          <CreateCampaignForm
            brandId={brandId}
            onCreated={(id) => {
              setCreating(null);
              update({ campaign: id });
            }}
          />
        )}
        {campaigns.isPending && (
          <div className="p-4">
            <Skeleton label="Loading campaigns" lines={3} />
          </div>
        )}
        {campaigns.isError && (
          <div className="p-4">
            <RequestError
              error={campaigns.error}
              onRetry={() => void campaigns.refetch()}
              title={forbidden ? 'Permission denied' : undefined}
            />
          </div>
        )}
        {campaigns.isSuccess && (
          <ul className="flex flex-col divide-y divide-border" aria-label="Campaigns">
            <li>
              <button
                type="button"
                aria-pressed={campaignId === null}
                onClick={() => update({ campaign: null })}
                className={listButton(campaignId === null)}
              >
                <span className="font-medium">All briefs</span>
              </button>
            </li>
            {campaigns.data.items.map((c) => {
              const chip = campaignChip(c.state);
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-pressed={c.id === campaignId}
                    onClick={() => update({ campaign: c.id, brief: null, package: null })}
                    className={listButton(c.id === campaignId)}
                    data-testid={`campaign-${c.id}`}
                  >
                    <span className="font-medium">{c.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {new Date(c.startsAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}{' '}
                      – {new Date(c.endsAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                    </span>
                    <span className="flex flex-wrap items-center gap-1">
                      <Badge tone={chip.tone}>{chip.label}</Badge>
                      {missedDate(c) && <Badge tone="critical">Missed date</Badge>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {campaigns.isSuccess && campaigns.data.items.length === 0 && (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            No campaigns yet. Group briefs in one, or write a standalone brief.
          </p>
        )}
      </section>
      <section
        aria-labelledby="briefs-title"
        className="flex shrink-0 flex-col border-t border-border lg:w-80 lg:border-r lg:border-t-0"
        data-testid="briefs"
      >
        <ColumnHeader
          id="briefs-title"
          title={campaignId ? 'Briefs in this campaign' : 'Briefs'}
          level={2}
          action={
            !forbidden && (
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={creating === 'brief'}
                onClick={() => setCreating(creating === 'brief' ? null : 'brief')}
              >
                {creating === 'brief' ? (
                  'Close'
                ) : (
                  <>
                    <span aria-hidden="true">+</span> Brief<span className="sr-only"> (new brief)</span>
                  </>
                )}
              </Button>
            )
          }
        />
        {creating === 'brief' && (
          <CreateBriefForm
            brandId={brandId}
            campaignId={campaignId}
            channels={channels.data ?? []}
            onCreated={(id) => {
              setCreating(null);
              update({ brief: id, package: null });
            }}
          />
        )}
        {briefs.isPending && (
          <div className="p-4">
            <Skeleton label="Loading briefs" lines={3} />
          </div>
        )}
        {briefs.isError && (
          <div className="p-4">
            <RequestError error={briefs.error} onRetry={() => void briefs.refetch()} />
          </div>
        )}
        {briefs.isSuccess && briefs.data.items.length === 0 && (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            No briefs yet. Write one, or accept a recommendation that creates one.
          </p>
        )}
        {briefs.isSuccess && briefs.data.items.length > 0 && (
          <ul className="flex flex-col divide-y divide-border" aria-label="Briefs">
            {briefs.data.items.map((b) => {
              const chip = briefChip(b.state);
              return (
                <li key={b.id}>
                  <button
                    type="button"
                    aria-pressed={b.id === briefId}
                    onClick={() => update({ brief: b.id, package: null })}
                    className={listButton(b.id === briefId)}
                    data-testid={`brief-${b.id}`}
                  >
                    <span className="font-medium">{b.message || b.audience || b.id}</span>
                    <span className="flex flex-wrap items-center gap-1">
                      <Badge tone={chip.tone}>{chip.label}</Badge>
                      {isSuggested(b) && (
                        <Badge tone="info" glyph={false}>
                          Suggested plan
                        </Badge>
                      )}
                      {briefGaps(b).length > 0 && <Badge tone="warning">Incomplete</Badge>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <div className="flex min-w-0 flex-1 flex-col gap-6 border-t border-border px-4 py-6 sm:px-8 lg:border-t-0">
        {channels.isError && (
          <RequestError
            error={channels.error}
            onRetry={() => void channels.refetch()}
            title="Channels could not be loaded"
          />
        )}
        {briefId ? (
          <BriefDetail
            key={briefId}
            brandId={brandId}
            briefId={briefId}
            channels={channelMap}
            packages={packages.data?.packages}
            packagesWindow={windowText}
            selectedPackageId={packageId}
            onSelectPackage={(id) => update({ package: id })}
          />
        ) : (
          <div data-testid="brief-detail">
            <EmptyState
              title="No brief selected"
              description={`Choose a brief to accept it, see its packages and produce variants. ${brand.name}’s revisions are never edited: revising creates the next one.`}
            />
          </div>
        )}
        {packages.isError && (
          <RequestError
            error={packages.error}
            onRetry={() => void packages.refetch()}
            title="Packages could not be loaded"
          />
        )}
        {packageId && (
          <PackageDetail
            key={packageId}
            companyId={companyId}
            brandId={brandId}
            contentPackageId={packageId}
            channels={channelMap}
          />
        )}
      </div>
    </main>
  );
}
