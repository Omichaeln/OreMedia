import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ASSIST_SECTION_LABEL,
  ASSIST_TERMINAL_STATES,
  type AssistSection,
  type AssistSectionStatus,
} from '@oremedia/contracts/brand-assist';
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
import { useToast } from '../../components/toast';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { formatMicros } from '../agents/run-helpers';
import { useBrandContext } from './brand-context';
import {
  useAssistJob,
  useBrandSource,
  useSuggestions,
  type AssistJobDto,
  type SuggestionDto,
} from './use-assist';

/**
 * BSC-4 / BSC-5: an assist job as people follow it (stages and sections, with cancel and retry) and its suggestions
 * as people review them: per section, each change shown against what the brand system says now, with where it comes
 * from (the source passage, which opens in context), how sure it is and what disagrees; accept, edit, reject or ask
 * for alternatives, one at a time or a whole section; undo the last decision; answer the job's questions. Accepted
 * suggestions go into the proposed update, which is applied through the usual review and save.
 */

const STATE_TEXT: Record<AssistJobDto['state'], string> = {
  queued: 'Waiting to start',
  capturing: 'Reading websites',
  extracting: 'Reading documents',
  proposing: 'Writing suggestions',
  ready: 'Suggestions ready',
  partially_ready: 'Some suggestions ready',
  failed: 'No suggestions could be made',
  cancelled: 'Cancelled',
};
const SECTION_STATUS: Record<AssistSectionStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Waiting', tone: 'neutral' },
  running: { label: 'Working', tone: 'info' },
  ready: { label: 'Ready', tone: 'good' },
  failed: { label: 'Failed', tone: 'critical' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};
/** Why a job stopped, in words. */
const JOB_ERROR: Record<string, string> = {
  no_usable_sources: 'None of the sources could be read. Fix or replace them and start again.',
  budget_exhausted: 'The AI budget ran out. An owner or admin can raise it under Settings.',
  budget_exhausted_day: "The brand's AI budget for today is used up. Try again tomorrow or ask an admin.",
  budget_exhausted_month: "The company's AI budget for this month is used up.",
  kill_switch_engaged: 'AI work is paused for this brand by an owner or admin.',
  model_routing_denied: "The company's model policy does not allow the configured model.",
  entitlement_exhausted: "The plan's AI budget for this month is used up.",
  model_unavailable: 'No AI model is configured for this service.',
  not_allowed: 'You no longer have permission to change the brand system.',
  no_section_finished: 'None of the sections could be finished. Try again.',
  model_failed: 'The AI service did not answer. Try again.',
};
const isRunning = (j: AssistJobDto) => !ASSIST_TERMINAL_STATES.includes(j.state);

