import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { NotFoundError, StaleRevisionError, ValidationFailedError } from '@oremedia/contracts/errors';
import type {
  VideoMediaInfo,
  VideoOperationBatch,
  VideoOperationsApply,
  VideoProjectV1,
} from '@oremedia/contracts/video';
import type { Finding } from '@oremedia/contracts/creative';
import {
  applyVideoBatch,
  blankVideoProject,
  instantiateVideoTemplate,
  listVideoTemplates,
  validateVideoProject,
  VideoOperationError,
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
