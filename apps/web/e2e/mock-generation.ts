import { createHash, randomUUID } from 'node:crypto';
import type { BrandSnapshot } from '@oremedia/contracts/brand';
import type { CreativeDocumentV1, Operation, OperationBatch } from '@oremedia/contracts/creative';
import { NotFoundError, StaleRevisionError, ValidationFailedError } from '@oremedia/contracts/errors';
import {
  GENERATION_PROGRESS,
  GenerationActive,
  GenerationCancel,
  GenerationGet,
  GenerationPreflight,
  GenerationRequest,
  GenerationRetry,
  GenerationStart,
  type GenerationInputs,
  type GenerationJobState,
  type GenerationProposal,
  type GenerationResult,
  type ModelElementEdit,
} from '@oremedia/contracts/generation';
import { fixtureSnapshot } from '@oremedia/editor/fixtures';
import {
  compileFill,
  generationSlots,
  groupOperations,
  preflightGeneration,
  structureFor,
} from '@oremedia/editor/generation';
import { applyBatch } from '@oremedia/editor/reduce';
import type { z } from 'zod';
import type { FactsBuilders } from './mock-facts';

/**
 * STU-1b slice of the UI-only transport (see mock-api.ts): creative.generation.* with the same paths, DTO shape and
 * errors as apps/api. The preflight, structure, compile and grouping are the editor's own pure code; the "model" is
 * scripted (it writes the key message into the headline, places an eligible photo, shortens selected text) and a
 * job advances one state per read, so progress, cancel and retry can be seen. A test double, not an implementation.
 */
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const now = () => new Date().toISOString();
const rid = (p: string) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;
const ORDER: GenerationJobState[] = ['queued', 'generating', 'validating', 'saving', 'completed'];
const LIVE = new Set<GenerationJobState>(['queued', 'generating', 'validating', 'saving']);
const MODEL_CALL_MICROS = 170_000;

interface MockRev {
  id: string;
  number: number;
  parentRevisionId: string | null;
  authorKind: 'user' | 'agent';
  snapshot: CreativeDocumentV1;
}

/** What the generation slice needs of the document store (MockBackend implements it). */
export interface GenerationHost {
  brandId: string;
  head(documentId: string): MockRev;
  revisionsOf(documentId: string): MockRev[];
  applyGenerated(documentId: string, batch: OperationBatch, inputs: GenerationInputs): { revisionId: string };
  duplicateForVariation(documentId: string, variation: number): string;
  effectiveFacts(): Array<{ id: string; statement: string; kind: BrandSnapshot['facts'][number]['kind'] }>;
  eligibleAssetIds(): string[];
  channelKeys(): string[];
}

interface MockJob {
  id: string;
  brandId: string;
  documentId: string;
  baseRevisionId: string;
  kind: 'generate' | 'refine';
  state: GenerationJobState;
  attempt: number;
  request: z.infer<typeof GenerationRequest>;
  inputsHash: string;
  costReservedMicros: number;
  costSpentMicros: number;
  error: { code: string; message: string } | null;
  result: GenerationResult | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  version: number;
  /** Test hooks: hold in `generating` until cancelled or released; fail at the model step. */
  hold: boolean;
  fail: boolean;
}

export class GenerationBackend {
  readonly jobs = new Map<string, MockJob>();
  /** Test hooks for the next started job: stay in `generating` (to cancel it), or fail at the model call once. */
  holdNext = false;
  failNext = false;
  remainingMicros = 20_000_000;
  constructor(private readonly host: GenerationHost) {}

  private snapshot(): BrandSnapshot {
    const s = fixtureSnapshot();
    return {
      ...s,
      facts: this.host.effectiveFacts().map((f) => ({ ...f, validFrom: null, validUntil: null })),
    };
  }

