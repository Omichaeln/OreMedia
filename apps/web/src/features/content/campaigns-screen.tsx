import { useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, Input, Skeleton, StatusBanner, StatusDot, Textarea, toneGlyph } from '@oremedia/ui';
import { AddToggle, ColumnHeader, listButton } from '../../components/column-header';
import { LoadMore } from '../../components/load-more';
import { RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { useBrandContext } from '../brand/brand-context';
import { useDestinationMap } from '../destinations/use-destinations';
import { localInputToIso } from '../publishing/publication-state';
import { useChannels, type ChannelDto } from '../publishing/use-publishing';
import { BriefDetail } from './brief-detail';
import { CampaignSummary, ContentWriteError } from './campaign-actions';
import { briefRowState, campaignChip, campaignIsClosed, missedDate } from './content-helpers';
import { PackageDetail } from './package-detail';
import { useBriefs, useCampaigns, usePackages } from './use-content';

/** A column's create form, as the interface lays its forms out: a bold title, stacked fields, the actions last. */
const FORM_CLASS = 'om-in flex flex-col gap-3 border-b border-border px-4 py-4';

const dayMonth = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

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
    <form onSubmit={submit} className={FORM_CLASS} noValidate>
      <p className="text-lg font-bold">New campaign</p>
      <Field label="Campaign name" htmlFor="campaign-name">
        <Input id="campaign-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
      </Field>
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
          variant="primary"
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
  campaignName,
  campaignClosed,
  channels,
  onCreated,
}: {
  brandId: string;
  campaignId: string | null;
  campaignName: string | null;
  campaignClosed: boolean;
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
    <form onSubmit={submit} className={FORM_CLASS} noValidate>
      <p className="text-lg font-bold">{campaignName ? `New brief in ${campaignName}` : 'New brief'}</p>
      <p className="text-xs text-muted-foreground">
        {campaignClosed
          ? 'The selected campaign is closed: it takes no new briefs.'
          : campaignId
            ? 'The brief belongs to the selected campaign.'
            : 'No campaign selected: the brief stands alone.'}
      </p>
      <Field label="Message" htmlFor="brief-message">
        <Textarea
          id="brief-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
          placeholder="What should this content say?"
        />
      </Field>
      <Field label="Audience" htmlFor="brief-audience">
        <Input
          id="brief-audience"
          value={audience}
          onChange={(e) => setAudience(e.target.value)}
          maxLength={1000}
        />
      </Field>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-xs text-muted-foreground">Planned channels</legend>
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
      <Field label="Constraints · one per line" htmlFor="brief-constraints">
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
        <ContentWriteError error={create.error} title="The brief was not created" />
      )}
      <div>
        <Button type="submit" variant="primary" disabled={create.isPending}>
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
 *
 * Laid out as the supplied interface sets it: three columns (campaigns, briefs on the tinted ground, the brief)
 * that each scroll on their own from 768 px and stack below it (D-31); a campaign row carries name, dates and
 * state, a brief row the message and one state line, and the brief opens as a document on the right.
 */
