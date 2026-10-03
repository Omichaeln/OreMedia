import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  ConflictError,
  NotFoundError,
  StaleRevisionError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type {
  VideoMediaInfo,
  VideoOperationBatch,
  VideoOperationsApply,
  VideoProjectV1,
} from '@oremedia/contracts/video';
import type { Finding } from '@oremedia/contracts/creative';
import {
  VIDEO_AI_PROGRESS,
  VideoAiRequest,
  type ModelRecutOutput,
  type ModelStoryboardOutput,
  type Storyboard,
  type VideoAiAccept,
  type VideoAiAssemble,
  type VideoAiSaveDraft,
  type VideoAiJobState,
  type VideoAiPreflight,
  type VideoAiResult,
  type VideoAiScope,
  type VideoAiStart,
} from '@oremedia/contracts/video-ai';
import {
  applyVideoBatch,
  blankVideoProject,
  checkModelStoryboard,
  compileAssembly,
  compileRecut,
  instantiateVideoTemplate,
  isEmptyProject,
  listVideoTemplates,
  storyboardProblems,
  validateVideoProject,
  videoTimelineDiff,
  VideoOperationError,
  type StoryboardAsset,
} from '@oremedia/editor';
import { fixtureSnapshot } from '@oremedia/editor/fixtures';

/**
 * STU-2b in the mock transport: video documents with timeline revisions (the real pure reducer and validation),
 * the library's video, audio and stills, and a render that reports progress on each poll, can be cancelled, and
 * ends with an export whose media URLs the e2e store answers (WebM: Playwright's Chromium has no H.264).
 */
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const now = () => new Date().toISOString();
const rid = (p: string) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;

export const VIDEO_LIBRARY: Array<VideoMediaInfo & { assetId: string; name: string }> = [
  {
    assetId: 'ast_beach',
    assetVersionId: 'av_video_beach',
    name: 'Beach walk',
    kind: 'video',
    mime: 'video/mp4',
    durationMs: 6_000,
    width: 1280,
    height: 720,
    hasAudio: true,
    derivatives: ['proxy', 'strip', 'strip_map', 'waveform', 'poster'],
  },
  {
    assetId: 'ast_city',
    assetVersionId: 'av_video_city',
    name: 'City lights',
    kind: 'video',
    mime: 'video/mp4',
    durationMs: 4_000,
    width: 720,
    height: 1280,
    hasAudio: false,
    derivatives: ['proxy', 'strip', 'strip_map', 'poster'],
  },
  {
    assetId: 'ast_music',
    assetVersionId: 'av_audio_music',
    name: 'Upbeat music',
    kind: 'audio',
    mime: 'audio/mpeg',
    durationMs: 20_000,
    width: null,
    height: null,
    hasAudio: true,
    derivatives: ['proxy', 'waveform'],
  },
  {
    assetId: 'ast_e2e',
    assetVersionId: 'av_photo',
    name: 'Sample photo',
    kind: 'image',
    mime: 'image/png',
    durationMs: null,
    width: 2,
    height: 2,
    hasAudio: false,
    derivatives: ['web'],
  },
];
const MEDIA = Object.fromEntries(VIDEO_LIBRARY.map((m) => [m.assetVersionId, m]));
const mediaOf = (ids: string[]): VideoMediaInfo[] =>
  [...new Set(ids)].flatMap((id) => {
    const m = MEDIA[id];
    if (!m) return [];
    const { assetId: _a, name: _n, ...info } = m;
    return [info];
  });
const timedIds = (p: VideoProjectV1) =>
  p.tracks.flatMap((t) =>
    t.kind === 'video' || t.kind === 'audio' ? t.items.map((i) => i.assetVersionId) : [],
  );

