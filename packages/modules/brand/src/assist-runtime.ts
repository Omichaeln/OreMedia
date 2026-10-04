import type { ActivityHooks, EvidenceItem } from '@oremedia/contracts/agents';
import { BrandSystemDocumentV1, emptyBrandSystemDocument } from '@oremedia/contracts/brand';
import {
  ASSIST_MAX_QUESTIONS,
  SOURCE_DOCUMENT_MAX_BYTES,
  SOURCE_FETCH_TIMEOUT_MS,
  type AssistSection,
  type AssistStage,
  type BrandAssistFinishResultV1,
  type BrandAssistInputV1,
  type BrandAssistJobState,
  type BrandAssistModelV1,
  type BrandAssistPlanV1,
  type BrandAssistPrepareResultV1,
  type BrandAssistProgressV1,
  type BrandAssistQuestionV1,
  type BrandAssistSectionInputV1,
  type BrandAssistSectionResultV1,
  type BrandAssistSourceInputV1,
  type BrandSourceCaptureResultV1,
  type BrandSourceReason,
  type BrandSourceStatus,
} from '@oremedia/contracts/brand-assist';
import { BudgetExhaustedError, NotFoundError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { requireTenant, withTransaction, type Tx } from '@oremedia/db';
import { describeValue, pathLabel, provenanceAt, valueAt } from '@oremedia/domain/brand-suggestions';
import { factDedupeKey } from '@oremedia/domain/facts';
import { sha256Hex } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import { policy } from '@oremedia/module-access';
import { budgets } from '@oremedia/module-billing';
import { audit } from '@oremedia/module-operations';
import { createProviderIO, type ProviderIO } from '@oremedia/providers';
import {
  BrandAssistJobRepository,
  BrandSourceRepository,
  BrandSuggestionRepository,
} from './assist-repositories';
import {
  EVIDENCE_CHARS_PER_SECTION,
  SECTION_OUTPUT_TOKENS,
  assistBlockers,
  assistModelGate,
  estimateSections,
  evidenceCharsOf,
  sourceCaptureOptions,
  workingDocument,
} from './assist';
import { parseSectionOutput, suggestionsFromOutput, type SuggestionSource } from './assist-suggestions';
import { DocumentRefusal, capText } from './capture/documents';
import { createCaptureIsolate, type CaptureIsolate } from './capture/isolate';
import { crawlSite } from './capture/site-crawl';
import { ApprovedFactRepository, BrandRepository, BrandVersionRepository } from './repositories';
import { brandResource, knownChannelKeys } from './service';

const brandsRepo = new BrandRepository();
const versionsRepo = new BrandVersionRepository();
const factsRepo = new ApprovedFactRepository();
const sourcesRepo = new BrandSourceRepository();
const jobsRepo = new BrandAssistJobRepository();
const suggestionsRepo = new BrandSuggestionRepository();

type JobRow = Awaited<ReturnType<typeof jobsRepo.getById>>;
type SourceRow = Awaited<ReturnType<typeof sourcesRepo.getById>>;

/** Evidence items are capped at 20000 characters (contracts/agents EvidenceItem.text). */
const EVIDENCE_CHUNK = 20_000;
/** A source always gets at least this much of a section's evidence, however many sources there are. */
const EVIDENCE_MIN_SHARE = 4_000;
/** Rejected suggestions shown to the model as "do not offer again", at most. */
const AVOID_MAX = 30;
/** A reservation outlives the job's longest plausible run (capture 2 min a site, a few minutes a section). */
const RESERVATION_TTL_MS = 2 * 3_600_000;

/** Reads the bytes of an uploaded document or an asset's original (worker-render wires the object store). */
export interface SourceObjectReader {
  /** The object's size before anything is downloaded; null when there is no object. */
  head(key: string): Promise<{ bytes: number } | null>;
  /** The object's bytes within an inclusive range (never more than the range, however large the object). */
  get(key: string, range: { start: number; end: number }): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

export interface BrandAssistRuntimeOptions {
  /** The model behind section calls (worker-core wires @oremedia/ai's brand assist model). */
  model?: BrandAssistModelV1;
  /** The object store (worker-render). */
  objects?: SourceObjectReader;
  /** Where untrusted pages and documents are parsed (default: a worker thread with time and memory limits). */
  isolate?: () => CaptureIsolate;
  /** Tests: the IO the crawl fetches through (default: the SSRF-safe provider IO). */
  io?: (tenantId: string) => ProviderIO;
  now?: () => Date;
}

const usable = (s: Pick<SourceRow, 'status' | 'duplicateOfSourceId'>) =>
  s.status === 'captured' && !s.duplicateOfSourceId;
const isTerminal = (s: BrandAssistJobState) =>
  ['ready', 'partially_ready', 'failed', 'cancelled'].includes(s);

/** The activity host's hooks for a section call: heartbeats, and which Temporal attempt this is. */
export interface SectionHooks extends ActivityHooks {
  attempt?: number;
}

const HEARTBEAT_EVERY_MS = 20_000;

/** Awaits `work`, heartbeating every HEARTBEAT_EVERY_MS so a long model call or parse is never taken for a dead worker. */
async function beating<T>(hooks: ActivityHooks | undefined, detail: string, work: Promise<T>): Promise<T> {
  if (!hooks) return work;
  const timer = setInterval(() => hooks.heartbeat(detail), HEARTBEAT_EVERY_MS);
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}

/** How a crawl or extraction refusal reads as a source status. */
function statusFor(reason: BrandSourceReason): BrandSourceStatus {
  switch (reason) {
    case 'not_https':
    case 'blocked_address':
    case 'robots_disallowed':
    case 'http_error':
    case 'timeout':
    case 'unreachable':
    case 'redirect_elsewhere':
    case 'encrypted':
    case 'not_uploaded':
      return 'inaccessible';
    case 'capture_failed':
    case 'corrupt':
      return 'failed';
    default:
      return 'unsupported';
  }
}

/**
 * BSC-4: the runtime behind brandAssistWorkflowV1 and its capture and extraction activities. Every effect lives here
 * (the activities establish tenant context and translate errors): the job's stages and per-section progress, each
 * source's capture with its status and reason, the budget reservation before any model call and its settlement, one
 * bounded model call per section, and the suggestions each call yields. Source text never enters Temporal: payloads
 * carry ids, statuses and counts only.
 */
export function createBrandAssistRuntime(opts: BrandAssistRuntimeOptions = {}) {
  const now = opts.now ?? (() => new Date());
  const io =
    opts.io ??
    ((tenantId: string) =>
      createProviderIO({
        providerKey: 'brand_source',
        tenantId,
        timeoutMs: SOURCE_FETCH_TIMEOUT_MS,
        limiter: { acquire: async () => {} },
        ...sourceCaptureOptions(),
      }));
  const actor = () => requireTenant().actor;

  async function lockJob(input: BrandAssistInputV1, tx: Tx): Promise<JobRow> {
    await brandsRepo.getById(input.brandId, tx); // a foreign or unknown brand is NOT_FOUND
    const job = await jobsRepo.lock(input.brandId, input.jobId, tx);
    if (!job) throw new NotFoundError('BrandAssistJob', input.jobId);
    return job;
  }

  const withProgress = (job: JobRow, change: (p: BrandAssistProgressV1) => void): BrandAssistProgressV1 => {
    const p = structuredClone(job.progress);
    change(p);
    return p;
  };

  async function sourceOfJob(
    input: BrandAssistSourceInputV1,
    tx: Tx,
  ): Promise<{ job: JobRow; source: SourceRow }> {
    const job = await lockJob(input, tx);
    if (!job.sourceIds.includes(input.sourceId)) throw new NotFoundError('BrandSource', input.sourceId);
    const source = await sourcesRepo.getById(input.sourceId, tx);
    if (source.brandId !== input.brandId) throw new NotFoundError('BrandSource', input.sourceId);
    return { job, source };
  }

  /** Stores a source's outcome (deduplicated by content hash) and counts it in the job's stage. */
  async function recordSource(
    input: BrandAssistSourceInputV1,
    stage: 'capturing' | 'extracting',
    outcome:
      | {
          ok: true;
          text: string;
          truncated: boolean;
          bytes: number | null;
          pages?: SourceRow['pages'];
          detail?: string | null;
        }
      | { ok: false; reason: BrandSourceReason; detail: string | null },
    extra: Partial<SourceRow> = {},
  ): Promise<BrandSourceCaptureResultV1> {
    return withTransaction(async (tx) => {
      const { job, source } = await sourceOfJob(input, tx);
      let result: BrandSourceCaptureResultV1;
      if (outcome.ok) {
        const capped = capText(outcome.text);
        const contentHash = sha256Hex(capped.text);
        const duplicate = await sourcesRepo.findLiveByHash(input.brandId, contentHash, source.id, tx);
        await sourcesRepo.update(
          source.id,
          source.version,
          {
            status: 'captured',
            reason: null,
            detail: outcome.detail?.slice(0, 300) ?? null,
            text: capped.text,
            truncated: capped.truncated || outcome.truncated ? 'yes' : 'no',
            contentHash,
            charCount: capped.text.length,
            ...(outcome.bytes !== null ? { byteSize: outcome.bytes } : {}),
            ...(outcome.pages ? { pages: outcome.pages } : {}),
            duplicateOfSourceId: duplicate && duplicate.id < source.id ? duplicate.id : null,
            capturedAt: now(),
            ...extra,
          },
          tx,
        );
        result = { sourceId: source.id, status: 'captured', reason: null };
      } else {
        const status = statusFor(outcome.reason);
        await sourcesRepo.update(
          source.id,
          source.version,
          {
            status,
            reason: outcome.reason,
            detail: outcome.detail?.slice(0, 300) ?? null,
            capturedAt: now(),
            ...extra,
          },
          tx,
        );
        result = { sourceId: source.id, status, reason: outcome.reason };
      }
      await jobsRepo.update(
        job.id,
        job.version,
        {
          progress: withProgress(job, (p) => {
            p.stages[stage].done = Math.min(p.stages[stage].total, p.stages[stage].done + 1);
          }),
        },
        tx,
      );
      await audit.record(
        actor(),
        'brand.source.capture',
        { type: 'brand_source', id: source.id },
        outcome.ok ? 'allowed' : 'denied',
        tx,
        {
          brandId: input.brandId,
          jobId: job.id,
          status: result.status,
          ...(result.reason ? { reason: result.reason } : {}),
        },
      );
      return result;
    });
  }

  /** The section's evidence: every usable source of the job, shared fairly, chunked as untrusted evidence items. */
  function evidenceFor(sources: readonly SourceRow[]): EvidenceItem[] {
    const live = sources.filter(usable);
    if (live.length === 0) return [];
    const share = Math.max(EVIDENCE_MIN_SHARE, Math.floor(EVIDENCE_CHARS_PER_SECTION / live.length));
    const items: EvidenceItem[] = [];
    for (const s of live) {
      const text = (s.text ?? '').slice(0, share);
      for (let at = 0; at < text.length; at += EVIDENCE_CHUNK)
        items.push({
          id: s.id,
          sourceKind:
            s.kind === 'url'
              ? 'web_page'
              : s.kind === 'brand_asset' && !s.mime?.includes('pdf')
                ? 'asset_metadata'
                : 'guideline_document',
          ref: (s.url ?? s.title).slice(0, 1000),
          text: text.slice(at, at + EVIDENCE_CHUNK),
          trust: 'untrusted',
        });
    }
    return items;
  }

  return {
    // ---- control (task queue `agents`) ----

    async beginBrandAssist(input: BrandAssistInputV1): Promise<BrandAssistPlanV1> {
      return withTransaction(async (tx) => {
        const job = await lockJob(input, tx);
        const skipped = (reason: string): BrandAssistPlanV1 => ({
          outcome: 'skipped',
          reason,
          urlSourceIds: [],
          documentSourceIds: [],
          sections: [],
        });
        if (isTerminal(job.state)) return skipped('already_finished');
        if (job.cancelRequestedAt) return skipped('cancelled');
        const sources = await sourcesRepo.listByIds(input.brandId, job.sourceIds, tx);
        const pending = sources.filter((s) => s.status === 'pending' && !s.removedAt);
        const urlSourceIds = pending.filter((s) => s.kind === 'url').map((s) => s.id);
        const documentSourceIds = pending.filter((s) => s.kind !== 'url' && s.storageKey).map((s) => s.id);
        const state: BrandAssistJobState = urlSourceIds.length
          ? 'capturing'
          : documentSourceIds.length
            ? 'extracting'
            : 'proposing';
        await jobsRepo.update(
          job.id,
          job.version,
          {
            state,
            startedAt: job.startedAt ?? now(),
            progress: withProgress(job, (p) => {
              p.stages.capturing = {
                status: urlSourceIds.length ? 'running' : 'skipped',
                done: 0,
                total: urlSourceIds.length,
              };
              p.stages.extracting = {
                status: documentSourceIds.length ? 'pending' : 'skipped',
                done: 0,
                total: documentSourceIds.length,
              };
            }),
          },
          tx,
        );
        return { outcome: 'run', reason: null, urlSourceIds, documentSourceIds, sections: job.sections };
      });
    },

    async markBrandAssistStage(input: BrandAssistInputV1 & { stage: AssistStage }): Promise<void> {
      await withTransaction(async (tx) => {
        const job = await lockJob(input, tx);
        if (isTerminal(job.state)) return;
        await jobsRepo.update(
          job.id,
          job.version,
          {
            state: input.stage,
            progress: withProgress(job, (p) => {
              for (const s of ['capturing', 'extracting', 'proposing'] as const) {
                if (s === input.stage) {
                  if (p.stages[s].status !== 'skipped') p.stages[s].status = 'running';
                  break;
                }
                if (p.stages[s].status === 'running' || p.stages[s].status === 'pending')
                  p.stages[s].status = 'done';
              }
            }),
          },
          tx,
        );
      });
    },

    async recordBrandSourceFailure(
      input: BrandAssistSourceInputV1 & { reason: BrandSourceReason },
    ): Promise<void> {
      await brandsRepo.getById(input.brandId); // a foreign or unknown brand is NOT_FOUND
      const source = await sourcesRepo.findById(input.sourceId);
      if (!source || source.brandId !== input.brandId) throw new NotFoundError('BrandSource', input.sourceId);
      if (source.status !== 'pending') return;
      await recordSource(input, source.kind === 'url' ? 'capturing' : 'extracting', {
        ok: false,
        reason: input.reason,
        detail: null,
      });
    },

    /**
     * Before any model call: the job is still wanted, it has evidence (a setup job), the gates hold (kill switch,
     * routing, entitlement, budget) and the estimate over the captured text is reserved with billing.
     */
    async prepareBrandAssistProposals(
      input: BrandAssistInputV1,
      requester: ResolvedActor,
    ): Promise<BrandAssistPrepareResultV1> {
      return withTransaction(async (tx) => {
        const job = await lockJob(input, tx);
        const brand = await brandsRepo.getById(input.brandId, tx);
        const fail = async (reason: string): Promise<BrandAssistPrepareResultV1> => {
          await jobsRepo.update(job.id, job.version, { error: reason }, tx);
          return { outcome: 'failed', reason, sections: [] };
        };
        if (job.cancelRequestedAt) return { outcome: 'cancelled', reason: 'cancelled', sections: [] };
        if (isTerminal(job.state)) return { outcome: 'failed', reason: 'already_finished', sections: [] };
        // The person (or agent) who asked must still be allowed to propose standards at the point of effect.
        await policy.assert(requester, 'brand.edit_standards', brandResource(brand), {}, tx);
        const sources = (await sourcesRepo.listByIds(input.brandId, job.sourceIds, tx)).filter(
          (s) => !s.removedAt,
        );
        if (job.kind === 'setup' && !sources.some(usable)) return fail('no_usable_sources');
        const gate = assistModelGate();
        if (!gate) return fail('model_unavailable');
        const published = brand.publishedVersionId ? await versionsRepo.findPublished(brand.id, tx) : null;
        const estimate = estimateSections(
          job.sections,
          evidenceCharsOf(sources.filter(usable)),
          JSON.stringify(published?.document ?? {}).length,
          gate,
        ).reduce((n, s) => n + s.costMicros, 0);
        const { blockers } = await assistBlockers(brand.id, estimate, tx);
        if (blockers[0]) return fail(blockers[0].code);
        let reservation;
        try {
          reservation = await budgets.reserveSpend(
            brand.id,
            job.id,
            estimate,
            new Date(now().getTime() + RESERVATION_TTL_MS),
          );
        } catch (err) {
          if (err instanceof BudgetExhaustedError) return fail('budget_exhausted');
          throw err;
        }
        await jobsRepo.update(
          job.id,
          job.version,
          {
            state: 'proposing',
            estimateMicros: estimate,
            reservedMicros: reservation.reservedMicros,
            budgetReservationId: reservation.id,
            progress: withProgress(job, (p) => {
              for (const s of ['capturing', 'extracting'] as const)
                if (p.stages[s].status === 'running' || p.stages[s].status === 'pending')
                  p.stages[s].status = 'done';
              p.stages.proposing.status = 'running';
            }),
          },
          tx,
        );
        return { outcome: 'run', reason: null, sections: job.sections };
      });
    },

    /**
     * One section: a bounded model call over the approved guidance and the job's evidence, charged to the job's
     * reservation, then the output checked against the section's strict schema and turned into suggestions. A retry
     * after the suggestions were stored returns them without calling the model again.
     */
    async proposeBrandAssistSection(
      input: BrandAssistSectionInputV1,
      hooks?: SectionHooks,
    ): Promise<BrandAssistSectionResultV1> {
      const model = opts.model;
      if (!model) throw new Error('brand assist runtime has no model');
      const started = await withTransaction(async (tx) => {
        const job = await lockJob(input, tx);
        const state = job.progress.sections[input.section];
        if (!job.sections.includes(input.section)) throw new NotFoundError('AssistSection', input.section);
        if (state?.status === 'ready')
          return {
            done: {
              section: input.section,
              outcome: 'ready' as const,
              suggestions: state.suggestions,
              reason: null,
            },
          };
        const stop = job.cancelRequestedAt
          ? 'cancelled'
          : job.error === 'budget_exhausted'
            ? 'budget_exhausted'
            : null;
        if (stop || !job.budgetReservationId) {
          const reason = stop ?? 'no_reservation';
          await jobsRepo.update(
            job.id,
            job.version,
            {
              progress: withProgress(job, (p) => {
                p.sections[input.section] = {
                  status: stop === 'cancelled' ? 'cancelled' : 'skipped',
                  suggestions: 0,
                  reason,
                };
              }),
            },
            tx,
          );
          return { done: { section: input.section, outcome: 'skipped' as const, suggestions: 0, reason } };
        }
        await jobsRepo.update(
          job.id,
          job.version,
          {
            progress: withProgress(job, (p) => {
              p.sections[input.section] = { status: 'running', suggestions: 0, reason: null };
            }),
          },
          tx,
        );
        return { job: { ...job, version: job.version + 1 } };
      });
      if (started.done) return started.done;
      const job = started.job as JobRow;
      const brand = await brandsRepo.getById(input.brandId);
      const sources = (await sourcesRepo.listByIds(input.brandId, job.sourceIds)).filter((s) => !s.removedAt);
      const published = brand.publishedVersionId ? await versionsRepo.findPublished(brand.id) : null;
      const guidance = published
        ? BrandSystemDocumentV1.parse(published.document)
        : emptyBrandSystemDocument();
      const working = await workingDocument(brand);
      const facts = await factsRepo.listEffective(brand.id, now());
      const avoidRows = job.alternativesForJobId
        ? (await suggestionsRepo.listForJob(brand.id, job.alternativesForJobId)).filter(
            (s) => s.status === 'rejected' && s.section === input.section,
          )
        : [];
      const gate = assistModelGate();
      hooks?.heartbeat(`section:${input.section}`);
      const result = await beating(
        hooks,
        `section:${input.section}:model`,
        model.propose({
          tenantId: input.tenantId,
          jobId: job.id,
          section: input.section,
          brandName: brand.name,
          defaultLocale: brand.defaultLocale,
          guidance,
          facts: facts.map((f) => ({ id: f.id, statement: f.statement })),
          evidence: evidenceFor(sources),
          instruction: job.instruction,
          preserve: job.preserve.map((p) =>
            `${pathLabel(p)}: ${describeValue(valueAt(working, p))}`.slice(0, 600),
          ),
          answers: job.answers ?? [],
          avoid: avoidRows
            .slice(0, AVOID_MAX)
            .map((s) => `${pathLabel(s.path)}: ${describeValue(s.payload)}`.slice(0, 400)),
          channelKeys: knownChannelKeys(),
          maxOutputTokens: Math.min(
            SECTION_OUTPUT_TOKENS,
            gate?.describe().maxOutputTokens ?? SECTION_OUTPUT_TOKENS,
          ),
        }),
      );
      hooks?.heartbeat(`section:${input.section}:charge`);
      // Cost already incurred is always charged before anything else is decided (spec 12.6), even when the job was
      // settled while the call ran (consumeIncurred): it still counts toward the caps. One key per call: each attempt
      // made its own model call, and a replay of the same attempt charges nothing.
      const billed = await budgets.consumeIncurred(
        job.budgetReservationId as string,
        brand.id,
        'model_tokens',
        result.usage.inputTokens + result.usage.outputTokens,
        'tokens',
        result.costMicros,
        `brand-assist:${job.id}:${input.section}`,
        `brand-assist:${job.id}:${input.section}:${hooks?.attempt !== undefined ? `a${hooks.attempt}` : newId('usageLedger')}`,
      );
      const overBudget = billed.closed || billed.exceeded;
      let output;
      try {
        if (result.parseError !== null) throw new Error(result.parseError);
        output = parseSectionOutput(input.section, result.raw);
      } catch {
        await withTransaction(async (tx) => {
          const j = await lockJob(input, tx);
          await jobsRepo.update(
            j.id,
            j.version,
            {
              spentMicros: j.spentMicros + result.costMicros,
              ...(overBudget ? { error: 'budget_exhausted' } : {}),
            },
            tx,
          );
        });
        // Retried by the activity host; a section whose answers never fit its schema fails on its own.
        throw new InvalidModelOutputError(input.section);
      }
      return withTransaction(async (tx) => {
        const j = await lockJob(input, tx);
        // Re-checked under the job's lock: an earlier attempt that outlived its timeout may have finished this
        // section already (or the job was closed meanwhile). Only a section still running gets suggestions, once.
        const sectionNow = j.progress.sections[input.section];
        if (sectionNow?.status !== 'running') {
          await jobsRepo.update(j.id, j.version, { spentMicros: j.spentMicros + result.costMicros }, tx);
          return {
            section: input.section,
            outcome: sectionNow?.status === 'ready' ? ('ready' as const) : ('skipped' as const),
            suggestions: sectionNow?.suggestions ?? 0,
            reason: sectionNow?.status === 'ready' ? null : (sectionNow?.reason ?? 'superseded_attempt'),
          };
        }
        const current = await workingDocument(brand, tx);
        const liveFacts = await factsRepo.listLiveStatements(brand.id, tx);
        const blocked = await suggestionsRepo.fingerprintsIn(
          brand.id,
          ['rejected', 'accepted', 'edited', 'pending'],
          tx,
        );
        const sourceMap = new Map<string, SuggestionSource>(
          sources
            .filter(usable)
            .map((s) => [s.id, { id: s.id, title: s.title, url: s.url, text: s.text ?? '' }]),
        );
        const drafts = suggestionsFromOutput(output, {
          section: input.section,
          current,
          sources: sourceMap,
          preserve: new Set(j.preserve),
          knownChannels: new Set(knownChannelKeys()),
          liveFactKeys: new Set(liveFacts.map((f) => factDedupeKey(f.statement))),
          blocked,
        });
        // A newer suggestion for the same item supersedes an older pending one (from an earlier job).
        for (const old of await suggestionsRepo.pendingForPaths(
          brand.id,
          drafts.map((d) => d.path),
          tx,
        ))
          if (old.jobId !== j.id)
            await suggestionsRepo.update(old.id, old.version, { status: 'superseded' }, tx);
        for (const d of drafts)
          await suggestionsRepo.create(
            {
              id: newId('brandSuggestion'),
              brandId: brand.id,
              jobId: j.id,
              section: d.section,
              path: d.path.slice(0, 400),
              op: d.op,
              payload: d.value,
              provenance: d.provenance,
              rationale: d.rationale || 'No reason given.',
              uncertainty: d.uncertainty,
              conflicts: d.conflicts,
              evidence: d.evidence,
              fingerprint: d.fingerprint,
              againstUserItem: d.againstUserItem ? 'yes' : 'no',
              // What the item is now: accepting later refuses if it has changed in between.
              basedOn:
                d.section === 'facts'
                  ? null
                  : {
                      value: valueAt(current, d.path) ?? null,
                      origin: provenanceAt(current, d.path)?.origin ?? null,
                    },
              status: 'pending',
            },
            tx,
          );
        const questions: BrandAssistQuestionV1[] = [...(j.questions as BrandAssistQuestionV1[])];
        for (const q of output.questions)
          if (questions.length < ASSIST_MAX_QUESTIONS)
            questions.push({
              id: `q${questions.length + 1}`,
              section: input.section,
              question: q.question,
              why: q.why,
              answer: null,
            });
        await jobsRepo.update(
          j.id,
          j.version,
          {
            questions,
            spentMicros: j.spentMicros + result.costMicros,
            ...(overBudget ? { error: 'budget_exhausted' } : {}),
            progress: withProgress(j, (p) => {
              p.sections[input.section] = {
                status: 'ready',
                suggestions: drafts.length,
                reason: overBudget ? 'budget_exhausted' : null,
              };
              p.stages.proposing.done = Math.min(p.stages.proposing.total, p.stages.proposing.done + 1);
            }),
          },
          tx,
        );
        return {
          section: input.section,
          outcome: 'ready' as const,
          suggestions: drafts.length,
          reason: overBudget ? 'budget_exhausted' : null,
        };
      });
    },

    async recordBrandAssistSectionFailure(
      input: BrandAssistSectionInputV1 & { reason: string },
    ): Promise<void> {
      await withTransaction(async (tx) => {
        const job = await lockJob(input, tx);
        if (job.progress.sections[input.section]?.status === 'ready') return;
        await jobsRepo.update(
          job.id,
          job.version,
          {
            progress: withProgress(job, (p) => {
              p.sections[input.section] = {
                status: 'failed',
                suggestions: 0,
                reason: input.reason.slice(0, 200),
              };
              p.stages.proposing.done = Math.min(p.stages.proposing.total, p.stages.proposing.done + 1);
            }),
          },
          tx,
        );
      });
    },

    /** Settles the reservation (the remainder is released) and closes the job: ready, partly ready, failed or cancelled. */
    async finishBrandAssist(
      input: BrandAssistInputV1 & { cancelled: boolean; failure: string | null },
    ): Promise<BrandAssistFinishResultV1> {
      await withTransaction((tx) => lockJob(input, tx)); // a foreign job is NOT_FOUND before anything is settled
      await budgets.settle(input.jobId);
      return withTransaction(async (tx) => {
        const job = await lockJob(input, tx);
        const counts = await suggestionsRepo.countsForJob(input.brandId, job.id, tx);
        const suggestions = [...counts.values()].reduce((n, c) => n + c, 0);
        if (isTerminal(job.state)) return { state: job.state, suggestions };
        const sections = job.sections.map((s) => job.progress.sections[s]?.status ?? 'pending');
        const ready = sections.filter((s) => s === 'ready').length;
        const cancelled = input.cancelled || job.cancelRequestedAt !== null;
        const state: BrandAssistJobState = cancelled
          ? 'cancelled'
          : ready === job.sections.length
            ? 'ready'
            : ready > 0
              ? 'partially_ready'
              : 'failed';
        await jobsRepo.update(
          job.id,
          job.version,
          {
            state,
            finishedAt: now(),
            ...(state === 'failed' && !job.error
              ? { error: (input.failure ?? 'no_section_finished').slice(0, 500) }
              : {}),
            progress: withProgress(job, (p) => {
              for (const s of job.sections) {
                const sec = p.sections[s];
                if (sec && (sec.status === 'pending' || sec.status === 'running'))
                  p.sections[s] = { ...sec, status: cancelled ? 'cancelled' : 'skipped' };
              }
              for (const stage of ['capturing', 'extracting', 'proposing'] as const)
                if (p.stages[stage].status === 'running' || p.stages[stage].status === 'pending')
                  p.stages[stage].status = 'done';
            }),
          },
          tx,
        );
        await audit.record(
          actor(),
          'brand.assist.finish',
          { type: 'brand_assist_job', id: job.id },
          'allowed',
          tx,
          {
            brandId: input.brandId,
            state,
            count: suggestions,
          },
        );
        return { state, suggestions };
      });
    },

    // ---- capture (task queue `ingest-metrics`) ----

    async captureBrandSourceUrl(
      input: BrandAssistSourceInputV1,
      hooks?: ActivityHooks,
    ): Promise<BrandSourceCaptureResultV1> {
      const source = await withTransaction(async (tx) => (await sourceOfJob(input, tx)).source);
      if (source.kind !== 'url' || !source.url) throw new NotFoundError('BrandSource', input.sourceId);
      if (source.status !== 'pending')
        return {
          sourceId: source.id,
          status: source.status,
          reason: (source.reason as BrandSourceReason | null) ?? null,
        };
      const isolate = (opts.isolate ?? createCaptureIsolate)();
      let crawl: Awaited<ReturnType<typeof crawlSite>>;
      try {
        crawl = await crawlSite(io(input.tenantId), source.url, {
          ...sourceCaptureOptions(),
          ...(hooks ? { heartbeat: hooks.heartbeat } : {}),
          parse: (html, pageUrl) => isolate.pageText(html, pageUrl),
        });
      } finally {
        await isolate.close();
      }
      return crawl.ok
        ? recordSource(input, 'capturing', {
            ok: true,
            text: crawl.text,
            truncated: false,
            bytes: crawl.bytes,
            pages: crawl.pages,
            detail: crawl.detail,
          })
        : recordSource(input, 'capturing', { ok: false, reason: crawl.reason, detail: crawl.detail });
    },

    // ---- extraction (task queue `media`) ----

    async extractBrandSourceDocument(
      input: BrandAssistSourceInputV1,
      hooks?: ActivityHooks,
    ): Promise<BrandSourceCaptureResultV1> {
      const objects = opts.objects;
      if (!objects) throw new Error('brand assist runtime has no object store');
      const source = await withTransaction(async (tx) => (await sourceOfJob(input, tx)).source);
      if (source.kind === 'url' || !source.storageKey || !source.mime)
        throw new NotFoundError('BrandSource', input.sourceId);
      if (source.status !== 'pending')
        return {
          sourceId: source.id,
          status: source.status,
          reason: (source.reason as BrandSourceReason | null) ?? null,
        };
      hooks?.heartbeat(`extract:${source.id}`);
      const storageKey = source.storageKey;
      // An uploaded document is deleted once read (its text is what is kept); an asset's original never is.
      const release = source.kind === 'document' ? { storageKey: null } : {};
      const discard = async () => {
        if (source.kind === 'document') await objects.delete(storageKey).catch(() => {});
      };
      const refuse = async (reason: BrandSourceReason, detail: string | null) => {
        const out = await recordSource(input, 'extracting', { ok: false, reason, detail }, release);
        await discard();
        return out;
      };
      // The size is checked before anything is downloaded, and the download itself is capped one byte past the limit
      // (an object replaced after the check still cannot be read whole).
      const head = await objects.head(storageKey);
      if (!head)
        return recordSource(
          input,
          'extracting',
          { ok: false, reason: 'not_uploaded', detail: null },
          release,
        );
      if (head.bytes > SOURCE_DOCUMENT_MAX_BYTES) return refuse('too_large', `${head.bytes} bytes`);
      const bytes = await objects.get(storageKey, { start: 0, end: SOURCE_DOCUMENT_MAX_BYTES });
      if (!bytes)
        return recordSource(
          input,
          'extracting',
          { ok: false, reason: 'not_uploaded', detail: null },
          release,
        );
      if (bytes.length > SOURCE_DOCUMENT_MAX_BYTES)
        return refuse('too_large', `over ${SOURCE_DOCUMENT_MAX_BYTES} bytes`);
      let result: BrandSourceCaptureResultV1;
      const isolate = (opts.isolate ?? createCaptureIsolate)();
      try {
        const doc = await beating(hooks, `extract:${source.id}`, isolate.extract(bytes, source.mime));
        result = await recordSource(
          input,
          'extracting',
          {
            ok: true,
            text: doc.text,
            truncated: doc.truncated,
            bytes: bytes.length,
            detail: doc.pages ? `${doc.pages} page${doc.pages === 1 ? '' : 's'}` : null,
          },
          release,
        );
      } catch (err) {
        if (!(err instanceof DocumentRefusal)) throw err;
        result = await recordSource(
          input,
          'extracting',
          { ok: false, reason: err.reason, detail: err.detail },
          release,
        );
      } finally {
        await isolate.close();
      }
      await discard();
      return result;
    },
  };
}

export type BrandAssistRuntime = ReturnType<typeof createBrandAssistRuntime>;

/** A model answer that never matched the section's schema: retried by the activity host, then the section fails. */
export class InvalidModelOutputError extends Error {
  constructor(section: AssistSection) {
    super(`The model's answer for ${section} did not match the expected shape`);
    this.name = 'InvalidModelOutputError';
  }
}