/** A job's progress: stages, sections, cost; cancel while it runs, retry what failed once it ends. */
export function JobProgress({
  job,
  onRetry,
}: {
  job: AssistJobDto;
  /** Starts the failed sections again (a new job over the same sources). */
  onRetry?: (sections: AssistSection[]) => void;
}) {
  const { brandId } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const cancel = useMutation(
    trpc.brand.assist.cancel.mutationOptions({
      ...mutationIntent(intent.key),
      onSettled: () => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.brand.assist.pathFilter());
      },
    }),
  );
  const running = isRunning(job);
  const failed = job.sections.filter((s) => job.progress.sections[s]?.status === 'failed');
  const stages = (['capturing', 'extracting', 'proposing'] as const).filter(
    (s) => job.progress.stages[s].status !== 'skipped',
  );
  const STAGE_LABEL = { capturing: 'Websites', extracting: 'Documents', proposing: 'Sections' } as const;
  return (
    <section
      className="flex flex-col gap-3 rounded-md border border-border p-3"
      aria-labelledby={`job-${job.id}`}
      data-testid="assist-progress"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`job-${job.id}`} className="text-sm font-semibold">
          {STATE_TEXT[job.state]}
        </h3>
        <div className="flex flex-wrap gap-2">
          {running && (
            <Button
              size="sm"
              variant="ghost"
              disabled={cancel.isPending || job.cancelRequested}
              onClick={() => cancel.mutate({ brandId, jobId: job.id })}
            >
              {job.cancelRequested ? 'Cancelling…' : 'Cancel'}
            </Button>
          )}
          {!running && failed.length > 0 && onRetry && (
            <Button size="sm" onClick={() => onRetry(failed)}>
              Try the failed sections again
            </Button>
          )}
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {STATE_TEXT[job.state]}
      </p>
      <ul className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground" aria-label="Stages">
        {stages.map((s) => {
          const st = job.progress.stages[s];
          return (
            <li key={s}>
              {STAGE_LABEL[s]}: <span className="tabular-nums">{st.done}</span> of{' '}
              <span className="tabular-nums">{st.total}</span>
              {st.status === 'running' ? ' (in progress)' : ''}
            </li>
          );
        })}
        <li>
          Cost: {formatMicros(job.spentMicros)} of {formatMicros(job.reservedMicros || job.estimateMicros)}{' '}
          reserved
        </li>
      </ul>
      <ul className="grid gap-1 sm:grid-cols-2" aria-label="Sections">
        {job.sections.map((s) => {
          const sec = job.progress.sections[s];
          const st = SECTION_STATUS[sec?.status ?? 'pending'];
          return (
            <li
              key={s}
              className="flex items-center justify-between gap-2 text-sm"
              data-testid="assist-section-status"
            >
              <span>{ASSIST_SECTION_LABEL[s]}</span>
              <span className="flex items-center gap-2">
                {sec?.status === 'ready' && (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {sec.suggestions} suggestion{sec.suggestions === 1 ? '' : 's'}
                  </span>
                )}
                <Badge tone={st.tone}>{st.label}</Badge>
              </span>
            </li>
          );
        })}
      </ul>
      {job.error && !running && (
        <StatusBanner
          tone="warning"
          title="Why it stopped"
          description={JOB_ERROR[job.error] ?? 'Something went wrong.'}
        />
      )}
    </section>
  );
}

const OP_TEXT = { add: 'Add', replace: 'Change', remove: 'Remove' } as const;
const ORIGIN: Record<string, { label: string; tone: Tone }> = {
  imported: { label: 'From your sources', tone: 'info' },
  inferred: { label: 'Pattern in your examples', tone: 'warning' },
  suggested: { label: 'AI suggestion', tone: 'warning' },
  user: { label: 'Your wording', tone: 'neutral' },
};
const STATUS_TEXT = {
  pending: null,
  accepted: { label: 'Accepted', tone: 'good' as Tone },
  edited: { label: 'Accepted with your edits', tone: 'good' as Tone },
  rejected: { label: 'Rejected', tone: 'neutral' as Tone },
  superseded: { label: 'Replaced by a newer suggestion', tone: 'neutral' as Tone },
};