interface VideoRev {
  id: string;
  documentId: string;
  parentRevisionId: string | null;
  number: number;
  brandVersionId: string;
  agentRunId: null;
  authorKind: 'user' | 'agent';
  authorId: string;
  changeSummary: string;
  kind: 'video';
  operations: VideoOperationBatch;
  snapshot: VideoProjectV1;
  contentHash: string;
  createdAt: string;
}
export interface VideoDoc {
  id: string;
  brandId: string;
  contentPackageId: null;
  title: string;
  currentRevisionId: string;
  schemaVersion: 1;
  kind: 'video';
  createdAt: string;
  updatedAt: string;
  version: number;
  revisions: VideoRev[];
}

export interface VideoJob {
  id: string;
  brandId: string;
  revisionId: string;
  formatKeys: string[];
  state: 'pending' | 'rendering' | 'ready' | 'failed' | 'cancelled';
  attempts: number;
  error: string | null;
  progress: { phase: string; fraction: number } | null;
  requestedByKind: 'user';
  requestedById: string;
  exportIds: string[];
  exports: unknown[];
  preview: null;
  createdAt: string;
  updatedAt: string;
  version: number;
  polls: number;
}

export class VideoMockBackend {
  readonly docs = new Map<string, VideoDoc>();
  readonly jobs = new Map<string, VideoJob>();
  /** Polls a render takes to finish (each poll advances its progress). */
  renderPolls = 4;
  constructor(
    readonly brandId: string,
    readonly brandVersionId: string,
    readonly objectStoreOrigin: () => string,
  ) {}

  /** A blank or template video bound to the fixture brand's caption font and colours. */
  create(
    title: string,
    options: {
      formatKey: VideoProjectV1['format']['key'];
      fps: 24 | 25 | 30;
      durationMs?: number;
      templateKey?: string;
    },
  ): VideoDoc {
    const bindings = {
      brandVersionId: this.brandVersionId,
      fonts: {
        display: 'av_font_display',
        heading: 'av_font_display',
        caption: 'av_font_display',
        body: 'av_font_display',
      },
      colours: { text: 'paper', box: 'ink', accent: 'accent' },
      newElementId: () =>
        `el_${randomUUID()
          .replace(/-/g, '')
          .slice(0, 26)
          .toUpperCase()
          .replace(/[ILOU]/g, '0')}`,
    };
    const project = options.templateKey
      ? instantiateVideoTemplate(options.templateKey, bindings, { fps: options.fps })
      : blankVideoProject(bindings, {
          formatKey: options.formatKey,
          fps: options.fps,
          ...(options.durationMs ? { durationMs: options.durationMs } : {}),
        });
    if (!project) throw new ValidationFailedError([{ path: 'video.templateKey', issue: 'unknown_template' }]);
    const id = rid('doc');
    const rev: VideoRev = this.revision(
      id,
      null,
      1,
      {
        baseRevisionId: '',
        operations: project.tracks.map((track, index) => ({ op: 'addTrack' as const, track, index })),
        summary: 'Initial video',
        origin: 'user',
      },
      project,
    );
    const doc: VideoDoc = {
      id,
      brandId: this.brandId,
      contentPackageId: null,
      title,
      currentRevisionId: rev.id,
      schemaVersion: 1,
      kind: 'video',
      createdAt: now(),
      updatedAt: now(),
      version: 1,
      revisions: [rev],
    };
    this.docs.set(id, doc);
    return doc;
  }

  private revision(
    documentId: string,
    parent: VideoRev | null,
    number: number,
    batch: VideoOperationBatch,
    snapshot: VideoProjectV1,
  ): VideoRev {
    return {
      id: rid('rev'),
      documentId,
      parentRevisionId: parent?.id ?? null,
      number,
      brandVersionId: this.brandVersionId,
      agentRunId: null,
      authorKind: batch.origin,
      authorId: 'usr_e2e',
      changeSummary: batch.summary,
      kind: 'video',
      operations: batch,
      snapshot,
      contentHash: hash(snapshot),
      createdAt: now(),
    };
  }

