import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, Input, Skeleton, StatusBanner } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { ContentWriteError } from './campaign-actions';
import { Select } from '../../components/select';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import type { ChannelDto } from '../publishing/use-publishing';
import { isSuggested, planItemChip } from './content-helpers';
import { usePlanItems, type BriefDto, type PlanItemDto } from './use-content';

const NO_CHANNEL = 'none';

function channelOptions(brief: BriefDto, channels: ReadonlyMap<string, ChannelDto>) {
  return [
    { value: NO_CHANNEL, label: 'Unassigned' },
    ...brief.channelConnectionIds.map((id) => {
      const c = channels.get(id);
      return { value: id, label: c ? `${c.displayName} (${c.providerKey})` : id };
    }),
  ];
}

/**
 * The interface's plan row: date · channel · item · format, one line once the brief column is wide enough (a
 * container query: the column is 300 px at tablet width beside the two lists), stacked below.
 */
const ROW_GRID = 'grid gap-x-3 gap-y-1 @md:grid-cols-[110px_90px_minmax(0,1fr)_auto]';

/** What the row says under its line: the item's state, where it goes, what it cites and who proposed it. */
function itemMeta(item: PlanItemDto, channel: ChannelDto | null | undefined): string {
  const chip = planItemChip(item.state);
  const where = channel
    ? `${item.channelKey} → ${channel.displayName}`
    : item.state === 'proposed'
      ? `${item.channelKey} · no connection assigned`
      : item.channelKey;
  const facts =
    item.factIds.length > 0 ? ` · ${item.factIds.length} fact${item.factIds.length === 1 ? '' : 's'}` : '';
  const by = item.createdByKind === 'agent' ? ' · proposed by an agent run' : '';
  return `${chip.label} · ${where}${facts}${by}`;
}

/**
 * One planned post, as the interface's plan table lays it out. A proposed item (the brief still a draft) is edited
 * in place: its cells are the fields, saved and dropped from the line under them; once the brief is accepted the
 * row is read-only and names the package it became.
 */
function PlanRow({
  item,
  brief,
  channels,
  onSelectPackage,
}: {
  item: PlanItemDto;
  brief: BriefDto;
  channels: ReadonlyMap<string, ChannelDto>;
  onSelectPackage: (contentPackageId: string) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [date, setDate] = useState(item.date);
  const [theme, setTheme] = useState(item.theme);
  const [formatKey, setFormatKey] = useState(item.formatKey);
  const [channelId, setChannelId] = useState(item.channelConnectionId ?? NO_CHANNEL);
  const refresh = () => {
    intent.renew();
    void queryClient.invalidateQueries(trpc.content.pathFilter());
  };
  const update = useMutation(
    trpc.content.planItems.update.mutationOptions({ ...mutationIntent(intent.key), onSuccess: refresh }),
  );
  const drop = useMutation(
    trpc.content.planItems.drop.mutationOptions({ ...mutationIntent(intent.key), onSuccess: refresh }),
  );
  const restore = useMutation(
    trpc.content.planItems.restore.mutationOptions({ ...mutationIntent(intent.key), onSuccess: refresh }),
  );
  const editable = item.state === 'proposed';
  const dirty =
    date !== item.date ||
    theme !== item.theme ||
    formatKey !== item.formatKey ||
    channelId !== (item.channelConnectionId ?? NO_CHANNEL);
  const busy = update.isPending || drop.isPending || restore.isPending;
  const error = update.error ?? drop.error ?? restore.error;
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || !theme.trim()) return;
    update.mutate({
      planItemId: item.id,
      expectedVersion: item.version,
      date,
      theme: theme.trim(),
      formatKey: formatKey.trim(),
      channelConnectionId: channelId === NO_CHANNEL ? null : channelId,
    });
  };
  const channel = item.channelConnectionId ? channels.get(item.channelConnectionId) : null;
  const packageId = item.contentPackageId;
  const formId = `plan-edit-${item.id}`;
  return (
    <li
      className={`flex flex-col gap-1.5 border-t border-border py-2.5 text-sm ${item.state === 'dropped' ? 'opacity-70' : ''}`}
      data-testid={`plan-item-${item.id}`}
    >
      {editable ? (
        <form
          id={formId}
          onSubmit={save}
          className="grid gap-2 @md:grid-cols-[8.5rem_minmax(0,1fr)_6rem] @2xl:grid-cols-[8.5rem_9rem_minmax(0,1fr)_6rem]"
          noValidate
        >
          <Input
            type="date"
            aria-label="Date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
            className="text-xs"
          />
          <Select
            aria-label="Channel"
            value={channelId}
            onValueChange={setChannelId}
            options={channelOptions(brief, channels)}
            size="sm"
            className="@md:col-span-2 @2xl:col-span-1"
          />
          <Input
            aria-label="Theme"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            maxLength={300}
            required
            className="@md:col-span-2 @2xl:col-span-1"
          />
          <Input
            aria-label="Format"
            value={formatKey}
            onChange={(e) => setFormatKey(e.target.value)}
            maxLength={60}
            required
            className="text-xs"
          />
        </form>
      ) : (
        <div className={ROW_GRID}>
          <span className="text-xs tabular-nums text-muted-foreground">{item.date}</span>
          <span className="text-muted-foreground">{channel ? channel.displayName : item.channelKey}</span>
          <span>{item.theme}</span>
          <span className="text-xs tabular-nums text-muted-foreground @md:text-right">{item.formatKey}</span>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{itemMeta(item, channel)}</span>
        {editable && (
          <span className="flex items-center gap-1">
            <Button
              type="submit"
              form={formId}
              size="sm"
              variant="primary"
              disabled={busy || !dirty || !theme.trim()}
            >
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => drop.mutate({ planItemId: item.id, expectedVersion: item.version })}
            >
              Drop
            </Button>
          </span>
        )}
        {item.state === 'dropped' && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => restore.mutate({ planItemId: item.id, expectedVersion: item.version })}
          >
            Restore
          </Button>
        )}
        {item.state === 'materialised' && packageId !== null && (
          <Button size="sm" variant="ghost" onClick={() => onSelectPackage(packageId)}>
            Open package
          </Button>
        )}
      </div>
      {error && <ContentWriteError error={error} title="The plan item was not changed" />}
    </li>
  );
}