/** The source a passage comes from, opened at the passage (highlighted). */
function SourceExcerptDialog({
  sourceId,
  excerpt,
  onClose,
}: {
  sourceId: string;
  excerpt: string;
  onClose: () => void;
}) {
  const { brandId } = useBrandContext();
  const source = useBrandSource(brandId, sourceId);
  const text = source.data?.text ?? '';
  const at = text.toLowerCase().indexOf(excerpt.toLowerCase().slice(0, 80));
  const start = Math.max(0, at - 600);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={source.data?.title ?? 'Source'} description={source.data?.url ?? undefined}>
        {source.isPending && <Skeleton label="Loading the source" lines={3} />}
        {source.isError && <RequestError error={source.error} />}
        {source.data && (
          <p className="max-h-[60vh] overflow-auto whitespace-pre-wrap text-sm" data-testid="source-excerpt">
            {at < 0 ? (
              <>
                <span className="mb-2 block text-xs text-muted-foreground">
                  The passage was not found in what was read; the start of the source is shown.
                </span>
                {text.slice(0, 2000)}
              </>
            ) : (
              <>
                {start > 0 ? '… ' : ''}
                {text.slice(start, at)}
                <mark>{text.slice(at, at + excerpt.length)}</mark>
                {text.slice(at + excerpt.length, at + excerpt.length + 600)}
                {' …'}
              </>
            )}
          </p>
        )}
        <DialogActions>
          <DialogClose asChild>
            <Button size="sm">Close</Button>
          </DialogClose>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

const lines = (t: string) =>
  t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
const words = (k: string) =>
  k
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .toLowerCase();
/** Fields a person edits as text; the rest (keys, kinds, numbers) are kept as suggested. */
const EDITABLE_KEYS = new Set([
  'summary',
  'trait',
  'note',
  'statement',
  'rationale',
  'rule',
  'notes',
  'description',
  'needs',
  'objections',
  'title',
  'text',
  'definition',
  'alternatives',
  'guidance',
  'dos',
  'donts',
  'examples',
  'purpose',
  'example',
  'rewrite',
  'captionStyle',
  'ctaConventions',
  'objectives',
  'conventions',
  'accessibility',
  'hashtags',
  'mentions',
  'links',
  'frequency',
  'audience',
  'formats',
  'positioning',
  'valueProposition',
]);

/** Edit a suggested value before accepting it: text fields as text, lists one per line; the item's name stays. */
function EditDialog({ suggestion, onClose }: { suggestion: SuggestionDto; onClose: () => void }) {
  const { brandId } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const intent = useIntentKey();
  const original = suggestion.value;
  const [value, setValue] = useState<unknown>(original);
  const edit = useMutation(
    trpc.brand.suggestions.edit.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.brand.pathFilter());
        toast({ tone: 'good', title: 'Accepted with your edits' });
        onClose();
      },
      onError: () => intent.renew(),
    }),
  );
  const error = edit.error ? toUiError(edit.error) : null;
  const fieldsOf = (v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.entries(v as Record<string, unknown>).filter(
          ([k, x]) =>
            EDITABLE_KEYS.has(k) &&
            (typeof x === 'string' || (Array.isArray(x) && x.every((i) => typeof i === 'string'))),
        )
      : [];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Edit: ${suggestion.label}`} description="Your wording is saved as yours.">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            edit.mutate({ brandId, suggestionId: suggestion.id, value });
          }}
        >
          {typeof value === 'string' && (
            <Field label="Text" htmlFor="edit-text">
              <Textarea id="edit-text" rows={4} value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
          )}
          {Array.isArray(value) && (
            <Field label="One per line" htmlFor="edit-lines">
              <Textarea
                id="edit-lines"
                rows={4}
                value={(value as string[]).join('\n')}
                onChange={(e) => setValue(lines(e.target.value))}
              />
            </Field>
          )}
          {fieldsOf(value).map(([k, x]) => {
            const id = `edit-${k}`;
            const set = (next: unknown) => setValue({ ...(value as object), [k]: next });
            return Array.isArray(x) ? (
              <Field key={k} label={`${words(k)} (one per line)`} htmlFor={id}>
                <Textarea
                  id={id}
                  rows={3}
                  value={(x as string[]).join('\n')}
                  onChange={(e) => set(lines(e.target.value))}
                />
              </Field>
            ) : (x as string).length > 80 ? (
              <Field key={k} label={words(k)} htmlFor={id}>
                <Textarea id={id} rows={3} value={x as string} onChange={(e) => set(e.target.value)} />
              </Field>
            ) : (
              <Field key={k} label={words(k)} htmlFor={id}>
                <Input id={id} value={x as string} onChange={(e) => set(e.target.value)} />
              </Field>
            );
          })}
          {error && (
            <StatusBanner
              tone="critical"
              title="Not saved"
              description={[error.message, ...error.details.map((d) => d.issue.replaceAll('_', ' '))].join(
                ' · ',
              )}
            />
          )}
          <DialogActions>
            <DialogClose asChild>
              <Button size="sm" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <Button size="sm" variant="primary" type="submit" disabled={edit.isPending}>
              {edit.isPending ? 'Saving…' : 'Accept with edits'}
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One suggestion: what changes against the brand system now, why, from where, and the decision. */
export function SuggestionCard({
  suggestion: s,
  canDecide,
  busy,
  onAccept,
  onReject,
}: {
  suggestion: SuggestionDto;
  canDecide: boolean;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [excerpt, setExcerpt] = useState<{ sourceId: string; excerpt: string } | null>(null);
  const origin = ORIGIN[s.provenance.origin] ?? { label: 'AI suggestion', tone: 'warning' as Tone };
  const status = STATUS_TEXT[s.status];
  const evidence = s.evidence.filter((e) => e.verified);
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border p-3" data-testid="suggestion-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={s.op === 'remove' ? 'warning' : 'info'} glyph={false}>
            {OP_TEXT[s.op]}
          </Badge>
          <span className="font-medium" data-testid="suggestion-label">
            {s.label}
          </span>
          <Badge tone={origin.tone} glyph={false}>
            {origin.label}
            {s.provenance.confidence === 'low' ? ' · low confidence' : ''}
          </Badge>
        </p>
        {status && (
          <Badge tone={status.tone} data-testid="suggestion-status">
            {status.label}
          </Badge>
        )}
      </div>
      <div className="grid gap-2 text-sm sm:grid-cols-2" data-testid="suggestion-diff">
        <div className="rounded-sm bg-muted px-2 py-1">
          <p className="text-xs font-medium text-muted-foreground">Now</p>
          <p className="whitespace-pre-wrap">
            {s.currentText ?? <span className="text-muted-foreground">Nothing yet</span>}
          </p>
        </div>
        <div className="rounded-sm border border-border px-2 py-1">
          <p className="text-xs font-medium text-muted-foreground">
            {s.op === 'remove' ? 'After' : 'Suggested'}
          </p>
          <p className="whitespace-pre-wrap">
            {s.op === 'remove' ? <span className="text-muted-foreground">Removed</span> : s.valueText}
          </p>
        </div>
      </div>
      <p className="text-sm">{s.rationale}</p>
      {s.againstUserItem && (
        <p className="text-xs text-status-warning" data-testid="suggestion-user-item">
          A person wrote the current wording. Accepting replaces it.
        </p>
      )}
      {s.uncertainty && <p className="text-xs text-muted-foreground">Uncertain: {s.uncertainty}</p>}
      {s.conflicts
        .filter((c) => !c.note.startsWith('A person wrote'))
        .map((c, i) => (
          <p key={i} className="text-xs text-status-warning">
            Disagreement: {c.note}
          </p>
        ))}
      {evidence.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Where it comes from">
          {evidence.map((e, i) => (
            <li key={i} className="text-xs">
              <blockquote className="border-l-2 border-border pl-2 italic">“{e.excerpt}”</blockquote>
              <span className="text-muted-foreground">{e.sourceTitle ?? 'A source'}</span>{' '}
              <button
                type="button"
                className="underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setExcerpt({ sourceId: e.sourceId, excerpt: e.excerpt })}
              >
                Open in source
              </button>
            </li>
          ))}
        </ul>
      )}
      {evidence.length === 0 && s.provenance.origin === 'suggested' && (
        <p className="text-xs text-muted-foreground">No source says this; it is a suggestion to consider.</p>
      )}
      {canDecide && s.status === 'pending' && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={onAccept}>
            Accept<span className="sr-only"> {s.label}</span>
          </Button>
          {s.op !== 'remove' && (
            <Button size="sm" disabled={busy} onClick={() => setEditing(true)}>
              Edit<span className="sr-only"> {s.label}</span>
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={onReject}>
            Reject<span className="sr-only"> {s.label}</span>
          </Button>
        </div>
      )}
      {editing && <EditDialog suggestion={s} onClose={() => setEditing(false)} />}
      {excerpt && <SourceExcerptDialog {...excerpt} onClose={() => setExcerpt(null)} />}
    </li>
  );
}

/** The job's open questions; answering starts a follow-up job that reads the answers. */
function Questions({ job, onFollowUp }: { job: AssistJobDto; onFollowUp: (jobId: string) => void }) {
  const { brandId } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const open = job.questions.filter((q) => q.answer === null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const answer = useMutation(
    trpc.brand.assist.answer.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.brand.assist.pathFilter());
        onFollowUp(res.jobId);
      },
      onError: () => intent.renew(),
    }),
  );
  if (open.length === 0) return null;
  const filled = open.filter((q) => (answers[q.id] ?? '').trim());
  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-border p-3"
      aria-labelledby={`questions-${job.id}`}
      onSubmit={(e) => {
        e.preventDefault();
        answer.mutate({
          brandId,
          jobId: job.id,
          answers: filled.map((q) => ({ questionId: q.id, answer: (answers[q.id] ?? '').trim() })),
        });
      }}
    >
      <h3 id={`questions-${job.id}`} className="text-sm font-semibold">
        Questions that would improve the suggestions
      </h3>
      {open.map((q) => (
        <Field key={q.id} label={q.question} htmlFor={`answer-${q.id}`} hint={q.why}>
          <Textarea
            id={`answer-${q.id}`}
            rows={2}
            maxLength={2000}
            value={answers[q.id] ?? ''}
            onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
          />
        </Field>
      ))}
      {answer.error && (
        <StatusBanner tone="critical" title="Not sent" description={toUiError(answer.error).message} />
      )}
      <div>
        <Button size="sm" type="submit" disabled={answer.isPending || filled.length === 0}>
          Send answers and update suggestions
        </Button>
      </div>
    </form>
  );
}

/**
 * The review of one job's suggestions by section (only `sections` when given: the section assistant shows its own
 * section inline). Accept all and "request alternatives" act on a section; undo takes back the last decision batch.
 */
export function SuggestionReview({
  jobId,
  sections,
  canDecide,
  onFollowUp,
  onAlternatives,
  onApply,
}: {
  jobId: string;
  sections?: AssistSection[];
  canDecide: boolean;
  onFollowUp: (jobId: string) => void;
  onAlternatives: (section: AssistSection) => void;
  /** Opens the proposed update for review and save; shown once something was accepted. */
  onApply?: () => void;
}) {
  const { brandId } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const job = useAssistJob(brandId, jobId);
  const jobRunning = job.data !== undefined && !ASSIST_TERMINAL_STATES.includes(job.data.state);
  const suggestions = useSuggestions(brandId, { jobId }, job.data !== undefined, jobRunning);
  // Once the job finishes, its suggestions are read again (the last poll may have come just before they were stored).
  const finished = job.data !== undefined && !jobRunning;
  const refetchSuggestions = suggestions.refetch;
  useEffect(() => {
    if (finished) void refetchSuggestions();
  }, [finished, refetchSuggestions]);
  const intent = useIntentKey();
  const [status, setStatus] = useState('');
  const refresh = () => void queryClient.invalidateQueries(trpc.brand.pathFilter());
  const onSettled = () => {
    intent.renew();
    refresh();
  };
  const accept = useMutation(
    trpc.brand.suggestions.accept.mutationOptions({ ...mutationIntent(intent.key), onSettled }),
  );
  const reject = useMutation(
    trpc.brand.suggestions.reject.mutationOptions({ ...mutationIntent(intent.key), onSettled }),
  );
  const acceptAll = useMutation(
    trpc.brand.suggestions.acceptAll.mutationOptions({ ...mutationIntent(intent.key), onSettled }),
  );
  const undo = useMutation(
    trpc.brand.suggestions.undo.mutationOptions({
      ...mutationIntent(intent.key),
      onSettled,
      onSuccess: (res) => {
        const msg = `Undone: ${res.decided.length} suggestion${res.decided.length === 1 ? '' : 's'} back to review.`;
        setStatus(msg);
        toast({ tone: 'info', title: msg });
      },
      onError: (err) =>
        toast({ tone: 'critical', title: 'Nothing undone', description: toUiError(err).message }),
    }),
  );
  const busy = accept.isPending || reject.isPending || acceptAll.isPending || undo.isPending;
  const error = [accept.error, reject.error, acceptAll.error].find(Boolean);
  const bySection = useMemo(() => {
    const items = suggestions.data?.items ?? [];
    const order = sections ?? job.data?.sections ?? [];
    return order
      .map((section) => ({
        section,
        items: items.filter((s) => s.section === section && s.status !== 'superseded'),
      }))
      .filter((g) => g.items.length > 0);
  }, [suggestions.data, sections, job.data]);
  if (job.isPending) return <Skeleton label="Loading the suggestions" lines={3} />;
  if (job.isError) return <RequestError error={job.error} onRetry={() => void job.refetch()} />;
  const decidedCount = (suggestions.data?.items ?? []).filter(
    (s) => s.status === 'accepted' || s.status === 'edited',
  ).length;
  const done = ASSIST_TERMINAL_STATES.includes(job.data.state);
  return (
    <div className="flex flex-col gap-4" data-testid="suggestion-review">
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      {done && bySection.length === 0 && suggestions.isSuccess && (
        <EmptyState
          title="No suggestions"
          description="The sources did not add anything new to what the brand system already says, or every suggestion was already decided."
        />
      )}
      {error && <StatusBanner tone="critical" title="Not saved" description={toUiError(error).message} />}
      {bySection.map(({ section, items }) => {
        const pending = items.filter((s) => s.status === 'pending');
        return (
          <section
            key={section}
            aria-labelledby={`review-${jobId}-${section}`}
            className="flex flex-col gap-2"
            data-testid="suggestion-section"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id={`review-${jobId}-${section}`} className="text-sm font-semibold">
                {ASSIST_SECTION_LABEL[section]}{' '}
                <span className="font-normal text-muted-foreground">
                  ({pending.length} to review of {items.length})
                </span>
              </h3>
              {canDecide && (
                <div className="flex flex-wrap gap-2">
                  {pending.length > 0 && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        acceptAll.mutate(
                          { brandId, jobId, section },
                          { onSuccess: (r) => setStatus(`${r.decided.length} suggestions accepted.`) },
                        )
                      }
                    >
                      Accept all in {ASSIST_SECTION_LABEL[section]}
                    </Button>
                  )}
                  {section !== 'facts' && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAlternatives(section)}>
                      Request alternatives
                    </Button>
                  )}
                </div>
              )}
            </div>
            <ul className="flex flex-col gap-2">
              {items.map((s) => (
                <SuggestionCard
                  key={s.id}
                  suggestion={s}
                  canDecide={canDecide}
                  busy={busy}
                  onAccept={() =>
                    accept.mutate(
                      { brandId, suggestionIds: [s.id] },
                      { onSuccess: () => setStatus(`Accepted: ${s.label}.`) },
                    )
                  }
                  onReject={() =>
                    reject.mutate(
                      { brandId, suggestionIds: [s.id] },
                      { onSuccess: () => setStatus(`Rejected: ${s.label}. It will not be suggested again.`) },
                    )
                  }
                />
              ))}
            </ul>
          </section>
        );
      })}
      {canDecide && <Questions job={job.data} onFollowUp={onFollowUp} />}
      {canDecide && decidedCount > 0 && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
          data-testid="review-summary"
        >
          <p className="text-sm">
            {decidedCount} suggestion{decidedCount === 1 ? '' : 's'} accepted into the proposed update.
            Nothing changes until the update is reviewed and saved.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => undo.mutate({ brandId })}>
              Undo last decision
            </Button>
            {onApply && (
              <Button size="sm" variant="primary" onClick={onApply}>
                Review and apply
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