  private prepare(document: CreativeDocumentV1, request: z.infer<typeof GenerationRequest>) {
    let n = 0;
    const structure = structureFor(document, request, {
      newId: () =>
        `el_${String(++n).padStart(4, '0')}GEN${randomUUID().replace(/-/g, '').slice(0, 19).toUpperCase()}`,
    });
    const working = structure.operations.length
      ? applyBatch(document, { operations: structure.operations })
      : document;
    const scope = request.kind === 'refine' ? request.refine.scope : null;
    const created = new Set(structure.createdPageIds);
    const slots = working.pages
      .filter((p) => structure.targetPageIds.includes(p.id))
      .flatMap((p) =>
        generationSlots(working, p, {
          scope: scope && !created.has(p.id) ? scope : null,
          createdPageIds: created,
        }),
      );
    return { structure, working, scope, slots };
  }

  private fresh(documentId: string) {
    return this.host.revisionsOf(documentId).every((r) => r.number === 1 || r.authorKind === 'agent');
  }

  preflight(input: z.infer<typeof GenerationPreflight>) {
    const head = this.host.head(input.documentId);
    if (head.id !== input.baseRevisionId) throw new StaleRevisionError(head.id);
    const request = GenerationRequest.parse(input.request);
    const { structure, working, slots } = this.prepare(head.snapshot, request);
    const snapshot = this.snapshot();
    const variations = request.kind === 'generate' ? request.brief.variations : 1;
    const totalMicros = MODEL_CALL_MICROS * Math.max(1, Math.ceil(variations / 2));
    const checked = preflightGeneration({
      document: head.snapshot,
      working,
      request,
      snapshot,
      slots,
      targetPageIds: structure.targetPageIds,
      eligibleAssets: this.host
        .eligibleAssetIds()
        .map((id) => ({ assetVersionId: id, kind: 'photo', altText: null })),
      channels: [],
      knownChannelKeys: new Set(this.host.channelKeys()),
      imageGeneration: {
        available: false,
        reason: 'Image generation is not set up for studio generation yet.',
      },
      templateResolved: true,
      costMicros: totalMicros,
      remainingMicros: this.remainingMicros,
    });
    // The mock knows the channel keys but not their capabilities: channel checks other than "known" are skipped.
    const issues = checked.issues.filter((i) => i.code !== 'channel_without_images');
    const facts = new Map(snapshot.facts.map((f) => [f.id, f]));
    const factIds = request.kind === 'generate' ? request.brief.factIds : request.refine.factIds;
    return {
      blocking: issues.some((i) => i.severity === 'blocking'),
      issues,
      constraints: checked.constraints,
      cost: {
        modelCalls: 1,
        modelMicros: totalMicros,
        images: 0,
        imageUnitMicros: 40_000,
        totalMicros,
        remainingMicros: this.remainingMicros,
      },
      inputs: {
        brandVersionId: snapshot.brandVersionId,
        brandVersionNumber: snapshot.brandVersionNumber,
        contentType: head.snapshot.contentType ?? null,
        templateVersionId: head.snapshot.templateVersionId ?? null,
        pages: working.pages
          .filter((p) => structure.targetPageIds.includes(p.id))
          .map((p) => ({
            pageId: p.id,
            name: p.name,
            formatKey: p.formatKey,
            width: p.width,
            height: p.height,
          })),
        structure: structure.labels,
        slots: slots.map((s) => ({
          pageId: s.pageId,
          elementId: s.elementId,
          key: s.key,
          kind: s.kind,
          name: s.name,
          role: s.role ?? null,
          maxLength: s.maxLength ?? null,
          required: s.required,
          fixed: s.fixed ?? null,
        })),
        facts: factIds.map((id) => ({
          id,
          statement: facts.get(id)?.statement ?? null,
          effective: facts.has(id),
        })),
        copyTemplates: [{ key: 'offer_post', name: 'Offer post' }],
        eligibleAssetCount: this.host.eligibleAssetIds().length,
        emptyImageSlots: checked.emptyImageSlots,
        imageGeneration: {
          available: false,
          reason: 'Image generation is not set up for studio generation yet.',
        },
        variations,
        fresh: request.kind === 'generate' && this.fresh(input.documentId),
      },
    };
  }

