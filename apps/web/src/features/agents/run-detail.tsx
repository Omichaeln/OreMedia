import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Field,
  Input,
  KpiStrip,
  Skeleton,
  StatusDot,
  Textarea,
  cn,
  toneGlyph,
  type Tone,
} from '@oremedia/ui';
import { Dialog, DialogActions, DialogClose, DialogContent } from '../../components/dialog';
import { Drawer, DrawerContent } from '../../components/drawer';
import { RequestError } from '../../components/request-state';
import { useToast } from '../../components/toast';
import { brandPath } from '../brand/brand-context';
import { toUiError } from '../../lib/errors';
import { intentContext, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { JsonTree } from './json-tree';
import {
  STEP_KIND_LABEL,
  formatCompactTokens,
  formatDuration,
  formatMicros,
  formatTokens,
  humanise,
  invocationLine,
  isTerminalState,
  modifyBatchOf,
  needsAttention,
  pendingProposal,
  reviewedOperations,
  runFigures,
  runStateChip,
  runTitle,
  stepTone,
  type PendingProposal,
  type ReviewedOperation,
} from './run-helpers';
import {
  useAgentRun,
  useAgentRunSteps,
  type InvocationDto,
  type RunDto,
  type StepDto,
} from './use-agent-runs';

export interface RunDetailProps {
  companyId: string;
  brandId: string;
  runId: string;
}

const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : '—');

/** The detail column's gutter: the interface's 32 × 36 px, less at phone width. */
const GUTTER = 'px-5 py-6 sm:px-9 sm:py-8';

/**
 * Run detail as the interface sets it: the id, principal, task and mode as an eyebrow, the goal as the title, the
 * state as a dot and a word, the figures (tool calls, tokens, cost) in a ruled strip, anything that needs attention
 * as tinted notes, the steps with their tool lines and timings, the redaction note, then the actions. Never
 * reasoning (spec 12.7): the steps show what was called, what came back and what it cost.
 */