  doc(id: string): VideoDoc | undefined {
    return this.docs.get(id);
  }
  head(doc: VideoDoc): VideoRev {
    return doc.revisions.find((r) => r.id === doc.currentRevisionId) as VideoRev;
  }
  get(id: string) {
    const doc = this.docs.get(id);
    if (!doc) return null;
    const { revisions: _r, ...row } = doc;
    const revision = this.head(doc);
    return { ...row, revision, media: mediaOf(timedIds(revision.snapshot)) };
  }

  private evaluate(base: VideoRev, batch: Pick<VideoOperationBatch, 'operations'>) {
    let next: VideoProjectV1;
    try {
      next = applyVideoBatch(base.snapshot, batch, { media: MEDIA, strictMedia: true });
    } catch (err) {
      if (err instanceof VideoOperationError)
        throw new ValidationFailedError(
          [{ path: 'operations', issue: `${err.code}: ${err.message}` }],
          err.message,
        );
      throw err;
    }
    const findings: Finding[] = validateVideoProject(next, { media: MEDIA, snapshot: fixtureSnapshot() });
    return { next, findings };
  }

  apply(input: z.infer<typeof VideoOperationsApply>) {
    const { documentId, ...batch } = input;
    const doc = this.docs.get(documentId);
    if (!doc) throw new NotFoundError('CreativeDocument', documentId);
    if (doc.currentRevisionId !== batch.baseRevisionId) throw new StaleRevisionError(doc.currentRevisionId);
    const base = this.head(doc);
    const { next, findings } = this.evaluate(base, batch);
    const revision = this.revision(documentId, base, base.number + 1, batch, next);
    doc.revisions.push(revision);
    doc.currentRevisionId = revision.id;
    doc.version += 1;
    doc.updatedAt = now();
    return { revision, findings, media: mediaOf(timedIds(next)), outdatedComments: 0, version: doc.version };
  }

  propose(input: z.infer<typeof VideoOperationsApply>) {
    const { documentId, ...batch } = input;
    const doc = this.docs.get(documentId);
    if (!doc) throw new NotFoundError('CreativeDocument', documentId);
    if (doc.currentRevisionId !== batch.baseRevisionId) throw new StaleRevisionError(doc.currentRevisionId);
    const base = this.head(doc);
    const { next, findings } = this.evaluate(base, batch);
    return {
      baseRevisionId: base.id,
      snapshot: next,
      contentHash: hash(next),
      findings,
      changedItemIds: [],
      blocking: findings.some((f) => f.severity === 'blocking'),
    };
  }

  /** Test backdoor: someone else saves on the head. */
  applyOutOfBand(documentId: string, operations: VideoOperationBatch['operations']) {
    const doc = this.docs.get(documentId) as VideoDoc;
    return this.apply({
      documentId,
      baseRevisionId: doc.currentRevisionId,
      operations,
      summary: 'Out-of-band edit',
      origin: 'user',
    });
  }

  ownsRevision(revisionId: string): VideoDoc | undefined {
    return [...this.docs.values()].find((d) => d.revisions.some((r) => r.id === revisionId));
  }

  request(revisionId: string, formatKeys: string[]) {
    const doc = this.ownsRevision(revisionId);
    const rev = doc?.revisions.find((r) => r.id === revisionId);
    if (!rev) throw new NotFoundError('CreativeRevision', revisionId);
    if (formatKeys.length !== 1 || formatKeys[0] !== rev.snapshot.format.key)
      throw new ValidationFailedError([
        { path: 'formatKeys', issue: `video_renders_at:${rev.snapshot.format.key}` },
      ]);
    const id = rid('rj');
    this.jobs.set(id, {
      id,
      brandId: this.brandId,
      revisionId,
      formatKeys,
      state: 'pending',
      attempts: 0,
      error: null,
      progress: null,
      requestedByKind: 'user',
      requestedById: 'usr_e2e',
      exportIds: [],
      exports: [],
      preview: null,
      createdAt: now(),
      updatedAt: now(),
      version: 0,
      polls: 0,
    });
    return { renderJobId: id, state: 'pending' as const, version: 0 };
  }

