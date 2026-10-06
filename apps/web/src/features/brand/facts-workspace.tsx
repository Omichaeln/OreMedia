import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FactCategory, type FactOrigin, type FactSource, type FactState } from '@oremedia/contracts/brand';
import { Badge, Button, EmptyState, Input, Skeleton, StatusBanner, type Tone } from '@oremedia/ui';
import { LoadMore } from '../../components/load-more';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { type UiError } from '../../lib/errors';
import { useTRPC } from '../../lib/trpc';
import { useSessionUser } from '../session/use-session-user';
import { useBrandContext } from './brand-context';
import {
  ApproveDialog,
  CATEGORY_LABEL,
  ConflictDialog,
  DAY_MS,
  EXPIRING_SOON_DAYS,
  FactFormDialog,
  MergeDialog,
  ReviewedDialog,
  STATE_LABEL,
  STATE_TONE,
  WithdrawDialog,
  dateText,
} from './facts-dialogs';
import { useCanSaveBrandSystem, useFactPages, type FactDto, type FactFilter } from './use-brand';

/**
 * BSC-3 facts workspace: what copy may state, grouped by category, with where each fact came from, who reviewed it
 * and when, how long it holds, and what disagrees with it. A person adds facts (with URL, asset or note sources),
 * edits proposals, approves (a reviewer note is required for an AI suggestion or inference without a source),
 * corrects approved facts (the correction supersedes the fact once approved), merges duplicates, resolves
 * conflicts, marks facts reviewed and withdraws them with a reason. Agents only propose; nothing here asks for ids.
 */

const ORIGIN_TONE: Record<FactOrigin, Tone> = {
  user: 'neutral',
  extracted: 'info',
  inferred: 'warning',
  suggested: 'warning',
};

/** Quick views over the list (one at a time), beside the state, category and origin filters and the search. */
const VIEWS = [
  { value: 'all', label: 'All facts' },
  { value: 'effective', label: 'In effect now' },
  { value: 'reviewDue', label: 'Due for review' },
  { value: 'expiring', label: 'Expiring within 30 days' },
  { value: 'conflicts', label: 'With open conflicts' },
  { value: 'duplicates', label: 'Possible duplicates' },
] as const;
type View = (typeof VIEWS)[number]['value'];

const VIEW_FILTER: Record<View, FactFilter> = {
  all: {},
  effective: { effective: true },
  reviewDue: { reviewDue: true },
  expiring: { expiringWithinDays: 30 },
  conflicts: { hasConflicts: true },
  duplicates: { possibleDuplicates: true },
};

const isLive = (f: FactDto) => f.state === 'proposed' || f.state === 'approved';

function originLabel(f: FactDto, me: string | null): string {
  switch (f.origin) {
    case 'user':
      return f.proposedByKind === 'user' && f.proposedById === me
        ? 'Entered by you'
        : f.proposedByName
          ? `Entered by ${f.proposedByName}`
          : 'Entered by a person';
    case 'extracted':
      return 'Extracted from source';
    case 'inferred':
      return 'Inferred';
    case 'suggested':
      return 'AI suggestion';
  }
}

