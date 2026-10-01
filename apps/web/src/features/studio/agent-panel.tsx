import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreativePage } from '@oremedia/contracts/creative';
import { applyBatch, changedElementIds } from '@oremedia/editor';
import { Badge, Button, EmptyState, Field, StatusBanner, Textarea } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { toUiError } from '../../lib/errors';
import { intentContext, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import {
  LIVE,
  useAgentPrincipals,
  useAgentRun,
  useAgentRunSteps,
  usePendingProposals,
  type PendingProposalDto,
} from '../agents/use-agent-runs';
import type { ElementDiff } from './diff';
import { ProposalPanel } from './proposal-panel';
import type { Proposal, StudioState } from './types';
import type { StudioApi } from './use-studio';

/** The run a person started from this document, kept per tab so leaving and returning shows its progress. */
const runKey = (documentId: string) => `oremedia.studio.run.${documentId}`;
const readRun = (documentId: string): string | null => {
  try {
    return sessionStorage.getItem(runKey(documentId));
  } catch {
    return null;
  }
};
const writeRun = (documentId: string, runId: string | null) => {
  try {
    if (runId) sessionStorage.setItem(runKey(documentId), runId);
    else sessionStorage.removeItem(runKey(documentId));
  } catch {
    // storage blocked: progress is shown while the tab stays open
  }
};

/**
 * A run's proposal as the studio's pending proposal: the payload's operations evaluated on the committed revision
 * when it is still the proposal's base (the overlay and diff come from that), stale otherwise (the panel says so).
 */
function proposalOf(item: PendingProposalDto, state: StudioState): Proposal {
  const batch = {
    operations: item.proposal.operations,
    summary: item.proposal.summary,
    origin: 'agent' as const,
  };
  const onBase = item.proposal.baseRevisionId === state.committed.revisionId;
  let snapshot = state.committed.snapshot;
  if (onBase) {
    try {
      snapshot = applyBatch(state.committed.snapshot, batch, { templates: state.templates });
    } catch {
      // an operation the head no longer takes: shown as the proposal's base, the server refuses it on accept
    }
  }
  return {
    id: item.stepId,
    batch,
    baseRevisionId: item.proposal.baseRevisionId,
    result: {
      baseRevisionId: item.proposal.baseRevisionId,
      snapshot,
      contentHash: item.proposal.contentHash,
      findings: item.proposal.findings,
      blocking: item.proposal.findings.some((f) => f.severity === 'blocking'),
      changedElementIds: changedElementIds(batch),
    },
    source: 'agent',
    run: { runId: item.runId, stepId: item.stepId },
  };
}

const RUN_TEXT: Record<string, string> = {
  planned: 'Queued',
  running: 'Working',
  waiting_for_review: 'Proposal ready',
  completed: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
  budget_exhausted: 'Stopped: budget exhausted',
  policy_denied: 'Stopped: policy denied',
  waiting_expired: 'Stopped: nobody decided in time',
};

export interface AgentPanelProps {
  brandId: string;
  documentId: string;
  page: CreativePage;
  state: StudioState;
  studio: StudioApi;
  proposalDiff: ElementDiff[] | null;
  hasLocalWork: boolean;
  readOnly: boolean;
  /** Development only: the dry-run simulation button (kept for the proposal overlay smoke). */
  simulate?: () => void;
}

/**
 * UX-07 studio agent conversation: a request starts a layout run on this document under a principal granted the
 * brand; its progress is read from the run, and the proposal it parks on is the same one after a leave and
 * return because it lives on the run. Accept, Modify and Reject go through agents.runs.approveProposal; the
 * server applies an accepted batch as the agent's revision (refused when the head moved), a modified one as the
 * person's.
 */
export function AgentPanel({
  brandId,
  documentId,
  page,
  state,
  studio,
  proposalDiff,
  hasLocalWork,
  readOnly,
  simulate,
}: AgentPanelProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [runId, setRunId] = useState<string | null>(() => readRun(documentId));
  const [instruction, setInstruction] = useState('');
  const principals = useAgentPrincipals(brandId);
  const [principalId, setPrincipalId] = useState('');
  const chosen = principals.items.find((p) => p.id === principalId) ?? principals.items[0] ?? null;
  const run = useAgentRun(runId);
  const live = run.data ? LIVE.has(run.data.state) : runId !== null;
  const steps = useAgentRunSteps(runId, live);
  const pending = usePendingProposals(brandId, documentId, live);
  const latestStep = steps.data?.items.at(-1) ?? null;

  const start = useMutation(
    trpc.agents.runs.start.mutationOptions({
      trpc: intentContext(intent.key),
      onSuccess: (res) => {
        intent.renew();
        setInstruction('');
        setRunId(res.runId);
        writeRun(documentId, res.runId);
        void queryClient.invalidateQueries(trpc.agents.runs.pathFilter());
      },
    }),
  );
  const cancel = useMutation(
    trpc.agents.runs.cancel.mutationOptions({
      trpc: intentContext(intent.key),
      onSuccess: () => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.agents.runs.pathFilter());
      },
    }),
  );
  const decide = useMutation(
    trpc.agents.runs.approveProposal.mutationOptions({
      trpc: intentContext(intent.key),
      onSuccess: async (res) => {
        intent.renew();
        studio.clearProposal();
        void queryClient.invalidateQueries(trpc.agents.runs.pathFilter());
        // A modified batch is applied at once; an accepted one is applied by the run, so the head is re-read as
        // the run moves on (the poll below) and once more now in case it already has.
        await studio.refreshHead();
        studio.dispatch({
          type: 'notice',
          notice: {
            tone: 'info',
            text:
              res.decision === 'accept'
                ? 'Accepted: the agent applies its proposal as the next revision.'
                : res.decision === 'modify'
                  ? 'Applied as your revision; edit on from here.'
                  : 'Rejected: the agent is told and continues.',
          },
        });
      },
    }),
  );

  // The server-side proposal for this document is the studio's pending proposal (and vanishes once decided).
  const serverProposal = pending.data?.items[0] ?? null;
  const shownRun = state.proposal?.run?.stepId ?? null;
  useEffect(() => {
    if (serverProposal && shownRun !== serverProposal.stepId)
      studio.setProposal(proposalOf(serverProposal, state));
    else if (!serverProposal && shownRun !== null && pending.isSuccess) studio.clearProposal();
  }, [serverProposal, shownRun, pending.isSuccess, state, studio]);

  // Once the run has moved on (it applied, or was told), re-read the head once so the agent's revision shows.
  const runState = run.data?.state ?? null;
  const settled = useRef<string | null>(null);
  useEffect(() => {
    if (!runId || !runState || LIVE.has(runState)) return;
    const mark = `${runId}:${runState}`;
    if (settled.current === mark) return;
    settled.current = mark;
    void studio.refreshHead();
    writeRun(documentId, null);
  }, [runId, runState, studio, documentId]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!chosen || !instruction.trim()) return;
    const headline = page.elements.find((el) => el.type === 'text' && !el.locked && !el.protected);
    start.mutate({
      brandId,
      servicePrincipalId: chosen.id,
      taskKind: 'layout',
      requestedAutonomy: 'create',
      brief: {
        documentId,
        baseRevisionId: state.committed.revisionId,
        copy: { headline: headline?.type === 'text' ? headline.text : instruction.trim() },
        formatKeys: [page.formatKey],
        notes: instruction.trim(),
      },
    });
  };
  const startUi = start.isError ? toUiError(start.error) : null;
  const decideUi = decide.isError ? toUiError(decide.error) : null;
  const blocked = readOnly
    ? 'This document is read-only'
    : principals.isSuccess && principals.items.length === 0
      ? 'No agent principal is granted this brand'
      : !instruction.trim()
        ? 'Say what the agent should change'
        : live
          ? 'Wait for the current run'
          : undefined;

  return (
    <div className="flex flex-col gap-3" data-testid="agent-panel">
      {state.proposal && proposalDiff ? (
        <section aria-labelledby="proposal-heading" className="flex flex-col gap-2">
          <h2 id="proposal-heading" className="text-sm font-semibold">
            Agent proposal
          </h2>
          <ProposalPanel
            proposal={state.proposal}
            diff={proposalDiff}
            headRevisionId={state.committed.revisionId}
            hasLocalWork={hasLocalWork || decide.isPending}
            onAccept={() =>
              state.proposal?.run
                ? decide.mutate({ ...state.proposal.run, decision: 'accept' })
                : studio.acceptProposal()
            }
            onModify={() =>
              state.proposal?.run
                ? decide.mutate({
                    ...state.proposal.run,
                    decision: 'modify',
                    batch: {
                      documentId,
                      baseRevisionId: state.committed.revisionId,
                      operations: state.proposal.batch.operations,
                      summary: state.proposal.batch.summary,
                    },
                  })
                : studio.modifyProposal()
            }
            onReject={() =>
              state.proposal?.run
                ? decide.mutate({ ...state.proposal.run, decision: 'reject' })
                : studio.rejectProposal()
            }
          />
          {decideUi && decideUi.kind === 'forbidden' && (
            <StatusBanner
              tone="critical"
              title="Permission denied"
              description={`${decideUi.message} Deciding on a creative proposal needs creative.edit for this brand.`}
            />
          )}
          {decideUi && decideUi.kind !== 'forbidden' && (
            <RequestError error={decide.error} title="The decision was not recorded" />
          )}
        </section>
      ) : (
        <EmptyState
          title="No agent proposal"
          description="Ask the agent below. Its change arrives here as a proposal you accept, modify or reject; nothing lands on the document without you."
          className="py-4"
          action={
            simulate ? (
              <Button size="sm" onClick={simulate} data-testid="simulate-proposal">
                Development only: simulate an agent proposal
              </Button>
            ) : undefined
          }
        />
      )}

      {runId && (
        <section aria-labelledby="agent-run-heading" className="flex flex-col gap-2" data-testid="agent-run">
          <h2 id="agent-run-heading" className="text-sm font-semibold">
            Current run
          </h2>
          {run.isPending && <p className="text-xs text-muted-foreground">Reading the run…</p>}
          {run.isError && <RequestError error={run.error} onRetry={() => void run.refetch()} />}
          {run.data && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={run.data.state === 'failed' ? 'critical' : live ? 'info' : 'good'} glyph={!live}>
                {RUN_TEXT[run.data.state] ?? run.data.state}
              </Badge>
              {latestStep && (
                <span className="text-xs text-muted-foreground" data-testid="agent-run-step">
                  {latestStep.summary}
                </span>
              )}
              {live && run.data.state !== 'waiting_for_review' && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate({ runId: run.data.id, reason: 'Stopped from the studio' })}
                >
                  Cancel
                </Button>
              )}
              {!live && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRunId(null);
                    writeRun(documentId, null);
                  }}
                >
                  Dismiss
                </Button>
              )}
            </div>
          )}
          {cancel.isError && <RequestError error={cancel.error} title="The run was not cancelled" />}
        </section>
      )}

      <form onSubmit={submit} className="flex flex-col gap-2 border-t border-border pt-3" noValidate>
        <Field
          label="Ask the agent"
          htmlFor="agent-instruction"
          hint="A layout run on this page from the saved revision; the result comes back as a proposal."
        >
          <Textarea
            id="agent-instruction"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={3}
            maxLength={4000}
            placeholder="Tighten the headline and give the photo more room"
          />
        </Field>
        {principals.isSuccess && principals.items.length > 1 && (
          <Field label="Service principal" htmlFor="agent-principal">
            <Select
              id="agent-principal"
              value={chosen?.id ?? ''}
              onValueChange={setPrincipalId}
              options={principals.items.map((p) => ({ value: p.id, label: p.name }))}
              size="sm"
            />
          </Field>
        )}
        {principals.isError && toUiError(principals.error).kind === 'forbidden' && (
          <StatusBanner
            tone="critical"
            title="Permission denied"
            description={`${toUiError(principals.error).message} Starting a run needs agent.start_run for this brand.`}
            data-testid="agent-denied"
          />
        )}
        {startUi && startUi.kind === 'forbidden' && (
          <StatusBanner tone="critical" title="Permission denied" description={startUi.message} />
        )}
        {startUi && startUi.kind !== 'forbidden' && (
          <RequestError error={start.error} title="The run did not start" />
        )}
        <div>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={start.isPending || Boolean(blocked) || !chosen}
            disabledReason={blocked}
            data-testid="agent-send"
          >
            {start.isPending ? 'Starting…' : 'Send'}
          </Button>
        </div>
      </form>
    </div>
  );
}