  /** Each poll moves a running render on: queued, then encoding at increasing fractions, then ready. */
  poll(id: string) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.state === 'pending' || job.state === 'rendering') {
      job.polls += 1;
      if (job.polls >= this.renderPolls) {
        const exportId = rid('exp');
        const rev = this.ownsRevision(job.revisionId)?.revisions.find(
          (r) => r.id === job.revisionId,
        ) as VideoRev;
        job.state = 'ready';
        job.progress = null;
        job.exportIds = [exportId];
        job.exports = [
          {
            id: exportId,
            revisionId: job.revisionId,
            pageId: 'timeline',
            formatKey: rev.snapshot.format.key,
            mime: 'video/mp4',
            width: rev.snapshot.format.width,
            height: rev.snapshot.format.height,
            bytes: 3_500_000,
            storageKey: `assets/e2e/exports/${exportId}.mp4`,
            contentHash: hash(exportId),
            rendererVersion: '1.0.0+video.1',
            manifest: {
              rendererVersion: '1.0.0+video.1',
              fonts: [],
              assets: [],
              brandVersionId: this.brandVersionId,
              revisionContentHash: rev.contentHash,
            },
            validation: { ok: true, findings: [] },
            publishable: true,
            durationMs: rev.snapshot.durationMs,
            fps: rev.snapshot.format.fps,
            posterStorageKey: `assets/e2e/exports/${exportId}.poster.webp`,
            captionsStorageKey: `assets/e2e/exports/${exportId}.vtt`,
            dedupeKey: hash(rev.contentHash),
            createdAt: now(),
          },
        ];
      } else {
        job.state = 'rendering';
        job.attempts = 1;
        job.progress = { phase: 'encoding', fraction: Math.min(0.95, job.polls / this.renderPolls) };
      }
      job.updatedAt = now();
    }
    const { polls: _p, ...dto } = job;
    return dto;
  }

  cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.state !== 'pending' && job.state !== 'rendering')
      throw new ValidationFailedError([
        { path: 'renderJobId', issue: `illegal transition: ${job.state} → cancel` },
      ]);
    job.state = 'cancelled';
    job.progress = null;
    job.version += 1;
    return { renderJobId: id, state: 'cancelled' as const, version: job.version };
  }

  exportMedia(id: string) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.state !== 'ready') return { items: [] };
    const origin = this.objectStoreOrigin();
    return {
      items: job.exportIds.map((exportId) => ({
        exportId,
        mime: 'video/mp4',
        url: `${origin}/e2e-object/${exportId}.webm`,
        posterUrl: `${origin}/e2e-object/${exportId}-poster.png`,
        captionsUrl: `${origin}/e2e-object/${exportId}.vtt`,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      })),
    };
  }

  templates() {
    return { items: listVideoTemplates() };
  }

  /** The library as assets.search returns it for the asked kinds. */
  search(kinds: readonly string[] | undefined) {
    const want = (k: string) => !kinds || kinds.includes(k);
    return VIDEO_LIBRARY.filter((m) =>
      m.kind === 'video' ? want('video') : m.kind === 'audio' ? want('audio') : want('photo'),
    ).map((m) => ({
      assetId: m.assetId,
      assetVersionId: m.assetVersionId,
      kind: m.kind === 'image' ? ('photo' as const) : m.kind,
      semanticRole: null,
      altText: m.name,
      contentHash: hash(m.assetVersionId),
      width: m.width,
      height: m.height,
      durationMs: m.durationMs,
    }));
  }
}

// ---- STU-3: studio video AI in the mock transport ---------------------------------------------------------------

/** What the scripted "model" answers next (tests set them); the real checks and compilers run on them. */
export interface VideoAiScript {
  storyboard: ModelStoryboardOutput;
  recut: ModelRecutOutput;
}

