import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Field, Input, Skeleton, StatusBanner } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { ContentWriteError } from './campaign-actions';
import { Select } from '../../components/select';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import type { ChannelDto } from '../publishing/use-publishing';
import { planItemChip } from './content-helpers';
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

/** One planned post: editable until the brief is accepted, then the package it became. */
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
  const chip = planItemChip(item.state);
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
  return (
    <li
      className={`flex flex-col gap-2 rounded-md border border-border p-2 text-sm ${item.state === 'dropped' ? 'opacity-70' : ''}`}
      data-testid={`plan-item-${item.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={chip.tone}>{chip.label}</Badge>
        <span className="text-xs text-muted-foreground">
          {item.channelKey}
          {channel
            ? ` → ${channel.displayName}`
            : item.state === 'proposed'
              ? ' · no connection assigned'
              : ''}
          {item.factIds.length > 0 && ` · ${item.factIds.length} fact${item.factIds.length === 1 ? '' : 's'}`}
          {item.createdByKind === 'agent' && ' · proposed by an agent run'}
        </span>
      </div>
      {editable ? (
        <form onSubmit={save} className="grid gap-2 sm:grid-cols-[8rem_1fr_7rem]" noValidate>
          <Field label="Date" htmlFor={`plan-date-${item.id}`}>
            <Input
              id={`plan-date-${item.id}`}
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </Field>
          <Field label="Theme" htmlFor={`plan-theme-${item.id}`}>
            <Input
              id={`plan-theme-${item.id}`}
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              maxLength={300}
              required
            />
          </Field>
          <Field label="Format" htmlFor={`plan-format-${item.id}`}>
            <Input
              id={`plan-format-${item.id}`}
              value={formatKey}
              onChange={(e) => setFormatKey(e.target.value)}
              maxLength={60}
              required
            />
          </Field>
          <Field label="Channel" htmlFor={`plan-channel-${item.id}`} className="sm:col-span-2">
            <Select
              id={`plan-channel-${item.id}`}
              value={channelId}
              onValueChange={setChannelId}
              options={channelOptions(brief, channels)}
              size="sm"
            />
          </Field>
          <div className="flex flex-wrap items-end gap-2">
            <Button type="submit" size="sm" variant="primary" disabled={busy || !dirty || !theme.trim()}>
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
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            <span className="font-medium">{item.date}</span> · {item.theme} · {item.formatKey}
          </span>
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
      )}
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
    <form onSubmit={submit} className="grid gap-2 sm:grid-cols-[8rem_1fr_7rem_auto]" noValidate>
      <Field label="Channel" htmlFor="plan-new-channel" className="sm:col-span-4">
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
        />
      </Field>
      <div className="flex items-end">
        <Button type="submit" size="sm" disabled={propose.isPending || !date || !theme.trim()}>
          {propose.isPending ? 'Adding…' : 'Add item'}
        </Button>
      </div>
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Planning needs content.plan for this brand.`}
          className="sm:col-span-4"
        />
      )}
      {ui && ui.kind !== 'forbidden' && (
        <div className="sm:col-span-4">
          <ContentWriteError error={propose.error} title="The plan item was not added" />
        </div>
      )}
    </form>
  );
}

/**
 * UX-09: the plan behind a brief. Items a run proposed (or a person added) are edited and dropped while the brief
 * is a draft; accepting the brief turns every proposed item into a draft package, shown here as "Open package".
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
    <section aria-labelledby="brief-plan" className="flex flex-col gap-2" data-testid="plan-grid">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="brief-plan" className="text-sm font-semibold">
          Plan
        </h3>
        {draft && (
          <Button size="sm" variant="ghost" onClick={onPlanWithAgent}>
            Plan with agent
          </Button>
        )}
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
        <EmptyState
          title="No plan yet"
          description={
            draft
              ? 'Plan with an agent (campaign planning) or add items by hand; accepting the brief turns them into draft packages.'
              : 'This brief was accepted without a plan.'
          }
        />
      )}
      {items.isSuccess && items.data.items.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Plan items">
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
      {draft && <AddPlanItemForm brief={brief} channels={channels} />}
    </section>
  );
}