export function CampaignsScreen() {
  const { companyId, brandId, brand } = useBrandContext();
  const [params, setParams] = useSearchParams();
  const campaignId = params.get('campaign');
  const briefId = params.get('brief');
  const packageId = params.get('package');
  const campaigns = useCampaigns(brandId);
  const briefs = useBriefs(brandId, campaignId);
  const packages = usePackages(brandId);
  const channels = useChannels(brandId);
  const channelMap = useMemo(
    () => new Map<string, ChannelDto>((channels.data ?? []).map((c) => [c.id, c])),
    [channels.data],
  );
  const destinationMap = useDestinationMap(brandId);
  const update = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    setParams(p, { replace: true });
  };
  const forbidden = campaigns.isError && toUiError(campaigns.error).kind === 'forbidden';
  const [creating, setCreating] = useState<'campaign' | 'brief' | null>(null);
  const selectedCampaign = campaignId ? campaigns.items.find((c) => c.id === campaignId) : undefined;

  return (
    <main
      id="main"
      className="om-in grid min-h-full md:h-full md:grid-cols-[minmax(170px,210px)_minmax(190px,250px)_minmax(0,1fr)] xl:grid-cols-[240px_290px_minmax(0,1fr)]"
    >
      <section
        aria-labelledby="campaigns-title"
        className="flex min-h-0 flex-col border-border md:overflow-y-auto md:border-r"
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
          <ul className="flex flex-col divide-y divide-border border-y border-border" aria-label="Campaigns">
            <li>
              <button
                type="button"
                aria-pressed={campaignId === null}
                onClick={() => update({ campaign: null })}
                className={listButton(campaignId === null)}
              >
                <span className="text-base font-bold">All briefs</span>
                <span className="text-xs text-muted-foreground">Every brief of the brand</span>
              </button>
            </li>
            {campaigns.items.map((c) => {
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
                    <span className="text-base font-bold">{c.name}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {dayMonth(c.startsAt)} – {dayMonth(c.endsAt)} · {chip.label}
                    </span>
                    {missedDate(c) && (
                      <span className="text-xs text-status-critical">
                        <span className="sr-only">{toneGlyph.critical} </span>Missed date
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {campaigns.isSuccess && campaigns.items.length === 0 && (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            No campaigns yet. Group briefs in one, or write a standalone brief.
          </p>
        )}
        <LoadMore
          shown={campaigns.items.length}
          hasNextPage={campaigns.hasNextPage}
          isFetchingNextPage={campaigns.isFetchingNextPage}
          onLoadMore={() => void campaigns.fetchNextPage()}
          noun="campaigns"
        />
      </section>
      <section
        aria-labelledby="briefs-title"
        className="flex min-h-0 flex-col border-t border-border bg-card-tint md:overflow-y-auto md:border-r md:border-t-0"
        data-testid="briefs"
      >
        <ColumnHeader
          id="briefs-title"
          title="Briefs"
          level={2}
          action={
            !forbidden && (
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={creating === 'brief'}
                onClick={() => setCreating(creating === 'brief' ? null : 'brief')}
                className="text-xs font-normal text-muted-foreground hover:text-foreground"
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
        {selectedCampaign && <CampaignSummary campaign={selectedCampaign} canPlan={!forbidden} />}
        {creating === 'brief' && (
          <CreateBriefForm
            brandId={brandId}
            campaignId={campaignId}
            campaignName={selectedCampaign?.name ?? null}
            campaignClosed={selectedCampaign ? campaignIsClosed(selectedCampaign.state) : false}
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
        {briefs.isSuccess && briefs.items.length === 0 && (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            No briefs yet. Write one, or accept a recommendation that creates one.
          </p>
        )}
        {briefs.isSuccess && briefs.items.length > 0 && (
          <ul className="flex flex-col divide-y divide-border border-y border-border" aria-label="Briefs">
            {briefs.items.map((b) => {
              const row = briefRowState(b);
              return (
                <li key={b.id}>
                  <button
                    type="button"
                    aria-pressed={b.id === briefId}
                    onClick={() => update({ brief: b.id, package: null })}
                    className={`${listButton(b.id === briefId, 'card')} gap-1.5`}
                    data-testid={`brief-${b.id}`}
                  >
                    <span className="text-base leading-[1.35] text-pretty">
                      {b.message || b.audience || b.id}
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <StatusDot tone={row.tone} size="sm" />
                      <span className="sr-only">{toneGlyph[row.tone]} </span>
                      {row.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <LoadMore
          shown={briefs.items.length}
          hasNextPage={briefs.hasNextPage}
          isFetchingNextPage={briefs.isFetchingNextPage}
          onLoadMore={() => void briefs.fetchNextPage()}
          noun="briefs"
        />
      </section>
      <div className="@container min-w-0 border-t border-border md:overflow-y-auto md:border-t-0">
        <div className="flex max-w-[680px] flex-col gap-7 px-4 pb-10 pt-6 sm:px-7 sm:pb-16 sm:pt-8">
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
              companyId={companyId}
              brandId={brandId}
              briefId={briefId}
              channels={channelMap}
              destinations={destinationMap}
              packages={packages}
              selectedPackageId={packageId}
              onSelectPackage={(id) => update({ package: id })}
              brandName={brand.name}
              timeZone={brand.timezone || 'UTC'}
              agentRunHref={(runId) =>
                `/c/${encodeURIComponent(companyId)}/b/${encodeURIComponent(brandId)}/agents?run=${encodeURIComponent(runId)}`
              }
            />
          ) : (
            <div className="flex flex-col gap-2" data-testid="brief-detail" role="status">
              <p className="text-xs uppercase text-muted-foreground">Brief</p>
              <h2 className="text-xl font-bold leading-tight tracking-[-0.01em]">No brief selected</h2>
              <p className="text-sm text-pretty text-muted-foreground">
                Choose a brief to accept it, see its packages and produce variants. {brand.name}’s revisions
                are never edited: revising creates the next one.
              </p>
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
              destinations={destinationMap}
              timeZone={brand.timezone || 'UTC'}
            />
          )}
        </div>
      </div>
    </main>
  );
}