interface MockAiJob {
  id: string;
  brandId: string;
  documentId: string;
  baseRevisionId: string;
  kind: 'storyboard' | 'recut';
  state: VideoAiJobState;
  progress: number;
  attempt: number;
  request: VideoAiRequest;
  result: VideoAiResult | null;
  error: { code: string; message: string } | null;
  polls: number;
  output: ModelStoryboardOutput | ModelRecutOutput;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** The mocked brand's channel call-to-action conventions (the only wording a recut may place unasked). */
const BRAND_CTAS = ['Shop the range'];

const ELIGIBLE_STORYBOARD: StoryboardAsset[] = VIDEO_LIBRARY.map((m) => ({
  assetVersionId: m.assetVersionId,
  kind: m.kind === 'image' ? ('photo' as const) : m.kind,
  name: m.name,
  altText: m.name,
  semanticRole: null,
  durationMs: m.durationMs,
  width: m.width,
  height: m.height,
  hasAudio: m.hasAudio,
  derivatives: m.derivatives,
}));
const STAGES: VideoAiJobState[] = ['queued', 'generating', 'validating', 'completed'];

/**
 * Durable video AI jobs, simulated: each poll moves a job one state on; on completion the scripted answer goes
 * through the real storyboard check or recut compile (eligible assets are the mock library; the fixture brand's
 * facts in force are `fct_e2e_cold`). Assemble and accept use the real assembly and recut compilers and write
 * revisions through the backend's apply, so undo, redo and history behave as in the app.
 */
export class VideoAiMockBackend {
  readonly jobs = new Map<string, MockAiJob>();
  script: VideoAiScript;
  effectiveFactIds = new Set(['fct_e2e_cold']);
  constructor(
    private readonly video: VideoMockBackend,
    script: VideoAiScript,
  ) {
    this.script = script;
  }

  private bindings() {
    return {
      fonts: {
        display: 'av_font_display',
        heading: 'av_font_display',
        caption: 'av_font_display',
        body: 'av_font_display',
      },
      colours: { text: 'paper', box: 'ink' },
      newElementId: () =>
        `el_${randomUUID()
          .replace(/-/g, '')
          .slice(0, 26)
          .toUpperCase()
          .replace(/[ILOU]/g, '0')}`,
    };
  }

  private dto(j: MockAiJob) {
    const live = !['completed', 'failed', 'cancelled'].includes(j.state);
    return {
      id: j.id,
      brandId: j.brandId,
      documentId: j.documentId,
      baseRevisionId: j.baseRevisionId,
      kind: j.kind,
      state: j.state,
      progress: j.progress,
      attempt: j.attempt,
      live,
      request: j.request,
      costReservedMicros: 170_000,
      costSpentMicros: j.state === 'completed' ? 42_000 : 0,
      error: j.error,
      result: j.result,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      finishedAt: live ? null : j.updatedAt,
      version: j.version,
    };
  }

  private headOf(documentId: string) {
    const doc = this.video.doc(documentId);
    if (!doc) throw new NotFoundError('CreativeDocument', documentId);
    return { doc, head: this.video.head(doc) };
  }

  preflight(input: z.infer<typeof VideoAiPreflight>) {
    const { head } = this.headOf(input.documentId);
    const request = VideoAiRequest.parse(input.request);
    const factIds = request.kind === 'storyboard' ? request.brief.factIds : request.recut.factIds;
    const issues = factIds
      .filter((id) => !this.effectiveFactIds.has(id))
      .map((id) => ({
        code: 'fact_not_effective',
        severity: 'blocking' as const,
        message: 'A chosen fact is not in force',
        ref: id,
      }));
    return {
      blocking: issues.length > 0,
      issues,
      cost: { modelCalls: 1, totalMicros: 170_000, remainingMicros: 20_000_000 },
      inputs: {
        brandVersionId: head.brandVersionId,
        brandVersionNumber: 1,
        formatKey: head.snapshot.format.key,
        durationMs: head.snapshot.durationMs,
        templateKey: head.snapshot.templateKey ?? null,
        templateScenes: [],
        eligible: { clips: 2, stills: 1, audio: 1 },
        facts: [],
        capabilities: { videoGeneration: false, speechGeneration: false, transcription: false },
        empty: isEmptyProject(head.snapshot),
      },
    };
  }

