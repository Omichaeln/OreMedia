import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { IMAGE_CREATIVE_KINDS } from '@oremedia/contracts/assets';
import type { ContentType, CreativePage } from '@oremedia/contracts/creative';
import type { GenerationBriefInput, GenerationRequest } from '@oremedia/contracts/generation';
import { applyBatch, changedElementIds, findElement, formatFor, FORMAT_DEFINITIONS } from '@oremedia/editor';
import { Badge, Button, Field, Input, StatusBanner, Textarea } from '@oremedia/ui';
import type { z } from 'zod';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { toUiError } from '../../lib/errors';
import { intentContext, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { useAssetSearch } from '../assets/use-assets';
import { brandPath, useBrandContext } from '../brand/brand-context';
import { useBrandVersion, useFacts } from '../brand/use-brand';
import { useChannelLimits } from '../publishing/use-publishing';
import { CONTENT_TYPES } from './create/content-types';
import type { ElementDiff } from './diff';
import { ProposalPanel } from './proposal-panel';
import type { Proposal, StudioState } from './types';
import { useTemplates } from './use-document';
import {
  useActiveGenerations,
  useGenerationJob,
  useGenerationPreflight,
  type GenerationJobDto,
  type GenerationPreflightDto,
  type GenerationPreflightInput,
} from './use-generation';
import type { StudioApi } from './use-studio';

/**
 * STU-1b generate panel: a brief for the whole graphic (defaults from the document, its template and the published
 * brand system, so nothing that is known is asked again) or a plain-language change to the selection or page. Either
 * is checked by the server's preflight (inputs, constraints, missing requirements, cost against the budget) before it
 * can start; the job then runs durably and the panel follows it (and finds it again after a reload). A first
 * generation into a fresh document lands as a revision (undoable); everything else comes back as a proposal whose
 * changes are kept or left out one by one.
 */

const handledKey = (documentId: string) => `oremedia.studio.generation.${documentId}`;
const readHandled = (documentId: string): string | null => {
  try {
    return sessionStorage.getItem(handledKey(documentId));
  } catch {
    return null;
  }
};
const writeHandled = (documentId: string, jobId: string) => {
  try {
    sessionStorage.setItem(handledKey(documentId), jobId);
  } catch {
    // storage blocked: the panel only forgets what it already showed in this tab
  }
};

const STATE_TEXT: Record<GenerationJobDto['state'], string> = {
  queued: 'Queued',
  generating: 'Writing and choosing images',
  validating: 'Checking against the brand',
  saving: 'Saving',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const ERROR_TEXT: Record<string, string> = {
  budget_exhausted: 'The generation budget is used up for now.',
  policy_denied: 'You or the model are not permitted to do this.',
  model_failed: 'The model provider did not answer. Try again.',
  model_output_invalid: 'The model answered in a form that could not be used. Try again.',
  validation_failed: 'The generated changes did not pass the brand checks.',
  stale_document:
    'The document changed while the generation ran; nothing was saved. Start again from the current revision.',
  not_found: 'Something the generation needed is no longer there.',
  failed: 'The generation failed.',
};

const REFUSED_TEXT = (reason: string): string => {
  if (reason.startsWith('fact_not_effective')) return 'cites a fact that is not in force';
  if (reason.startsWith('text_too_long')) return 'text too long for its place';
  if (reason.startsWith('brand_validation')) return `fails a brand check (${reason.split(':')[1] ?? ''})`;
  return (
    {
      element_locked: 'locked',
      element_logo: 'logos are never changed',
      element_protected: 'protected',
      element_page_locked: 'on a locked page',
      element_out_of_scope: 'outside the selection',
      page_not_in_scope: 'outside the page being worked on',
      asset_not_eligible: 'the asset is not eligible',
      colour_not_in_palette: 'not a brand colour',
      box_outside_page: 'would leave the page',
      too_many_operations: 'more changes than one proposal can hold',
    }[reason] ?? reason.replaceAll('_', ' ')
  );
};

const money = (micros: number) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(
    micros / 1_000_000,
  );

/** Waits for typing to settle before the preflight is asked again. */
function useSettled<T>(value: T, ms = 500): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return settled;
}

type AssetUse = 'allowed' | 'include' | 'prioritise' | 'exclude' | 'reference';
const ASSET_USE_OPTIONS: Array<{ value: AssetUse; label: string }> = [
  { value: 'allowed', label: 'May be used' },
  { value: 'include', label: 'Include' },
  { value: 'prioritise', label: 'Prefer' },
  { value: 'exclude', label: 'Do not use' },
  { value: 'reference', label: 'Reference for direction' },
];

export interface GeneratePanelProps {
  documentId: string;
  page: CreativePage;
  state: StudioState;
  studio: StudioApi;
  proposalDiff: ElementDiff[] | null;
  hasLocalWork: boolean;
  readOnly: boolean;
}

export function GeneratePanel({
  documentId,
  page,
  state,
  studio,
  proposalDiff,
  hasLocalWork,
  readOnly,
}: GeneratePanelProps) {
  const { companyId, brandId } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'generate' | 'refine'>(() =>
    state.selection.length ? 'refine' : 'generate',
  );
  const [jobId, setJobId] = useState<string | null>(null);
  const active = useActiveGenerations(documentId);
  const job = useGenerationJob(jobId);

  // Reattach: a live job of this document (another tab, a reload) or its last finished one not yet handled here.
  const attached = useRef(false);
  useEffect(() => {
    if (attached.current || !active.data) return;
    attached.current = true;
    const live = active.data.items[0];
    if (live) setJobId(live.id);
    else if (active.data.last && readHandled(documentId) !== active.data.last.id)
      setJobId(active.data.last.id);
  }, [active.data, documentId]);

  // Once a job finishes: adopt its revision (undoable) or show its proposal; said once per job.
  const stateRef = useRef(state);
  const studioRef = useRef(studio);
  useEffect(() => {
    stateRef.current = state;
    studioRef.current = studio;
  });
  const handled = useRef<string | null>(null);
  const finished = job.data && !job.data.live ? job.data : null;
  useEffect(() => {
    if (!finished || handled.current === `${finished.id}:${finished.state}`) return;
    handled.current = `${finished.id}:${finished.state}`;
    void queryClient.invalidateQueries(trpc.creative.generation.active.pathFilter());
    if (finished.state !== 'completed' || readHandled(documentId) === finished.id) return;
    const s = stateRef.current;
    const proposal = finished.result?.proposal ?? null;
    if (finished.resultDocumentIds.includes(documentId)) {
      writeHandled(documentId, finished.id);
      void studioRef.current.adoptHead().then(() =>
        studioRef.current.dispatch({
          type: 'notice',
          notice: {
            tone: 'info',
            text: 'Generated: the result is a new revision. Undo takes it back; History lists it.',
          },
        }),
      );
    } else if (proposal && proposal.baseRevisionId === s.committed.revisionId) {
      let snapshot = s.committed.snapshot;
      try {
        snapshot = applyBatch(
          s.committed.snapshot,
          { operations: proposal.operations },
          { templates: s.templates },
        );
      } catch {
        // shown as the base; the server refuses it on accept
      }
      const next: Proposal = {
        id: finished.id,
        batch: { operations: proposal.operations, summary: proposal.summary, origin: 'agent' },
        baseRevisionId: proposal.baseRevisionId,
        result: {
          baseRevisionId: proposal.baseRevisionId,
          snapshot,
          contentHash: proposal.contentHash,
          findings: proposal.findings,
          blocking: proposal.findings.some((f) => f.severity === 'blocking'),
          changedElementIds: changedElementIds({ operations: proposal.operations }),
        },
        source: 'agent',
        generation: { jobId: finished.id, groups: proposal.groups },
      };
      studioRef.current.setProposal(next);
    }
  }, [finished, documentId, queryClient, trpc]);

  // One idempotency key per command, renewed after every attempt (a cancel never replays as a retry or vice versa).
  const cancelIntent = useIntentKey();
  const retryIntent = useIntentKey();
  const cancel = useMutation(
    trpc.creative.generation.cancel.mutationOptions({
      trpc: intentContext(cancelIntent.key),
      onSettled: () => {
        cancelIntent.renew();
        void queryClient.invalidateQueries(trpc.creative.generation.pathFilter());
      },
    }),
  );
  const retry = useMutation(
    trpc.creative.generation.retry.mutationOptions({
      trpc: intentContext(retryIntent.key),
      onSuccess: (res) => {
        handled.current = null;
        setJobId(res.id);
      },
      onSettled: () => {
        retryIntent.renew();
        void queryClient.invalidateQueries(trpc.creative.generation.pathFilter());
      },
    }),
  );

  const generationProposal = state.proposal?.generation ? state.proposal : null;
  const decide = (accept: boolean, groupIds?: string[], asMine = false) => {
    if (!generationProposal?.generation) return;
    writeHandled(documentId, generationProposal.generation.jobId);
    if (accept) studio.acceptProposal({ ...(groupIds ? { groupIds } : {}), asMine });
    else studio.rejectProposal();
  };

  return (
    <div className="flex flex-col gap-4" data-testid="generate-panel">
      {generationProposal && proposalDiff && (
        <section aria-labelledby="generation-proposal-heading" className="flex flex-col gap-2">
          <h2 id="generation-proposal-heading" className="text-sm font-semibold">
            Generated proposal
          </h2>
          <ProposalPanel
            proposal={generationProposal}
            diff={proposalDiff}
            headRevisionId={state.committed.revisionId}
            hasLocalWork={hasLocalWork}
            onAccept={(ids) => decide(true, ids)}
            onAcceptAsMine={(ids) => decide(true, ids, true)}
            onModify={() => {
              if (generationProposal.generation)
                writeHandled(documentId, generationProposal.generation.jobId);
              studio.modifyProposal();
            }}
            onReject={() => decide(false)}
          />
        </section>
      )}

      {jobId && (
        <JobStatus
          job={job.data ?? null}
          loadError={job.isError ? job.error : null}
          onRetryLoad={() => void job.refetch()}
          documentId={documentId}
          companyId={companyId}
          brandId={brandId}
          cancelling={cancel.isPending}
          retrying={retry.isPending}
          onCancel={(j) => cancel.mutate({ jobId: j.id, expectedVersion: j.version })}
          onRetry={(j) => retry.mutate({ jobId: j.id, expectedVersion: j.version })}
          onDismiss={() => {
            if (job.data) writeHandled(documentId, job.data.id);
            setJobId(null);
          }}
          actionError={cancel.isError ? cancel.error : retry.isError ? retry.error : null}
        />
      )}

      <div role="group" aria-label="What to do" className="flex gap-1 rounded-md border border-border p-1">
        {(
          [
            ['generate', 'Generate the graphic'],
            ['refine', 'Change part of it'],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            size="sm"
            variant={mode === value ? 'primary' : 'ghost'}
            aria-pressed={mode === value}
            className="flex-1"
            onClick={() => setMode(value)}
          >
            {label}
          </Button>
        ))}
      </div>

      {mode === 'generate' ? (
        <BriefForm
          documentId={documentId}
          state={state}
          busy={Boolean(job.data?.live)}
          hasLocalWork={hasLocalWork}
          readOnly={readOnly}
          onStarted={(j) => {
            handled.current = null;
            setJobId(j.id);
          }}
        />
      ) : (
        <RefineForm
          documentId={documentId}
          page={page}
          state={state}
          busy={Boolean(job.data?.live)}
          hasLocalWork={hasLocalWork}
          readOnly={readOnly}
          onStarted={(j) => {
            handled.current = null;
            setJobId(j.id);
          }}
        />
      )}
    </div>
  );
}

// ---- job status ----------------------------------------------------------------------------------------------

function JobStatus({
  job,
  loadError,
  onRetryLoad,
  documentId,
  companyId,
  brandId,
  cancelling,
  retrying,
  onCancel,
  onRetry,
  onDismiss,
  actionError,
}: {
  job: GenerationJobDto | null;
  loadError: unknown;
  onRetryLoad: () => void;
  documentId: string;
  companyId: string;
  brandId: string;
  cancelling: boolean;
  retrying: boolean;
  onCancel: (job: GenerationJobDto) => void;
  onRetry: (job: GenerationJobDto) => void;
  onDismiss: () => void;
  actionError: unknown;
}) {
  if (loadError)
    return <RequestError error={loadError} onRetry={onRetryLoad} title="The generation could not be read" />;
  if (!job) return <p className="text-xs text-muted-foreground">Reading the generation…</p>;
  const tone =
    job.state === 'failed' ? 'critical' : job.state === 'cancelled' ? 'warning' : job.live ? 'info' : 'good';
  const otherDocs = job.resultDocumentIds.filter((id) => id !== documentId);
  return (
    <section
      aria-labelledby="generation-job-heading"
      className="flex flex-col gap-2"
      data-testid="generation-job"
    >
      <h2 id="generation-job-heading" className="text-sm font-semibold">
        {job.kind === 'refine' ? 'Change' : 'Generation'}
      </h2>
      <div className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
        <Badge tone={tone} glyph={!job.live} data-testid="generation-state" data-state={job.state}>
          {STATE_TEXT[job.state]}
        </Badge>
        {job.attempt > 1 && <span className="text-xs text-muted-foreground">attempt {job.attempt}</span>}
        <span className="text-xs text-muted-foreground">
          {money(job.costSpentMicros)} spent of {money(job.costReservedMicros)} reserved
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Generation progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={job.progress}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full bg-primary transition-[width]" style={{ width: `${job.progress}%` }} />
      </div>
      {job.error && (
        <StatusBanner
          tone="critical"
          title="The generation did not finish"
          description={ERROR_TEXT[job.error.code] ?? job.error.message}
        />
      )}
      {job.result && job.result.refused.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {job.result.refused.length} suggested change{job.result.refused.length === 1 ? ' was' : 's were'}{' '}
            refused
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {job.result.refused.map((r, i) => (
              <li key={i}>
                {r.elementId.slice(-6)} on {r.pageId}: {REFUSED_TEXT(r.reason)}
              </li>
            ))}
          </ul>
        </details>
      )}
      {otherDocs.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" aria-label="Variations">
          {otherDocs.map((id, i) => (
            <li key={id}>
              <Link
                className="underline-offset-2 hover:underline"
                to={brandPath(companyId, brandId, `studio/${encodeURIComponent(id)}`)}
              >
                Open variation {i + 2} <span aria-hidden="true">→</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {job.live && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onCancel(job)}
            disabledReason={
              cancelling
                ? 'Cancelling…'
                : job.state === 'saving'
                  ? 'Saving: it finishes and can be undone'
                  : undefined
            }
            data-testid="generation-cancel"
          >
            Cancel
          </Button>
        )}
        {(job.state === 'failed' || job.state === 'cancelled') && (
          <Button size="sm" onClick={() => onRetry(job)} disabledReason={retrying ? 'Retrying…' : undefined}>
            Try again
          </Button>
        )}
        {!job.live && (
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </div>
      {actionError !== null && <RequestError error={actionError} title="That did not work" />}
    </section>
  );
}

// ---- preflight ----------------------------------------------------------------------------------------------

function Preflight({
  result,
  pending,
  error,
}: {
  result: GenerationPreflightDto | undefined;
  pending: boolean;
  error: unknown;
}) {
  if (error) return <RequestError error={error} title="The request could not be checked" />;
  if (!result)
    return <p className="text-xs text-muted-foreground">{pending ? 'Checking the request…' : ''}</p>;
  const blocking = result.issues.filter((i) => i.severity === 'blocking');
  const warnings = result.issues.filter((i) => i.severity !== 'blocking');
  const over = result.cost.remainingMicros !== null && result.cost.totalMicros > result.cost.remainingMicros;
  return (
    <section
      aria-labelledby="preflight-heading"
      className="flex flex-col gap-2 rounded-md border border-border p-2"
      data-testid="preflight"
    >
      <h3 id="preflight-heading" className="text-xs font-semibold">
        Before it starts
      </h3>
      <p className="text-xs" data-testid="preflight-cost">
        Estimated cost {money(result.cost.totalMicros)}
        {result.cost.images > 0 &&
          ` (including ${result.cost.images} image${result.cost.images === 1 ? '' : 's'})`}
        {result.cost.remainingMicros !== null && (
          <> · {money(result.cost.remainingMicros)} left in the budget</>
        )}
        {over && (
          <Badge tone="critical" className="ml-1">
            Over budget
          </Badge>
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        {result.inputs.fresh && result.inputs.variations > 0
          ? 'This document has no edits of yours yet: the result becomes the next revision (Undo takes it back).'
          : 'The result comes back as a proposal you accept in part or in full.'}
        {result.inputs.variations > 1 &&
          ` Further variations go into ${result.inputs.variations - 1} new document${result.inputs.variations > 2 ? 's' : ''}.`}
      </p>
      {blocking.length > 0 && (
        <ul
          className="flex flex-col gap-1 text-xs"
          aria-label="Needs attention"
          data-testid="preflight-blocking"
        >
          {blocking.map((i, n) => (
            <li key={n} className="flex items-start gap-1.5">
              <Badge tone="critical">Fix</Badge>
              <span>{i.message}</span>
            </li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs" aria-label="Notes">
          {warnings.map((i, n) => (
            <li key={n} className="flex items-start gap-1.5">
              <Badge tone="warning">Note</Badge>
              <span>{i.message}</span>
            </li>
          ))}
        </ul>
      )}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          What applies ({result.constraints.length} rule{result.constraints.length === 1 ? '' : 's'}, brand
          version {result.inputs.brandVersionNumber})
        </summary>
        <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4">
          {result.constraints.map((c, n) => (
            <li key={n}>{c.text}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

const startBlocked = (opts: {
  readOnly: boolean;
  hasLocalWork: boolean;
  busy: boolean;
  preflight: GenerationPreflightDto | undefined;
  pending: boolean;
  ready: boolean;
  notReady: string;
}): string | undefined =>
  opts.readOnly
    ? 'This document is read-only'
    : opts.hasLocalWork
      ? 'Save your pending changes first'
      : opts.busy
        ? 'Wait for the current generation'
        : !opts.ready
          ? opts.notReady
          : !opts.preflight || opts.pending
            ? 'Checking the request…'
            : opts.preflight.blocking
              ? 'Fix what the check lists first'
              : undefined;

// ---- the brief ----------------------------------------------------------------------------------------------

function useStart(onStarted: (job: GenerationJobDto) => void) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const start = useMutation(
    trpc.creative.generation.start.mutationOptions({
      trpc: intentContext(intent.key),
      onSuccess: (res) => {
        intent.renew();
        onStarted(res);
        void queryClient.invalidateQueries(trpc.creative.generation.pathFilter());
      },
    }),
  );
  return start;
}

function BriefForm({
  documentId,
  state,
  busy,
  hasLocalWork,
  readOnly,
  onStarted,
}: {
  documentId: string;
  state: StudioState;
  busy: boolean;
  hasLocalWork: boolean;
  readOnly: boolean;
  onStarted: (job: GenerationJobDto) => void;
}) {
  const { brandId } = useBrandContext();
  const snapshot = state.committed.snapshot;
  const brandVersion = useBrandVersion(brandId, snapshot.brandVersionId);
  const audiences = brandVersion.data?.document.voice.audiences ?? [];
  const channels = useChannelLimits(brandId);
  const facts = useFacts(brandId, { effective: true });
  // Generation fills image areas: stills only (STU-2b: the creative purpose also covers video and audio).
  const assets = useAssetSearch(brandId, 'creative', undefined, IMAGE_CREATIVE_KINDS);
  const templates = useTemplates(brandId);
  const approvedTemplates = (templates.data?.items ?? []).filter(
    (t) => t.state === 'active' && t.currentVersionId,
  );

  // Defaults: the document's content type, the channels its formats are made for, every unlocked page.
  const formatChannels = useMemo(
    () => [...new Set(snapshot.pages.flatMap((p) => formatFor(p.formatKey)?.providerKeys ?? []))],
    [snapshot.pages],
  );
  const [objective, setObjective] = useState('');
  const [audience, setAudience] = useState('');
  const [keyMessage, setKeyMessage] = useState('');
  const [contentType, setContentType] = useState<ContentType | ''>(snapshot.contentType ?? '');
  const [channelKeys, setChannelKeys] = useState<string[] | null>(null);
  const [layout, setLayout] = useState('current');
  const [headline, setHeadline] = useState('');
  const [body, setBody] = useState('');
  const [cta, setCta] = useState('');
  const [copyTemplateKey, setCopyTemplateKey] = useState('');
  const [factIds, setFactIds] = useState<string[]>([]);
  const [assetUse, setAssetUse] = useState<Record<string, AssetUse>>({});
  const [visualDirection, setVisualDirection] = useState('');
  const [variations, setVariations] = useState('1');
  const [generateImages, setGenerateImages] = useState(false);

  const certified = channels.data?.items ?? [];
  const chosenChannels =
    channelKeys ?? formatChannels.filter((k) => certified.some((c) => c.providerKey === k));
  const byUse = (use: AssetUse) =>
    Object.entries(assetUse)
      .filter(([, u]) => u === use)
      .map(([id]) => id);
  const brief: GenerationBriefInput = {
    objective,
    audience,
    keyMessage,
    ...(contentType ? { contentType } : {}),
    channelKeys: chosenChannels,
    layout: layout === 'current' ? { kind: 'current' } : { kind: 'template', templateVersionId: layout },
    requiredCopy: {
      ...(headline.trim() ? { headline: headline.trim() } : {}),
      ...(body.trim() ? { body: body.trim() } : {}),
      ...(cta.trim() ? { cta: cta.trim() } : {}),
    },
    ...(copyTemplateKey ? { copyTemplateKey } : {}),
    factIds,
    assets: { include: byUse('include'), exclude: byUse('exclude'), prioritise: byUse('prioritise') },
    visualDirection,
    referenceAssetVersionIds: byUse('reference'),
    variations: Number(variations),
    generateImages,
  };
  const ready = Boolean(objective.trim() || keyMessage.trim() || headline.trim());
  const request: z.input<typeof GenerationRequest> = { kind: 'generate', brief };
  const settled = useSettled(
    JSON.stringify({ documentId, baseRevisionId: state.committed.revisionId, request }),
  );
  const preflight = useGenerationPreflight(ready ? (JSON.parse(settled) as GenerationPreflightInput) : null);
  const start = useStart(onStarted);
  const blocked = startBlocked({
    readOnly,
    hasLocalWork,
    busy,
    preflight: preflight.data,
    pending: preflight.isFetching,
    ready,
    notReady: 'Say what it should achieve, the key message or the headline',
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (blocked) return;
    start.mutate({ documentId, baseRevisionId: state.committed.revisionId, request });
  };
  const copyTemplates = preflight.data?.inputs.copyTemplates ?? [];
  const imageGeneration = preflight.data?.inputs.imageGeneration ?? null;

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate aria-label="Generate the graphic">
      <Field label="Objective" htmlFor="gen-objective" hint="What the graphic should achieve.">
        <Input
          id="gen-objective"
          value={objective}
          maxLength={500}
          onChange={(e) => setObjective(e.target.value)}
        />
      </Field>
      <Field label="Key message" htmlFor="gen-message">
        <Textarea
          id="gen-message"
          rows={2}
          value={keyMessage}
          maxLength={500}
          onChange={(e) => setKeyMessage(e.target.value)}
        />
      </Field>
      <Field label="Audience" htmlFor="gen-audience">
        {audiences.length > 0 ? (
          <Select
            id="gen-audience"
            value={audience || '__any'}
            onValueChange={(v) => setAudience(v === '__any' ? '' : v)}
            options={[
              { value: '__any', label: 'The brand’s usual audience' },
              ...audiences.map((a) => ({
                value: a.key,
                label: a.description ? `${a.key}: ${a.description}`.slice(0, 80) : a.key,
              })),
            ]}
            size="sm"
          />
        ) : (
          <Input
            id="gen-audience"
            value={audience}
            maxLength={300}
            onChange={(e) => setAudience(e.target.value)}
          />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Content type" htmlFor="gen-type">
          <Select
            id="gen-type"
            value={contentType || '__doc'}
            onValueChange={(v) => setContentType(v === '__doc' ? '' : (v as ContentType))}
            options={[
              { value: '__doc', label: 'As the document' },
              // A video (no page formats) is not a generation target.
              ...CONTENT_TYPES.filter((c) => c.available && c.formats.length > 0).map((c) => ({
                value: c.key,
                label: c.label,
              })),
            ]}
            size="sm"
          />
        </Field>
        <Field
          label="Variations"
          htmlFor="gen-variations"
          hint="More than one makes copies of this document."
        >
          <Select
            id="gen-variations"
            value={variations}
            onValueChange={setVariations}
            options={['1', '2', '3', '4'].map((n) => ({ value: n, label: n }))}
            size="sm"
          />
        </Field>
      </div>
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="text-xs font-medium text-muted-foreground">Destination channels</legend>
        {channels.isPending && <p className="text-xs text-muted-foreground">Reading channels…</p>}
        {certified.length === 0 && channels.isSuccess && (
          <p className="text-xs text-muted-foreground">No channel is certified for publishing yet.</p>
        )}
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {certified.map((c) => (
            <label key={c.providerKey} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={chosenChannels.includes(c.providerKey)}
                onChange={(e) =>
                  setChannelKeys(
                    e.target.checked
                      ? [...chosenChannels, c.providerKey]
                      : chosenChannels.filter((k) => k !== c.providerKey),
                  )
                }
              />
              {c.vendor === c.providerKey ? c.providerKey : `${c.vendor} (${c.providerKey})`}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-xs text-muted-foreground" data-testid="gen-format">
        Format:{' '}
        {[
          ...new Set(
            snapshot.pages.map((p) => FORMAT_DEFINITIONS[p.formatKey]?.label ?? `${p.width}×${p.height}`),
          ),
        ].join(', ')}{' '}
        · {snapshot.pages.length} page{snapshot.pages.length === 1 ? '' : 's'}
      </p>
      <Field label="Layout" htmlFor="gen-layout">
        <Select
          id="gen-layout"
          value={layout}
          onValueChange={setLayout}
          options={[
            { value: 'current', label: 'Keep this layout' },
            ...approvedTemplates.map((t) => ({
              value: t.currentVersionId ?? '',
              label: `Brand template: ${t.name}`,
            })),
          ]}
          size="sm"
        />
      </Field>
      {copyTemplates.length > 0 && (
        <Field
          label="Copy structure"
          htmlFor="gen-copy-template"
          hint="From the brand system for this type and channel."
        >
          <Select
            id="gen-copy-template"
            value={copyTemplateKey || (copyTemplates[0]?.key ?? '')}
            onValueChange={setCopyTemplateKey}
            options={copyTemplates.map((t) => ({ value: t.key, label: t.name }))}
            size="sm"
          />
        </Field>
      )}
      <details className="flex flex-col gap-2">
        <summary className="cursor-pointer text-xs font-medium">Required copy (used as written)</summary>
        <div className="mt-2 flex flex-col gap-2">
          <Field label="Headline" htmlFor="gen-headline">
            <Input
              id="gen-headline"
              value={headline}
              maxLength={300}
              onChange={(e) => setHeadline(e.target.value)}
            />
          </Field>
          <Field label="Body" htmlFor="gen-body">
            <Textarea
              id="gen-body"
              rows={2}
              value={body}
              maxLength={1000}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
          <Field label="Call to action" htmlFor="gen-cta">
            <Input id="gen-cta" value={cta} maxLength={80} onChange={(e) => setCta(e.target.value)} />
          </Field>
        </div>
      </details>
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="text-xs font-medium text-muted-foreground">Approved facts it may state</legend>
        {facts.isError && <RequestError error={facts.error} onRetry={() => void facts.refetch()} />}
        {facts.isSuccess && facts.data.items.length === 0 && (
          <p className="text-xs text-muted-foreground">No facts are in force for this brand.</p>
        )}
        {(facts.data?.items ?? []).map((f) => (
          <label key={f.id} className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={factIds.includes(f.id)}
              onChange={(e) =>
                setFactIds((ids) => (e.target.checked ? [...ids, f.id] : ids.filter((x) => x !== f.id)))
              }
            />
            <span>{f.statement}</span>
          </label>
        ))}
      </fieldset>
      <details>
        <summary className="cursor-pointer text-xs font-medium">
          Images ({assets.items.length} eligible)
        </summary>
        <ul className="mt-2 flex flex-col gap-1.5 text-sm">
          {assets.isError && <RequestError error={assets.error} onRetry={() => void assets.refetch()} />}
          {assets.items.map((a, i) => (
            <li key={a.assetVersionId} className="grid grid-cols-[1fr_9rem] items-center gap-2">
              <span className="truncate" id={`gen-asset-${i}`}>
                {a.altText ?? a.kind} <span className="text-xs text-muted-foreground">({a.kind})</span>
              </span>
              <Select
                aria-label={`How to use ${a.altText ?? a.kind}`}
                value={assetUse[a.assetVersionId] ?? 'allowed'}
                onValueChange={(v) => setAssetUse((m) => ({ ...m, [a.assetVersionId]: v as AssetUse }))}
                options={ASSET_USE_OPTIONS}
                size="sm"
              />
            </li>
          ))}
        </ul>
      </details>
      <Field label="Visual direction" htmlFor="gen-visual">
        <Textarea
          id="gen-visual"
          rows={2}
          value={visualDirection}
          maxLength={1000}
          onChange={(e) => setVisualDirection(e.target.value)}
        />
      </Field>
      {imageGeneration?.available && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={generateImages}
            onChange={(e) => setGenerateImages(e.target.checked)}
          />
          Generate images for empty image areas
        </label>
      )}
      {ready && (
        <Preflight
          result={preflight.data}
          pending={preflight.isFetching}
          error={preflight.isError ? preflight.error : null}
        />
      )}
      {start.isError && <RequestError error={start.error} title="The generation did not start" />}
      <div>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabledReason={start.isPending ? 'Starting…' : blocked}
          data-testid="generation-start"
        >
          {start.isPending ? 'Starting…' : 'Generate'}
        </Button>
      </div>
    </form>
  );
}

// ---- a change to part of the graphic --------------------------------------------------------------------------

const ADAPT_FORMATS = ['ig_story_9x16', 'ig_feed_4x5', 'square_1080', 'li_1200x627', 'x_1600x900'];

function RefineForm({
  documentId,
  page,
  state,
  busy,
  hasLocalWork,
  readOnly,
  onStarted,
}: {
  documentId: string;
  page: CreativePage;
  state: StudioState;
  busy: boolean;
  hasLocalWork: boolean;
  readOnly: boolean;
  onStarted: (job: GenerationJobDto) => void;
}) {
  const { brandId } = useBrandContext();
  // Generation fills image areas: stills only (STU-2b: the creative purpose also covers video and audio).
  const assets = useAssetSearch(brandId, 'creative', undefined, IMAGE_CREATIVE_KINDS);
  const [instruction, setInstruction] = useState('');
  const [action, setAction] = useState<'edit' | 'alternatives' | 'adapt'>('edit');
  const [count, setCount] = useState('2');
  const [formatKey, setFormatKey] = useState(
    () => ADAPT_FORMATS.find((k) => k !== page.formatKey) ?? 'ig_story_9x16',
  );
  const [assetVersionId, setAssetVersionId] = useState('');
  const selection = state.selection.filter((id) => findElement(page, id) !== null);
  const names = selection.map((id) => findElement(page, id)?.name ?? id);
  const elementIds = action === 'edit' ? selection : [];
  const request: z.input<typeof GenerationRequest> = {
    kind: 'refine',
    refine: {
      instruction: instruction.trim() || '…',
      scope: { pageId: page.id, elementIds },
      action:
        action === 'edit'
          ? { kind: 'edit' }
          : action === 'alternatives'
            ? { kind: 'alternatives', count: Number(count) }
            : { kind: 'adapt', formatKey },
      assetVersionIds: assetVersionId ? [assetVersionId] : [],
    },
  };
  const ready = instruction.trim().length > 0;
  const settled = useSettled(
    JSON.stringify({ documentId, baseRevisionId: state.committed.revisionId, request }),
  );
  const preflight = useGenerationPreflight(ready ? (JSON.parse(settled) as GenerationPreflightInput) : null);
  const start = useStart(onStarted);
  const blocked = startBlocked({
    readOnly,
    hasLocalWork,
    busy,
    preflight: preflight.data,
    pending: preflight.isFetching,
    ready,
    notReady: 'Say what should change',
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (blocked) return;
    start.mutate({ documentId, baseRevisionId: state.committed.revisionId, request });
  };
  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3"
      noValidate
      aria-label="Change part of the graphic"
    >
      <p className="text-xs text-muted-foreground" data-testid="refine-scope">
        {action !== 'edit'
          ? `Works on a copy of ${page.name}; ${page.name} itself is not changed.`
          : selection.length
            ? `Only ${names.join(', ')} on ${page.name} can change.`
            : `Anything on ${page.name} can change. Select elements on the canvas to narrow it.`}
      </p>
      <Field label="What should change" htmlFor="refine-instruction">
        <Textarea
          id="refine-instruction"
          rows={3}
          value={instruction}
          maxLength={2000}
          placeholder="Shorten this headline without changing the layout"
          onChange={(e) => setInstruction(e.target.value)}
        />
      </Field>
      <Field label="As" htmlFor="refine-action">
        <Select
          id="refine-action"
          value={action}
          onValueChange={(v) => setAction(v as typeof action)}
          options={[
            {
              value: 'edit',
              label: selection.length ? 'A change to the selection' : 'A change to this page',
            },
            { value: 'alternatives', label: 'Alternative versions of this page' },
            { value: 'adapt', label: 'This page adapted to another format' },
          ]}
          size="sm"
        />
      </Field>
      {action === 'alternatives' && (
        <Field label="How many" htmlFor="refine-count">
          <Select
            id="refine-count"
            value={count}
            onValueChange={setCount}
            options={['1', '2', '3'].map((n) => ({ value: n, label: n }))}
            size="sm"
          />
        </Field>
      )}
      {action === 'adapt' && (
        <Field label="Format" htmlFor="refine-format">
          <Select
            id="refine-format"
            value={formatKey}
            onValueChange={setFormatKey}
            options={ADAPT_FORMATS.filter((k) => k !== page.formatKey).map((k) => ({
              value: k,
              label: FORMAT_DEFINITIONS[k]?.label ?? k,
            }))}
            size="sm"
          />
        </Field>
      )}
      <Field label="Use an approved image (optional)" htmlFor="refine-asset">
        <Select
          id="refine-asset"
          value={assetVersionId || '__none'}
          onValueChange={(v) => setAssetVersionId(v === '__none' ? '' : v)}
          options={[
            { value: '__none', label: 'No particular image' },
            ...assets.items.map((a) => ({ value: a.assetVersionId, label: a.altText ?? a.kind })),
          ]}
          size="sm"
        />
      </Field>
      {ready && (
        <Preflight
          result={preflight.data}
          pending={preflight.isFetching}
          error={preflight.isError ? preflight.error : null}
        />
      )}
      {start.isError && (
        <RequestError
          error={start.error}
          title={
            toUiError(start.error).kind === 'forbidden' ? 'Permission denied' : 'The change did not start'
          }
        />
      )}
      <div>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabledReason={start.isPending ? 'Starting…' : blocked}
          data-testid="refine-start"
        >
          {start.isPending ? 'Starting…' : 'Propose the change'}
        </Button>
      </div>
    </form>
  );
}
