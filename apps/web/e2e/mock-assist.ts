import { BrandSystemDocumentV1, type GuidanceProvenance } from '@oremedia/contracts/brand';
import {
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
  type AssistSection,
  type BrandAssistJobState,
  type BrandAssistProgressV1,
  type BrandAssistQuestionV1,
  type BrandSourceDto,
  type SuggestionEvidence,
  type SuggestionOp,
  type SuggestionStatus,
} from '@oremedia/contracts/brand-assist';
import {
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { MembershipRole } from '@oremedia/contracts/tenancy';
import type { MockBrandVersion, MockBuilders, t } from './mock-api';

/**
 * BSC-4 / BSC-5 slice of the UI-only transport (see mock-api.ts): brand.sources.*, brand.assist.*,
 * brand.suggestions.* and brand.history.* with the same paths, DTO shapes and error envelope as apps/api. A job moves
 * on by one stage each time it is read (queued → reading → writing → ready) and then holds scripted suggestions for
 * the voice, vocabulary, messaging, channel and fact sections; accepting writes them into the pending proposal the
 * brand system screen reviews and saves. A test double, never a second implementation.
 */
const DECIDERS: ReadonlySet<MembershipRole> = new Set(['owner', 'admin', 'brand_manager']);
const now = () => new Date().toISOString();

export interface AssistHost {
  applied(): BrandSystemDocumentV1;
  appliedVersionId(): string | null;
  proposal(): MockBrandVersion | null;
  propose(document: BrandSystemDocumentV1): MockBrandVersion;
  apply(document: BrandSystemDocumentV1): MockBrandVersion;
  versions(): MockBrandVersion[];
}

interface MockSource extends BrandSourceDto {
  text: string | null;
  removed: boolean;
}
interface MockJob {
  id: string;
  brandId: string;
  kind: 'setup' | 'section';
  sections: AssistSection[];
  instruction: string | null;
  sourceIds: string[];
  preserve: string[];
  state: BrandAssistJobState;
  progress: BrandAssistProgressV1;
  questions: BrandAssistQuestionV1[];
  parentJobId: string | null;
  alternativesFor: string | null;
  cancelRequested: boolean;
  reads: number;
  createdAt: string;
  version: number;
}
interface MockSuggestion {
  id: string;
  jobId: string;
  section: AssistSection;
  path: string;
  label: string;
  op: SuggestionOp;
  value: unknown;
  provenance: GuidanceProvenance;
  rationale: string;
  uncertainty: string | null;
  evidence: SuggestionEvidence[];
  againstUserItem: boolean;
  status: SuggestionStatus;
  batchId: string | null;
  before: unknown;
  factId: string | null;
  createdAt: string;
  version: number;
}

const describe = (v: unknown): string | null => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join('; ');
  return Object.entries(v as Record<string, unknown>)
    .filter(
      ([k, x]) => k !== 'provenance' && x !== undefined && x !== '' && !(Array.isArray(x) && x.length === 0),
    )
    .map(
      ([k, x]) =>
        `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${Array.isArray(x) ? x.join('; ') : String(x)}`,
    )
    .join(' · ');
};