  start(input: z.infer<typeof VideoAiStart>) {
    const { doc } = this.headOf(input.documentId);
    if (doc.currentRevisionId !== input.baseRevisionId) throw new StaleRevisionError(doc.currentRevisionId);
    const request = VideoAiRequest.parse(input.request);
    const id = rid('svj');
    const job: MockAiJob = {
      id,
      brandId: this.video.brandId,
      documentId: doc.id,
      baseRevisionId: input.baseRevisionId,
      kind: request.kind,
      state: 'queued',
      progress: VIDEO_AI_PROGRESS.queued,
      attempt: 1,
      request,
      result: null,
      error: null,
      polls: 0,
      output: request.kind === 'storyboard' ? this.script.storyboard : this.script.recut,
      version: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    this.jobs.set(id, job);
    return this.dto(job);
  }

  /** Each read moves a live job on one state; completion checks or compiles the scripted answer. */
  get(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) throw new NotFoundError('StudioVideoJob', jobId);
    if (STAGES.includes(job.state) && job.state !== 'completed') {
      job.polls += 1;
      const next = STAGES[Math.min(STAGES.length - 1, STAGES.indexOf(job.state) + 1)] as VideoAiJobState;
      if (next === 'completed') job.result = this.complete(job);
      job.state = next;
      job.progress = VIDEO_AI_PROGRESS[next];
      job.updatedAt = now();
      job.version += 1;
    }
    return this.dto(job);
  }

  private compileCtx(job: MockAiJob, scope: VideoAiScope | null) {
    return {
      media: MEDIA,
      bindings: this.bindings(),
      idPrefix: `ai${job.id.slice(-6).toLowerCase()}_`,
      waveforms: {},
      eligibleAssetIds: new Set(
        ELIGIBLE_STORYBOARD.filter((a) => a.kind !== 'audio').map((a) => a.assetVersionId),
      ),
      effectiveFactIds: this.effectiveFactIds,
      scope,
      script: this.scriptOf(job.documentId),
      approvedCtas: [
        ...(job.request.kind === 'recut' && job.request.recut.ctaText ? [job.request.recut.ctaText] : []),
        ...BRAND_CTAS,
      ],
    };
  }

  /** As the server: the narration of the document's last finished storyboard, by scene title. */
  private scriptOf(documentId: string) {
    const { head } = this.headOf(documentId);
    const last = [...this.jobs.values()]
      .reverse()
      .find(
        (j) => j.documentId === documentId && j.kind === 'storyboard' && j.state === 'completed' && j.result,
      );
    return (last?.result?.storyboard?.scenes ?? [])
      .filter((s) => s.narration)
      .map((s) => ({
        sceneId: head.snapshot.scenes.find((p) => p.title === s.title)?.id ?? null,
        narration: s.narration,
      }));
  }