  start(input: z.infer<typeof GenerationStart>) {
    const request = GenerationRequest.parse(input.request);
    const inputsHash = hash(request);
    const existing = [...this.jobs.values()].find(
      (j) =>
        j.documentId === input.documentId &&
        j.baseRevisionId === input.baseRevisionId &&
        j.inputsHash === inputsHash,
    );
    if (existing) return this.dto(existing);
    const pre = this.preflight(input);
    if (pre.blocking)
      throw new ValidationFailedError(
        pre.issues
          .filter((i) => i.severity === 'blocking')
          .map((i) => ({ path: 'request', issue: `${i.code}: ${i.message}` })),
        'The generation cannot start',
      );
    const job: MockJob = {
      id: rid('sgj'),
      brandId: this.host.brandId,
      documentId: input.documentId,
      baseRevisionId: input.baseRevisionId,
      kind: request.kind,
      state: 'queued',
      attempt: 1,
      request,
      inputsHash,
      costReservedMicros: pre.cost.totalMicros,
      costSpentMicros: 0,
      error: null,
      result: null,
      createdAt: now(),
      updatedAt: now(),
      finishedAt: null,
      version: 0,
      hold: this.holdNext,
      fail: this.failNext,
    };
    this.holdNext = false;
    this.failNext = false;
    this.jobs.set(job.id, job);
    return this.dto(job);
  }