export function FactsWorkspace() {
  const { companyId, brandId } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const canDecide = useCanSaveBrandSystem(companyId);
  const me = useSessionUser(true).data?.userId ?? null;
  const [view, setView] = useState<View>('all');
  const [state, setState] = useState<FactState | 'all'>('all');
  const [category, setCategory] = useState<FactCategory | 'all'>('all');
  const [origin, setOrigin] = useState<FactOrigin | 'all'>('all');
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchText.trim()), 300);
    return () => clearTimeout(t);
  }, [searchText]);
  const filter: FactFilter = {
    ...VIEW_FILTER[view],
    ...(state !== 'all' ? { state } : {}),
    ...(category !== 'all' ? { category } : {}),
    ...(origin !== 'all' ? { origin } : {}),
    ...(search ? { search } : {}),
  };
  const facts = useFactPages(brandId, filter);
  const [conflict, setConflict] = useState<UiError | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: 'add' }
    | { kind: 'edit' | 'correct' | 'approve' | 'withdraw' | 'review'; fact: FactDto }
    | { kind: 'conflict'; fact: FactDto; conflictId: string }
    | { kind: 'merge'; factIds: string[] }
    | null
  >(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = useState('');
  const close = () => setDialog(null);
  const reload = () => {
    setConflict(null);
    void queryClient.invalidateQueries(trpc.brand.facts.pathFilter());
  };
  const onDone = (message: string) => {
    setStatus(message);
    close();
  };
  const filtersOn =
    view !== 'all' || state !== 'all' || category !== 'all' || origin !== 'all' || search !== '';
  const groups = useMemo(() => {
    const byCategory = new Map<FactCategory, FactDto[]>();
    for (const f of facts.items) byCategory.set(f.category, [...(byCategory.get(f.category) ?? []), f]);
    return FactCategory.options.flatMap((c) => {
      const items = byCategory.get(c);
      return items ? [{ category: c, items }] : [];
    });
  }, [facts.items]);
  const selectedFacts = facts.items.filter((f) => selected.has(f.id) && isLive(f));
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section aria-label="Facts" className="flex flex-col" data-testid="facts-workspace">
      <div className="mb-4 flex flex-col gap-2" role="search" aria-label="Filter facts">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Input
            type="search"
            aria-label="Search facts"
            placeholder="Search statements"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="h-8 max-w-xs"
            maxLength={200}
          />
          <div className="flex flex-wrap gap-2">
            {canDecide && (
              <Button
                size="sm"
                disabled={selectedFacts.length < 2}
                onClick={() => setDialog({ kind: 'merge', factIds: selectedFacts.map((f) => f.id) })}
              >
                Merge selected{selectedFacts.length > 0 ? ` (${selectedFacts.length})` : ''}
              </Button>
            )}
            <Button size="sm" variant="primary" onClick={() => setDialog({ kind: 'add' })}>
              Add a fact
            </Button>
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Select
            size="sm"
            aria-label="Show"
            value={view}
            onValueChange={(v) => setView(v as View)}
            options={[...VIEWS]}
          />
          <Select
            size="sm"
            aria-label="State"
            value={state}
            onValueChange={(v) => setState(v as FactState | 'all')}
            options={[
              { value: 'all', label: 'Any state' },
              ...(['proposed', 'approved', 'superseded', 'revoked'] as const).map((s) => ({
                value: s,
                label: STATE_LABEL[s],
              })),
            ]}
          />
          <Select
            size="sm"
            aria-label="Category"
            value={category}
            onValueChange={(v) => setCategory(v as FactCategory | 'all')}
            options={[
              { value: 'all', label: 'Any category' },
              ...FactCategory.options.map((c) => ({ value: c, label: CATEGORY_LABEL[c] })),
            ]}
          />
          <Select
            size="sm"
            aria-label="Origin"
            value={origin}
            onValueChange={(v) => setOrigin(v as FactOrigin | 'all')}
            options={[
              { value: 'all', label: 'Any origin' },
              { value: 'user', label: 'Entered by a person' },
              { value: 'extracted', label: 'Extracted from source' },
              { value: 'inferred', label: 'Inferred' },
              { value: 'suggested', label: 'AI suggestion' },
            ]}
          />
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      {conflict && (
        <StatusBanner
          tone="warning"
          title="Conflict: this fact changed since you loaded it"
          description={conflict.message}
          actions={
            <Button size="sm" onClick={reload}>
              Reload
            </Button>
          }
          className="mb-3"
        />
      )}
      {facts.isPending && <Skeleton label="Loading facts" lines={4} />}
      {facts.isError && <RequestError error={facts.error} onRetry={() => void facts.refetch()} />}
      {facts.isSuccess && facts.items.length === 0 && (
        <EmptyState
          title={filtersOn ? 'No facts match' : 'No facts yet'}
          description={
            filtersOn
              ? 'Change the filters or the search to see more.'
              : 'Facts are what copy may state: offers, prices, claims, contact details. Add one with its source; a brand manager approves it.'
          }
          action={
            filtersOn ? (
              <Button
                size="sm"
                onClick={() => {
                  setView('all');
                  setState('all');
                  setCategory('all');
                  setOrigin('all');
                  setSearchText('');
                  setSearch('');
                }}
              >
                Clear filters
              </Button>
            ) : (
              <Button size="sm" variant="primary" onClick={() => setDialog({ kind: 'add' })}>
                Add a fact
              </Button>
            )
          }
        />
      )}
      {groups.map((g) => (
        <section key={g.category} aria-labelledby={`facts-${g.category}`} className="mb-6">
          <h3 id={`facts-${g.category}`} className="om-label mb-1">
            {CATEGORY_LABEL[g.category]} <span className="tabular-nums">({g.items.length})</span>
          </h3>
          <ul className="flex flex-col">
            {g.items.map((f) => (
              <FactCard
                key={f.id}
                fact={f}
                me={me}
                canDecide={canDecide}
                selected={selected.has(f.id)}
                onToggle={() => toggle(f.id)}
                onAction={(kind) => setDialog({ kind, fact: f })}
                onResolve={(conflictId) => setDialog({ kind: 'conflict', fact: f, conflictId })}
                onMergeWith={(other) => setDialog({ kind: 'merge', factIds: [f.id, other] })}
              />
            ))}
          </ul>
        </section>
      ))}
      {facts.isSuccess && facts.items.length > 0 && (
        <LoadMore
          shown={facts.items.length}
          hasNextPage={facts.hasNextPage}
          isFetchingNextPage={facts.isFetchingNextPage}
          onLoadMore={() => void facts.fetchNextPage()}
          noun={facts.items.length === 1 ? 'fact' : 'facts'}
          className="px-0"
        />
      )}
      {(dialog?.kind === 'add' || dialog?.kind === 'edit' || dialog?.kind === 'correct') && (
        <FactFormDialog
          mode={dialog.kind}
          fact={dialog.kind === 'add' ? null : dialog.fact}
          onClose={close}
          onDone={onDone}
          onConflict={setConflict}
        />
      )}
      {dialog?.kind === 'approve' && (
        <ApproveDialog fact={dialog.fact} onClose={close} onDone={onDone} onConflict={setConflict} />
      )}
      {dialog?.kind === 'withdraw' && (
        <WithdrawDialog fact={dialog.fact} onClose={close} onDone={onDone} onConflict={setConflict} />
      )}
      {dialog?.kind === 'review' && (
        <ReviewedDialog fact={dialog.fact} onClose={close} onDone={onDone} onConflict={setConflict} />
      )}
      {dialog?.kind === 'conflict' && (
        <ConflictDialog
          fact={dialog.fact}
          conflictId={dialog.conflictId}
          onClose={close}
          onDone={onDone}
          onConflict={setConflict}
        />
      )}
      {dialog?.kind === 'merge' && (
        <MergeDialog
          factIds={dialog.factIds}
          onClose={close}
          onDone={(m) => {
            setSelected(new Set());
            onDone(m);
          }}
          onConflict={setConflict}
        />
      )}
    </section>
  );
}

