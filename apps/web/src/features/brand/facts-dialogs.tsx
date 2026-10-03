import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  FactCategory,
  type FactConflictOutcome,
  type FactSource,
  type FactState,
} from '@oremedia/contracts/brand';
import { Badge, Button, Field, Input, Skeleton, StatusBanner, Textarea, type Tone } from '@oremedia/ui';
import { Dialog, DialogActions, DialogClose, DialogContent } from '../../components/dialog';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { useToast } from '../../components/toast';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { toUiError, type UiError } from '../../lib/errors';
import { useTRPC } from '../../lib/trpc';
import { AssetPickerDialog } from '../assets/asset-picker';
import { useBrandContext } from './brand-context';
import { useFacts, type FactDto } from './use-brand';

/**
 * BSC-3 facts workspace dialogs (add, edit, correct, approve, withdraw, mark reviewed, resolve a conflict, merge)
 * and the labels and helpers the workspace shares with them (facts-workspace.tsx).
 */

export const CATEGORY_LABEL: Record<FactCategory, string> = {
  company: 'Company',
  product: 'Products',
  service: 'Services',
  location: 'Locations',
  contact: 'Contact details',
  differentiator: 'Differentiators',
  audience: 'Audience',
  terminology: 'Terminology',
  claim: 'Claims',
  faq: 'FAQs',
  offer: 'Offers',
  price: 'Prices',
  statistic: 'Statistics',
  legal: 'Legal',
};

export const STATE_LABEL: Record<FactState, string> = {
  proposed: 'Proposed',
  approved: 'Approved',
  revoked: 'Withdrawn',
  superseded: 'Superseded',
};
export const STATE_TONE: Record<FactState, Tone> = {
  proposed: 'warning',
  approved: 'good',
  revoked: 'neutral',
  superseded: 'neutral',
};

export const DAY_MS = 86_400_000;
export const EXPIRING_SOON_DAYS = 30;

export const dateText = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    : null;
/** `<input type="date">` value (local day) ↔ ISO instant: a start is the day's first moment, an end its last. */
const toDayInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fromDayInput = (day: string, end = false): string | null =>
  day ? new Date(`${day}T${end ? '23:59:59.999' : '00:00:00.000'}`).toISOString() : null;

/** Sources that count as evidence (the server's rule: a note or a comment alone is not a source). */
const EVIDENCE_KINDS: ReadonlySet<FactSource['kind']> = new Set([
  'asset',
  'document',
  'url',
  'metric_snapshot',
  'experiment_result',
]);
export const needsReviewerNote = (f: FactDto) =>
  (f.origin === 'suggested' || f.origin === 'inferred') && !f.sources.some((s) => EVIDENCE_KINDS.has(s.kind));

/**
 * What every workspace mutation does when it settles: on success the list is refreshed and the outcome announced;
 * a CONFLICT (someone changed the fact since it loaded) is shown with the reload action. Each mutation keeps its own
 * idempotency key per intent (renewed when the intent ends either way).
 */
export function useFactSettled(onConflict: (ui: UiError) => void) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return {
    success(title: string) {
      toast({ tone: 'good', title });
      void queryClient.invalidateQueries(trpc.brand.facts.pathFilter());
    },
    error(err: unknown) {
      const ui = toUiError(err);
      if (ui.kind === 'conflict') onConflict(ui);
    },
  };
}

export interface DialogBaseProps {
  onClose: () => void;
  onDone: (message: string) => void;
  onConflict: (ui: UiError) => void;
}

/** A source as the form holds it before it is sent. */
type DraftSource =
  | { kind: 'url'; ref: string; title: string; excerpt: string }
  | { kind: 'asset'; ref: string; title: string; excerpt: string }
  | { kind: 'other'; ref: string; title: string; excerpt: string };

const toDraft = (s: FactSource): DraftSource | null =>
  s.kind === 'url' || s.kind === 'asset' || s.kind === 'other'
    ? { kind: s.kind, ref: s.ref, title: s.title ?? '', excerpt: s.excerpt ?? '' }
    : null;