export function RunDetail({ companyId, brandId, runId }: RunDetailProps) {
  const run = useAgentRun(runId);
  const live = run.data ? !isTerminalState(run.data.state) : false;
  const steps = useAgentRunSteps(runId, live);
  const headingRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    headingRef.current?.focus(); // managed focus: selecting a run moves focus to its detail (spec 21.3)
  }, [runId]);

  if (run.isPending)
    return (
      <div className={GUTTER} data-testid="run-detail">
        <Skeleton label="Loading run" lines={4} />
      </div>
    );
  if (run.isError)
    return (
      <div className={GUTTER} data-testid="run-detail">
        <RequestError
          error={run.error}
          onRetry={() => void run.refetch()}
          title={
            toUiError(run.error).kind === 'forbidden'
              ? 'Restricted: this run is not in a brand you can see'
              : undefined
          }
        />
      </div>
    );
  const chip = runStateChip(run.data.state);
  const items = steps.data?.items ?? [];
  const attention = needsAttention(run.data, items);
  const proposal = run.data.state === 'waiting_for_review' ? pendingProposal(items) : null;
  const figures = runFigures(run.data, items);
  return (
    <section
      aria-labelledby="run-title"
      className={cn('om-in flex max-w-[760px] flex-col gap-6 pb-12 sm:pb-16', GUTTER)}
      data-testid="run-detail"
      data-run-state={run.data.state}
    >
      <div
        ref={headingRef}
        tabIndex={-1}
        className="flex flex-col gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <p className="text-xs tabular-nums text-muted-foreground">
          {run.data.id} · {run.data.servicePrincipalId} · {humanise(run.data.taskKind)} ·{' '}
          {humanise(run.data.autonomyMode)} mode
        </p>
        <h2 id="run-title" className="text-xl font-bold tracking-title">
          {runTitle(run.data)}
        </h2>
        <p className="flex flex-wrap items-center gap-1.5 text-sm">
          <StatusDot tone={chip.tone} />
          <span className="sr-only">{toneGlyph[chip.tone]} </span>
          <span data-testid="run-state">{chip.label}</span>
          {live && <span className="text-xs text-muted-foreground">· refreshing every 5 s</span>}
        </p>
      </div>
      <KpiStrip
        size="md"
        items={[
          { label: 'Tool calls', value: steps.isSuccess ? figures.toolCalls : '—' },
          { label: 'Tokens', value: steps.isSuccess ? formatCompactTokens(figures.tokens) : '—' },
          { label: 'Cost', value: formatMicros(figures.costMicros), testId: 'run-cost' },
        ]}
      />
      {attention.length > 0 && (
        <section
          aria-labelledby="run-attention"
          data-testid="needs-attention"
          className="flex flex-col gap-2"
        >
          <h3 id="run-attention" className="sr-only">
            Needs attention
          </h3>
          {attention.map((a, i) => (
            <Note key={i} tone={a.tone} title={a.title} detail={a.detail} />
          ))}
        </section>
      )}
      {run.data.state === 'waiting_for_review' && steps.isSuccess && !proposal && (
        <Note
          tone="warning"
          title="Proposal not found"
          detail="The run is waiting for review but no proposal invocation is recorded yet; it refreshes automatically."
        />
      )}
      <section aria-labelledby="run-steps" className="flex flex-col">
        <h3 id="run-steps" className="sr-only">
          Steps
        </h3>
        {steps.isPending && <Skeleton label="Loading steps" lines={3} />}
        {steps.isError && <RequestError error={steps.error} onRetry={() => void steps.refetch()} />}
        {steps.isSuccess && items.length === 0 && (
          <p role="status" className="border-t border-border py-3 text-sm text-muted-foreground">
            {live
              ? 'No steps recorded yet: the run has not reached its first step; this list refreshes automatically.'
              : 'No steps recorded: the run ended before any step was recorded.'}
          </p>
        )}
        {steps.isSuccess && items.length > 0 && <Timeline steps={items} />}
      </section>
      <p className="text-xs text-muted-foreground">
        Model reasoning isn’t stored. Inputs are redacted; actions, outputs and costs are kept.
      </p>
      <details className="text-xs">
        <summary className="inline-flex min-h-6 cursor-pointer items-center rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Run record
        </summary>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">Initiator</dt>
          <dd>
            {run.data.initiatorKind} <code>{run.data.initiatorId}</code>
          </dd>
          <dt className="text-muted-foreground">Service principal</dt>
          <dd>
            <code>{run.data.servicePrincipalId}</code>
          </dd>
          <dt className="text-muted-foreground">Started</dt>
          <dd>{when(run.data.createdAt)}</dd>
          <dt className="text-muted-foreground">Finished</dt>
          <dd>{when(run.data.finishedAt)}</dd>
          <dt className="text-muted-foreground">Deadline</dt>
          <dd>{when(run.data.deadlineAt)}</dd>
          <dt className="text-muted-foreground">Model</dt>
          <dd>
            {run.data.modelConfig['provider']} / {run.data.modelConfig['model']}
          </dd>
          <dt className="text-muted-foreground">Correlation</dt>
          <dd>
            <code>{run.data.correlationId}</code>
          </dd>
        </dl>
      </details>
      {(proposal || !isTerminalState(run.data.state)) && (
        <div className="flex flex-wrap gap-2">
          {proposal && (
            <ReviewProposal companyId={companyId} brandId={brandId} run={run.data} proposal={proposal} />
          )}
          <CancelRun run={run.data} />
        </div>
      )}
    </section>
  );
}

/** The interface's tinted note: what happened or what is needed, polite (the run is a record), never colour alone. */
function Note({ tone, title, detail }: { tone: Tone; title: string; detail: string }) {
  return (
    <p
      role="status"
      className={cn(
        'om-in rounded-lg px-3.5 py-2.5 text-sm text-pretty',
        tone === 'critical'
          ? 'bg-status-critical-tint'
          : tone === 'warning'
            ? 'bg-status-warning-tint'
            : 'bg-accent-tint',
      )}
    >
      <span className="sr-only">{toneGlyph[tone]} </span>
      <strong className="font-bold">{title}.</strong> {detail}
    </p>
  );
}