function FactCard({
  fact: f,
  me,
  canDecide,
  selected,
  onToggle,
  onAction,
  onResolve,
  onMergeWith,
}: {
  fact: FactDto;
  me: string | null;
  canDecide: boolean;
  selected: boolean;
  onToggle: () => void;
  onAction: (kind: 'edit' | 'correct' | 'approve' | 'withdraw' | 'review') => void;
  onResolve: (conflictId: string) => void;
  onMergeWith: (factId: string) => void;
}) {
  const now = Date.now();
  const until = f.validUntil ? new Date(f.validUntil).getTime() : null;
  const expiringSoon =
    f.state === 'approved' && until !== null && until > now && until - now <= EXPIRING_SOON_DAYS * DAY_MS;
  const openConflicts = f.conflicts.filter((c) => c.status === 'open');
  const live = isLive(f);
  const statementId = `fact-${f.id}-statement`;
  return (
    <li className="border-t border-border py-3 text-sm" data-testid="fact-card" aria-labelledby={statementId}>
      <div className="flex items-start gap-2">
        {canDecide && live && (
          <input
            type="checkbox"
            className="mt-1"
            checked={selected}
            onChange={onToggle}
            aria-label={`Select for merging: ${f.statement.slice(0, 80)}`}
          />
        )}
        <div className="min-w-0 flex-1">
          <p
            id={statementId}
            className="whitespace-pre-wrap break-words font-medium"
            data-testid="fact-statement"
          >
            {f.statement}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={STATE_TONE[f.state]}>{STATE_LABEL[f.state]}</Badge>
            <Badge tone={ORIGIN_TONE[f.origin]} glyph={false} data-testid="fact-origin">
              {originLabel(f, me)}
            </Badge>
            {f.scope && <Badge glyph={false}>{f.scope}</Badge>}
            {f.effective && <Badge tone="good">In effect</Badge>}
            {f.reviewDue && <Badge tone="warning">Review due</Badge>}
            {expiringSoon && <Badge tone="warning">Expiring {dateText(f.validUntil)}</Badge>}
            {f.expired && f.state === 'approved' && <Badge tone="critical">Expired</Badge>}
            {openConflicts.length > 0 && (
              <Badge tone="critical">
                {openConflicts.length} open conflict{openConflicts.length === 1 ? '' : 's'}
              </Badge>
            )}
            {f.supersedesFactId && f.state === 'proposed' && <Badge tone="info">Correction</Badge>}
          </div>
        </div>
      </div>
      <dl className="mt-2 grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[8rem_1fr]">
        <dt className="text-muted-foreground">Sources</dt>
        <dd>
          {f.sources.length === 0 ? (
            <span className="text-muted-foreground">No source given</span>
          ) : (
            <ul className="flex flex-col gap-1">
              {f.sources.map((s, i) => (
                <li key={`${s.kind}-${i}`}>
                  <SourceView source={s} />
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt className="text-muted-foreground">Validity</dt>
        <dd>
          {f.validFrom || f.validUntil
            ? `${f.validFrom ? `From ${dateText(f.validFrom)}` : 'Now'}${f.validUntil ? ` until ${dateText(f.validUntil)}` : ', no end date'}`
            : 'No limit'}
        </dd>
        <dt className="text-muted-foreground">Review</dt>
        <dd>
          {f.reviewedAt
            ? `Reviewed ${dateText(f.reviewedAt)}${f.reviewedByName ? ` by ${f.reviewedByName}` : ''}`
            : 'Not reviewed yet'}
          {f.reviewDueAt ? ` · next review ${dateText(f.reviewDueAt)}` : ''}
        </dd>
        {f.state === 'revoked' && (
          <>
            <dt className="text-muted-foreground">Withdrawn</dt>
            <dd>
              {f.revokeReason ?? 'No reason recorded'}
              {f.revokedByName ? ` (${f.revokedByName})` : ''}
            </dd>
          </>
        )}
        {f.state === 'superseded' && (
          <>
            <dt className="text-muted-foreground">Superseded</dt>
            <dd>Replaced by a correction or merged into another fact; it no longer applies.</dd>
          </>
        )}
        {openConflicts.length > 0 && (
          <>
            <dt className="text-muted-foreground">Conflicts</dt>
            <dd>
              <ul className="flex flex-col gap-1" data-testid="fact-conflicts">
                {openConflicts.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words">
                      {c.factStatement ? `Disagrees with “${c.factStatement}”` : 'Disagrees with a source'}
                      {c.note ? `: ${c.note}` : ''}
                    </span>
                    {c.source && <SourceView source={c.source} />}
                    {canDecide && live && (
                      <Button size="sm" variant="ghost" onClick={() => onResolve(c.id)}>
                        Resolve<span className="sr-only"> this conflict</span>
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        {f.possibleDuplicates.length > 0 && live && (
          <>
            <dt className="text-muted-foreground">Possible duplicates</dt>
            <dd>
              <ul className="flex flex-col gap-1">
                {f.possibleDuplicates.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words">“{d.statement}”</span>
                    {canDecide && (
                      <Button size="sm" variant="ghost" onClick={() => onMergeWith(d.id)}>
                        Merge<span className="sr-only"> these two facts</span>
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>
      {live && (
        <div className="mt-3 flex flex-wrap gap-2">
          {f.state === 'proposed' && canDecide && (
            <Button size="sm" variant="primary" onClick={() => onAction('approve')}>
              Approve
            </Button>
          )}
          {f.state === 'proposed' && (
            <Button size="sm" onClick={() => onAction('edit')}>
              Edit
            </Button>
          )}
          {f.state === 'approved' && (
            <Button size="sm" onClick={() => onAction('correct')}>
              Correct
            </Button>
          )}
          {f.state === 'approved' && canDecide && (
            <Button size="sm" onClick={() => onAction('review')}>
              Mark reviewed
            </Button>
          )}
          {canDecide && (
            <Button size="sm" variant="danger" onClick={() => onAction('withdraw')}>
              Withdraw
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** A URL opens in a new tab; an asset shows by its name; a note or a reviewer's note shows its text. */
function SourceView({ source: s }: { source: FactSource }) {
  const excerpt = s.excerpt ? (
    <blockquote className="mt-0.5 border-l-2 border-border pl-2 text-muted-foreground">
      {s.excerpt}
    </blockquote>
  ) : null;
  let label: ReactNode;
  switch (s.kind) {
    case 'url':
      label = (
        <a
          href={s.ref}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all underline underline-offset-2 hover:text-foreground"
        >
          {s.title ?? s.ref}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      );
      break;
    case 'asset':
      label = <span>Asset: {s.title ?? 'a brand asset'}</span>;
      break;
    case 'reviewer':
      label = <span>Reviewer note: {s.note ?? ''}</span>;
      break;
    case 'other':
      label = <span>Note: {s.ref}</span>;
      break;
    default:
      label = <span>{s.title ?? s.ref}</span>;
  }
  return (
    <div className="min-w-0 break-words">
      {label}
      {s.kind !== 'reviewer' && s.note ? <span className="text-muted-foreground"> · {s.note}</span> : null}
      {excerpt}
    </div>
  );
}