const fromDraft = (s: DraftSource): FactSource => ({
  kind: s.kind,
  ref: s.ref.trim(),
  ...(s.title.trim() ? { title: s.title.trim() } : {}),
  ...(s.excerpt.trim() ? { excerpt: s.excerpt.trim() } : {}),
});

function validUrl(v: string) {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Add a fact, edit a proposed one, or propose a correction of an approved one. */
export function FactFormDialog({
  mode,
  fact,
  onClose,
  onDone,
  onConflict,
}: DialogBaseProps & { mode: 'add' | 'edit' | 'correct'; fact: FactDto | null }) {
  const { brandId } = useBrandContext();
  const trpc = useTRPC();
  const [category, setCategory] = useState<FactCategory>(fact?.category ?? 'company');
  const [scope, setScope] = useState(fact?.scope ?? '');
  const [statement, setStatement] = useState(fact?.statement ?? '');
  const [sources, setSources] = useState<DraftSource[]>(
    (fact?.sources ?? []).flatMap((s) => toDraft(s) ?? []),
  );
  const keptSources = (fact?.sources ?? []).filter((s) => toDraft(s) === null && s.kind !== 'reviewer');
  const [validFrom, setValidFrom] = useState(toDayInput(fact?.validFrom ?? null));
  const [validUntil, setValidUntil] = useState(toDayInput(fact?.validUntil ?? null));
  const [reviewDue, setReviewDue] = useState(
    toDayInput(mode === 'correct' ? null : (fact?.reviewDueAt ?? null)),
  );
  const [picking, setPicking] = useState(false);
  const [touched, setTouched] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const settled = useFactSettled(onConflict);
  const proposeIntent = useIntentKey();
  const propose = useMutation(
    trpc.brand.facts.propose.mutationOptions({
      ...mutationIntent(proposeIntent.key),
      onSuccess: (r) => {
        proposeIntent.renew();
        if (r.duplicate) {
          setDuplicate(true);
          return;
        }
        settled.success('Fact proposed');
        onDone('Fact added as a proposal');
      },
      onError: (err) => {
        proposeIntent.renew();
        settled.error(err);
      },
    }),
  );
  const updateIntent = useIntentKey();
  const update = useMutation(
    trpc.brand.facts.update.mutationOptions({
      ...mutationIntent(updateIntent.key),
      onSuccess: () => {
        updateIntent.renew();
        settled.success('Proposal saved');
        onDone('Proposal saved');
      },
      onError: (err) => {
        updateIntent.renew();
        settled.error(err);
      },
    }),
  );
  const correctIntent = useIntentKey();
  const correct = useMutation(
    trpc.brand.facts.correct.mutationOptions({
      ...mutationIntent(correctIntent.key),
      onSuccess: () => {
        correctIntent.renew();
        settled.success('Correction proposed');
        onDone('Correction proposed');
      },
      onError: (err) => {
        correctIntent.renew();
        settled.error(err);
      },
    }),
  );
  const active = mode === 'add' ? propose : mode === 'edit' ? update : correct;
  const sourceErrors = sources.map((s) =>
    s.kind === 'url' && !validUrl(s.ref.trim())
      ? 'Enter a full web address (https://…)'
      : s.ref.trim() === ''
        ? 'Required'
        : null,
  );
  const windowError =
    // Day strings (YYYY-MM-DD) compare in order; the end is the day's last moment, so the same day is valid.
    validFrom && validUntil && validUntil < validFrom ? 'The end must not be before the start' : undefined;
  const statementError = touched && !statement.trim() ? 'Say what the fact is' : undefined;
  const invalid = !statement.trim() || sourceErrors.some(Boolean) || Boolean(windowError);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (invalid) return;
    const sent = [...keptSources, ...sources.map(fromDraft)];
    const vFrom = fromDayInput(validFrom);
    const vUntil = fromDayInput(validUntil, true);
    const due = fromDayInput(reviewDue);
    if (mode === 'add')
      propose.mutate({
        brandId,
        category,
        statement: statement.trim(),
        ...(scope.trim() ? { scope: scope.trim() } : {}),
        sources: sent,
        ...(vFrom ? { validFrom: vFrom } : {}),
        ...(vUntil ? { validUntil: vUntil } : {}),
        ...(due ? { reviewDueAt: due } : {}),
      });
    else if (fact && mode === 'edit')
      update.mutate({
        brandId,
        factId: fact.id,
        expectedVersion: fact.version,
        category,
        statement: statement.trim(),
        scope: scope.trim() || null,
        sources: sent,
        validFrom: vFrom,
        validUntil: vUntil,
        reviewDueAt: due,
      });
    else if (fact)
      correct.mutate({
        brandId,
        factId: fact.id,
        expectedVersion: fact.version,
        category,
        statement: statement.trim(),
        scope: scope.trim() || null,
        sources: sent,
        validFrom: vFrom,
        validUntil: vUntil,
        reviewDueAt: due,
      });
  };
  const ui = active.isError ? toUiError(active.error) : null;
  const title =
    mode === 'add' ? 'Add a fact' : mode === 'edit' ? 'Edit the proposed fact' : 'Correct the fact';
  const set = (i: number, patch: Partial<DraftSource>) =>
    setSources((all) => all.map((s, j) => (j === i ? ({ ...s, ...patch } as DraftSource) : s)));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={title}
        description={
          mode === 'correct'
            ? 'The correction is proposed; the current fact keeps applying until a brand manager approves the correction, then it is superseded.'
            : 'A fact is what copy may state. It is proposed now and applies once a brand manager approves it.'
        }
        className="w-[min(94vw,40rem)]"
        data-testid="fact-form"
      >
        <form onSubmit={submit} noValidate className="grid gap-3 sm:grid-cols-2">
          {duplicate && (
            <StatusBanner
              tone="info"
              title="This fact is already in the brand"
              description="The same statement is already proposed or approved, so nothing new was added."
              className="sm:col-span-2"
            />
          )}
          <Field label="Category" htmlFor="fact-category">
            <Select
              id="fact-category"
              value={category}
              onValueChange={(v) => setCategory(v as FactCategory)}
              options={FactCategory.options.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))}
            />
          </Field>
          <Field
            label="Scope (optional)"
            htmlFor="fact-scope"
            hint="Leave empty for brand-wide, or name a market or channel."
          >
            <Input id="fact-scope" value={scope} onChange={(e) => setScope(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Statement" htmlFor="fact-statement" className="sm:col-span-2" error={statementError}>
            <Textarea
              id="fact-statement"
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
              onBlur={() => setTouched(true)}
              maxLength={4000}
              rows={3}
              required
            />
          </Field>
          <fieldset className="flex flex-col gap-2 sm:col-span-2">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">Sources</legend>
            {sources.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No source yet. A fact with a source is easier to approve and to trust.
              </p>
            )}
            {sources.map((s, i) => (
              <div
                key={i}
                className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-2"
                data-testid="fact-source"
              >
                {s.kind === 'url' && (
                  <Field
                    label="Web address"
                    htmlFor={`src-${i}-ref`}
                    error={touched ? (sourceErrors[i] ?? undefined) : undefined}
                  >
                    <Input
                      id={`src-${i}-ref`}
                      type="url"
                      inputMode="url"
                      value={s.ref}
                      onChange={(e) => set(i, { ref: e.target.value })}
                      placeholder="https://"
                      maxLength={1000}
                    />
                  </Field>
                )}
                {s.kind === 'asset' && (
                  <p className="text-sm sm:col-span-1">
                    Asset: <span className="font-medium">{s.title || 'a brand asset'}</span>
                  </p>
                )}
                {s.kind === 'other' && (
                  <Field
                    label="Note"
                    htmlFor={`src-${i}-ref`}
                    error={touched ? (sourceErrors[i] ?? undefined) : undefined}
                  >
                    <Input
                      id={`src-${i}-ref`}
                      value={s.ref}
                      onChange={(e) => set(i, { ref: e.target.value })}
                      maxLength={1000}
                    />
                  </Field>
                )}
                {s.kind === 'url' && (
                  <Field label="Title (optional)" htmlFor={`src-${i}-title`}>
                    <Input
                      id={`src-${i}-title`}
                      value={s.title}
                      onChange={(e) => set(i, { title: e.target.value })}
                      maxLength={200}
                    />
                  </Field>
                )}
                {s.kind !== 'other' && (
                  <Field
                    label="Excerpt (optional)"
                    htmlFor={`src-${i}-excerpt`}
                    className="sm:col-span-2"
                    hint="The words in the source that support the statement."
                  >
                    <Textarea
                      id={`src-${i}-excerpt`}
                      value={s.excerpt}
                      onChange={(e) => set(i, { excerpt: e.target.value })}
                      maxLength={1000}
                      rows={2}
                    />
                  </Field>
                )}
                <div className="sm:col-span-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setSources((all) => all.filter((_, j) => j !== i))}
                  >
                    Remove source<span className="sr-only"> {i + 1}</span>
                  </Button>
                </div>
              </div>
            ))}
            {sources.length < 20 && (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() =>
                    setSources((all) => [...all, { kind: 'url', ref: '', title: '', excerpt: '' }])
                  }
                >
                  Add a web address
                </Button>
                <Button type="button" size="sm" onClick={() => setPicking(true)}>
                  Add an asset
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() =>
                    setSources((all) => [...all, { kind: 'other', ref: '', title: '', excerpt: '' }])
                  }
                >
                  Add a note
                </Button>
              </div>
            )}
          </fieldset>
          <Field label="Valid from (optional)" htmlFor="fact-valid-from">
            <Input
              id="fact-valid-from"
              type="date"
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
            />
          </Field>
          <Field label="Valid until (optional)" htmlFor="fact-valid-until" error={windowError}>
            <Input
              id="fact-valid-until"
              type="date"
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
            />
          </Field>
          <Field
            label="Review by (optional)"
            htmlFor="fact-review-due"
            hint="Without a date, approval schedules a review a year later."
          >
            <Input
              id="fact-review-due"
              type="date"
              value={reviewDue}
              onChange={(e) => setReviewDue(e.target.value)}
            />
          </Field>
          {ui && ui.kind !== 'conflict' && (
            <StatusBanner
              tone="critical"
              title="Not saved"
              description={ui.message}
              className="sm:col-span-2"
            />
          )}
          <div className="sm:col-span-2">
            <DialogActions>
              <DialogClose asChild>
                <Button type="button" variant="ghost">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" variant="primary" disabled={active.isPending}>
                {mode === 'add' ? 'Propose fact' : mode === 'edit' ? 'Save proposal' : 'Propose correction'}
              </Button>
            </DialogActions>
          </div>
        </form>
        <AssetPickerDialog
          brandId={brandId}
          purpose="reference"
          open={picking}
          onOpenChange={setPicking}
          title="Choose an asset as the source"
          onPick={(a) =>
            setSources((all) => [
              ...all,
              { kind: 'asset', ref: a.assetId, title: a.altText ?? a.kind, excerpt: '' },
            ])
          }
        />
      </DialogContent>
    </Dialog>
  );
}

