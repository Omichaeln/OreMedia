import type { z } from 'zod';
import {
  BrandSystemDocumentV1,
  emptyBrandSystemDocument,
  type FactOrigin,
  type FactSource,
  type GuidanceProvenance,
} from '@oremedia/contracts/brand';
import type { AssistSection } from '@oremedia/contracts/brand-assist';
import {
  ASSIST_TERMINAL_STATES,
  BrandAssistAnswer,
  BrandAssistCancel,
  BrandAssistGet,
  BrandAssistList,
  BrandAssistRequest,
  BrandHistoryCompare,
  BrandHistoryList,
  BrandHistoryRestore,
  BrandSourceAdd,
  BrandSourceGet,
  BrandSourceList,
  BrandSourceRemove,
  BrandSuggestionAccept,
  BrandSuggestionAcceptAll,
  BrandSuggestionEdit,
  BrandSuggestionList,
  BrandSuggestionReject,
  BrandSuggestionUndo,
  SOURCES_PER_BRAND_MAX,
  SOURCE_DOCUMENT_TYPES,
  SOURCE_TEXT_MAX_CHARS,
  type AssistBlockerCode,
  type AssistModelGateV1,
  type BrandAssistEstimateV1,
  type BrandAssistJobDto,
  type BrandAssistProgressV1,
  type BrandAssistQuestionV1,
  type BrandHistoryEntryDto,
  type BrandSourceDto,
  type BrandSourceReason,
  type BrandSuggestionDecisionResult,
  type BrandSuggestionDto,
  type SuggestionEvidence,
} from '@oremedia/contracts/brand-assist';
import {
  BudgetExhaustedError,
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { requireTenant, type Tx } from '@oremedia/db';
import {
  applyChange,
  describeValue,
  diffBrandDocuments,
  changedSectionLabels,
  parsePath,
  pathLabel,
  provenanceAt,
  sameValue,
  stripProvenance,
  valueAt,
} from '@oremedia/domain/brand-suggestions';
import { hashCanonical, sha256Hex } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import { accessService, assertTenantCapability, policy } from '@oremedia/module-access';
import { budgets, entitlements } from '@oremedia/module-billing';
import { audit, killSwitch, outbox } from '@oremedia/module-operations';
import { BlockedAddressError, assertSafeUrl } from '@oremedia/providers';
import {
  BrandAssistJobRepository,
  BrandHistoryRepository,
  BrandSourceRepository,
  BrandSuggestionRepository,
} from './assist-repositories';
import { tidyText } from './capture/html-text';
import { capText } from './capture/documents';
import { BrandRepository, BrandVersionRepository } from './repositories';
import { actorRef, assertDocumentReferences, assertMayDecide, brandResource, brandService } from './service';

const brandsRepo = new BrandRepository();
const versionsRepo = new BrandVersionRepository();
const sourcesRepo = new BrandSourceRepository();
const jobsRepo = new BrandAssistJobRepository();
const suggestionsRepo = new BrandSuggestionRepository();
const historyRepo = new BrandHistoryRepository();

type BrandRow = Awaited<ReturnType<typeof brandsRepo.getById>>;
type SourceRow = Awaited<ReturnType<typeof sourcesRepo.getById>>;
type JobRow = Awaited<ReturnType<typeof jobsRepo.getById>>;
type SuggestionRow = Awaited<ReturnType<typeof suggestionsRepo.getById>>;
type VersionRow = Awaited<ReturnType<typeof versionsRepo.getById>>;

// ---- hooks (spec 4.2: the brand module never imports another module's tables or services) ----

/**
 * The deployment's model and the tenant's routing policy, as @oremedia/ai reads them (composition wires
 * `brandAssistModelGate()`). There is no harmless default: until registered, an estimate reports
 * `model_unavailable` and a start is refused.
 */
let modelGate: AssistModelGateV1 | null = null;
export const registerAssistModelGate = (gate: AssistModelGateV1 | null): void => {
  modelGate = gate;
};
export const assistModelGate = (): AssistModelGateV1 | null => modelGate;

/**
 * Where uploaded documents go before their text is read: a presigned PUT to a tenant-prefixed key, and deletion
 * (composition wires the assets module's storage). Until registered, document sources are refused.
 */
export interface SourceUploadStore {
  /** A presigned PUT bound to the declared size (the store refuses any other body length). */
  signUpload(
    key: string,
    opts: { contentType: string; contentLength: number },
  ): Promise<{ url: string; expiresAt: Date }>;
  delete(key: string): Promise<void>;
}
let uploadStore: SourceUploadStore | null = null;
export const registerSourceUploadStore = (store: SourceUploadStore | null): void => {
  uploadStore = store;
};
/** The key a document source is uploaded to (the quarantine prefix: never served, tenant-checked by the store). */
export const sourceUploadKey = (tenantId: string, sourceId: string): string =>
  `quarantine/${tenantId}/${sourceId}`;

/** One of the brand's assets as a source reads it (composition wires `assetService.describeForSource`). */
export interface SourceAssetInfo {
  assetId: string;
  assetVersionId: string;
  name: string;
  kind: string;
  state: string;
  mime: string;
  bytes: number;
  altText: string | null;
  width: number | null;
  height: number | null;
  /** The original's object key; read for PDF assets only, never deleted by the source. */
  storageKey: string;
}
export type SourceAssetResolver = (
  brandId: string,
  assetVersionId: string,
  tx?: Tx,
) => Promise<SourceAssetInfo | null>;
let assetResolver: SourceAssetResolver = async () => null;
export const registerSourceAssetResolver = (fn: SourceAssetResolver | null): void => {
  assetResolver = fn ?? (async () => null);
};

/** Tests only (a local HTTP server): allow http://127.0.0.1 sources. Refused in production by the dispatcher. */
let captureLoopback = false;
export const configureSourceCapture = (opts: { insecureAllowLoopback?: boolean }): void => {
  captureLoopback = opts.insecureAllowLoopback === true;
};
export const sourceCaptureOptions = () => (captureLoopback ? { insecureAllowLoopback: true } : {});

// ---- shared helpers ----

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const nameOf = (names: ReadonlyMap<string, string>, id: string | null) =>
  id ? (names.get(id) ?? null) : null;

async function loadSource(brandId: string, sourceId: string, tx?: Tx): Promise<SourceRow> {
  const s = await sourcesRepo.getById(sourceId, tx);
  if (s.brandId !== brandId || s.removedAt) throw new NotFoundError('BrandSource', sourceId);
  return s;
}
export async function loadJob(brandId: string, jobId: string, tx?: Tx): Promise<JobRow> {
  const j = await jobsRepo.getById(jobId, tx);
  if (j.brandId !== brandId) throw new NotFoundError('BrandAssistJob', jobId);
  return j;
}

export const toSourceDto = (s: Omit<SourceRow, 'text'>): BrandSourceDto => ({
  id: s.id,
  brandId: s.brandId,
  kind: s.kind,
  title: s.title,
  url: s.url,
  fileName: s.fileName,
  mime: s.mime,
  assetVersionId: s.assetVersionId,
  status: s.status,
  reason: (s.reason as BrandSourceReason | null) ?? null,
  detail: s.detail,
  byteSize: s.byteSize,
  charCount: s.charCount,
  truncated: s.truncated === 'yes',
  pages: s.pages ?? [],
  duplicateOfSourceId: s.duplicateOfSourceId,
  capturedAt: iso(s.capturedAt),
  createdAt: s.createdAt.toISOString(),
  version: s.version,
});

/** A website address as stored: https (or loopback http in tests), no credentials, no fragment. */
function normaliseSourceUrl(raw: string): URL {
  let url: URL;
  try {
    url = assertSafeUrl(raw, sourceCaptureOptions());
  } catch (err) {
    if (err instanceof BlockedAddressError)
      throw new ValidationFailedError(
        [{ path: 'url', issue: /is not allowed/.test(err.message) ? 'not_https' : 'blocked_address' }],
        /is not allowed/.test(err.message)
          ? 'Use the https:// address of the website'
          : 'This address cannot be read: it points to a private or reserved network',
      );
    throw new ValidationFailedError([{ path: 'url', issue: 'invalid_url' }], 'This is not a web address');
  }
  // Only the standard https port: a site is read where its visitors read it (loopback test servers aside).
  if (url.port !== '' && !sourceCaptureOptions().insecureAllowLoopback)
    throw new ValidationFailedError(
      [{ path: 'url', issue: 'unsupported_port' }],
      'Use the site’s standard https address, without a port number',
    );
  url.hash = '';
  return url;
}

/** The pending proposal of the brand (D-22), or null. */
async function pendingProposalOf(brand: BrandRow, tx?: Tx): Promise<VersionRow | null> {
  const applied = brand.publishedVersionId ? await versionsRepo.findById(brand.publishedVersionId, tx) : null;
  return historyRepo.pendingProposal(brand.id, applied?.number ?? null, tx);
}
async function appliedDocument(brand: BrandRow, tx?: Tx): Promise<BrandSystemDocumentV1> {
  const published = brand.publishedVersionId ? await versionsRepo.findPublished(brand.id, tx) : null;
  return published ? BrandSystemDocumentV1.parse(published.document) : emptyBrandSystemDocument();
}
/** What suggestions are compared with: the pending proposal when there is one, else the applied brand system. */
export async function workingDocument(brand: BrandRow, tx?: Tx): Promise<BrandSystemDocumentV1> {
  const proposal = await pendingProposalOf(brand, tx);
  return proposal ? BrandSystemDocumentV1.parse(proposal.document) : appliedDocument(brand, tx);
}

// ---- estimates (shared with the worker's prepare step) ----

/** Characters of evidence one section call reads at most (all sources together, shared fairly). */
export const EVIDENCE_CHARS_PER_SECTION = 60_000;
/** Output tokens a section call may use (bounded again by the deployment's maxOutputTokens). */
export const SECTION_OUTPUT_TOKENS = 3_000;
/** A pending website is estimated at this many characters (the crawl's caps make more unlikely). */
const PENDING_SOURCE_CHARS = 40_000;
const PROMPT_OVERHEAD_CHARS = 9_000;
const tokensOf = (chars: number) => Math.ceil(chars / 4);

export function estimateSections(
  sections: readonly AssistSection[],
  evidenceChars: number,
  guidanceChars: number,
  gate: AssistModelGateV1,
) {
  const cfg = gate.describe();
  const outputTokens = Math.min(SECTION_OUTPUT_TOKENS, cfg.maxOutputTokens);
  return sections.map((section) => {
    const inputTokens = tokensOf(
      Math.min(evidenceChars, EVIDENCE_CHARS_PER_SECTION) +
        Math.min(guidanceChars, 12_000) +
        PROMPT_OVERHEAD_CHARS,
    );
    const costMicros = Math.ceil(
      (inputTokens * cfg.inputMicrosPerMillionTokens + outputTokens * cfg.outputMicrosPerMillionTokens) /
        1_000_000,
    );
    return { section, inputTokens, outputTokens, costMicros };
  });
}

/** The blockers a job would meet now, in the order the agents' effective limits report theirs. */
export async function assistBlockers(
  brandId: string,
  estimateMicros: number,
  tx?: Tx,
): Promise<{ blockers: BrandAssistEstimateV1['blockers']; remaining: BrandAssistEstimateV1['remaining'] }> {
  const { tenantId } = requireTenant();
  const blockers: BrandAssistEstimateV1['blockers'] = [];
  const add = (code: AssistBlockerCode, message: string) => blockers.push({ code, message });
  if (await killSwitch.isOn('agent_starts', brandId, tx))
    add('kill_switch_engaged', 'AI work is paused for this brand by an owner or admin.');
  if (!modelGate) add('model_unavailable', 'No AI model is configured for this service.');
  else
    try {
      await modelGate.assertRouting(tenantId);
    } catch (err) {
      if (!(err instanceof PolicyDeniedError)) throw err;
      add(
        'model_routing_denied',
        `${err.message}; an owner or admin changes the model routing policy under Settings.`,
      );
    }
  const entitlement = await entitlements.check(tenantId, 'generation_budget_micros_month', tx);
  if (!entitlement.allowed) add('entitlement_exhausted', "The plan's AI budget for this month is used up.");
  const spend = await budgets.summary(brandId, tx);
  if (estimateMicros > spend.month.remainingMicros)
    add(
      'budget_exhausted_month',
      "The company's remaining AI budget this month is below what this would reserve.",
    );
  if (estimateMicros > spend.day.remainingMicros)
    add('budget_exhausted_day', "The brand's remaining AI budget today is below what this would reserve.");
  return {
    blockers,
    remaining: { monthMicros: spend.month.remainingMicros, dayMicros: spend.day.remainingMicros },
  };
}

const sourceIsUsable = (s: Pick<SourceRow, 'status' | 'duplicateOfSourceId'>) =>
  s.status === 'captured' && !s.duplicateOfSourceId;
const sourceIsPending = (s: Pick<SourceRow, 'status'>) => s.status === 'pending';

/** Evidence characters a job over these sources reads (captured text, or an allowance for what is still pending). */
export function evidenceCharsOf(
  sources: ReadonlyArray<Pick<SourceRow, 'status' | 'duplicateOfSourceId' | 'charCount'>>,
) {
  return sources.reduce(
    (n, s) => n + (sourceIsUsable(s) ? (s.charCount ?? 0) : sourceIsPending(s) ? PENDING_SOURCE_CHARS : 0),
    0,
  );
}

const emptyProgress = (
  sections: readonly AssistSection[],
  urls: number,
  docs: number,
): BrandAssistProgressV1 => ({
  stages: {
    capturing: { status: urls ? 'pending' : 'skipped', done: 0, total: urls },
    extracting: { status: docs ? 'pending' : 'skipped', done: 0, total: docs },
    proposing: { status: 'pending', done: 0, total: sections.length },
  },
  sections: Object.fromEntries(sections.map((s) => [s, { status: 'pending', suggestions: 0, reason: null }])),
});

const isTerminal = (state: JobRow['state']) => ASSIST_TERMINAL_STATES.includes(state);
const ASSIST_WORKFLOW_ID = (jobId: string) => `brand-assist:${jobId}`;

// ---- suggestion helpers ----

const factOriginFor = (p: GuidanceProvenance): FactOrigin =>
  p.origin === 'imported'
    ? 'extracted'
    : p.origin === 'inferred'
      ? 'inferred'
      : p.origin === 'user'
        ? 'user'
        : 'suggested';

/**
 * Whether the item changed after the suggestion was made (MAJOR: a later edit must never be overwritten silently):
 * it now says something else, or a person has written it since. Facts are checked by their own dedupe.
 */
export const changedSince = (
  row: Pick<SuggestionRow, 'basedOn' | 'section' | 'path'>,
  doc: BrandSystemDocumentV1,
): boolean => {
  if (!row.basedOn || row.section === 'facts') return false;
  if (!sameValue(row.basedOn.value ?? null, valueAt(doc, row.path) ?? null)) return true;
  return provenanceAt(doc, row.path)?.origin === 'user' && row.basedOn.origin !== 'user';
};

interface SuggestionContext {
  doc: BrandSystemDocumentV1;
  names: ReadonlyMap<string, string>;
  labels: ReadonlyMap<string, { title: string; url: string | null }>;
}

function toSuggestionDto(s: SuggestionRow, ctx: SuggestionContext): BrandSuggestionDto {
  const parsed = parsePath(s.path);
  const virtual = parsed?.target.kind === 'keyed' && parsed.target.virtual;
  const current = virtual ? null : (stripProvenance(valueAt(ctx.doc, s.path)) ?? null);
  const value = s.op === 'remove' ? null : (s.payload ?? null);
  return {
    id: s.id,
    jobId: s.jobId,
    brandId: s.brandId,
    section: s.section,
    path: s.path,
    label: pathLabel(s.path),
    op: s.op,
    value,
    current,
    valueText: value === null ? null : describeValue(value) || null,
    currentText: current === null ? null : describeValue(current) || null,
    provenance: s.provenance,
    rationale: s.rationale,
    uncertainty: s.uncertainty,
    conflicts: s.conflicts,
    evidence: s.evidence.map((e) => ({
      ...e,
      sourceTitle: ctx.labels.get(e.sourceId)?.title ?? null,
      sourceUrl: ctx.labels.get(e.sourceId)?.url ?? null,
    })),
    againstUserItem: s.againstUserItem === 'yes',
    changedSince: s.status === 'pending' && changedSince(s, ctx.doc),
    status: s.status,
    decidedByName: nameOf(ctx.names, s.decidedById),
    decidedAt: iso(s.decidedAt),
    batchId: s.batchId,
    factId: s.factId,
    createdAt: s.createdAt.toISOString(),
    version: s.version,
  };
}

async function suggestionContext(
  brand: BrandRow,
  rows: readonly SuggestionRow[],
  tx?: Tx,
): Promise<SuggestionContext> {
  const doc = await workingDocument(brand, tx);
  const names = await accessService.memberNames(
    rows.flatMap((r) => (r.decidedById ? [r.decidedById] : [])),
    tx,
  );
  const ids = [...new Set(rows.flatMap((r) => r.evidence.map((e: SuggestionEvidence) => e.sourceId)))];
  const labels = new Map(
    (await sourcesRepo.labelsOf(brand.id, ids, tx)).map((l) => [l.id, { title: l.title, url: l.url }]),
  );
  return { doc, names, labels };
}

/** D-22: a proposal sent for review is not changed under its reviewers; suggestions wait until it is back. */
function assertProposalOpenForEdits(proposal: Pick<VersionRow, 'state'>, path: string): void {
  if (proposal.state === 'in_review')
    throw new ValidationFailedError(
      [{ path, issue: 'proposal_in_review' }],
      'The proposed changes are in review. Approve them or send them back before changing them with suggestions',
    );
}

/** The pending proposal to write into, made from the applied brand system when there is none (D-22 proposal). */
async function proposalFor(actor: ResolvedActor, brand: BrandRow, tx: Tx): Promise<VersionRow> {
  const existing = await pendingProposalOf(brand, tx);
  if (existing) {
    assertProposalOpenForEdits(existing, 'suggestionIds');
    return existing;
  }
  const document = await appliedDocument(brand, tx);
  const id = newId('brandVersion');
  const number = await versionsRepo.nextNumber(brand.id, tx);
  await versionsRepo.create(
    { id, brandId: brand.id, number, state: 'draft', document, contentHash: hashCanonical(document) },
    tx,
  );
  await audit.record(
    actorRef(actor),
    'brand.version.create_draft',
    { type: 'brand_version', id },
    'allowed',
    tx,
    {
      brandId: brand.id,
      cause: 'suggestion_accepted',
    },
  );
  return versionsRepo.getById(id, tx);
}

interface Decision {
  row: SuggestionRow;
  /** The value a person wrote instead (edit), already checked; undefined to take the suggestion as it is. */
  edited?: unknown;
}

/**
 * Accept or edit: each value is written into the pending proposal (made if needed) with its provenance (`user` when
 * a person edited it), a fact suggestion becomes a proposed fact (dedupe aware), and the batch is recorded so it can
 * be undone. The proposal must still hold together (the same reference checks as any save). People only.
 */
async function decideAccept(
  actor: ResolvedActor,
  brand: BrandRow,
  decisions: Decision[],
  tx: Tx,
): Promise<BrandSuggestionDecisionResult> {
  const batchId = newId('brandSuggestionBatch');
  const skipped: BrandSuggestionDecisionResult['skipped'] = [];
  const decided: string[] = [];
  const factIds: string[] = [];
  const docDecisions = decisions.filter((d) => d.row.section !== 'facts');
  const proposal = docDecisions.length ? await proposalFor(actor, brand, tx) : null;
  let doc = proposal ? BrandSystemDocumentV1.parse(proposal.document) : null;
  const before = doc;
  const now = new Date();
  for (const { row, edited } of decisions) {
    const status = edited === undefined ? 'accepted' : 'edited';
    if (row.section === 'facts') {
      const value = (edited ?? row.payload) as { statement: string; category: string; scope?: string };
      const verified = row.evidence.filter((e) => e.verified).slice(0, 20);
      const labels = new Map(
        (
          await sourcesRepo.labelsOf(
            brand.id,
            verified.map((e) => e.sourceId),
            tx,
          )
        ).map((l) => [l.id, l]),
      );
      const shaped: FactSource[] = verified.map((e) => {
        const l = labels.get(e.sourceId);
        const excerpt = e.excerpt.slice(0, 1000);
        return l?.url
          ? { kind: 'url', ref: l.url, title: l.title.slice(0, 200), excerpt }
          : {
              kind: 'document',
              ref: (l?.title ?? e.sourceId).slice(0, 1000),
              title: (l?.title ?? 'Source').slice(0, 200),
              excerpt,
            };
      });
      const origin = edited === undefined ? factOriginFor(row.provenance) : 'user';
      const result = await brandService.facts.propose(
        actor,
        {
          brandId: brand.id,
          category: value.category as never,
          statement: value.statement,
          ...(value.scope ? { scope: value.scope } : {}),
          origin,
          sources: shaped,
        },
        tx,
      );
      factIds.push(result.factId);
      await suggestionsRepo.update(
        row.id,
        row.version,
        {
          status,
          decidedById: actor.id,
          decidedAt: now,
          batchId,
          factId: result.factId,
          appliedValue: { factId: result.factId, created: !result.duplicate },
          ...(edited === undefined ? {} : { payload: edited }),
        },
        tx,
      );
      decided.push(row.id);
      continue;
    }
    if (!doc) continue;
    if (changedSince(row, doc)) {
      skipped.push({ suggestionId: row.id, reason: 'changed_since' });
      continue;
    }
    const value = edited ?? row.payload;
    const previous = valueAt(doc, row.path);
    const provenance: GuidanceProvenance =
      edited === undefined
        ? { ...row.provenance, suggestionId: row.id }
        : { origin: 'user', suggestionId: row.id };
    try {
      doc = applyChange(doc, { path: row.path, op: row.op, value, provenance });
    } catch (err) {
      skipped.push({ suggestionId: row.id, reason: (err as { issue?: string }).issue ?? 'invalid_value' });
      continue;
    }
    await suggestionsRepo.update(
      row.id,
      row.version,
      {
        status,
        decidedById: actor.id,
        decidedAt: now,
        batchId,
        appliedProposalVersionId: proposal?.id ?? null,
        appliedBefore: previous === undefined ? null : previous,
        appliedValue: row.op === 'remove' ? null : (valueAt(doc, row.path) ?? null),
        ...(edited === undefined ? {} : { payload: edited }),
      },
      tx,
    );
    decided.push(row.id);
  }
  if (proposal && doc && before && hashCanonical(doc) !== hashCanonical(before)) {
    const published = brand.publishedVersionId ? await versionsRepo.findPublished(brand.id, tx) : null;
    await assertDocumentReferences(
      brand.id,
      doc,
      published
        ? BrandSystemDocumentV1.parse(published.document)
        : BrandSystemDocumentV1.parse(proposal.document),
      tx,
    );
    await versionsRepo.update(
      proposal.id,
      proposal.version,
      { document: doc, contentHash: hashCanonical(doc) },
      tx,
    );
  }
  if (decided.length)
    await audit.record(
      actorRef(actor),
      'brand.suggestion.accept',
      { type: 'brand', id: brand.id },
      'allowed',
      tx,
      {
        brandId: brand.id,
        batchId,
        count: decided.length,
        ...(proposal ? { proposalVersionId: proposal.id } : {}),
      },
    );
  return {
    batchId: decided.length ? batchId : null,
    proposalVersionId: proposal?.id ?? null,
    decided,
    factIds,
    skipped,
  };
}

async function assertMayDecideOnBrand(actor: ResolvedActor, brand: BrandRow, tx: Tx) {
  const decision = await policy.assert(actor, 'brand.edit_standards', brandResource(brand), {}, tx);
  assertMayDecide(decision); // agents propose; a person accepts, edits, rejects and undoes
}

function pendingOnly(rows: SuggestionRow[]) {
  const skipped: BrandSuggestionDecisionResult['skipped'] = [];
  const pending = rows.filter((r) => {
    if (r.status === 'pending') return true;
    skipped.push({ suggestionId: r.id, reason: `already_${r.status}` });
    return false;
  });
  return { pending, skipped };
}

// ---- the service ----

/** Retention of captured source text (worker-core registers it with the retention sweep). */
export const brandSourceRetention = {
  purgeText: (cutoff: Date, dryRun: boolean, tx: Tx): Promise<number> =>
    sourcesRepo.purgeTextCapturedBefore(cutoff, dryRun, tx),
};

export const brandAssistService = {
  sources: {
    /**
     * Adds a source. A website is read when an assist job starts (worker-ingest); a document is uploaded to the URL
     * returned and read when a job starts (worker-render); pasted text and an asset's description are captured at
     * once. The same address, text or asset already live in the brand is not added twice (`duplicate: true`).
     */
    async add(actor: ResolvedActor, input: z.input<typeof BrandSourceAdd>, tx: Tx) {
      const parsed = BrandSourceAdd.parse(input);
      await assertTenantCapability('brand_source_capture', tx);
      const brand = await brandsRepo.lock(parsed.brandId, tx);
      await policy.assert(actor, 'brand.edit_standards', brandResource(brand), {}, tx);
      if (actor.kind !== 'user' && actor.kind !== 'service_principal')
        throw new PolicyDeniedError('actor_kind_not_allowed', 'Only people and agents may add sources');
      if ((await sourcesRepo.countLive(brand.id, tx)) >= SOURCES_PER_BRAND_MAX)
        throw new ValidationFailedError(
          [{ path: 'brandId', issue: 'too_many_sources' }],
          `A brand holds at most ${SOURCES_PER_BRAND_MAX} sources; remove some first`,
        );
      const { tenantId } = requireTenant();
      const id = newId('brandSource');
      const base = {
        id,
        brandId: brand.id,
        createdByKind: actor.kind,
        createdById: actor.id,
      } as const;
      let upload: { url: string; expiresAt: string; contentType: string } | null = null;
      switch (parsed.kind) {
        case 'url': {
          const url = normaliseSourceUrl(parsed.url).toString();
          const existing = await sourcesRepo.findLiveByUrl(brand.id, url, tx);
          if (existing)
            return { sourceId: existing.id, version: existing.version, duplicate: true, upload: null };
          await sourcesRepo.create(
            { ...base, kind: 'url', title: parsed.title ?? new URL(url).host, url, status: 'pending' },
            tx,
          );
          break;
        }
        case 'text': {
          const capped = capText(tidyText(parsed.text), SOURCE_TEXT_MAX_CHARS);
          const contentHash = sha256Hex(capped.text);
          const existing = await sourcesRepo.findLiveByHash(brand.id, contentHash, null, tx);
          if (existing)
            return { sourceId: existing.id, version: existing.version, duplicate: true, upload: null };
          await sourcesRepo.create(
            {
              ...base,
              kind: 'text',
              title: parsed.title,
              status: 'captured',
              text: capped.text,
              truncated: capped.truncated ? 'yes' : 'no',
              contentHash,
              charCount: capped.text.length,
              byteSize: Buffer.byteLength(parsed.text),
              capturedAt: new Date(),
            },
            tx,
          );
          break;
        }
        case 'document': {
          if (!uploadStore)
            throw new PolicyDeniedError(
              'not_available_yet',
              'Document uploads are not available in this service',
            );
          const storageKey = sourceUploadKey(tenantId, id);
          await sourcesRepo.create(
            {
              ...base,
              kind: 'document',
              title: parsed.title ?? parsed.fileName,
              fileName: parsed.fileName,
              mime: parsed.mime,
              byteSize: parsed.byteSize,
              storageKey,
              status: 'pending',
            },
            tx,
          );
          const signed = await uploadStore.signUpload(storageKey, {
            contentType: parsed.mime,
            contentLength: parsed.byteSize,
          });
          upload = { url: signed.url, expiresAt: signed.expiresAt.toISOString(), contentType: parsed.mime };
          break;
        }
        case 'brand_asset': {
          const asset = await assetResolver(brand.id, parsed.assetVersionId, tx);
          if (!asset) throw new NotFoundError('AssetVersion', parsed.assetVersionId);
          if (asset.state !== 'approved')
            throw new ValidationFailedError(
              [{ path: 'assetVersionId', issue: 'asset_not_approved' }],
              'Only approved assets can be used as sources',
            );
          const existing = await sourcesRepo.findLiveByAssetVersion(brand.id, asset.assetVersionId, tx);
          if (existing)
            return { sourceId: existing.id, version: existing.version, duplicate: true, upload: null };
          const readable = asset.mime === 'application/pdf';
          // Images, logos and fonts are evidence by their description only: nothing is read from the file.
          const described = readable
            ? null
            : tidyText(
                [
                  `Brand asset "${asset.name}": ${asset.kind}, ${SOURCE_DOCUMENT_TYPES[asset.mime as keyof typeof SOURCE_DOCUMENT_TYPES] ?? asset.mime}, approved.`,
                  asset.width && asset.height ? `Size: ${asset.width} x ${asset.height} pixels.` : '',
                  asset.altText ? `Description: ${asset.altText}` : '',
                ].join('\n'),
              );
          await sourcesRepo.create(
            {
              ...base,
              kind: 'brand_asset',
              title: asset.name,
              mime: asset.mime,
              assetId: asset.assetId,
              assetVersionId: asset.assetVersionId,
              byteSize: asset.bytes,
              storageKey: readable ? asset.storageKey : null,
              status: readable ? 'pending' : 'captured',
              ...(described
                ? {
                    text: described,
                    contentHash: sha256Hex(described),
                    charCount: described.length,
                    capturedAt: new Date(),
                  }
                : {}),
            },
            tx,
          );
          break;
        }
      }
      await audit.record(actorRef(actor), 'brand.source.add', { type: 'brand_source', id }, 'allowed', tx, {
        brandId: brand.id,
        kind: parsed.kind,
      });
      return { sourceId: id, version: 0, duplicate: false, upload };
    },

    async list(actor: ResolvedActor, input: z.input<typeof BrandSourceList>, tx?: Tx) {
      const parsed = BrandSourceList.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      await policy.assert(actor, 'brand.read', brandResource(brand), {}, tx);
      const page = await sourcesRepo.list(brand.id, parsed.page, tx);
      return { items: page.items.map(toSourceDto), nextCursor: page.nextCursor };
    },

    /** One source with the start of its text (what a person reads to check an excerpt in context). */
    async get(actor: ResolvedActor, input: z.input<typeof BrandSourceGet>, tx?: Tx) {
      const parsed = BrandSourceGet.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      await policy.assert(actor, 'brand.read', brandResource(brand), {}, tx);
      const s = await loadSource(brand.id, parsed.sourceId, tx);
      return {
        ...toSourceDto(s),
        text: s.text ? s.text.slice(0, 60_000) : null,
        textTruncated: (s.text?.length ?? 0) > 60_000,
      };
    },

    /** Removes a source from the list; suggestions that cite it keep naming it. An unread upload is deleted. */
    async remove(actor: ResolvedActor, input: z.input<typeof BrandSourceRemove>, tx: Tx) {
      const parsed = BrandSourceRemove.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      await policy.assert(actor, 'brand.edit_standards', brandResource(brand), {}, tx);
      const s = await loadSource(brand.id, parsed.sourceId, tx);
      await sourcesRepo.update(
        s.id,
        parsed.expectedVersion,
        { removedAt: new Date(), ...(s.kind === 'document' ? { storageKey: null } : {}) },
        tx,
      );
      if (s.kind === 'document' && s.storageKey && uploadStore)
        await uploadStore.delete(s.storageKey).catch(() => {});
      await audit.record(
        actorRef(actor),
        'brand.source.remove',
        { type: 'brand_source', id: s.id },
        'allowed',
        tx,
        {
          brandId: brand.id,
        },
      );
      return { sourceId: s.id, version: parsed.expectedVersion + 1 };
    },
  },

  assist: {
    /** What a job would cost and what would stop it, read before it starts; nothing is reserved or written. */
    async estimate(actor: ResolvedActor, input: BrandAssistRequest, tx?: Tx): Promise<BrandAssistEstimateV1> {
      const parsed = BrandAssistRequest.parse(input);
      await assertTenantCapability('brand_assist', tx);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      await policy.assert(actor, 'brand.edit_standards', brandResource(brand), {}, tx);
      const sources = await sourcesRepo.listByIds(brand.id, parsed.sourceIds, tx);
      if (sources.length !== new Set(parsed.sourceIds).size || sources.some((s) => s.removedAt))
        throw new NotFoundError(
          'BrandSource',
          parsed.sourceIds.find((id) => !sources.some((s) => s.id === id)) ?? '',
        );
      const usable = sources.filter(sourceIsUsable).length;
      const pending = sources.filter(sourceIsPending).length;
      const guidanceChars = JSON.stringify(await appliedDocument(brand, tx)).length;
      const sections = modelGate
        ? estimateSections(parsed.sections, evidenceCharsOf(sources), guidanceChars, modelGate)
        : [];
      const estimateMicros = sections.reduce((n, s) => n + s.costMicros, 0);
      const { blockers, remaining } = await assistBlockers(brand.id, estimateMicros, tx);
      if (parsed.kind === 'setup' && usable + pending === 0)
        blockers.push({ code: 'no_usable_sources', message: 'Add at least one source that can be read.' });
      return {
        estimateMicros,
        sections,
        sources: { usable, pending, unusable: sources.length - usable - pending },
        blockers,
        remaining,
      };
    },

    /**
     * Starts a job (outbox brand.assist_requested → brandAssistWorkflowV1). Refused for the first blocker an estimate
     * would show. An identical request while one is running joins it (`duplicate: true`).
     */
    async start(
      actor: ResolvedActor,
      input: BrandAssistRequest,
      tx: Tx,
      extra: { answers?: Array<{ question: string; answer: string }>; parentJobId?: string } = {},
    ) {
      const parsed = BrandAssistRequest.parse(input);
      await assertTenantCapability('brand_assist', tx);
      const brand = await brandsRepo.lock(parsed.brandId, tx);
      await policy.assert(actor, 'brand.edit_standards', brandResource(brand), {}, tx);
      if (actor.kind !== 'user' && actor.kind !== 'service_principal')
        throw new PolicyDeniedError(
          'actor_kind_not_allowed',
          'Only people and agents may ask for suggestions',
        );
      const sourceIds = [...new Set(parsed.sourceIds)];
      const sources = await sourcesRepo.listByIds(brand.id, sourceIds, tx);
      for (const id of sourceIds)
        if (!sources.some((s) => s.id === id && !s.removedAt)) throw new NotFoundError('BrandSource', id);
      for (const [i, p] of (parsed.preserve ?? []).entries())
        if (!parsePath(p))
          throw new ValidationFailedError([{ path: `preserve.${i}`, issue: 'unknown_path' }]);
      if (parsed.alternativesForJobId) await loadJob(brand.id, parsed.alternativesForJobId, tx);
      const requestKey = hashCanonical({
        kind: parsed.kind,
        sections: [...parsed.sections].sort(),
        instruction: parsed.instruction ?? null,
        sourceIds: [...sourceIds].sort(),
        preserve: [...(parsed.preserve ?? [])].sort(),
        alternativesFor: parsed.alternativesForJobId ?? null,
        answers: extra.answers ?? null,
      });
      const running = await jobsRepo.findRunningByKey(brand.id, requestKey, tx);
      if (running)
        return { jobId: running.id, state: running.state, duplicate: true, version: running.version };
      const usable = sources.filter(sourceIsUsable).length;
      const pending = sources.filter(sourceIsPending).length;
      if (parsed.kind === 'setup' && usable + pending === 0)
        throw new ValidationFailedError(
          [{ path: 'sourceIds', issue: 'no_usable_sources' }],
          'Add at least one source that can be read',
        );
      if (!modelGate)
        throw new PolicyDeniedError('not_available_yet', 'No AI model is configured for this service');
      const guidanceChars = JSON.stringify(await appliedDocument(brand, tx)).length;
      const estimateMicros = estimateSections(
        parsed.sections,
        evidenceCharsOf(sources),
        guidanceChars,
        modelGate,
      ).reduce((n, s) => n + s.costMicros, 0);
      const { blockers } = await assistBlockers(brand.id, estimateMicros, tx);
      const first = blockers[0];
      if (first) {
        if (first.code === 'budget_exhausted_month' || first.code === 'budget_exhausted_day')
          throw new BudgetExhaustedError(
            first.code === 'budget_exhausted_month' ? 'tenant_month' : 'brand_day',
          );
        throw new PolicyDeniedError(first.code, first.message);
      }
      const urls = sources.filter((s) => s.kind === 'url' && sourceIsPending(s)).length;
      const docs = sources.filter((s) => s.kind !== 'url' && sourceIsPending(s)).length;
      const id = newId('brandAssistJob');
      await jobsRepo.create(
        {
          id,
          brandId: brand.id,
          kind: parsed.kind,
          sections: parsed.sections,
          instruction: parsed.instruction?.trim() || null,
          sourceIds,
          preserve: parsed.preserve ?? [],
          answers: extra.answers ?? null,
          parentJobId: extra.parentJobId ?? null,
          alternativesForJobId: parsed.alternativesForJobId ?? null,
          state: 'queued',
          progress: emptyProgress(parsed.sections, urls, docs),
          questions: [],
          estimateMicros,
          requestKey,
          createdByKind: actor.kind,
          createdById: actor.id,
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'brand.assist.start',
        { type: 'brand_assist_job', id },
        'allowed',
        tx,
        {
          brandId: brand.id,
          kind: parsed.kind,
          count: parsed.sections.length,
        },
      );
      await outbox.add(
        'brand.assist_requested',
        { type: 'brand_assist_job', id, version: 0 },
        { jobId: id, brandId: brand.id, actorKind: actor.kind, actorId: actor.id },
        tx,
        { brandId: brand.id },
      );
      return { jobId: id, state: 'queued' as const, duplicate: false, version: 0 };
    },

    async get(
      actor: ResolvedActor,
      input: z.input<typeof BrandAssistGet>,
      tx?: Tx,
    ): Promise<BrandAssistJobDto> {
      const parsed = BrandAssistGet.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      await policy.assert(actor, 'brand.read', brandResource(brand), {}, tx);
      const job = await loadJob(brand.id, parsed.jobId, tx);
      const names = await accessService.memberNames(
        job.createdByKind === 'user' ? [job.createdById] : [],
        tx,
      );
      return toJobDto(job, names, await suggestionsRepo.countsForJob(brand.id, job.id, tx));
    },

    async list(actor: ResolvedActor, input: z.input<typeof BrandAssistList>, tx?: Tx) {
      const parsed = BrandAssistList.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      await policy.assert(actor, 'brand.read', brandResource(brand), {}, tx);
      const page = await jobsRepo.list(brand.id, parsed.page, tx);
      const names = await accessService.memberNames(
        page.items.flatMap((j) => (j.createdByKind === 'user' ? [j.createdById] : [])),
        tx,
      );
      const items = [];
      for (const j of page.items)
        items.push(toJobDto(j, names, await suggestionsRepo.countsForJob(brand.id, j.id, tx)));
      return { items, nextCursor: page.nextCursor };
    },

    /** Asks the running workflow to stop (outbox brand.assist_cancel_requested → signal); a finished job is unchanged. */
    async cancel(actor: ResolvedActor, input: z.input<typeof BrandAssistCancel>, tx: Tx) {
      const parsed = BrandAssistCancel.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      await policy.assert(actor, 'brand.edit_standards', brandResource(brand), {}, tx);
      const job = await jobsRepo.lock(brand.id, parsed.jobId, tx);
      if (!job) throw new NotFoundError('BrandAssistJob', parsed.jobId);
      if (isTerminal(job.state) || job.cancelRequestedAt)
        return { jobId: job.id, state: job.state, version: job.version };
      await jobsRepo.update(job.id, job.version, { cancelRequestedAt: new Date() }, tx);
      await audit.record(
        actorRef(actor),
        'brand.assist.cancel',
        { type: 'brand_assist_job', id: job.id },
        'allowed',
        tx,
        {
          brandId: brand.id,
        },
      );
      await outbox.add(
        'brand.assist_cancel_requested',
        { type: 'brand_assist_job', id: job.id, version: job.version + 1 },
        { jobId: job.id, workflowId: ASSIST_WORKFLOW_ID(job.id), actorKind: actor.kind, actorId: actor.id },
        tx,
        { brandId: brand.id },
      );
      return { jobId: job.id, state: job.state, version: job.version + 1 };
    },

    /** Records answers to a finished job's questions and starts a follow-up section job that reads them. */
    async answer(actor: ResolvedActor, input: z.input<typeof BrandAssistAnswer>, tx: Tx) {
      const parsed = BrandAssistAnswer.parse(input);
      await assertTenantCapability('brand_assist', tx);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      await policy.assert(actor, 'brand.edit_standards', brandResource(brand), {}, tx);
      const job = await jobsRepo.lock(brand.id, parsed.jobId, tx);
      if (!job) throw new NotFoundError('BrandAssistJob', parsed.jobId);
      if (job.state !== 'ready' && job.state !== 'partially_ready')
        throw new ValidationFailedError(
          [{ path: 'jobId', issue: 'job_not_ready' }],
          'Answer once the job has finished',
        );
      const questions = job.questions.map((q) => {
        const a = parsed.answers.find((x) => x.questionId === q.id);
        return a ? { ...q, answer: a.answer } : q;
      });
      for (const [i, a] of parsed.answers.entries())
        if (!job.questions.some((q) => q.id === a.questionId))
          throw new ValidationFailedError([{ path: `answers.${i}.questionId`, issue: 'unknown_question' }]);
      await jobsRepo.update(job.id, job.version, { questions }, tx);
      const answered = questions.filter((q) => parsed.answers.some((a) => a.questionId === q.id));
      const sections = [...new Set(answered.map((q) => q.section))];
      return brandAssistService.assist.start(
        actor,
        { brandId: brand.id, kind: 'section', sections, sourceIds: job.sourceIds, preserve: job.preserve },
        tx,
        {
          answers: answered.map((q) => ({ question: q.question, answer: q.answer ?? '' })),
          parentJobId: job.id,
        },
      );
    },
  },

  suggestions: {
    async list(actor: ResolvedActor, input: z.input<typeof BrandSuggestionList>, tx?: Tx) {
      const parsed = BrandSuggestionList.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      await policy.assert(actor, 'brand.read', brandResource(brand), {}, tx);
      if (parsed.jobId) await loadJob(brand.id, parsed.jobId, tx);
      const page = await suggestionsRepo.list(
        brand.id,
        {
          ...(parsed.jobId ? { jobId: parsed.jobId } : {}),
          ...(parsed.section ? { section: parsed.section } : {}),
          ...(parsed.status ? { status: parsed.status } : {}),
        },
        parsed.page,
        tx,
      );
      const ctx = await suggestionContext(brand, page.items, tx);
      return { items: page.items.map((s) => toSuggestionDto(s, ctx)), nextCursor: page.nextCursor };
    },

    async accept(actor: ResolvedActor, input: z.input<typeof BrandSuggestionAccept>, tx: Tx) {
      const parsed = BrandSuggestionAccept.parse(input);
      const brand = await brandsRepo.lock(parsed.brandId, tx);
      await assertMayDecideOnBrand(actor, brand, tx);
      const rows = await suggestionsRepo.listByIds(brand.id, parsed.suggestionIds, tx);
      for (const id of parsed.suggestionIds)
        if (!rows.some((r) => r.id === id)) throw new NotFoundError('BrandSuggestion', id);
      const { pending, skipped } = pendingOnly(rows);
      const result = await decideAccept(
        actor,
        brand,
        pending.map((row) => ({ row })),
        tx,
      );
      return { ...result, skipped: [...skipped, ...result.skipped] };
    },

    /** Accept with the person's own wording: checked against the item's schema; its provenance becomes `user`. */
    async edit(actor: ResolvedActor, input: z.input<typeof BrandSuggestionEdit>, tx: Tx) {
      const parsed = BrandSuggestionEdit.parse(input);
      const brand = await brandsRepo.lock(parsed.brandId, tx);
      await assertMayDecideOnBrand(actor, brand, tx);
      const [row] = await suggestionsRepo.listByIds(brand.id, [parsed.suggestionId], tx);
      if (!row) throw new NotFoundError('BrandSuggestion', parsed.suggestionId);
      if (row.status !== 'pending')
        throw new ValidationFailedError([{ path: 'suggestionId', issue: `already_${row.status}` }]);
      if (row.op === 'remove')
        throw new ValidationFailedError(
          [{ path: 'value', issue: 'removal_has_no_value' }],
          'Accept or reject a removal',
        );
      const target = parsePath(row.path);
      const checked = target?.target.schema.safeParse(stripProvenance(parsed.value));
      if (!target || !checked?.success)
        throw new ValidationFailedError(
          (checked?.error?.issues ?? [])
            .slice(0, 10)
            .map((i) => ({ path: `value.${i.path.join('.')}`, issue: i.message })),
          'The edited value is not valid for this item',
        );
      // An edit that renames a keyed item would land elsewhere: the key stays the suggestion's.
      if (target.target.kind === 'keyed' && !target.target.virtual) {
        const key = target.target.keyOf(checked.data as Record<string, unknown>);
        if (key.trim().toLocaleLowerCase() !== (target.key ?? '').trim().toLocaleLowerCase())
          throw new ValidationFailedError(
            [{ path: 'value', issue: 'key_changed' }],
            'Keep the item’s name; reject this suggestion and add the item yourself to rename it',
          );
      }
      return decideAccept(actor, brand, [{ row, edited: checked.data }], tx);
    },

    /** Rejected suggestions are remembered by fingerprint: a later import or regeneration does not suggest them again. */
    async reject(actor: ResolvedActor, input: z.input<typeof BrandSuggestionReject>, tx: Tx) {
      const parsed = BrandSuggestionReject.parse(input);
      const brand = await brandsRepo.lock(parsed.brandId, tx);
      await assertMayDecideOnBrand(actor, brand, tx);
      const rows = await suggestionsRepo.listByIds(brand.id, parsed.suggestionIds, tx);
      for (const id of parsed.suggestionIds)
        if (!rows.some((r) => r.id === id)) throw new NotFoundError('BrandSuggestion', id);
      const { pending, skipped } = pendingOnly(rows);
      const now = new Date();
      for (const r of pending)
        await suggestionsRepo.update(
          r.id,
          r.version,
          { status: 'rejected', decidedById: actor.id, decidedAt: now },
          tx,
        );
      if (pending.length)
        await audit.record(
          actorRef(actor),
          'brand.suggestion.reject',
          { type: 'brand', id: brand.id },
          'allowed',
          tx,
          {
            brandId: brand.id,
            count: pending.length,
          },
        );
      return {
        batchId: null,
        proposalVersionId: null,
        decided: pending.map((r) => r.id),
        factIds: [],
        skipped,
      };
    },

    async acceptAll(actor: ResolvedActor, input: z.input<typeof BrandSuggestionAcceptAll>, tx: Tx) {
      const parsed = BrandSuggestionAcceptAll.parse(input);
      const brand = await brandsRepo.lock(parsed.brandId, tx);
      await assertMayDecideOnBrand(actor, brand, tx);
      await loadJob(brand.id, parsed.jobId, tx);
      const rows = (await suggestionsRepo.listForJob(brand.id, parsed.jobId, tx)).filter(
        (r) => r.section === parsed.section && r.status === 'pending',
      );
      return decideAccept(
        actor,
        brand,
        rows.map((row) => ({ row })),
        tx,
      );
    },

    /**
     * Undoes an accepted batch (the latest when none is named): each item goes back to what it was, unless it changed
     * since (then it is left and reported), and a fact it proposed is withdrawn while still proposed. The suggestions
     * become pending again. Only while the proposal they went into is still open.
     */
    async undo(actor: ResolvedActor, input: z.input<typeof BrandSuggestionUndo>, tx: Tx) {
      const parsed = BrandSuggestionUndo.parse(input);
      const brand = await brandsRepo.lock(parsed.brandId, tx);
      await assertMayDecideOnBrand(actor, brand, tx);
      const batchId = parsed.batchId ?? (await suggestionsRepo.latestBatch(brand.id, tx));
      if (!batchId)
        throw new ValidationFailedError(
          [{ path: 'batchId', issue: 'nothing_to_undo' }],
          'There is nothing to undo',
        );
      const rows = (await suggestionsRepo.listBatch(brand.id, batchId, tx)).filter(
        (r) => r.status === 'accepted' || r.status === 'edited',
      );
      if (rows.length === 0) throw new NotFoundError('SuggestionBatch', batchId);
      const proposalId = rows.find((r) => r.appliedProposalVersionId)?.appliedProposalVersionId ?? null;
      const proposal = proposalId ? await versionsRepo.findById(proposalId, tx) : null;
      if (
        proposalId &&
        (!proposal ||
          proposal.brandId !== brand.id ||
          (proposal.state !== 'draft' && proposal.state !== 'in_review'))
      )
        throw new ValidationFailedError(
          [{ path: 'batchId', issue: 'proposal_closed' }],
          'These suggestions were already applied or discarded; restore an earlier version from History instead',
        );
      if (proposal) assertProposalOpenForEdits(proposal, 'batchId');
      let doc = proposal ? BrandSystemDocumentV1.parse(proposal.document) : null;
      const before = doc;
      const skipped: BrandSuggestionDecisionResult['skipped'] = [];
      const undone: string[] = [];
      // Walked in reverse of how the batch was applied: an item goes back only while it still holds what this batch
      // wrote, so when two changes in the batch touched one item, the later one is undone first.
      const order: SuggestionRow[] = [];
      const waiting = rows.filter((r) => r.section !== 'facts');
      for (let progress = true; progress && waiting.length;) {
        progress = false;
        for (const r of [...waiting]) {
          const now = doc ? valueAt(doc, r.path) : undefined;
          if (!doc || !sameValue(stripProvenance(now) ?? null, stripProvenance(r.appliedValue) ?? null))
            continue;
          order.push(r);
          waiting.splice(waiting.indexOf(r), 1);
          progress = true;
          const prior = r.appliedBefore ?? undefined;
          doc = applyChange(doc, {
            path: r.path,
            op: prior === undefined ? 'remove' : 'replace',
            value: prior === undefined ? null : stripProvenance(prior),
            ...(prior && typeof prior === 'object' && 'provenance' in (prior as object)
              ? { provenance: (prior as { provenance: GuidanceProvenance }).provenance }
              : {}),
          });
        }
      }
      for (const r of waiting) skipped.push({ suggestionId: r.id, reason: 'changed_since' });
      for (const r of [...rows.filter((x) => x.section === 'facts'), ...order]) {
        if (r.section === 'facts') {
          const applied = r.appliedValue as { factId?: string; created?: boolean } | null;
          if (applied?.factId && applied.created) {
            const fact = (
              await brandService.facts.list(
                actor,
                { brandId: brand.id, ids: [applied.factId], page: { limit: 1 } },
                tx,
              )
            ).items[0];
            if (fact?.state === 'proposed')
              await brandService.facts.withdraw(
                actor,
                {
                  brandId: brand.id,
                  factId: fact.id,
                  expectedVersion: fact.version,
                  reason: 'Suggestion undone',
                },
                tx,
              );
          }
        }
        await suggestionsRepo.update(
          r.id,
          r.version,
          {
            status: 'pending',
            decidedById: null,
            decidedAt: null,
            batchId: null,
            appliedProposalVersionId: null,
            appliedBefore: null,
            appliedValue: null,
            factId: null,
          },
          tx,
        );
        undone.push(r.id);
      }
      if (proposal && doc && before) {
        const contentHash = hashCanonical(doc);
        if (contentHash !== proposal.contentHash) {
          // What is put back must still hold together, as any save (a reference removed meanwhile, for instance).
          const published = brand.publishedVersionId ? await versionsRepo.findPublished(brand.id, tx) : null;
          await assertDocumentReferences(
            brand.id,
            doc,
            published ? BrandSystemDocumentV1.parse(published.document) : before,
            tx,
          );
          await versionsRepo.update(proposal.id, proposal.version, { document: doc, contentHash }, tx);
        }
      }
      await audit.record(
        actorRef(actor),
        'brand.suggestion.undo',
        { type: 'brand', id: brand.id },
        'allowed',
        tx,
        {
          brandId: brand.id,
          batchId,
          count: undone.length,
        },
      );
      return { batchId, proposalVersionId: proposal?.id ?? null, decided: undone, factIds: [], skipped };
    },
  },

  /** BSC-5: the applied versions of the brand system, compared and restored (a restore is a normal save). */
  history: {
    async list(actor: ResolvedActor, input: z.input<typeof BrandHistoryList>, tx?: Tx) {
      const parsed = BrandHistoryList.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      await policy.assert(actor, 'brand.read', brandResource(brand), {}, tx);
      const page = await historyRepo.listApplied(brand.id, parsed.page, tx);
      const names = await accessService.memberNames(
        page.items.flatMap((v) => (v.publishedByUserId ? [v.publishedByUserId] : [])),
        tx,
      );
      const items: BrandHistoryEntryDto[] = [];
      for (const v of page.items) {
        const previous = await historyRepo.appliedBefore(brand.id, v.number, tx);
        items.push({
          versionId: v.id,
          number: v.number,
          current: v.id === brand.publishedVersionId,
          appliedAt: iso(v.publishedAt),
          appliedByName: nameOf(names, v.publishedByUserId),
          changedSections: changedSectionLabels(
            previous ? BrandSystemDocumentV1.parse(previous.document) : emptyBrandSystemDocument(),
            BrandSystemDocumentV1.parse(v.document),
          ),
        });
      }
      return { items, nextCursor: page.nextCursor };
    },

    /** What differs between an earlier version and the applied brand system (or another version), per section. */
    async compare(actor: ResolvedActor, input: z.input<typeof BrandHistoryCompare>, tx?: Tx) {
      const parsed = BrandHistoryCompare.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      await policy.assert(actor, 'brand.read', brandResource(brand), {}, tx);
      const from = await loadVersionOf(brand.id, parsed.versionId, tx);
      const toId = parsed.againstVersionId ?? brand.publishedVersionId;
      const to = toId ? await loadVersionOf(brand.id, toId, tx) : null;
      const summary = (v: VersionRow | null) =>
        v
          ? {
              versionId: v.id,
              number: v.number,
              appliedAt: iso(v.publishedAt),
              current: v.id === brand.publishedVersionId,
            }
          : null;
      return {
        from: summary(from),
        to: summary(to),
        sections: diffBrandDocuments(
          BrandSystemDocumentV1.parse(from.document),
          to ? BrandSystemDocumentV1.parse(to.document) : emptyBrandSystemDocument(),
        ),
      };
    },

    /**
     * Restores an earlier applied version: its document saved through brand.system.save, so permissions, reference
     * checks, the impact on approved and scheduled work and the audit behave exactly as for any save.
     */
    async restore(actor: ResolvedActor, input: z.input<typeof BrandHistoryRestore>, tx: Tx) {
      const parsed = BrandHistoryRestore.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      const v = await loadVersionOf(brand.id, parsed.versionId, tx);
      if (!v.publishedAt)
        throw new ValidationFailedError(
          [{ path: 'versionId', issue: 'never_applied' }],
          'Only a version that was applied can be restored',
        );
      if (v.id === brand.publishedVersionId)
        throw new ValidationFailedError(
          [{ path: 'versionId', issue: 'already_current' }],
          'This version is the brand system now',
        );
      const result = await brandService.system.save(
        actor,
        {
          brandId: brand.id,
          basedOnVersionId: parsed.basedOnVersionId,
          document: BrandSystemDocumentV1.parse(v.document),
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'brand.history.restore',
        { type: 'brand_version', id: v.id },
        'allowed',
        tx,
        {
          brandId: brand.id,
          ...(result.versionId ? { versionId: result.versionId } : {}),
        },
      );
      return { ...result, restoredFromVersionId: v.id, restoredFromNumber: v.number };
    },
  },
};

async function loadVersionOf(brandId: string, versionId: string, tx?: Tx): Promise<VersionRow> {
  const v = await versionsRepo.getById(versionId, tx);
  if (v.brandId !== brandId) throw new NotFoundError('BrandVersion', versionId);
  return v;
}

export function toJobDto(
  j: JobRow,
  names: ReadonlyMap<string, string>,
  counts: ReadonlyMap<string, number>,
): BrandAssistJobDto {
  return {
    id: j.id,
    brandId: j.brandId,
    kind: j.kind,
    sections: j.sections,
    instruction: j.instruction,
    sourceIds: j.sourceIds,
    preserve: j.preserve,
    state: j.state,
    progress: j.progress,
    questions: j.questions as BrandAssistQuestionV1[],
    estimateMicros: j.estimateMicros,
    reservedMicros: j.reservedMicros,
    spentMicros: j.spentMicros,
    error: j.error,
    parentJobId: j.parentJobId,
    cancelRequested: j.cancelRequestedAt !== null,
    createdByName: j.createdByKind === 'user' ? (names.get(j.createdById) ?? null) : null,
    suggestionCounts: {
      pending: counts.get('pending') ?? 0,
      accepted: counts.get('accepted') ?? 0,
      edited: counts.get('edited') ?? 0,
      rejected: counts.get('rejected') ?? 0,
      superseded: counts.get('superseded') ?? 0,
    },
    createdAt: j.createdAt.toISOString(),
    startedAt: iso(j.startedAt),
    finishedAt: iso(j.finishedAt),
    version: j.version,
  };
}