/** The paths the script writes, applied as the server's domain applies them (enough for the screens under test). */
function valueAt(doc: BrandSystemDocumentV1, path: string): unknown {
  const [collection, key] = path.split('#') as [string, string | undefined];
  if (path === 'voice.summary') return doc.voice.summary || undefined;
  if (path === 'messaging.positioning') return doc.messaging?.positioning || undefined;
  if (path === 'channelBaseline.cta') return doc.channelBaseline?.cta || undefined;
  const list =
    collection === 'voice.personality'
      ? (doc.voice.personality ?? [])
      : collection === 'vocabulary'
        ? (doc.vocabulary ?? [])
        : collection === 'voice.principles'
          ? (doc.voice.principles ?? [])
          : [];
  const keyOf = (i: Record<string, unknown>) =>
    String(i['trait'] ?? i['term'] ?? i['statement'] ?? '').toLowerCase();
  const found = (list as Array<Record<string, unknown>>).find((i) => keyOf(i) === (key ?? '').toLowerCase());
  if (!found) return undefined;
  const { provenance: _p, ...rest } = found;
  return rest;
}
function applyAt(
  doc: BrandSystemDocumentV1,
  path: string,
  value: unknown,
  provenance?: GuidanceProvenance,
): BrandSystemDocumentV1 {
  const [collection, key] = path.split('#') as [string, string | undefined];
  const next = structuredClone(doc);
  const item =
    value && typeof value === 'object'
      ? { ...(value as object), ...(provenance ? { provenance } : {}) }
      : value;
  if (path === 'voice.summary') next.voice.summary = (value as string | undefined) ?? '';
  else if (path === 'messaging.positioning')
    next.messaging = {
      positioning: (value as string | undefined) ?? '',
      valueProposition: '',
      pillars: [],
      keyMessages: [],
      ...(next.messaging ? { ...next.messaging, positioning: (value as string | undefined) ?? '' } : {}),
    };
  else if (path === 'channelBaseline.cta') {
    const { cta: _c, ...rest } = next.channelBaseline ?? {};
    next.channelBaseline = value === undefined ? rest : { ...rest, cta: value as string };
  } else {
    const keyOf = (i: Record<string, unknown>) =>
      String(i['trait'] ?? i['term'] ?? i['statement'] ?? '').toLowerCase();
    const list = [
      ...((collection === 'voice.personality'
        ? next.voice.personality
        : collection === 'vocabulary'
          ? next.vocabulary
          : next.voice.principles) ?? []),
    ] as Array<Record<string, unknown>>;
    const at = list.findIndex((i) => keyOf(i) === (key ?? '').toLowerCase());
    if (value === undefined) {
      if (at >= 0) list.splice(at, 1);
    } else if (at >= 0) list[at] = item as Record<string, unknown>;
    else list.push(item as Record<string, unknown>);
    if (collection === 'voice.personality') next.voice.personality = list as never;
    else if (collection === 'vocabulary') next.vocabulary = list as never;
    else next.voice.principles = list as never;
  }
  return BrandSystemDocumentV1.parse(next);
}

export class AssistBackend {
  readonly sources: MockSource[] = [];
  readonly jobs: MockJob[] = [];
  readonly suggestions: MockSuggestion[] = [];
  readonly restores: string[] = [];
  /** Tests: the blockers the next estimate and start report (cost, budget, kill switch). */
  blockers: Array<{ code: string; message: string }> = [];
  private seq = 0;

  constructor(
    readonly brandId: string,
    private readonly role: () => MembershipRole,
    readonly host: AssistHost,
    private readonly objectStoreOrigin: () => string,
  ) {}