  job(jobId: string): MockJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new NotFoundError('StudioGenerationJob', jobId);
    return job;
  }

  /** One read advances a live job by one state, as the worker would between two polls. */
  get(jobId: string) {
    const job = this.job(jobId);
    if (LIVE.has(job.state) && !(job.hold && job.state === 'generating')) this.advance(job);
    return this.dto(job);
  }

  release(jobId: string): void {
    this.job(jobId).hold = false;
  }

  private touch(job: MockJob, patch: Partial<MockJob>) {
    Object.assign(job, patch, { updatedAt: now(), version: job.version + 1 });
  }

  private advance(job: MockJob) {
    const next = ORDER[ORDER.indexOf(job.state) + 1] ?? 'completed';
    if (next === 'validating') {
      if (job.fail) {
        job.fail = false;
        this.touch(job, {
          state: 'failed',
          error: { code: 'model_failed', message: 'provider unavailable' },
          finishedAt: now(),
          costSpentMicros: 0,
        });
        return;
      }
      this.touch(job, { state: next, costSpentMicros: job.costSpentMicros + 41_000 });
      return;
    }
    if (next !== 'completed') return this.touch(job, { state: next });
    if (this.host.head(job.documentId).id !== job.baseRevisionId) {
      this.touch(job, {
        state: 'failed',
        error: { code: 'stale_document', message: 'The document changed while the generation ran' },
        finishedAt: now(),
      });
      return;
    }
    this.touch(job, { state: 'completed', result: this.save(job), finishedAt: now() });
  }

  /** The scripted "model": a fill per variation, compiled and saved as the server would. */
  private save(job: MockJob): GenerationResult {
    const base = this.host.head(job.documentId);
    const { structure, working, scope, slots } = this.prepare(base.snapshot, job.request);
    const snapshot = this.snapshot();
    const variations = job.request.kind === 'generate' ? job.request.brief.variations : 1;
    const fresh = job.request.kind === 'generate' && this.fresh(job.documentId);
    const revisions: GenerationResult['revisions'] = [];
    let proposal: GenerationProposal | null = null;
    const refused: GenerationResult['refused'] = [];
    for (let variation = 0; variation < variations; variation++) {
      const edits = this.script(job, slots, variation);
      let n = 0;
      const compiled = compileFill(
        working,
        { summary: 'Scripted fill', edits },
        {
          variation,
          targetPageIds: structure.targetPageIds,
          scope,
          createdPageIds: new Set(structure.createdPageIds),
          slots,
          eligibleAssetIds: new Set(this.host.eligibleAssetIds()),
          paletteTokens: new Set(snapshot.document.tokens.colours.map((c) => c.key)),
          effectiveFactIds: new Set(snapshot.facts.map((f) => f.id)),
          newId: () =>
            `el_${String(++n).padStart(4, '0')}PHT${randomUUID().replace(/-/g, '').slice(0, 19).toUpperCase()}`,
        },
      );
      refused.push(...compiled.refused);
      const operations: Operation[] = [...structure.operations, ...compiled.operations];
      const labels = [...structure.labels, ...compiled.labels];
      if (!operations.length) continue;
      const summary =
        job.request.kind === 'refine'
          ? `Change: ${job.request.refine.instruction}`.slice(0, 500)
          : 'Generated: scripted fill';
      const inputs: GenerationInputs = {
        jobId: job.id,
        kind: job.kind,
        request: job.request,
        inputsHash: job.inputsHash,
        templateVersionId: null,
        brandVersionId: snapshot.brandVersionId,
        scope,
        assetVersionIds: compiled.assetVersionIds,
        factIds: compiled.factIds,
        modelCallRefs: [`sgj:${job.id}:${job.attempt}:model`],
        costMicros: job.costSpentMicros,
        variation,
      };
      if (job.request.kind === 'refine' || (variation === 0 && !fresh)) {
        const after = applyBatch(base.snapshot, { operations });
        proposal = {
          documentId: job.documentId,
          baseRevisionId: base.id,
          operations,
          summary,
          groups: groupOperations(operations, labels),
          findings: [],
          contentHash: hash(after),
          scope,
          inputs,
        };
        continue;
      }
      const into =
        variation === 0 ? job.documentId : this.host.duplicateForVariation(job.documentId, variation);
      const head = this.host.head(into);
      const { revisionId } = this.host.applyGenerated(
        into,
        { baseRevisionId: head.id, operations, summary, origin: 'agent' },
        inputs,
      );
      revisions.push({ documentId: into, revisionId, variation });
    }
    return { revisions, proposal, refused, findings: [] };
  }

  private script(
    job: MockJob,
    slots: ReturnType<typeof generationSlots>,
    variation: number,
  ): ModelElementEdit[] {
    const edits: ModelElementEdit[] = [];
    const editable = slots.filter((s) => !s.fixed);
    const fit = (text: string, max?: number) => (max ? text.slice(0, max) : text);
    if (job.request.kind === 'generate') {
      const b = job.request.brief;
      const headline = editable.find(
        (s) => s.kind === 'text' && (s.role === 'headline' || s.role === undefined),
      );
      const message = b.requiredCopy.headline ?? (b.keyMessage || b.objective);
      if (headline) {
        const factIds = b.factIds.slice(0, 1);
        edits.push({
          label: 'Headline',
          pageId: headline.pageId,
          elementId: headline.elementId,
          text: fit(`${message}${variation ? ` (take ${variation + 1})` : ''}`, headline.maxLength),
          ...(factIds.length ? { factIds } : {}),
        });
      }
      const area = editable.find((s) => s.kind === 'image_area' || s.kind === 'image');
      const photo =
        b.assets.include[0] ??
        b.assets.prioritise[0] ??
        this.host.eligibleAssetIds().find((id) => !b.assets.exclude.includes(id));
      if (area && photo)
        edits.push({ label: 'Photo', pageId: area.pageId, elementId: area.elementId, assetVersionId: photo });
      // A colour outside the palette is refused by the compiler, as the server refuses it.
      const body = editable.find((s) => s.kind === 'text' && s.role === 'body');
      if (body)
        edits.push({
          label: 'Body colour',
          pageId: body.pageId,
          elementId: body.elementId,
          colourToken: '#000000',
        });
      // Logos are never the model's to change: the server refuses this edit.
      const logo = slots.find((s) => s.kind === 'logo');
      if (logo)
        edits.push({
          label: 'Logo',
          pageId: logo.pageId,
          elementId: logo.elementId,
          box: { ...logo.box, x: logo.box.x + 10 },
        });
      return edits;
    }
    const r = job.request.refine;
    const words = (s: string, n: number) => s.split(/\s+/).filter(Boolean).slice(0, n).join(' ');
    for (const s of editable.filter((x) => x.kind === 'text')) {
      const text = s.text ?? '';
      if (/prominent|bigger|larger/i.test(r.instruction))
        edits.push({
          label: `Make ${s.name} more prominent`,
          pageId: s.pageId,
          elementId: s.elementId,
          sizePx: 80,
          weight: 800,
        });
      else
        edits.push({
          label: `Shorter ${s.name.toLowerCase()}`,
          pageId: s.pageId,
          elementId: s.elementId,
          text: words(text, 3) || 'New',
        });
    }
    if (r.assetVersionIds[0]) {
      const area = editable.find((s) => s.kind === 'image_area' || s.kind === 'image');
      if (area)
        edits.push({
          label: 'Photo',
          pageId: area.pageId,
          elementId: area.elementId,
          assetVersionId: r.assetVersionIds[0],
        });
    }
    return edits;
  }

  cancel(input: z.infer<typeof GenerationCancel>) {
    const job = this.job(input.jobId);
    if (job.state === 'cancelled') return this.dto(job);
    if (!LIVE.has(job.state) || job.state === 'saving')
      throw new ValidationFailedError([
        { path: 'state', issue: `illegal transition from '${job.state}' on 'cancel'` },
      ]);
    this.touch(job, { state: 'cancelled', finishedAt: now() });
    return this.dto(job);
  }

  retry(input: z.infer<typeof GenerationRetry>) {
    const job = this.job(input.jobId);
    if (LIVE.has(job.state)) return this.dto(job);
    if (job.state === 'completed')
      throw new ValidationFailedError([
        { path: 'state', issue: "illegal transition from 'completed' on 'retry'" },
      ]);
    this.touch(job, {
      state: 'queued',
      attempt: job.attempt + 1,
      error: null,
      result: null,
      finishedAt: null,
      hold: false,
    });
    return this.dto(job);
  }

  active(documentId: string) {
    const all = [...this.jobs.values()].filter((j) => j.documentId === documentId).reverse();
    const last = all.find((j) => !LIVE.has(j.state));
    return {
      items: all.filter((j) => LIVE.has(j.state)).map((j) => this.dto(j)),
      last: last ? this.dto(last) : null,
    };
  }

  /** The inputs a revision records when a person accepts groups of a job's proposal (operations.applyBatch). */
  inputsFor(generation: { jobId: string; groupIds: string[] }): GenerationInputs {
    const proposal = this.job(generation.jobId).result?.proposal;
    if (!proposal)
      throw new ValidationFailedError([{ path: 'generation.jobId', issue: 'job_has_no_proposal' }]);
    return { ...proposal.inputs, acceptedGroupIds: generation.groupIds };
  }

  dto(j: MockJob) {
    return {
      id: j.id,
      brandId: j.brandId,
      documentId: j.documentId,
      baseRevisionId: j.baseRevisionId,
      kind: j.kind,
      state: j.state,
      progress: GENERATION_PROGRESS[j.state],
      attempt: j.attempt,
      live: LIVE.has(j.state),
      request: j.request,
      costReservedMicros: j.costReservedMicros,
      costSpentMicros: j.costSpentMicros,
      error: j.error,
      resultRevisionIds: j.result?.revisions.map((r) => r.revisionId) ?? [],
      resultDocumentIds: [...new Set(j.result?.revisions.map((r) => r.documentId) ?? [])],
      result: j.result,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      finishedAt: j.finishedAt,
      version: j.version,
    };
  }
}

export function generationRouter(b: GenerationBackend, { router, query, mutation }: FactsBuilders) {
  return router({
    preflight: query.input(GenerationPreflight).query(({ input }) => b.preflight(input)),
    start: mutation.input(GenerationStart).mutation(({ input }) => b.start(input)),
    get: query.input(GenerationGet).query(({ input }) => b.get(input.jobId)),
    active: query.input(GenerationActive).query(({ input }) => b.active(input.documentId)),
    cancel: mutation.input(GenerationCancel).mutation(({ input }) => b.cancel(input)),
    retry: mutation.input(GenerationRetry).mutation(({ input }) => b.retry(input)),
  });
}