/** The steps as the interface's rows: a dot, what the step did, its tool lines, and its timing on the right. */
function Timeline({ steps }: { steps: StepDto[] }) {
  return (
    <ol className="flex flex-col" aria-label="Steps" data-testid="timeline">
      {steps.map((s, i) => {
        const tone = stepTone(s);
        const metrics = [
          s.tokensIn + s.tokensOut > 0 && `${formatTokens(s.tokensIn)} in / ${formatTokens(s.tokensOut)} out`,
          s.costMicros > 0 && formatMicros(s.costMicros),
        ].filter((m): m is string => typeof m === 'string');
        return (
          <li
            key={s.id}
            className="om-in grid grid-cols-[20px_minmax(0,1fr)_auto] gap-3 border-t border-border py-3"
            style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}
            data-testid="step"
            data-step-kind={s.kind}
          >
            <span className="flex items-start pt-1.5">
              <StatusDot tone={tone} />
              <span className="sr-only">
                {toneGlyph[tone]} {STEP_KIND_LABEL[s.kind]}
              </span>
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-sm">{s.summary}</span>
              {s.invocations.map((inv) => (
                <Invocation key={inv.id} invocation={inv} />
              ))}
              {metrics.length > 0 && (
                <code className="truncate font-sans text-xs tabular-nums text-muted-foreground">
                  {metrics.join(' · ')}
                </code>
              )}
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">
              {s.durationMs > 0 ? formatDuration(s.durationMs) : '—'}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** One tool call: "tool → result", its policy and outcome when they are not the ordinary allowed/ok, and the redacted input. */
function Invocation({ invocation: i }: { invocation: InvocationDto }) {
  const line = invocationLine(i);
  const notable = i.policyDecision !== 'allowed' || i.outcome !== 'ok';
  return (
    <div
      className="flex min-w-0 flex-col gap-0.5"
      data-testid="invocation"
      data-policy-decision={i.policyDecision}
    >
      <code className="truncate font-sans text-xs tabular-nums text-muted-foreground" title={line}>
        {line}
        {notable && ` · policy ${i.policyDecision} · outcome ${i.outcome}`}
      </code>
      <details className="text-xs">
        <summary className="inline-flex min-h-6 cursor-pointer items-center rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Redacted input (hash {i.inputHash.slice(0, 12)}…)
        </summary>
        <div className="mt-1">
          <JsonTree value={i.inputRedacted} label={`Redacted input of ${i.toolName}`} />
        </div>
      </details>
    </div>
  );
}

/** Spec 13.5: cancel moves the row and signals the workflow; the person confirms first. */
function CancelRun({ run }: { run: RunDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const intent = useIntentKey();
  const cancel = useMutation(
    trpc.agents.runs.cancel.mutationOptions({
      trpc: intentContext(intent.key),
      onSuccess: () => {
        intent.renew();
        setOpen(false);
        void queryClient.invalidateQueries(trpc.agents.pathFilter());
        toast({ tone: 'neutral', title: 'Run cancelled' });
      },
    }),
  );
  if (isTerminalState(run.state)) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button onClick={() => setOpen(true)}>Cancel run</Button>
      <DialogContent
        role="alertdialog"
        title="Cancel this run?"
        description="The run stops at its next checkpoint, its budget reservation is released and any pending proposal is dropped. This cannot be undone."
      >
        {cancel.isError && <RequestError error={cancel.error} className="mb-2" />}
        <DialogActions>
          <DialogClose asChild>
            <Button>Keep running</Button>
          </DialogClose>
          <Button
            variant="danger"
            onClick={() => cancel.mutate({ runId: run.id })}
            disabled={cancel.isPending}
            data-testid="confirm-cancel"
          >
            {cancel.isPending ? 'Cancelling…' : 'Cancel run'}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

/** The interface's "Review proposal": the pending proposal opens in a side sheet for the decision. */
function ReviewProposal({
  companyId,
  brandId,
  run,
  proposal,
}: {
  companyId: string;
  brandId: string;
  run: RunDto;
  proposal: PendingProposal;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <Button variant="primary" onClick={() => setOpen(true)}>
        Review proposal
      </Button>
      <DrawerContent title="Review proposal" side="right" className="w-[min(92vw,34rem)] overflow-y-auto p-5">
        {open && (
          <ProposalDecision
            companyId={companyId}
            brandId={brandId}
            run={run}
            proposal={proposal}
            onDecided={() => setOpen(false)}
          />
        )}
      </DrawerContent>
    </Drawer>
  );
}

/**
 * Spec 12.2 proposalDecision through agents.runs.approveProposal: Accept applies the batch as the run's principal,
 * Reject sends the model back, Modify applies the person's own batch: the proposed operations reviewed one by one
 * (RA-07), any of them removed, each proposed text edited in place, under the person's summary; the studio shows
 * the document it targets. Nothing is typed as JSON; the creative module validates the batch as it would any edit.
 */
function ProposalDecision({
  companyId,
  brandId,
  run,
  proposal,
  onDecided,
}: {
  companyId: string;
  brandId: string;
  run: RunDto;
  proposal: PendingProposal;
  onDecided: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const intent = useIntentKey();
  const [modifying, setModifying] = useState(false);
  const [rows, setRows] = useState<ReviewedOperation[]>(() =>
    reviewedOperations(proposal.payload.operations),
  );
  const [summary, setSummary] = useState(proposal.payload.summary);
  const [modifyError, setModifyError] = useState<string | null>(null);
  const decide = useMutation(
    trpc.agents.runs.approveProposal.mutationOptions({
      trpc: intentContext(intent.key),
      onSuccess: (res) => {
        intent.renew();
        setModifying(false);
        onDecided();
        void queryClient.invalidateQueries(trpc.agents.pathFilter());
        toast({
          tone: 'good',
          title: `Proposal ${res.decision === 'accept' ? 'accepted' : res.decision === 'reject' ? 'rejected' : 'modified'}`,
          description: res.appliedRevisionId ? `Applied as revision ${res.appliedRevisionId}.` : undefined,
        });
      },
    }),
  );
  const kept = rows.filter((r) => r.kept);
  const setRow = (index: number, patch: Partial<ReviewedOperation>) =>
    setRows((rs) => rs.map((r) => (r.index === index ? { ...r, ...patch } : r)));
  const submitModify = () => {
    if (kept.length === 0) {
      setModifyError('Keep at least one operation, or reject the proposal instead.');
      return;
    }
    if (!summary.trim()) {
      setModifyError('Give the change a summary; it is recorded with the revision.');
      return;
    }
    setModifyError(null);
    decide.mutate({
      runId: run.id,
      stepId: proposal.stepId,
      decision: 'modify',
      batch: modifyBatchOf(proposal.payload, rows, summary.trim()),
    });
  };
  const blocking = proposal.payload.findings.filter((f) => f.severity === 'blocking');
  const decideUi = decide.isError ? toUiError(decide.error) : null;
  const batchIssue = decideUi?.details.find((d) => d.path?.startsWith('batch'));
  return (
    <section aria-labelledby="proposal-title" data-testid="proposal" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <p className="text-xs tabular-nums text-muted-foreground">
          {run.id} · {humanise(run.taskKind)} · base revision {proposal.payload.baseRevisionId}
        </p>
        <h2 id="proposal-title" className="text-lg font-bold tracking-title">
          Review proposal
        </h2>
        <p className="text-sm">
          {proposal.payload.summary || `${proposal.payload.operations.length} operation(s)`}
        </p>
      </div>
      <Note
        tone={blocking.length > 0 ? 'critical' : 'warning'}
        title="Agent proposal pending"
        detail={`${proposal.payload.operations.length} operation${proposal.payload.operations.length === 1 ? '' : 's'} on the document, awaiting a person.`}
      />
      <p className="text-sm">
        <Link
          to={brandPath(companyId, brandId, `studio/${encodeURIComponent(proposal.payload.documentId)}`)}
          className="underline"
        >
          Open <code>{proposal.payload.documentId}</code> in the studio
        </Link>
      </p>
      {proposal.payload.findings.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" aria-label="Findings">
          {proposal.payload.findings.map((f, i) => (
            <li key={i} className="flex items-start gap-2">
              <Badge
                tone={f.severity === 'blocking' ? 'critical' : f.severity === 'warning' ? 'warning' : 'info'}
              >
                {f.severity}
              </Badge>
              <span>{f.message}</span>
            </li>
          ))}
        </ul>
      )}
      {!modifying && (
        <details className="text-xs">
          <summary className="inline-flex min-h-6 cursor-pointer items-center rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Proposed operations
          </summary>
          <div className="mt-1">
            <JsonTree value={proposal.payload.operations} label="Proposed operations" />
          </div>
        </details>
      )}
      {decide.isError && !batchIssue && <RequestError error={decide.error} title="Decision not recorded" />}
      {!modifying && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={decide.isPending}
            disabledReason={
              blocking.length > 0
                ? `Blocked by ${blocking.length} finding${blocking.length === 1 ? '' : 's'}; modify it or reject`
                : undefined
            }
            onClick={() => decide.mutate({ runId: run.id, stepId: proposal.stepId, decision: 'accept' })}
          >
            Accept
          </Button>
          <Button disabled={decide.isPending} onClick={() => setModifying(true)}>
            Modify
          </Button>
          <Button
            variant="danger"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ runId: run.id, stepId: proposal.stepId, decision: 'reject' })}
          >
            Reject
          </Button>
        </div>
      )}
      {modifying && (
        <form
          className="flex flex-col gap-3"
          noValidate
          data-testid="modify-proposal"
          onSubmit={(e) => {
            e.preventDefault();
            submitModify();
          }}
        >
          <p className="text-xs text-muted-foreground">
            Review each proposed change. Remove the ones you do not want and edit any text; what is left is
            applied to the document as your own change, validated like any edit.
          </p>
          <ol className="flex flex-col gap-2" aria-label="Proposed operations to review">
            {rows.map((r) => (
              <li
                key={r.index}
                className={`flex flex-col gap-2 rounded-lg border border-border p-3 text-sm${r.kept ? '' : ' opacity-60'}`}
                data-testid="modify-operation"
                data-kept={r.kept}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">#{r.index + 1}</span>
                  <span className="font-medium">{r.label}</span>
                  <span className="text-xs text-muted-foreground">{r.target}</span>
                  {!r.kept && <Badge tone="neutral">removed</Badge>}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => setRow(r.index, { kept: !r.kept })}
                  >
                    {r.kept ? `Remove #${r.index + 1}` : `Restore #${r.index + 1}`}
                  </Button>
                </div>
                {r.text !== null && r.kept && (
                  <Field label="Text" htmlFor={`modify-op-${r.index}-text`}>
                    <Textarea
                      id={`modify-op-${r.index}-text`}
                      value={r.text}
                      onChange={(e) => setRow(r.index, { text: e.target.value })}
                      rows={2}
                    />
                  </Field>
                )}
              </li>
            ))}
          </ol>
          <Field
            label="Summary of your change"
            htmlFor="modify-summary"
            hint="Recorded with the revision, as the agent's summary would have been."
            error={modifyError ?? batchIssue?.issue}
          >
            <Input id="modify-summary" value={summary} onChange={(e) => setSummary(e.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={decide.isPending}>
              {decide.isPending
                ? 'Applying…'
                : `Apply ${kept.length} of ${rows.length} operation${rows.length === 1 ? '' : 's'}`}
            </Button>
            <Button type="button" onClick={() => setModifying(false)}>
              Back
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