  private complete(job: MockAiJob): VideoAiResult {
    const { head } = this.headOf(job.documentId);
    if (job.request.kind === 'storyboard') {
      let n = 0;
      const { storyboard, refused } = checkModelStoryboard(job.output as ModelStoryboardOutput, {
        brief: job.request.brief,
        eligible: new Map(ELIGIBLE_STORYBOARD.map((a) => [a.assetVersionId, a])),
        effectiveFactIds: this.effectiveFactIds,
        alternatives: (kind) =>
          kind === 'footage'
            ? [
                {
                  kind: 'use_still',
                  label: 'Use an approved still for the shot (held on screen; no motion)',
                  available: true,
                },
                {
                  kind: 'generated_clip',
                  label: 'Generate a 5 s clip (labelled as generated, held for approval)',
                  available: false,
                  reason: 'Video generation is turned off for this company',
                },
                {
                  kind: 'ask_for_footage',
                  label: 'Ask for footage: upload it to the library with its rights',
                  available: true,
                },
              ]
            : [{ kind: 'no_music', label: 'No music', available: true }],
        mint: () => `${job.id.slice(-4).toLowerCase()}s${++n}`,
      });
      return {
        storyboard,
        proposal: null,
        revisions: [],
        conflicts: [],
        refused,
        findings: [],
        summary: storyboard.title,
        draft: null,
      };
    }
    const output = job.output as ModelRecutOutput;
    const scope = job.request.recut.scope;
    const compiled = compileRecut(head.snapshot, output.actions, this.compileCtx(job, scope));
    const proposal = compiled.operations.length
      ? {
          kind: 'recut' as const,
          documentId: job.documentId,
          baseRevisionId: head.id,
          origin: 'agent' as const,
          summary: output.summary,
          operations: compiled.operations,
          groups: compiled.groups.map(({ operations: _o, ...g }) => g),
          changes: videoTimelineDiff(head.snapshot, compiled.project),
          findings: [],
          contentHash: hash(compiled.project),
          scope,
          acceptedRevisionId: null,
        }
      : null;
    return {
      storyboard: null,
      proposal,
      revisions: [],
      conflicts: [
        ...compiled.conflicts,
        ...output.unsupported.map((m) => ({ code: 'not_supported', message: m, itemIds: [] })),
      ],
      refused: [],
      findings: [],
      summary: output.summary,
      draft: null,
    };
  }

  active(documentId: string) {
    const all = [...this.jobs.values()].filter((j) => j.documentId === documentId).reverse();
    const finished = (k: MockAiJob['kind']) =>
      all.find((j) => j.kind === k && ['completed', 'failed', 'cancelled'].includes(j.state));
    const sb = finished('storyboard');
    const rc = finished('recut');
    return {
      items: all
        .filter((j) => !['completed', 'failed', 'cancelled'].includes(j.state))
        .map((j) => this.dto(j)),
      lastStoryboard: sb ? this.dto(sb) : null,
      lastRecut: rc ? this.dto(rc) : null,
    };
  }

  cancel(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) throw new NotFoundError('StudioVideoJob', jobId);
    if (job.state !== 'cancelled') {
      if (['completed', 'failed', 'saving'].includes(job.state))
        throw new ValidationFailedError([
          { path: 'state', issue: `illegal transition: ${job.state} → cancel` },
        ]);
      job.state = 'cancelled';
      job.progress = 100;
      job.version += 1;
    }
    return this.dto(job);
  }

