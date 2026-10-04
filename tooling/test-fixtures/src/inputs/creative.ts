import type { CrossTenantFixture } from '../cross-tenant-inputs';
import { seedCreativeDocument } from './creative-seed';

/** One entry per creative.* procedure, every id pointing at the foreign tenant's rows from CREATIVE_SEED (spec 19.3). */
export const CREATIVE_INPUTS: Record<string, CrossTenantFixture> = {
  'creative.documents.create': { buildInput: (f) => ({ brandId: f['brandId'], title: 'Foreign document' }) },
  'creative.documents.get': { buildInput: (f) => ({ documentId: f['creativeDocumentId'] }) },
  'creative.documents.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'creative.documents.duplicate': { buildInput: (f) => ({ documentId: f['creativeDocumentId'] }) },
  'creative.documents.rename': {
    buildInput: (f) => ({ documentId: f['creativeDocumentId'], title: 'Foreign rename' }),
  },
  'creative.revisions.list': {
    buildInput: (f) => ({ documentId: f['creativeDocumentId'], page: { limit: 50 } }),
  },
  'creative.revisions.get': {
    buildInput: (f) => ({ documentId: f['creativeDocumentId'], revisionId: f['creativeRevisionId'] }),
  },
  'creative.operations.applyBatch': {
    buildInput: (f) => ({
      documentId: f['creativeDocumentId'],
      baseRevisionId: f['creativeRevisionId'],
      operations: [{ op: 'setLock', pageId: 'page_1', elementId: f['creativeElementId'], locked: true }],
      summary: 'x',
      origin: 'user',
    }),
  },
  'creative.operations.propose': {
    buildInput: (f) => ({
      documentId: f['creativeDocumentId'],
      baseRevisionId: f['creativeRevisionId'],
      operations: [{ op: 'setLock', pageId: 'page_1', elementId: f['creativeElementId'], locked: true }],
      summary: 'x',
      origin: 'user',
    }),
  },
  'creative.renders.request': {
    buildInput: (f) => ({
      documentId: f['creativeDocumentId'],
      revisionId: f['creativeRevisionId'],
      formatKeys: ['square_1080'],
    }),
  },
  'creative.renders.get': { buildInput: (f) => ({ renderJobId: f['renderJobId'] }) },
  'creative.renders.exportMedia': { buildInput: (f) => ({ renderJobId: f['renderJobId'] }) },
  'creative.renders.cancel': { buildInput: (f) => ({ renderJobId: f['renderJobId'] }) },
  'creative.operations.applyVideo': {
    buildInput: (f) => ({
      documentId: f['videoDocumentId'],
      baseRevisionId: f['videoRevisionId'],
      operations: [{ op: 'setTrackLock', trackId: 'trk_video', locked: true }],
      summary: 'x',
      origin: 'user',
    }),
  },
  'creative.operations.proposeVideo': {
    buildInput: (f) => ({
      documentId: f['videoDocumentId'],
      baseRevisionId: f['videoRevisionId'],
      operations: [{ op: 'removeCaption', trackId: 'trk_captions', itemId: 'cap_seed' }],
      summary: 'x',
      origin: 'user',
    }),
  },
  'creative.videoTemplates.list': { buildInput: (f) => ({ brandId: f['brandId'] }) },
  'creative.videoAi.preflight': {
    buildInput: (f) => ({
      documentId: f['videoDocumentId'],
      baseRevisionId: f['videoRevisionId'],
      request: { kind: 'storyboard', brief: { objective: 'x' } },
    }),
  },
  'creative.videoAi.start': {
    buildInput: (f) => ({
      documentId: f['videoDocumentId'],
      baseRevisionId: f['videoRevisionId'],
      request: { kind: 'storyboard', brief: { objective: 'x' } },
    }),
  },
  'creative.videoAi.get': { buildInput: (f) => ({ jobId: f['videoJobId'] }) },
  'creative.videoAi.active': { buildInput: (f) => ({ documentId: f['videoDocumentId'] }) },
  'creative.videoAi.cancel': { buildInput: (f) => ({ jobId: f['videoJobId'], expectedVersion: 0 }) },
  'creative.videoAi.retry': { buildInput: (f) => ({ jobId: f['videoJobId'], expectedVersion: 0 }) },
  'creative.videoAi.assemble': {
    buildInput: (f) => ({
      jobId: f['videoJobId'],
      baseRevisionId: f['videoRevisionId'],
      storyboard: {
        title: 'x',
        scenes: [
          {
            id: 'sc_1',
            title: 'x',
            shots: [{ id: 'sh_1', description: 'x', assetVersionId: null, durationMs: 1000 }],
          },
        ],
        pacing: 'balanced',
        captions: false,
        audio: 'none',
        logo: false,
      },
    }),
  },
  'creative.videoAi.saveDraft': {
    buildInput: (f) => ({
      jobId: f['videoJobId'],
      expectedVersion: 0,
      storyboard: {
        title: 'x',
        scenes: [
          {
            id: 'sc_1',
            title: 'x',
            shots: [{ id: 'sh_1', description: 'x', assetVersionId: null, durationMs: 1000 }],
          },
        ],
        pacing: 'balanced',
        captions: false,
        audio: 'none',
        logo: false,
      },
    }),
  },
  'creative.videoAi.accept': {
    buildInput: (f) => ({ jobId: f['videoJobId'], baseRevisionId: f['videoRevisionId'], groupIds: ['a1'] }),
  },
  'creative.comments.add': {
    buildInput: (f) => ({
      documentId: f['creativeDocumentId'],
      revisionId: f['creativeRevisionId'],
      elementId: f['creativeElementId'],
      body: 'x',
    }),
  },
  'creative.comments.resolve': {
    buildInput: (f) => ({
      documentId: f['creativeDocumentId'],
      commentId: f['commentId'],
      expectedVersion: 0,
    }),
  },
  'creative.comments.list': {
    buildInput: (f) => ({ documentId: f['creativeDocumentId'], page: { limit: 50 } }),
  },
  'creative.templates.create': { buildInput: (f) => ({ brandId: f['brandId'], name: 'x' }) },
  'creative.templates.createVersion': {
    buildInput: (f) => ({
      templateId: f['templateId'],
      document: seedCreativeDocument(f['creativePublishedBrandVersionId'] ?? 'bv_foreign'),
      slots: [],
      formats: ['square_1080'],
    }),
  },
  'creative.templates.approve': {
    buildInput: (f) => ({
      templateId: f['templateId'],
      templateVersionId: f['templateVersionId'],
      expectedVersion: 0,
    }),
  },
  'creative.templates.retire': {
    buildInput: (f) => ({
      templateId: f['templateId'],
      templateVersionId: f['templateVersionId'],
      expectedVersion: 0,
    }),
  },
  'creative.templates.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'creative.templates.listCurrent': {
    buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }),
  },
  'creative.templates.get': {
    buildInput: (f) => ({ templateId: f['templateId'], templateVersionId: f['templateVersionId'] }),
  },
  // STU-1b generation jobs: a foreign document, revision or job is NOT_FOUND.
  'creative.generation.preflight': {
    buildInput: (f) => ({
      documentId: f['creativeDocumentId'],
      baseRevisionId: f['creativeRevisionId'],
      request: { kind: 'refine', refine: { instruction: 'x', scope: { pageId: 'page_1' } } },
    }),
  },
  'creative.generation.start': {
    buildInput: (f) => ({
      documentId: f['creativeDocumentId'],
      baseRevisionId: f['creativeRevisionId'],
      request: { kind: 'refine', refine: { instruction: 'x', scope: { pageId: 'page_1' } } },
    }),
  },
  'creative.generation.get': { buildInput: (f) => ({ jobId: f['generationJobId'] }) },
  'creative.generation.active': { buildInput: (f) => ({ documentId: f['creativeDocumentId'] }) },
  'creative.generation.cancel': { buildInput: (f) => ({ jobId: f['generationJobId'], expectedVersion: 0 }) },
  'creative.generation.retry': { buildInput: (f) => ({ jobId: f['generationJobId'], expectedVersion: 0 }) },
};