  private id(prefix: string) {
    this.seq += 1;
    return `${prefix}_${String(this.seq).padStart(4, '0')}`;
  }
  assertDecider() {
    if (!DECIDERS.has(this.role()))
      throw new PolicyDeniedError(
        'role_missing',
        'Your role does not include brand.edit_standards for this brand',
      );
  }
  assertBrand(brandId: string) {
    if (brandId !== this.brandId) throw new NotFoundError('Brand', brandId);
  }
  source(id: string) {
    const s = this.sources.find((x) => x.id === id && !x.removed);
    if (!s) throw new NotFoundError('BrandSource', id);
    return s;
  }
  job(id: string) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) throw new NotFoundError('BrandAssistJob', id);
    return j;
  }
  private working(): BrandSystemDocumentV1 {
    return this.host.proposal()?.document ?? this.host.applied();
  }

  addSource(input: BrandSourceAdd) {
    const base = {
      id: this.id('bsrc'),
      brandId: this.brandId,
      url: null,
      fileName: null,
      mime: null,
      assetVersionId: null,
      reason: null,
      detail: null,
      byteSize: null,
      charCount: null,
      truncated: false,
      pages: [] as BrandSourceDto['pages'],
      duplicateOfSourceId: null,
      capturedAt: null as string | null,
      createdAt: now(),
      version: 0,
      removed: false,
      text: null as string | null,
    };
    if (input.kind === 'url') {
      if (!input.url.startsWith('https://'))
        throw new ValidationFailedError(
          [{ path: 'url', issue: 'not_https' }],
          'Use the https:// address of the website',
        );
      const existing = this.sources.find((s) => s.url === input.url && !s.removed);
      if (existing)
        return { sourceId: existing.id, version: existing.version, duplicate: true, upload: null };
      const s: MockSource = {
        ...base,
        kind: 'url',
        title: input.title ?? new URL(input.url).host,
        url: input.url,
        status: 'pending',
      };
      this.sources.unshift(s);
      return { sourceId: s.id, version: 0, duplicate: false, upload: null };
    }
    if (input.kind === 'text') {
      const s: MockSource = {
        ...base,
        kind: 'text',
        title: input.title,
        status: 'captured',
        text: input.text,
        charCount: input.text.length,
        capturedAt: now(),
      };
      this.sources.unshift(s);
      return { sourceId: s.id, version: 0, duplicate: false, upload: null };
    }
    if (input.kind === 'document') {
      const s: MockSource = {
        ...base,
        kind: 'document',
        title: input.title ?? input.fileName,
        fileName: input.fileName,
        mime: input.mime,
        byteSize: input.byteSize,
        status: 'pending',
      };
      this.sources.unshift(s);
      return {
        sourceId: s.id,
        version: 0,
        duplicate: false,
        upload: {
          url: `${this.objectStoreOrigin()}/e2e-upload/${s.id}`,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          contentType: input.mime,
        },
      };
    }
    throw new NotFoundError('AssetVersion', input.assetVersionId);
  }

  /** A job read: it moves on one stage per read, and at the end holds its suggestions. */
  advance(j: MockJob) {
    if (['ready', 'partially_ready', 'failed', 'cancelled'].includes(j.state)) return;
    j.reads += 1;
    if (j.cancelRequested) {
      j.state = 'cancelled';
      for (const s of j.sections)
        j.progress.sections[s] = { status: 'cancelled', suggestions: 0, reason: 'cancelled' };
      return;
    }
    if (j.reads === 1) {
      j.state = 'capturing';
      j.progress.stages.capturing.status = 'running';
      return;
    }
    if (j.reads === 2) {
      for (const id of j.sourceIds) {
        const s = this.sources.find((x) => x.id === id);
        if (!s || s.status !== 'pending') continue;
        if (s.url?.includes('blocked'))
          Object.assign(s, { status: 'inaccessible', reason: 'robots_disallowed', capturedAt: now() });
        else
          Object.assign(s, {
            status: 'captured',
            text: `We roast single-origin coffee in Leeds. Founded in 2014. ${s.title}`,
            charCount: 60,
            pages: s.url ? [{ url: s.url, title: s.title, canonicalUrl: s.url, chars: 60 }] : [],
            capturedAt: now(),
          });
      }
      j.progress.stages.capturing = {
        status: 'done',
        done: j.progress.stages.capturing.total,
        total: j.progress.stages.capturing.total,
      };
      j.progress.stages.extracting = {
        ...j.progress.stages.extracting,
        status: j.progress.stages.extracting.total ? 'done' : 'skipped',
        done: j.progress.stages.extracting.total,
      };
      j.state = 'proposing';
      j.progress.stages.proposing.status = 'running';
      return;
    }
    for (const section of j.sections) {
      const made = this.script(j, section);
      j.progress.sections[section] = { status: 'ready', suggestions: made, reason: null };
    }
    j.progress.stages.proposing = { status: 'done', done: j.sections.length, total: j.sections.length };
    if (j.kind === 'setup' && !j.parentJobId)
      j.questions = [
        {
          id: 'q1',
          section: 'voice',
          question: 'Do you write in British or American English?',
          why: 'Your sources mix both.',
          answer: null,
        },
      ];
    j.state = 'ready';
  }

  private script(j: MockJob, section: AssistSection): number {
    const captured = j.sourceIds
      .map((id) => this.sources.find((s) => s.id === id))
      .filter((s) => s?.status === 'captured');
    // The passage the script cites is on the website (the pasted notes say something else).
    const evidenceSource = captured.find((s) => s?.url) ?? captured[0];
    const evidence: SuggestionEvidence[] = evidenceSource
      ? [{ sourceId: evidenceSource.id, excerpt: 'We roast single-origin coffee in Leeds.', verified: true }]
      : [];
    const make = (
      path: string,
      label: string,
      value: unknown,
      origin: GuidanceProvenance['origin'],
      extra: Partial<MockSuggestion> = {},
    ) => {
      if (j.preserve.includes(path)) return 0;
      const current = valueAt(this.working(), path);
      if (JSON.stringify(current) === JSON.stringify(value)) return 0;
      this.suggestions.push({
        id: this.id('bsug'),
        jobId: j.id,
        section,
        path,
        label,
        op: current === undefined ? 'add' : 'replace',
        value,
        provenance: { origin, confidence: origin === 'suggested' ? 'medium' : 'high' },
        rationale:
          origin === 'imported'
            ? 'Your website says this in its own words.'
            : 'Fits the voice your sources describe.',
        uncertainty: null,
        evidence: origin === 'imported' ? evidence : [],
        againstUserItem: false,
        status: 'pending',
        batchId: null,
        before: null,
        factId: null,
        createdAt: now(),
        version: 0,
        ...extra,
      });
      return 1;
    };
    const alt = j.alternativesFor !== null;
    switch (section) {
      case 'voice':
        return (
          make(
            'voice.summary',
            'Voice summary',
            alt ? 'Warm, direct and concrete.' : 'Plain-spoken and warm; we explain before we sell.',
            evidence.length ? 'imported' : 'suggested',
          ) +
          (alt
            ? 0
            : make(
                'voice.personality#Curious',
                'Personality trait "Curious"',
                { trait: 'Curious', note: 'We ask before we assume.' },
                'suggested',
              ))
        );
      case 'vocabulary':
        return make(
          'vocabulary#blend',
          'Term "blend"',
          { term: 'blend', usage: 'avoid', alternatives: ['roast'] },
          'suggested',
        );
      case 'messaging':
        return make(
          'messaging.positioning',
          'Positioning',
          'The roastery that names every farm.',
          'suggested',
        );
      case 'channels':
        return make(
          'channelBaseline.cta',
          'Channel default: cta',
          'One clear call to action, last.',
          'suggested',
        );
      case 'facts':
        return make(
          'facts#Founded in 2014.',
          'Fact "Founded in 2014."',
          { statement: 'Founded in 2014.', category: 'company' },
          evidence.length ? 'imported' : 'suggested',
        );
      default:
        return 0;
    }
  }

  start(input: BrandAssistRequest, extra: { parentJobId?: string } = {}) {
    if (this.blockers[0]) throw new PolicyDeniedError(this.blockers[0].code, this.blockers[0].message);
    const parsed = BrandAssistRequest.parse(input);
    for (const id of parsed.sourceIds) this.source(id);
    const pendingUrls = parsed.sourceIds.filter(
      (id) => this.sources.find((s) => s.id === id)?.status === 'pending',
    ).length;
    const j: MockJob = {
      id: this.id('baj'),
      brandId: this.brandId,
      kind: parsed.kind,
      sections: parsed.sections,
      instruction: parsed.instruction ?? null,
      sourceIds: parsed.sourceIds,
      preserve: parsed.preserve ?? [],
      state: 'queued',
      progress: {
        stages: {
          capturing: { status: pendingUrls ? 'pending' : 'skipped', done: 0, total: pendingUrls },
          extracting: { status: 'skipped', done: 0, total: 0 },
          proposing: { status: 'pending', done: 0, total: parsed.sections.length },
        },
        sections: Object.fromEntries(
          parsed.sections.map((s) => [s, { status: 'pending', suggestions: 0, reason: null }]),
        ),
      },
      questions: [],
      parentJobId: extra.parentJobId ?? null,
      alternativesFor: parsed.alternativesForJobId ?? null,
      cancelRequested: false,
      reads: 0,
      createdAt: now(),
      version: 0,
    };
    this.jobs.unshift(j);
    return { jobId: j.id, state: j.state, duplicate: false, version: 0 };
  }

  jobDto(j: MockJob) {
    const count = (st: SuggestionStatus) =>
      this.suggestions.filter((s) => s.jobId === j.id && s.status === st).length;
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
      questions: j.questions,
      estimateMicros: 12_000 * j.sections.length,
      reservedMicros: 12_000 * j.sections.length,
      spentMicros: j.state === 'ready' ? 9_000 * j.sections.length : 0,
      error: null,
      parentJobId: j.parentJobId,
      cancelRequested: j.cancelRequested,
      createdByName: 'E2E Owner',
      suggestionCounts: {
        pending: count('pending'),
        accepted: count('accepted'),
        edited: count('edited'),
        rejected: count('rejected'),
        superseded: count('superseded'),
      },
      createdAt: j.createdAt,
      startedAt: j.createdAt,
      finishedAt: ['ready', 'cancelled'].includes(j.state) ? now() : null,
      version: j.version,
    };
  }

  suggestionDto(s: MockSuggestion) {
    const doc = this.working();
    const virtual = s.section === 'facts';
    const current = virtual ? null : (valueAt(doc, s.path) ?? null);
    const value = s.op === 'remove' ? null : s.value;
    return {
      id: s.id,
      jobId: s.jobId,
      brandId: this.brandId,
      section: s.section,
      path: s.path,
      label: s.label,
      op: s.op,
      value,
      current,
      valueText: describe(value),
      currentText: describe(current),
      provenance: s.provenance,
      rationale: s.rationale,
      uncertainty: s.uncertainty,
      conflicts: [],
      evidence: s.evidence.map((e) => {
        const src = this.sources.find((x) => x.id === e.sourceId);
        return { ...e, sourceTitle: src?.title ?? null, sourceUrl: src?.url ?? null };
      }),
      againstUserItem: s.againstUserItem,
      changedSince: false,
      status: s.status,
      decidedByName: s.status === 'pending' ? null : 'E2E Owner',
      decidedAt: null,
      batchId: s.batchId,
      factId: s.factId,
      createdAt: s.createdAt,
      version: s.version,
    };
  }

  decide(ids: string[], edited?: unknown) {
    this.assertDecider();
    const batchId = this.id('bsb');
    const rows = ids.map((id) => {
      const s = this.suggestions.find((x) => x.id === id);
      if (!s) throw new NotFoundError('BrandSuggestion', id);
      return s;
    });
    const decided: string[] = [];
    const skipped: Array<{ suggestionId: string; reason: string }> = [];
    let doc = this.working();
    const docRows = rows.filter((r) => r.section !== 'facts' && r.status === 'pending');
    for (const s of rows) {
      if (s.status !== 'pending') {
        skipped.push({ suggestionId: s.id, reason: `already_${s.status}` });
        continue;
      }
      if (s.section !== 'facts') {
        s.before = valueAt(doc, s.path) ?? null;
        const value = edited ?? s.value;
        doc = applyAt(
          doc,
          s.path,
          s.op === 'remove' ? undefined : value,
          edited === undefined
            ? { ...s.provenance, suggestionId: s.id }
            : { origin: 'user', suggestionId: s.id },
        );
      } else s.factId = 'fact_from_suggestion';
      Object.assign(s, {
        status: edited === undefined ? 'accepted' : 'edited',
        batchId,
        version: s.version + 1,
        ...(edited === undefined ? {} : { value: edited }),
      });
      decided.push(s.id);
    }
    let proposalVersionId: string | null = null;
    if (docRows.length) {
      const proposal = this.host.proposal() ?? this.host.propose(this.host.applied());
      Object.assign(proposal, { document: doc, version: proposal.version + 1, updatedAt: now() });
      proposalVersionId = proposal.id;
    }
    return {
      batchId: decided.length ? batchId : null,
      proposalVersionId,
      decided,
      factIds: rows.flatMap((r) => (r.factId ? [r.factId] : [])),
      skipped,
    };
  }

  undo(batchId?: string) {
    this.assertDecider();
    const applied = this.suggestions.filter(
      (s) => s.batchId && (s.status === 'accepted' || s.status === 'edited'),
    );
    const target =
      batchId ??
      applied
        .map((s) => s.batchId as string)
        .sort()
        .at(-1);
    if (!target)
      throw new ValidationFailedError(
        [{ path: 'batchId', issue: 'nothing_to_undo' }],
        'There is nothing to undo',
      );
    const rows = applied.filter((s) => s.batchId === target);
    const proposal = this.host.proposal();
    let doc = proposal?.document ?? null;
    for (const s of rows) {
      if (doc && s.section !== 'facts') doc = applyAt(doc, s.path, s.before === null ? undefined : s.before);
      Object.assign(s, {
        status: 'pending',
        batchId: null,
        before: null,
        factId: null,
        version: s.version + 1,
      });
    }
    if (proposal && doc)
      Object.assign(proposal, { document: doc, version: proposal.version + 1, updatedAt: now() });
    return {
      batchId: target,
      proposalVersionId: proposal?.id ?? null,
      decided: rows.map((r) => r.id),
      factIds: [],
      skipped: [],
    };
  }
}