  retry(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) throw new NotFoundError('StudioVideoJob', jobId);
    if (job.state === 'failed' || job.state === 'cancelled') {
      job.state = 'queued';
      job.attempt += 1;
      job.progress = VIDEO_AI_PROGRESS.queued;
      job.error = null;
      job.result = null;
      job.version += 1;
    }
    return this.dto(job);
  }

  private commit(
    job: MockAiJob,
    operations: VideoOperationBatch['operations'],
    summary: string,
    origin: 'user' | 'agent',
  ) {
    const res = this.video.apply({
      documentId: job.documentId,
      baseRevisionId: this.headOf(job.documentId).doc.currentRevisionId,
      operations,
      summary,
      origin,
    });
    return res;
  }

  saveDraft(input: z.infer<typeof VideoAiSaveDraft>) {
    const job = this.jobs.get(input.jobId);
    if (!job || job.kind !== 'storyboard' || !job.result)
      throw new NotFoundError('StudioVideoJob', input.jobId);
    if (job.version !== input.expectedVersion)
      throw new ConflictError('StudioVideoJob', job.id, input.expectedVersion);
    job.result = { ...job.result, draft: input.storyboard };
    job.version += 1;
    return this.dto(job);
  }

  assemble(input: z.infer<typeof VideoAiAssemble>) {
    const job = this.jobs.get(input.jobId);
    if (!job || job.kind !== 'storyboard' || !job.result)
      throw new NotFoundError('StudioVideoJob', input.jobId);
    const { doc, head } = this.headOf(job.documentId);
    if (doc.currentRevisionId !== input.baseRevisionId) throw new StaleRevisionError(doc.currentRevisionId);
    const problems = storyboardProblems(input.storyboard, {
      eligible: new Map(ELIGIBLE_STORYBOARD.map((a) => [a.assetVersionId, a])),
      effectiveFactIds: this.effectiveFactIds,
      brief: (job.request as Extract<VideoAiRequest, { kind: 'storyboard' }>).brief,
    });
    if (problems.length)
      throw new ValidationFailedError(
        problems.map((p) => ({ path: p.path, issue: p.reason })),
        'The storyboard uses something it may not',
      );
    const ctx = { media: MEDIA, bindings: this.bindings(), idPrefix: `ai${job.id.slice(-6).toLowerCase()}_` };
    const compiled = compileAssembly(head.snapshot, input.storyboard, ctx);
    const summary = `Assembled storyboard “${input.storyboard.title}”`;
    job.result = { ...job.result, storyboard: input.storyboard, draft: null, conflicts: compiled.conflicts };
    if (isEmptyProject(head.snapshot)) {
      const res = this.commit(job, compiled.operations, summary, 'agent'); // model-planned: agent guards
      return {
        applied: true as const,
        ...res,
        conflicts: compiled.conflicts,
        proposal: null,
        job: this.dto(job),
      };
    }
    const proposal = {
      kind: 'assembly' as const,
      documentId: doc.id,
      baseRevisionId: head.id,
      origin: 'agent' as const,
      summary,
      operations: compiled.operations,
      groups: compiled.groups.map(({ operations: _o, ...g }) => g),
      changes: videoTimelineDiff(head.snapshot, compiled.project),
      findings: [],
      contentHash: hash(compiled.project),
      scope: null,
      storyboard: input.storyboard,
      acceptedRevisionId: null,
    };
    job.result = { ...job.result, proposal };
    job.version += 1;
    return { applied: false as const, proposal, conflicts: compiled.conflicts, job: this.dto(job) };
  }

  accept(input: z.infer<typeof VideoAiAccept>) {
    const job = this.jobs.get(input.jobId);
    const proposal = job?.result?.proposal;
    if (!job || !proposal) throw new ValidationFailedError([{ path: 'jobId', issue: 'no_proposal' }]);
    const { doc, head } = this.headOf(job.documentId);
    if (doc.currentRevisionId !== proposal.baseRevisionId)
      throw new StaleRevisionError(doc.currentRevisionId);
    const only = new Set(input.groupIds);
    const operations =
      proposal.kind === 'recut'
        ? compileRecut(
            head.snapshot,
            (job.output as ModelRecutOutput).actions,
            this.compileCtx(job, proposal.scope),
            only,
          ).operations
        : compileAssembly(
            head.snapshot,
            proposal.storyboard as Storyboard,
            { media: MEDIA, bindings: this.bindings(), idPrefix: `ai${job.id.slice(-6).toLowerCase()}_` },
            only,
          ).operations;
    const kept = proposal.groups.filter((g) => only.has(g.id));
    const res = this.commit(
      job,
      operations,
      kept.length === proposal.groups.length
        ? proposal.summary
        : `${proposal.summary} (${kept.map((g) => g.label).join('; ')})`,
      proposal.origin,
    );
    job.result = {
      ...(job.result as VideoAiResult),
      proposal: { ...proposal, acceptedRevisionId: res.revision.id },
    };
    job.version += 1;
    return { ...res, job: this.dto(job) };
  }
}