export function ApproveDialog({ fact, onClose, onDone, onConflict }: DialogBaseProps & { fact: FactDto }) {
  const { brandId } = useBrandContext();
  const trpc = useTRPC();
  const required = needsReviewerNote(fact);
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const settled = useFactSettled(onConflict);
  const approveIntent = useIntentKey();
  const approve = useMutation(
    trpc.brand.facts.approve.mutationOptions({
      ...mutationIntent(approveIntent.key),
      onSuccess: () => {
        approveIntent.renew();
        settled.success('Fact approved');
        onDone('Fact approved');
      },
      onError: (err) => {
        approveIntent.renew();
        settled.error(err);
      },
    }),
  );

  const error = touched && required && !note.trim() ? 'A reviewer note is required for this fact' : undefined;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (required && !note.trim()) return;
    approve.mutate({
      brandId,
      factId: fact.id,
      expectedVersion: fact.version,
      ...(note.trim() ? { reviewerNote: note.trim() } : {}),
    });
  };
  const ui = approve.isError ? toUiError(approve.error) : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Approve the fact" description={`“${fact.statement}”`} data-testid="approve-fact">
        <form onSubmit={submit} noValidate className="flex flex-col gap-3">
          {fact.supersedesFactId && (
            <StatusBanner
              tone="info"
              title="This is a correction"
              description="Approving it supersedes the fact it corrects; work citing that fact is held for review."
            />
          )}
          {required && (
            <StatusBanner
              tone="warning"
              title={
                fact.origin === 'inferred' ? 'Inferred, with no source' : 'AI suggestion, with no source'
              }
              description="Say why it holds before approving it: your note is kept with the fact as the reviewer's source."
            />
          )}
          <Field
            label={required ? 'Reviewer note' : 'Reviewer note (optional)'}
            htmlFor="approve-note"
            error={error}
          >
            <Textarea
              id="approve-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={3}
            />
          </Field>
          {ui && ui.kind !== 'conflict' && (
            <StatusBanner tone="critical" title="Not approved" description={ui.message} />
          )}
          <DialogActions>
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={approve.isPending}>
              Approve
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function WithdrawDialog({ fact, onClose, onDone, onConflict }: DialogBaseProps & { fact: FactDto }) {
  const { brandId } = useBrandContext();
  const trpc = useTRPC();
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const settled = useFactSettled(onConflict);
  const withdrawIntent = useIntentKey();
  const withdraw = useMutation(
    trpc.brand.facts.withdraw.mutationOptions({
      ...mutationIntent(withdrawIntent.key),
      onSuccess: () => {
        withdrawIntent.renew();
        settled.success('Fact withdrawn');
        onDone('Fact withdrawn');
      },
      onError: (err) => {
        withdrawIntent.renew();
        settled.error(err);
      },
    }),
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!reason.trim()) return;
    withdraw.mutate({ brandId, factId: fact.id, expectedVersion: fact.version, reason: reason.trim() });
  };
  const ui = withdraw.isError ? toUiError(withdraw.error) : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        role="alertdialog"
        title="Withdraw the fact"
        description={`“${fact.statement}”`}
        data-testid="withdraw-fact"
      >
        <form onSubmit={submit} noValidate className="flex flex-col gap-3">
          {fact.state === 'approved' && (
            <p className="text-sm text-muted-foreground">
              It stops applying at once. Scheduled posts that cite it are held for a person to review.
            </p>
          )}
          <Field
            label="Reason"
            htmlFor="withdraw-reason"
            error={touched && !reason.trim() ? 'Give a reason' : undefined}
          >
            <Textarea
              id="withdraw-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              rows={2}
            />
          </Field>
          {ui && ui.kind !== 'conflict' && (
            <StatusBanner tone="critical" title="Not withdrawn" description={ui.message} />
          )}
          <DialogActions>
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="danger" disabled={withdraw.isPending}>
              Withdraw
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ReviewedDialog({ fact, onClose, onDone, onConflict }: DialogBaseProps & { fact: FactDto }) {
  const { brandId } = useBrandContext();
  const trpc = useTRPC();
  const [next, setNext] = useState(toDayInput(new Date(Date.now() + 365 * DAY_MS).toISOString()));
  const [note, setNote] = useState('');
  const settled = useFactSettled(onConflict);
  const markIntent = useIntentKey();
  const mark = useMutation(
    trpc.brand.facts.markReviewed.mutationOptions({
      ...mutationIntent(markIntent.key),
      onSuccess: () => {
        markIntent.renew();
        settled.success('Marked as reviewed');
        onDone('Marked as reviewed');
      },
      onError: (err) => {
        markIntent.renew();
        settled.error(err);
      },
    }),
  );

  const nextIso = fromDayInput(next);
  const error =
    nextIso && new Date(nextIso).getTime() <= Date.now() ? 'Choose a date in the future' : undefined;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (error) return;
    mark.mutate({
      brandId,
      factId: fact.id,
      expectedVersion: fact.version,
      ...(nextIso ? { nextReviewDueAt: nextIso } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
  };
  const ui = mark.isError ? toUiError(mark.error) : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Mark the fact reviewed"
        description={`“${fact.statement}” still holds.`}
        data-testid="review-fact"
      >
        <form onSubmit={submit} noValidate className="flex flex-col gap-3">
          <Field label="Next review" htmlFor="review-next" error={error}>
            <Input id="review-next" type="date" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="Note (optional)" htmlFor="review-note">
            <Textarea
              id="review-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={2}
            />
          </Field>
          {ui && ui.kind !== 'conflict' && (
            <StatusBanner tone="critical" title="Not saved" description={ui.message} />
          )}
          <DialogActions>
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={mark.isPending}>
              Mark reviewed
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const OUTCOMES: Array<{ value: FactConflictOutcome; label: string; needsFact?: boolean }> = [
  { value: 'kept_this', label: 'This fact is right' },
  { value: 'kept_other', label: 'The other fact is right (this one is superseded)', needsFact: true },
  { value: 'annotated', label: 'Both stand: explain why' },
];

export function ConflictDialog({
  fact,
  conflictId,
  onClose,
  onDone,
  onConflict,
}: DialogBaseProps & { fact: FactDto; conflictId: string }) {
  const { brandId } = useBrandContext();
  const trpc = useTRPC();
  const conflict = fact.conflicts.find((c) => c.id === conflictId);
  const [outcome, setOutcome] = useState<FactConflictOutcome>('kept_this');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const settled = useFactSettled(onConflict);
  const resolveIntent = useIntentKey();
  const resolve = useMutation(
    trpc.brand.facts.resolveConflict.mutationOptions({
      ...mutationIntent(resolveIntent.key),
      onSuccess: () => {
        resolveIntent.renew();
        settled.success('Conflict resolved');
        onDone('Conflict resolved');
      },
      onError: (err) => {
        resolveIntent.renew();
        settled.error(err);
      },
    }),
  );

  const noteMissing = outcome === 'annotated' && !note.trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (noteMissing) return;
    resolve.mutate({
      brandId,
      factId: fact.id,
      expectedVersion: fact.version,
      conflictId,
      outcome,
      ...(note.trim() ? { note: note.trim() } : {}),
    });
  };
  const ui = resolve.isError ? toUiError(resolve.error) : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Resolve the conflict"
        description={`“${fact.statement}”`}
        data-testid="resolve-conflict"
      >
        <form onSubmit={submit} noValidate className="flex flex-col gap-3">
          <p className="text-sm">
            {conflict?.factStatement
              ? `Disagrees with “${conflict.factStatement}”`
              : 'Disagrees with a source'}
            {conflict?.note ? `: ${conflict.note}` : ''}
          </p>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-xs font-semibold">Decision</legend>
            {OUTCOMES.filter((o) => !o.needsFact || conflict?.factStatement).map((o) => (
              <label key={o.value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`conflict-${fact.id}-${conflictId}`}
                  value={o.value}
                  checked={outcome === o.value}
                  onChange={() => setOutcome(o.value)}
                />
                {o.label}
              </label>
            ))}
          </fieldset>
          <Field
            label={outcome === 'annotated' ? 'Note' : 'Note (optional)'}
            htmlFor="conflict-note"
            error={touched && noteMissing ? 'Explain why both stand' : undefined}
          >
            <Textarea
              id="conflict-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={2}
            />
          </Field>
          {ui && ui.kind !== 'conflict' && (
            <StatusBanner tone="critical" title="Not resolved" description={ui.message} />
          )}
          <DialogActions>
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={resolve.isPending}>
              Resolve
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Keep one fact; the others are superseded by it. The facts are read by id (a possible duplicate may sit on a page
 * not loaded yet). When an approved fact is among them, only an approved fact may be kept (the server's rule).
 */
export function MergeDialog({
  factIds,
  onClose,
  onDone,
  onConflict,
}: DialogBaseProps & { factIds: string[] }) {
  const { brandId } = useBrandContext();
  const trpc = useTRPC();
  const loaded = useFacts(brandId, { ids: factIds });
  const facts = (loaded.data?.items ?? []).filter((f) => f.state === 'proposed' || f.state === 'approved');
  const anyApproved = facts.some((f) => f.state === 'approved');
  const keepable = (f: FactDto) => !anyApproved || f.state === 'approved';
  const [choice, setChoice] = useState<string | null>(null);
  const keep = choice ?? facts.find(keepable)?.id ?? '';
  const settled = useFactSettled(onConflict);
  const mergeIntent = useIntentKey();
  const merge = useMutation(
    trpc.brand.facts.merge.mutationOptions({
      ...mutationIntent(mergeIntent.key),
      onSuccess: () => {
        mergeIntent.renew();
        settled.success('Facts merged');
        onDone('Facts merged');
      },
      onError: (err) => {
        mergeIntent.renew();
        settled.error(err);
      },
    }),
  );
  const kept = facts.find((f) => f.id === keep);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!kept || facts.length < 2) return;
    merge.mutate({
      brandId,
      keep: { factId: kept.id, expectedVersion: kept.version },
      merge: facts.filter((f) => f.id !== kept.id).map((f) => ({ factId: f.id, expectedVersion: f.version })),
    });
  };
  const ui = merge.isError ? toUiError(merge.error) : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Merge facts"
        description="Keep one statement; the others are superseded by it and their sources join it. Work citing an approved fact that is superseded is held for review."
        data-testid="merge-facts"
      >
        {loaded.isPending && <Skeleton label="Loading the facts" lines={2} />}
        {loaded.isError && <RequestError error={loaded.error} onRetry={() => void loaded.refetch()} />}
        {loaded.isSuccess && (
          <form onSubmit={submit} noValidate className="flex flex-col gap-3">
            {facts.length < 2 && (
              <StatusBanner
                tone="warning"
                title="Nothing to merge"
                description="These facts no longer apply or are not visible; reload the list."
              />
            )}
            <fieldset
              className="flex flex-col gap-2"
              aria-describedby={anyApproved ? 'merge-keep-hint' : undefined}
            >
              <legend className="text-xs font-semibold">Keep</legend>
              {anyApproved && (
                <p id="merge-keep-hint" className="text-xs text-muted-foreground">
                  An approved fact is among them, so the one you keep must be approved too: approve a proposal
                  first if it should be the one that stays.
                </p>
              )}
              {facts.map((f) => (
                <label key={f.id} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    className="mt-1"
                    name="merge-keep"
                    value={f.id}
                    checked={keep === f.id}
                    disabled={!keepable(f)}
                    onChange={() => setChoice(f.id)}
                  />
                  <span className="min-w-0 break-words">
                    {f.statement} <Badge tone={STATE_TONE[f.state]}>{STATE_LABEL[f.state]}</Badge>
                  </span>
                </label>
              ))}
            </fieldset>
            {ui && ui.kind !== 'conflict' && (
              <StatusBanner tone="critical" title="Not merged" description={ui.message} />
            )}
            <DialogActions>
              <DialogClose asChild>
                <Button type="button" variant="ghost">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" variant="primary" disabled={merge.isPending || !kept || facts.length < 2}>
                Merge {facts.length} facts
              </Button>
            </DialogActions>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