function AddPlanItemForm({
  brief,
  channels,
}: {
  brief: BriefDto;
  channels: ReadonlyMap<string, ChannelDto>;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [date, setDate] = useState('');
  const [theme, setTheme] = useState('');
  const [formatKey, setFormatKey] = useState('post');
  const [channelId, setChannelId] = useState(brief.channelConnectionIds[0] ?? NO_CHANNEL);
  const propose = useMutation(
    trpc.content.planItems.propose.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setDate('');
        setTheme('');
        void queryClient.invalidateQueries(trpc.content.pathFilter());
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!date || !theme.trim()) return;
    // The channel key is the provider the planner would name; the connection binds the item to it.
    const channel = channelId === NO_CHANNEL ? null : channels.get(channelId);
    propose.mutate({
      briefId: brief.id,
      items: [
        {
          date,
          channelKey: channel?.providerKey ?? (channelId === NO_CHANNEL ? 'unassigned' : channelId),
          ...(channelId === NO_CHANNEL ? {} : { channelConnectionId: channelId }),
          theme: theme.trim(),
          formatKey: formatKey.trim() || 'post',
        },
      ],
    });
  };
  const ui = propose.isError ? toUiError(propose.error) : null;
  return (
    <form
      onSubmit={submit}
      className="grid gap-2 border-t border-border pt-3 @lg:grid-cols-[8.5rem_minmax(0,1fr)_6rem_auto]"
      noValidate
    >
      <Field label="Channel" htmlFor="plan-new-channel" className="@lg:col-span-4">
        <Select
          id="plan-new-channel"
          value={channelId}
          onValueChange={setChannelId}
          options={channelOptions(brief, channels)}
          size="sm"
        />
      </Field>
      <Field label="Date" htmlFor="plan-new-date">
        <Input
          id="plan-new-date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          required
          className="text-xs"
        />
      </Field>
      <Field label="Theme" htmlFor="plan-new-theme">
        <Input
          id="plan-new-theme"
          value={theme}
          onChange={(e) => setTheme(e.target.value)}
          maxLength={300}
          required
        />
      </Field>
      <Field label="Format" htmlFor="plan-new-format">
        <Input
          id="plan-new-format"
          value={formatKey}
          onChange={(e) => setFormatKey(e.target.value)}
          maxLength={60}
          className="text-xs"
        />
      </Field>
      <div className="flex items-end">
        <Button type="submit" disabled={propose.isPending || !date || !theme.trim()}>
          {propose.isPending ? 'Adding…' : 'Add item'}
        </Button>
      </div>
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Planning needs content.plan for this brand.`}
          className="@lg:col-span-4"
        />
      )}
      {ui && ui.kind !== 'forbidden' && (
        <div className="@lg:col-span-4">
          <ContentWriteError error={propose.error} title="The plan item was not added" />
        </div>
      )}
    </form>
  );
}

/**
 * UX-09: the plan behind a brief, as the interface's PLAN table (date, channel, item, format, divided by rules).
 * Items a run proposed (or a person added) are edited and dropped while the brief is a draft; accepting the brief
 * turns every proposed item into a draft package, shown here as "Open package".
 */
export function PlanGrid({
  brief,
  channels,
  onSelectPackage,
  onPlanWithAgent,
}: {
  brief: BriefDto;
  channels: ReadonlyMap<string, ChannelDto>;
  onSelectPackage: (contentPackageId: string) => void;
  onPlanWithAgent: () => void;
}) {
  const items = usePlanItems(brief.id);
  const draft = brief.state === 'draft';
  return (
    <section aria-labelledby="brief-plan" className="flex flex-col" data-testid="plan-grid">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 id="brief-plan" className="om-label">
          Plan
        </h3>
        <div className="flex items-center gap-3">
          {isSuggested(brief) && (
            <span className="text-xs text-accent-ink">Suggested by an agent · not accepted</span>
          )}
          {draft && (
            <Button size="sm" variant="ghost" onClick={onPlanWithAgent}>
              Plan with agent
            </Button>
          )}
        </div>
      </div>
      {items.isPending && <Skeleton label="Loading the plan" lines={2} />}
      {items.isError && (
        <RequestError
          error={items.error}
          onRetry={() => void items.refetch()}
          title="The plan could not be loaded"
        />
      )}
      {items.isSuccess && items.data.items.length === 0 && (
        <p className="border-t border-border py-2.5 text-sm text-muted-foreground" role="status">
          No plan yet.{' '}
          {draft
            ? 'Plan with an agent (campaign planning) or add items below; accepting the brief turns them into draft packages.'
            : 'This brief was accepted without a plan.'}
        </p>
      )}
      {items.isSuccess && items.data.items.length > 0 && (
        <ul className="flex flex-col" aria-label="Plan items">
          {items.data.items.map((item) => (
            <PlanRow
              key={`${item.id}:${item.version}`}
              item={item}
              brief={brief}
              channels={channels}
              onSelectPackage={onSelectPackage}
            />
          ))}
        </ul>
      )}
      {draft && (
        <div className="mt-2">
          <AddPlanItemForm brief={brief} channels={channels} />
        </div>
      )}
    </section>
  );
}