const SECTION_OF: Array<[keyof BrandSystemDocumentV1 | 'voice', string]> = [
  ['logoRules', 'Logo'],
  ['tokens', 'Colour'],
  ['voice', 'Voice & personality'],
  ['messaging', 'Messaging'],
  ['vocabulary', 'Vocabulary'],
  ['writingPatterns', 'Writing patterns'],
  ['copyTemplates', 'Templates'],
  ['channelBaseline', 'Channel guidance'],
  ['guidelines', 'Guidelines'],
];
const changed = (a: BrandSystemDocumentV1, b: BrandSystemDocumentV1) =>
  SECTION_OF.filter(([k]) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)).map(
    ([k, label]) => ({ k, label }),
  );

export function assistRouters(
  b: AssistBackend,
  { router, query, mutation }: { router: typeof t.router } & Pick<MockBuilders, 'query' | 'mutation'>,
) {
  return {
    sources: router({
      add: mutation.input(BrandSourceAdd).mutation(({ input }) => {
        b.assertBrand(input.brandId);
        b.assertDecider();
        return b.addSource(input);
      }),
      list: query.input(BrandSourceList).query(({ input }) => {
        b.assertBrand(input.brandId);
        return {
          items: b.sources.filter((s) => !s.removed).map(({ text: _t, removed: _r, ...dto }) => dto),
          nextCursor: null,
        };
      }),
      get: query.input(BrandSourceGet).query(({ input }) => {
        b.assertBrand(input.brandId);
        const { removed: _r, ...s } = b.source(input.sourceId);
        return { ...s, textTruncated: false };
      }),
      remove: mutation.input(BrandSourceRemove).mutation(({ input }) => {
        b.assertDecider();
        const s = b.source(input.sourceId);
        if (s.version !== input.expectedVersion)
          throw new ConflictError('BrandSource', s.id, input.expectedVersion);
        Object.assign(s, { removed: true, version: s.version + 1 });
        return { sourceId: s.id, version: s.version };
      }),
    }),
    assist: router({
      estimate: query.input(BrandAssistRequest).query(({ input }) => {
        b.assertBrand(input.brandId);
        const sources = input.sourceIds.map((id) => b.source(id));
        return {
          estimateMicros: 12_000 * input.sections.length,
          sections: input.sections.map((section) => ({
            section,
            inputTokens: 6000,
            outputTokens: 3000,
            costMicros: 12_000,
          })),
          sources: {
            usable: sources.filter((s) => s.status === 'captured').length,
            pending: sources.filter((s) => s.status === 'pending').length,
            unusable: sources.filter((s) => s.status !== 'captured' && s.status !== 'pending').length,
          },
          blockers: b.blockers,
          remaining: { monthMicros: 80_000_000, dayMicros: 19_000_000 },
        };
      }),
      start: mutation.input(BrandAssistRequest).mutation(({ input }) => {
        b.assertBrand(input.brandId);
        b.assertDecider();
        return b.start(input);
      }),
      get: query.input(BrandAssistGet).query(({ input }) => {
        b.assertBrand(input.brandId);
        const j = b.job(input.jobId);
        b.advance(j);
        return b.jobDto(j);
      }),
      list: query.input(BrandAssistList).query(({ input }) => {
        b.assertBrand(input.brandId);
        return { items: b.jobs.map((j) => b.jobDto(j)), nextCursor: null };
      }),
      cancel: mutation.input(BrandAssistCancel).mutation(({ input }) => {
        b.assertDecider();
        const j = b.job(input.jobId);
        j.cancelRequested = true;
        j.version += 1;
        return { jobId: j.id, state: j.state, version: j.version };
      }),
      answer: mutation.input(BrandAssistAnswer).mutation(({ input }) => {
        b.assertDecider();
        const j = b.job(input.jobId);
        for (const a of input.answers) {
          const q = j.questions.find((x) => x.id === a.questionId);
          if (!q) throw new ValidationFailedError([{ path: 'answers', issue: 'unknown_question' }]);
          q.answer = a.answer;
        }
        return b.start(
          {
            brandId: j.brandId,
            kind: 'section',
            sections: ['voice'],
            sourceIds: j.sourceIds,
            instruction: 'Answers',
          },
          { parentJobId: j.id },
        );
      }),
    }),
    suggestions: router({
      list: query.input(BrandSuggestionList).query(({ input }) => {
        b.assertBrand(input.brandId);
        return {
          items: b.suggestions
            .filter(
              (s) =>
                (!input.jobId || s.jobId === input.jobId) &&
                (!input.section || s.section === input.section) &&
                (!input.status || s.status === input.status),
            )
            .map((s) => b.suggestionDto(s)),
          nextCursor: null,
        };
      }),
      accept: mutation.input(BrandSuggestionAccept).mutation(({ input }) => b.decide(input.suggestionIds)),
      edit: mutation
        .input(BrandSuggestionEdit)
        .mutation(({ input }) => b.decide([input.suggestionId], input.value)),
      reject: mutation.input(BrandSuggestionReject).mutation(({ input }) => {
        b.assertDecider();
        const decided: string[] = [];
        for (const id of input.suggestionIds) {
          const s = b.suggestions.find((x) => x.id === id);
          if (!s) throw new NotFoundError('BrandSuggestion', id);
          if (s.status === 'pending') {
            Object.assign(s, { status: 'rejected', version: s.version + 1 });
            decided.push(id);
          }
        }
        return { batchId: null, proposalVersionId: null, decided, factIds: [], skipped: [] };
      }),
      acceptAll: mutation
        .input(BrandSuggestionAcceptAll)
        .mutation(({ input }) =>
          b.decide(
            b.suggestions
              .filter((s) => s.jobId === input.jobId && s.section === input.section && s.status === 'pending')
              .map((s) => s.id),
          ),
        ),
      undo: mutation.input(BrandSuggestionUndo).mutation(({ input }) => b.undo(input.batchId)),
    }),
    history: router({
      list: query.input(BrandHistoryList).query(() => {
        const applied = b.host
          .versions()
          .filter((v) => v.publishedAt !== null)
          .sort((x, y) => y.number - x.number);
        return {
          items: applied.map((v, i) => ({
            versionId: v.id,
            number: v.number,
            current: v.id === b.host.appliedVersionId(),
            appliedAt: v.publishedAt,
            appliedByName: 'E2E Owner',
            changedSections: ((prev) =>
              prev ? changed(prev.document, v.document).map((c) => c.label) : ['Voice & personality'])(
              applied[i + 1],
            ),
          })),
          nextCursor: null,
        };
      }),
      compare: query.input(BrandHistoryCompare).query(({ input }) => {
        const versions = b.host.versions();
        const from = versions.find((v) => v.id === input.versionId);
        if (!from) throw new NotFoundError('BrandVersion', input.versionId);
        const to = versions.find((v) => v.id === (input.againstVersionId ?? b.host.appliedVersionId()));
        const target = to?.document ?? b.host.applied();
        return {
          from: { versionId: from.id, number: from.number, appliedAt: from.publishedAt, current: false },
          to: to ? { versionId: to.id, number: to.number, appliedAt: to.publishedAt, current: true } : null,
          sections: changed(from.document, target).map(({ k, label }) => ({
            section: String(k),
            label,
            changes:
              k === 'voice' && from.document.voice.summary !== target.voice.summary
                ? [
                    {
                      change: 'changed' as const,
                      item: 'Voice summary',
                      before: from.document.voice.summary || null,
                      after: target.voice.summary || null,
                    },
                  ]
                : [{ change: 'changed' as const, item: label, before: null, after: null }],
          })),
        };
      }),
      restore: mutation.input(BrandHistoryRestore).mutation(({ input }) => {
        b.assertDecider();
        const v = b.host.versions().find((x) => x.id === input.versionId);
        if (!v || !v.publishedAt)
          throw new ValidationFailedError([{ path: 'versionId', issue: 'never_applied' }]);
        if ((b.host.appliedVersionId() ?? null) !== input.basedOnVersionId)
          throw new ConflictError('BrandSystem', b.brandId, 1);
        const applied = b.host.apply(v.document);
        b.restores.push(v.id);
        return {
          brandId: b.brandId,
          changed: true,
          versionId: applied.id,
          contentHash: applied.contentHash,
          restoredFromVersionId: v.id,
          restoredFromNumber: v.number,
        };
      }),
    }),
  };
}
