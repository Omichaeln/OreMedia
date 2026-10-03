import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import type { z } from 'zod';
import { emptyBrandSystemDocument, type BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import { NotFoundError, StaleRevisionError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { WaveformV1 } from '@oremedia/contracts/media';
import type { ResolvedActorUser } from '@oremedia/contracts/policy';
import type { VideoMediaInfo, VideoOperation, VideoProjectV1 } from '@oremedia/contracts/video';
import type {
  ModelRecutOutput,
  ModelStoryboardOutput,
  StudioVideoJobInputV1,
  StudioVideoJobRuntimeV1,
  VideoAiRequest,
} from '@oremedia/contracts/video-ai';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { tenants } from '@oremedia/db/schema/access';
import { budgetReservations, usageLedger } from '@oremedia/db/schema/billing';
import { approvedFacts, brands } from '@oremedia/db/schema/brand';
import { creativeRevisions, studioVideoJobs } from '@oremedia/db/schema/creative';
import { outboxEvents } from '@oremedia/db/schema/operations';
import { newId } from '@oremedia/domain/ids';
import {
  FakeModelAdapter,
  type ModelAdapter,
  RECUT_TOOL,
  STORYBOARD_TOOL,
  modelConfigFromEnv,
  resetRoutingPolicies,
  setTenantRoutingPolicy,
  type FakeModelStep,
} from '@oremedia/ai';
import { budgets } from '@oremedia/module-billing';
import {
  brandService,
  registerBrandAssetKindSource,
  resetBrandAssetKindSource,
} from '@oremedia/module-brand';
import {
  creativeService,
  registerAssetAuthoriser,
  registerCreativeAssetCatalog,
  registerVideoAiAssetSource,
  registerVideoAiCapabilitySource,
  resetAssetAuthoriser,
  resetVideoAiAssetSource,
  videoAiErrorCode,
  videoAiJobs,
  videoAiService,
} from '@oremedia/module-creative';
import { createStudioVideoRuntime } from './studio-video';

/**
 * STU-3 against MySQL 8 with a scripted model: a storyboard from a brief uses eligible assets only (an invented asset
 * id and a claim without an effective fact are refused and listed), gaps carry this brand's alternatives; assembly
 * into an empty video applies directly with generation inputs, into a non-empty one becomes a proposal accepted per
 * group; recuts compile to proposals with a diff (duration fit, pauses from the waveform), report a conflict when
 * locked material exceeds the target, respect the scope, and accept in part; a vertical version is a new document and
 * the original is untouched; cancel, retry, budget refusal, model failure and idempotent start; foreign ids NOT_FOUND.
 */
const USER = 'usr_stu3_test';
const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: USER },
  brandIds: 'all',
  correlationId: 'corr_stu3',
});
const manager = (tenantId: string): ResolvedActorUser => ({
  kind: 'user',
  id: USER,
  tenantId,
  membershipId: 'mem_stu3',
  membershipStatus: 'active',
  role: 'brand_manager',
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});
const run = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  runInTenant(ctx(tenantId), () => withTransaction(fn));
const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => runInTenant(ctx(tenantId), fn);

const brandDocument = (): BrandSystemDocumentV1 => ({
  ...emptyBrandSystemDocument(),
  voice: {
    ...emptyBrandSystemDocument().voice,
    summary: 'Plain',
    tone: ['plain'],
    prohibitedPhrases: ['cheap'],
  },
  tokens: {
    colours: [
      { key: 'ink', value: '#172120', role: 'text' },
      { key: 'paper', value: '#F4F6F3', role: 'background' },
      { key: 'accent', value: '#0F6E63', role: 'accent' },
    ],
    typeRoles: (['display', 'heading', 'body', 'label', 'caption'] as const).map((role, i) => ({
      role,
      fontAssetId: 'ast_font',
      weight: 600,
      minSizePx: [40, 28, 18, 14, 12][i] as number,
    })),
    spacingScale: [4, 8, 16],
    radii: [0, 4],
    contrastTarget: 'AA',
  },
  logoRules: [
    {
      assetId: 'ast_logo',
      variant: 'primary',
      allowedBackgroundColourKeys: ['paper'],
      clearSpaceRatio: 0.2,
      minWidthPx: 120,
    },
  ],
  channelGuidance: [
    {
      providerKey: 'linkedin_page',
      captionStyle: 'Sentence case',
      preferredFormats: [],
      ctaConventions: 'Learn more',
    },
  ],
});

const MEDIA: Record<string, VideoMediaInfo> = {
  av_demo: {
    assetVersionId: 'av_demo',
    kind: 'video',
    mime: 'video/mp4',
    durationMs: 12_000,
    width: 1920,
    height: 1080,
    hasAudio: true,
    derivatives: ['poster', 'proxy', 'strip', 'strip_map', 'waveform'],
  },
  av_intro: {
    assetVersionId: 'av_intro',
    kind: 'video',
    mime: 'video/mp4',
    durationMs: 8_000,
    width: 1920,
    height: 1080,
    hasAudio: true,
    derivatives: ['poster', 'proxy', 'strip'],
  },
  av_still: {
    assetVersionId: 'av_still',
    kind: 'image',
    mime: 'image/png',
    durationMs: null,
    width: 2000,
    height: 1500,
    hasAudio: false,
    derivatives: ['web'],
  },
  av_music: {
    assetVersionId: 'av_music',
    kind: 'audio',
    mime: 'audio/mpeg',
    durationMs: 60_000,
    width: null,
    height: null,
    hasAudio: true,
    derivatives: ['proxy', 'waveform'],
  },
};
const ELIGIBLE = [
  { id: 'av_demo', kind: 'video' as const, name: 'Product demo, hands on the bottle', alt: 'Close-up demo' },
  { id: 'av_intro', kind: 'video' as const, name: 'Founder intro', alt: null },
  { id: 'av_still', kind: 'photo' as const, name: 'Bottle range', alt: 'Three bottles' },
  { id: 'av_music', kind: 'audio' as const, name: 'Calm bed', alt: null },
];
/** av_demo: loud except quiet from 3.0 s to 4.5 s of the source (20 peaks a second). */
const WAVEFORMS: Record<string, WaveformV1> = {
  av_demo: {
    schemaVersion: 1,
    peaksPerSecond: 20,
    durationMs: 12_000,
    peaks: Array.from({ length: 240 }, (_, i) => (i >= 60 && i < 90 ? 4 : 700)),
  },
};

const registerEligible = () =>
  registerVideoAiAssetSource(async () =>
    ELIGIBLE.map((a) => ({
      assetVersionId: a.id,
      kind: a.kind,
      name: a.name,
      altText: a.alt,
      semanticRole: null,
      durationMs: MEDIA[a.id]?.durationMs ?? null,
      width: MEDIA[a.id]?.width ?? null,
      height: MEDIA[a.id]?.height ?? null,
      hasAudio: MEDIA[a.id]?.hasAudio ?? false,
      derivatives: MEDIA[a.id]?.derivatives ?? [],
    })),
  );

const call = (name: string, input: unknown): FakeModelStep => ({
  kind: 'tool_calls',
  toolCalls: [{ name, arguments: input }],
  usage: { inputTokens: 3000, outputTokens: 600 },
});

async function publishBrand(tenantId: string, brandId: string) {
  const actor = manager(tenantId);
  const draft = await run(tenantId, (tx) => brandService.versions.createDraft(actor, { brandId }, tx));
  await run(tenantId, (tx) =>
    brandService.versions.update(
      actor,
      { brandId, versionId: draft.versionId, expectedVersion: 0, document: brandDocument() },
      tx,
    ),
  );
  await run(tenantId, (tx) =>
    brandService.versions.submitForReview(
      actor,
      { brandId, versionId: draft.versionId, expectedVersion: 1 },
      tx,
    ),
  );
  await run(tenantId, (tx) =>
    brandService.versions.publish(actor, { brandId, versionId: draft.versionId, expectedVersion: 2 }, tx),
  );
}

describe('STU-3 studio video AI against MySQL 8 (scripted model)', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandB = newId('brand');
  const A = manager(tenantA);
  const factInForce = newId('approvedFact');
  const factRevoked = newId('approvedFact');
  const modelConfig = { ...modelConfigFromEnv({}), provider: 'fake', model: 'fake-model' };
  const runtimeWith = (script: FakeModelStep[]) => {
    const adapter = new FakeModelAdapter(script);
    return { adapter, runtime: createStudioVideoRuntime({ adapter, modelConfig }) };
  };

  /** The workflow's order, as the activities would run it (the orchestration itself is tested on Temporal). */
  async function drive(
    job: { id: string; attempt: number },
    runtime: StudioVideoJobRuntimeV1,
    tenantId = tenantA,
  ) {
    const input: StudioVideoJobInputV1 = {
      tenantId,
      actor: { kind: 'user', id: USER },
      correlationId: 'corr_stu3',
      jobId: job.id,
      attempt: job.attempt,
    };
    const actor = manager(tenantId);
    return inTenant(tenantId, async () => {
      let phase = 'begin';
      try {
        if (!(await runtime.begin(input)).proceed) return 'stopped';
        phase = 'reserve';
        if (!(await runtime.reserve(input)).proceed) return 'stopped';
        phase = 'model';
        if (!(await runtime.callModel(input, actor)).proceed) return 'stopped';
        phase = 'save';
        return (await runtime.save(input, actor)).state;
      } catch (err) {
        const code = videoAiErrorCode(err);
        await runtime.fail(
          input,
          phase === 'model' && code === 'failed' ? 'model_failed' : code,
          (err as Error).message,
        );
        return 'failed';
      } finally {
        await runtime.settle(input);
      }
    });
  }

  const newVideo = (title: string, formatKey: 'video_16x9' | 'video_9x16' = 'video_16x9') =>
    run(tenantA, (tx) =>
      creativeService.documents.create(
        A,
        { brandId: brandA, title, kind: 'video', video: { formatKey, fps: 30 } },
        tx,
      ),
    );
  const head = async (documentId: string) => {
    const d = await inTenant(tenantA, () => creativeService.documents.get(A, { documentId }));
    if (d.revision.kind !== 'video') throw new Error('expected video');
    return d.revision;
  };
  const start = (documentId: string, baseRevisionId: string, request: z.input<typeof VideoAiRequest>) =>
    run(tenantA, (tx) => videoAiService.start(A, { documentId, baseRevisionId, request }, tx));
  const getJob = (jobId: string) => inTenant(tenantA, () => videoAiService.get(A, { jobId }));
  const failure = async (p: Promise<unknown>) => {
    try {
      await p;
      return null;
    } catch (err) {
      return err;
    }
  };

  const storyboardAnswer = (): ModelStoryboardOutput => ({
    title: 'Cold all day',
    scenes: [
      {
        title: 'Introduction',
        narration: 'Meet the bottle. It keeps drinks cold for 24 hours.',
        onScreenText: 'Meet the bottle',
        claims: [{ text: 'It keeps drinks cold for 24 hours.', factIds: [factInForce] }],
        shots: [
          {
            description: 'Founder holds the bottle',
            assetVersionId: 'av_intro',
            sourceInMs: 0,
            durationMs: 4_000,
          },
        ],
      },
      {
        title: 'Product demonstration',
        narration: 'Fill it, close it, go. Best in town.',
        claims: [{ text: 'Best in town.', factIds: [factRevoked] }],
        shots: [
          {
            description: 'Hands fill the bottle',
            assetVersionId: 'av_demo',
            sourceInMs: 1_000,
            durationMs: 6_000,
          },
          { description: 'Bottle on a mountain', assetVersionId: 'av_invented', durationMs: 2_000 },
        ],
      },
    ],
    gaps: [],
    musicAssetVersionId: 'av_music',
  });
  /** Start a storyboard job and run it with the given answer; returns the completed job. */
  async function storyboardFor(documentId: string, revisionId: string, answer = storyboardAnswer()) {
    const job = await start(documentId, revisionId, {
      kind: 'storyboard',
      brief: { objective: 'Launch', durationMs: 12_000, factIds: [factInForce], channelKey: 'linkedin_page' },
    });
    const { runtime, adapter } = runtimeWith([call(STORYBOARD_TOOL, answer)]);
    expect(await drive(job, runtime)).toBe('completed');
    return { job: await getJob(job.id), adapter };
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    registerBrandAssetKindSource(
      async (_b, ids) =>
        new Map(ids.map((id) => [id, id === 'ast_font' ? ('font' as const) : ('logo' as const)])),
    );
    registerAssetAuthoriser(async (assetVersionId) => {
      if (!(assetVersionId in MEDIA) && !['av_font', 'av_logo'].includes(assetVersionId))
        throw new ValidationFailedError([{ path: 'asset', issue: `unknown ${assetVersionId}` }]);
    });
    registerCreativeAssetCatalog({
      mediaInfo: async (ids) => ids.flatMap((id) => (MEDIA[id] ? [MEDIA[id]] : [])),
      currentVersionIds: async (assetIds) =>
        Object.fromEntries(
          assetIds.flatMap((id) =>
            id === 'ast_font' ? [[id, 'av_font']] : id === 'ast_logo' ? [[id, 'av_logo']] : [],
          ),
        ),
      waveforms: async (ids) =>
        Object.fromEntries(ids.flatMap((id) => (WAVEFORMS[id] ? [[id, WAVEFORMS[id]]] : []))),
    });
    registerEligible();
    registerVideoAiCapabilitySource(async () => ({
      videoGeneration: { available: true, costMicrosPerSecond: 100_000 },
      speechGeneration: { available: false, reason: 'Speech generation is turned off for this company' },
    }));
    for (const t of [tenantA, tenantB])
      setTenantRoutingPolicy(t, {
        schemaVersion: 1,
        defaultModel: 'fake-model',
        permittedVendors: ['fake'],
        permittedRegions: [],
        deniedModels: [],
      });
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'stu3-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'stu3-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    await tdb.db.insert(approvedFacts).values([
      {
        id: factInForce,
        tenantId: tenantA,
        brandId: brandA,
        kind: 'claim',
        statement: 'Keeps drinks cold for 24 hours',
        evidence: [],
        state: 'approved',
        proposedByKind: 'user',
        proposedById: USER,
      },
      {
        id: factRevoked,
        tenantId: tenantA,
        brandId: brandA,
        kind: 'claim',
        statement: 'Best in town',
        evidence: [],
        state: 'revoked',
        proposedByKind: 'user',
        proposedById: USER,
      },
    ]);
    await publishBrand(tenantA, brandA);
    await publishBrand(tenantB, brandB);
  }, 120_000);
  afterAll(async () => {
    resetBrandAssetKindSource();
    resetAssetAuthoriser();
    resetVideoAiAssetSource();
    registerVideoAiCapabilitySource(null);
    resetRoutingPolicies();
    await tdb?.drop();
  });

  it('storyboards from a brief with eligible assets only; an invented asset and an unsupported claim are refused', async () => {
    const v = await newVideo('Launch film');
    const preflight = await inTenant(tenantA, () =>
      videoAiService.preflight(A, {
        documentId: v.documentId,
        baseRevisionId: v.revisionId,
        request: {
          kind: 'storyboard',
          brief: { factIds: [factInForce, factRevoked], assets: { include: ['av_nope'] } },
        },
      }),
    );
    expect(preflight.blocking).toBe(true);
    expect(preflight.issues.map((i) => i.code).sort()).toEqual(['asset_not_eligible', 'fact_not_effective']);
    expect(preflight.inputs.eligible).toEqual({ clips: 2, stills: 1, audio: 1 });
    expect(preflight.inputs.capabilities.transcription).toBe(false);

    const { job, adapter } = await storyboardFor(v.documentId, v.revisionId);
    const req = adapter.requests[0];
    expect(req?.tools.map((t) => t.name)).toEqual([STORYBOARD_TOOL]);
    expect(req?.system).toContain('av_demo');
    expect(req?.system).toContain(factInForce);
    expect(req?.system).not.toContain(factRevoked);
    expect(req?.system).toContain('<<<EVIDENCE'); // asset names reach the model as untrusted data
    expect(req?.system).toContain('Learn more'); // the channel's CTA guidance
    const sb = job.result?.storyboard;
    expect(sb?.scenes.flatMap((s) => s.shots.map((x) => x.assetVersionId))).toEqual([
      'av_intro',
      'av_demo',
      null,
    ]);
    expect(job.result?.refused.map((r) => r.reason).sort()).toEqual([
      'asset_not_eligible',
      'claim_without_effective_fact',
    ]);
    expect(sb?.scenes[1]?.narration).toBe('Fill it, close it, go.');
    const footage = sb?.gaps.find((g) => g.kind === 'footage');
    expect(footage?.alternatives.map((a) => [a.kind, a.available])).toEqual([
      ['use_still', true],
      ['generated_clip', true],
      ['ask_for_footage', true],
    ]);
    expect(footage?.alternatives[1]?.costMicros).toBe(500_000);
    // Nothing was written to the timeline; the model call was charged once to the ledger.
    expect((await head(v.documentId)).id).toBe(v.revisionId);
    const ledger = await tdb.db
      .select()
      .from(usageLedger)
      .where(like(usageLedger.sourceRef, `svj:${job.id}:1:model:%`));
    expect(ledger).toHaveLength(1);
    expect(job.costSpentMicros).toBeGreaterThan(0);
  });

  it('starts idempotently and reattaches: the same request on the same revision is the same job', async () => {
    const v = await newVideo('Idempotent');
    const request = { kind: 'storyboard' as const, brief: { objective: 'Same' } };
    const a = await start(v.documentId, v.revisionId, request);
    const b = await start(v.documentId, v.revisionId, request);
    expect(b.id).toBe(a.id);
    const active = await inTenant(tenantA, () => videoAiService.active(A, { documentId: v.documentId }));
    expect(active.items.map((j) => j.id)).toEqual([a.id]);
    const events = await tdb.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventType, 'creative.video_job_requested'));
    expect(events.filter((e) => e.payload['jobId'] === a.id)).toHaveLength(1);
  });

  it('assembles into an empty video at once (undoable revision with generation inputs), later as a proposal accepted in part', async () => {
    const v = await newVideo('Assembled');
    const { job } = await storyboardFor(v.documentId, v.revisionId);
    const storyboard = job.result?.storyboard;
    if (!storyboard) throw new Error('storyboard');
    // The person edits: drops the gap shot, shortens the demo and gives the second scene a title.
    const edited = structuredClone(storyboard);
    const demo = edited.scenes[1];
    if (!demo) throw new Error('scene');
    demo.shots = demo.shots
      .filter((s) => s.assetVersionId !== null)
      .map((s) => ({ ...s, durationMs: 5_000 }));
    demo.onScreenText = 'Fill, close, go';
    // A fabricated asset in the edit is refused before anything is compiled.
    const tampered = structuredClone(edited);
    (tampered.scenes[0]?.shots[0] as { assetVersionId: string }).assetVersionId = 'av_invented';
    const refused = await failure(
      run(tenantA, (tx) =>
        videoAiService.assemble(A, { jobId: job.id, baseRevisionId: v.revisionId, storyboard: tampered }, tx),
      ),
    );
    expect(refused).toBeInstanceOf(ValidationFailedError);

    const applied = await run(tenantA, (tx) =>
      videoAiService.assemble(A, { jobId: job.id, baseRevisionId: v.revisionId, storyboard: edited }, tx),
    );
    if (!applied.applied) throw new Error('expected a direct apply');
    const project = applied.revision.snapshot as VideoProjectV1;
    expect(project.durationMs).toBe(9_000);
    expect(project.scenes.map((s) => s.title)).toEqual(['Introduction', 'Product demonstration']);
    expect(project.tracks.find((t) => t.kind === 'video')?.items.map((c) => c.assetVersionId)).toEqual([
      'av_intro',
      'av_demo',
    ]);
    expect(project.tracks.find((t) => t.kind === 'audio')?.items[0]).toMatchObject({
      assetVersionId: 'av_music',
    });
    expect(project.tracks.find((t) => t.kind === 'caption')?.items.length).toBeGreaterThan(0);
    const [row] = await tdb.db
      .select()
      .from(creativeRevisions)
      .where(eq(creativeRevisions.id, applied.revision.id));
    expect(row?.authorKind).toBe('agent'); // model-planned: held to the agent guards, committed by the person
    expect(row?.generationInputs).toMatchObject({
      jobId: job.id,
      kind: 'assembly',
      assetVersionIds: expect.arrayContaining(['av_intro', 'av_demo', 'av_music']),
      factIds: [factInForce],
      modelCallRefs: [expect.stringMatching(new RegExp(`^svj:${job.id}:1:model:`))],
    });

    // Assembling again over the assembled video is a proposal; keep only the captions group.
    const second = await run(tenantA, (tx) =>
      videoAiService.assemble(
        A,
        { jobId: job.id, baseRevisionId: applied.revision.id, storyboard: edited },
        tx,
      ),
    );
    if (second.applied) throw new Error('expected a proposal');
    expect(second.proposal.groups.map((g) => g.id)).toEqual(['titles', 'captions', 'music', 'clips']);
    expect((await head(v.documentId)).id).toBe(applied.revision.id);
    const accepted = await run(tenantA, (tx) =>
      videoAiService.accept(
        A,
        { jobId: job.id, baseRevisionId: applied.revision.id, groupIds: ['captions'] },
        tx,
      ),
    );
    expect(accepted.revision.number).toBe(applied.revision.number + 1);
    const [acceptedRow] = await tdb.db
      .select()
      .from(creativeRevisions)
      .where(eq(creativeRevisions.id, accepted.revision.id));
    expect(acceptedRow?.generationInputs).toMatchObject({ acceptedGroupIds: ['captions'] });
    // A proposal is accepted once.
    expect(
      await failure(
        run(tenantA, (tx) =>
          videoAiService.accept(
            A,
            { jobId: job.id, baseRevisionId: accepted.revision.id, groupIds: ['titles'] },
            tx,
          ),
        ),
      ),
    ).toBeInstanceOf(ValidationFailedError);
  });

  it('commits a change above 100 operations as consecutive revisions (each a readable batch, one undo step each)', async () => {
    const v = await newVideo('Long storyboard');
    const answer: ModelStoryboardOutput = {
      title: 'Twelve scenes',
      scenes: Array.from({ length: 12 }, (_, i) => ({
        title: `Scene ${i + 1}`,
        narration: 'One line here. Another line there. And a third.',
        onScreenText: `Title ${i + 1}`,
        shots: Array.from({ length: 6 }, (_, k) => ({
          description: `Still ${i + 1}.${k + 1}`,
          assetVersionId: 'av_still',
          durationMs: 1_000,
        })),
      })),
      gaps: [],
      musicAssetVersionId: 'av_music',
    };
    const { job } = await storyboardFor(v.documentId, v.revisionId, answer);
    const assembled = await run(tenantA, (tx) =>
      videoAiService.assemble(
        A,
        { jobId: job.id, baseRevisionId: v.revisionId, storyboard: job.result!.storyboard! },
        tx,
      ),
    );
    if (!assembled.applied) throw new Error('expected apply');
    expect(assembled.parts.length).toBeGreaterThan(1);
    for (const part of assembled.parts) expect(part.operations.operations.length).toBeLessThanOrEqual(100);
    expect(assembled.parts.at(-1)?.id).toBe(assembled.revision.id);
    expect(assembled.parts.map((p) => p.number)).toEqual(assembled.parts.map((_, k) => 2 + k));
    const project = (await head(v.documentId)).snapshot;
    expect(project.tracks.find((t) => t.kind === 'video')?.items).toHaveLength(72);
    expect(project.durationMs).toBe(72_000);
    // Every part reads back (VideoOperationBatch holds at most 100 operations) and records the job.
    for (const part of assembled.parts) {
      const rev = await inTenant(tenantA, () =>
        creativeService.revisions.get(A, { documentId: v.documentId, revisionId: part.id }),
      );
      expect(rev.kind).toBe('video');
      const [row] = await tdb.db.select().from(creativeRevisions).where(eq(creativeRevisions.id, part.id));
      expect(row?.generationInputs).toMatchObject({ jobId: job.id, kind: 'assembly' });
    }
  });

  /** A 16:9 video assembled from a two-scene storyboard: intro 4 s, demo 8 s (music under both). */
  async function assembledVideo(title: string) {
    const v = await newVideo(title);
    const answer = storyboardAnswer();
    const demo = answer.scenes[1];
    if (!demo) throw new Error('scene');
    demo.shots = [{ description: 'Demo', assetVersionId: 'av_demo', sourceInMs: 0, durationMs: 8_000 }];
    const { job } = await storyboardFor(v.documentId, v.revisionId, answer);
    const assembled = await run(tenantA, (tx) =>
      videoAiService.assemble(
        A,
        { jobId: job.id, baseRevisionId: v.revisionId, storyboard: job.result!.storyboard! },
        tx,
      ),
    );
    if (!assembled.applied) throw new Error('expected apply');
    return {
      jobId: job.id,
      storyboard: job.result!.storyboard!,
      documentId: v.documentId,
      revision: assembled.revision,
      project: assembled.revision.snapshot as VideoProjectV1,
    };
  }
  const recut = async (
    documentId: string,
    revisionId: string,
    answer: ModelRecutOutput,
    scope: object = { kind: 'timeline' },
  ) => {
    const job = await start(documentId, revisionId, {
      kind: 'recut',
      recut: { instruction: 'Change it', scope: scope as never },
    });
    const { runtime, adapter } = runtimeWith([call(RECUT_TOOL, answer)]);
    const state = await drive(job, runtime);
    return { state, job: await getJob(job.id), adapter };
  };

  it('recuts: shortens to a target and removes pauses found in the waveform, with a diff; accept keeps one group', async () => {
    const v = await assembledVideo('Recut');
    const { state, job, adapter } = await recut(v.documentId, v.revision.id, {
      summary: 'Shorter and tighter',
      actions: [{ kind: 'tighten' }, { kind: 'fit_duration', targetMs: 9_000 }],
      unsupported: [],
    });
    expect(state).toBe('completed');
    expect(adapter.requests[0]?.messages[0]?.content[0]).toMatchObject({ type: 'text' });
    const proposal = job.result?.proposal;
    expect(proposal?.groups.map((g) => [g.id, g.label])).toEqual([
      ['a1', 'Remove pauses'],
      ['a2', 'Fit the length: 9.0 s'],
    ]);
    expect(proposal?.changes.some((c) => c.target === 'duration' && c.kind === 'trimmed')).toBe(true);
    // The proposal did not touch the document.
    expect((await head(v.documentId)).id).toBe(v.revision.id);
    const accepted = await run(tenantA, (tx) =>
      videoAiService.accept(A, { jobId: job.id, baseRevisionId: v.revision.id, groupIds: ['a1'] }, tx),
    );
    const out = accepted.revision.snapshot as VideoProjectV1;
    // The 1.5 s pause at 3.0-4.5 s of the demo (timeline 7.0-8.5 s) is cut, minus 150 ms kept each side.
    expect(out.durationMs).toBe(12_000 - 1_200);
    const [row] = await tdb.db
      .select()
      .from(creativeRevisions)
      .where(eq(creativeRevisions.id, accepted.revision.id));
    expect(row?.authorKind).toBe('agent');
    expect(row?.generationInputs).toMatchObject({
      kind: 'recut',
      acceptedGroupIds: ['a1'],
      scope: { kind: 'timeline' },
    });
  });

  it('reports a conflict when locked material is longer than the target, and proposes nothing', async () => {
    const v = await assembledVideo('Locked');
    const demo = v.project.tracks.find((t) => t.kind === 'video')?.items[1];
    const lock: VideoOperation = {
      op: 'setItemLock',
      trackId: 'trk_video',
      itemId: demo?.id ?? '',
      locked: true,
    };
    const locked = await run(tenantA, (tx) =>
      creativeService.videoOperations.apply(
        A,
        {
          documentId: v.documentId,
          baseRevisionId: v.revision.id,
          operations: [lock],
          summary: 'lock',
          origin: 'user',
        },
        tx,
      ),
    );
    const { state, job } = await recut(v.documentId, locked.revision.id, {
      summary: 'Twenty seconds',
      actions: [{ kind: 'fit_duration', targetMs: 6_000 }],
      unsupported: ['Add a drone shot over the city'],
    });
    expect(state).toBe('completed');
    expect(job.result?.proposal).toBeNull();
    expect(job.result?.conflicts.map((c) => c.code)).toEqual(['locked_exceeds_target', 'not_supported']);
    expect(job.result?.conflicts[0]?.message).toMatch(/at least/);
  });

  it('holds the scope on the server: replacing the opening shot keeps the rest, an out-of-scope removal is a conflict', async () => {
    const v = await assembledVideo('Scoped');
    const [intro, demo] = v.project.tracks.find((t) => t.kind === 'video')?.items ?? [];
    const { job } = await recut(
      v.documentId,
      v.revision.id,
      {
        summary: 'New opening',
        actions: [
          { kind: 'replace_source', itemId: intro?.id ?? '', assetVersionId: 'av_still' },
          { kind: 'remove_items', itemIds: [demo?.id ?? ''] },
        ],
        unsupported: [],
      },
      { kind: 'items', itemIds: [intro?.id] },
    );
    expect(job.result?.proposal?.groups.map((g) => g.id)).toEqual(['a1']);
    expect(job.result?.conflicts.some((c) => c.groupId === 'a2')).toBe(true);
    const accepted = await run(tenantA, (tx) =>
      videoAiService.accept(A, { jobId: job.id, baseRevisionId: v.revision.id, groupIds: ['a1'] }, tx),
    );
    const out = accepted.revision.snapshot as VideoProjectV1;
    const clips = out.tracks.find((t) => t.kind === 'video')?.items ?? [];
    expect(clips[0]?.assetVersionId).toBe('av_still');
    expect(clips[1]).toEqual(demo);
  });

  it('makes a vertical version as a new document and keeps the original', async () => {
    const v = await assembledVideo('Wide');
    const demo = v.project.tracks.find((t) => t.kind === 'video')?.items[1];
    const { job } = await recut(v.documentId, v.revision.id, {
      summary: 'Vertical cut',
      actions: [
        {
          kind: 'vertical_version',
          formatKey: 'video_9x16',
          focus: [{ itemId: demo?.id ?? '', focalX: 0.65, focalY: 0.5 }],
        },
      ],
      unsupported: [],
    });
    expect(job.result?.revisions).toHaveLength(1);
    expect((await head(v.documentId)).id).toBe(v.revision.id);
    const created = job.result?.revisions[0];
    const vertical = await head(created?.documentId ?? '');
    expect(vertical.snapshot.format).toMatchObject({ key: 'video_9x16', width: 1080, height: 1920 });
    expect(vertical.snapshot.tracks.find((t) => t.kind === 'video')?.items[1]).toMatchObject({
      frame: { fit: 'fill', focalX: 0.65 },
    });
    const [row] = await tdb.db.select().from(creativeRevisions).where(eq(creativeRevisions.id, vertical.id));
    expect(row?.generationInputs).toMatchObject({ kind: 'vertical_version', jobId: job.id });
  });

  const inputOf = (job: { id: string; attempt: number }): StudioVideoJobInputV1 => ({
    tenantId: tenantA,
    actor: { kind: 'user', id: USER },
    correlationId: 'corr_stu3',
    jobId: job.id,
    attempt: job.attempt,
  });
  const jobRow = async (jobId: string) =>
    (await tdb.db.select().from(studioVideoJobs).where(eq(studioVideoJobs.id, jobId)))[0]!;
  const reservationOf = async (runId: string | null) =>
    (
      await tdb.db
        .select()
        .from(budgetReservations)
        .where(eq(budgetReservations.runId, runId ?? ''))
    )[0];

  it('scopes the idempotent start to the requester and to live jobs: another person or a finished job starts anew', async () => {
    const v = await newVideo('Live key');
    const request = { kind: 'storyboard' as const, brief: { objective: 'Scoped' } };
    const mine = await start(v.documentId, v.revisionId, request);
    const other = { ...A, id: 'usr_stu3_other', membershipId: 'mem_stu3_other' };
    const theirs = await run(tenantA, (tx) =>
      videoAiService.start(other, { documentId: v.documentId, baseRevisionId: v.revisionId, request }, tx),
    );
    expect(theirs.id).not.toBe(mine.id); // another person never joins (or can cancel) my job by asking the same
    const cancelled = await run(tenantA, (tx) =>
      videoAiService.cancel(A, { jobId: mine.id, expectedVersion: mine.version }, tx),
    );
    expect((await jobRow(cancelled.id)).liveKey).toBeNull();
    const again = await start(v.documentId, v.revisionId, request);
    expect(again.id).not.toBe(mine.id); // a finished job is not returned for a fresh request
    expect(again.state).toBe('queued');
    expect(await start(v.documentId, v.revisionId, request)).toMatchObject({ id: again.id });
  });

  it('a late settle of a superseded attempt never touches the retry’s reservation; retry released the old one', async () => {
    const v = await newVideo('Late settle');
    const job = await start(v.documentId, v.revisionId, { kind: 'storyboard', brief: { objective: 'Late' } });
    const { runtime } = runtimeWith([call(STORYBOARD_TOOL, storyboardAnswer())]);
    const first = inputOf(job);
    await inTenant(tenantA, async () => {
      await runtime.begin(first);
      await runtime.reserve(first);
      await runtime.fail(first, 'model_failed', 'provider down'); // settle of attempt 1 has not run yet
    });
    const firstRunId = (await jobRow(job.id)).budgetRunId;
    expect((await reservationOf(firstRunId))?.state).toBe('held');
    const failed = await getJob(job.id);
    const retried = await run(tenantA, (tx) =>
      videoAiService.retry(A, { jobId: job.id, expectedVersion: failed.version }, tx),
    );
    expect((await reservationOf(firstRunId))?.state).toBe('released');
    const second = inputOf(retried);
    await inTenant(tenantA, async () => {
      await runtime.begin(second);
      await runtime.reserve(second);
    });
    const secondRow = await jobRow(job.id);
    expect(secondRow.budgetRunId).not.toBe(firstRunId);
    // Attempt 1's activities finish late: settle, spend and its reservation lookup are no-ops for attempt 2.
    await inTenant(tenantA, async () => {
      await runtime.settle(first);
      await videoAiJobs.addSpend(first, 123_456);
      expect(await videoAiJobs.reservationIdOf(first)).toBeNull();
      expect(await videoAiJobs.reservationIdOf(second)).toBe(secondRow.budgetReservationId);
    });
    expect((await reservationOf(secondRow.budgetRunId))?.state).toBe('held');
    expect((await jobRow(job.id)).costSpentMicros).toBe(0);
    // Attempt 2 carries on to completion on its own reservation.
    await inTenant(tenantA, async () => {
      expect((await runtime.callModel(second, A)).proceed).toBe(true);
      expect((await runtime.save(second, A)).state).toBe('completed');
      await runtime.settle(second);
    });
    expect((await reservationOf(secondRow.budgetRunId))?.state).toBe('settled');
  });

  it('a cancel while the model call is in flight still ledgers what the call cost', async () => {
    const v = await newVideo('Cancel in flight');
    const job = await start(v.documentId, v.revisionId, { kind: 'storyboard', brief: { objective: 'Mid' } });
    const fake = new FakeModelAdapter([call(STORYBOARD_TOOL, storyboardAnswer())]);
    const adapter: ModelAdapter = {
      provider: fake.provider,
      async complete(req) {
        const now = await getJob(job.id);
        await run(tenantA, (tx) =>
          videoAiService.cancel(A, { jobId: job.id, expectedVersion: now.version }, tx),
        );
        return fake.complete(req);
      },
    };
    const runtime = createStudioVideoRuntime({ adapter, modelConfig });
    expect(await drive(job, runtime)).toBe('stopped');
    const done = await getJob(job.id);
    expect(done.state).toBe('cancelled');
    expect(done.result).toBeNull();
    expect(done.costSpentMicros).toBeGreaterThan(0); // the cancelled attempt shows what it cost
    const ledger = await tdb.db
      .select()
      .from(usageLedger)
      .where(like(usageLedger.sourceRef, `svj:${job.id}:1:model:%`));
    expect(ledger).toHaveLength(1);
    const reservation = await reservationOf((await jobRow(job.id)).budgetRunId);
    expect(reservation?.state).toBe('released');
    expect(reservation?.consumedMicros).toBe(ledger[0]?.costMicros);
  });

  it('accept checks the storyboard again: a fact revoked or an asset no longer eligible since refuses it', async () => {
    const v = await assembledVideo('Changed since');
    const proposed = await run(tenantA, (tx) =>
      videoAiService.assemble(
        A,
        { jobId: v.jobId, baseRevisionId: v.revision.id, storyboard: v.storyboard },
        tx,
      ),
    );
    if (proposed.applied) throw new Error('expected a proposal');
    const acceptAll = () =>
      failure(
        run(tenantA, (tx) =>
          videoAiService.accept(
            A,
            { jobId: v.jobId, baseRevisionId: v.revision.id, groupIds: ['titles', 'captions'] },
            tx,
          ),
        ),
      );
    await tdb.db.update(approvedFacts).set({ state: 'revoked' }).where(eq(approvedFacts.id, factInForce));
    try {
      const refused = await acceptAll();
      expect(refused).toBeInstanceOf(ValidationFailedError);
      expect(JSON.stringify((refused as ValidationFailedError).details)).toContain(
        'claim_without_effective_fact',
      );
    } finally {
      await tdb.db.update(approvedFacts).set({ state: 'approved' }).where(eq(approvedFacts.id, factInForce));
    }
    registerVideoAiAssetSource(async () =>
      ELIGIBLE.filter((a) => a.id !== 'av_music').map((a) => ({
        assetVersionId: a.id,
        kind: a.kind,
        name: a.name,
        altText: a.alt,
        semanticRole: null,
        durationMs: MEDIA[a.id]?.durationMs ?? null,
        width: MEDIA[a.id]?.width ?? null,
        height: MEDIA[a.id]?.height ?? null,
        hasAudio: MEDIA[a.id]?.hasAudio ?? false,
        derivatives: MEDIA[a.id]?.derivatives ?? [],
      })),
    );
    try {
      const refused = await acceptAll();
      expect(refused).toBeInstanceOf(ValidationFailedError);
      expect(JSON.stringify((refused as ValidationFailedError).details)).toContain('asset_not_eligible');
    } finally {
      registerEligible();
    }
    expect((await head(v.documentId)).id).toBe(v.revision.id); // nothing was written
  });

  it('never rewrites or removes a protected title when assembling, and commits as the agent', async () => {
    const v = await assembledVideo('Protected title');
    const track = v.project.tracks.find((t) => t.kind === 'overlay');
    const title = track?.items.find((o) => o.element.type === 'text');
    if (!track || !title) throw new Error('expected a title');
    const guarded = { ...title, element: { ...title.element, protected: true } };
    const protectedRev = await run(tenantA, (tx) =>
      creativeService.videoOperations.apply(
        A,
        {
          documentId: v.documentId,
          baseRevisionId: v.revision.id,
          operations: [{ op: 'setOverlay', trackId: track.id, overlay: guarded }],
          summary: 'protect the title',
          origin: 'user',
        },
        tx,
      ),
    );
    const before = (protectedRev.revision.snapshot as VideoProjectV1).tracks
      .find((t) => t.id === track.id)
      ?.items.find((o) => o.id === title.id);
    const proposed = await run(tenantA, (tx) =>
      videoAiService.assemble(
        A,
        { jobId: v.jobId, baseRevisionId: protectedRev.revision.id, storyboard: v.storyboard },
        tx,
      ),
    );
    if (proposed.applied) throw new Error('expected a proposal');
    const touched = proposed.proposal.operations.filter(
      (o) => ('itemId' in o && o.itemId === title.id) || ('overlay' in o && o.overlay.id === title.id),
    );
    expect(touched).toEqual([]);
    const accepted = await run(tenantA, (tx) =>
      videoAiService.accept(
        A,
        { jobId: v.jobId, baseRevisionId: protectedRev.revision.id, groupIds: ['titles'] },
        tx,
      ),
    );
    const out = accepted.revision.snapshot as VideoProjectV1;
    expect(out.tracks.find((t) => t.id === track.id)?.items.find((o) => o.id === title.id)).toEqual(before);
    const [row] = await tdb.db
      .select()
      .from(creativeRevisions)
      .where(eq(creativeRevisions.id, accepted.revision.id));
    expect(row?.authorKind).toBe('agent');
  });

  it('a vertical version beside other actions reframes the original; the other actions stay a proposal', async () => {
    const v = await assembledVideo('Wide and tight');
    const { job } = await recut(v.documentId, v.revision.id, {
      summary: 'Tighter, and a vertical one',
      actions: [{ kind: 'tighten' }, { kind: 'vertical_version', formatKey: 'video_9x16', focus: [] }],
      unsupported: [],
    });
    expect(job.result?.revisions).toHaveLength(1);
    expect(job.result?.proposal?.groups.map((g) => g.id)).toEqual(['a1']);
    expect((await head(v.documentId)).id).toBe(v.revision.id);
    const vertical = await head(job.result?.revisions[0]?.documentId ?? '');
    expect(vertical.snapshot.format.key).toBe('video_9x16');
    // Made from the original: the pause the proposal would cut is still there.
    expect(vertical.snapshot.durationMs).toBe(v.project.durationMs);
    expect(vertical.snapshot.tracks.find((t) => t.kind === 'video')?.items.map((c) => c.id)).toEqual(
      v.project.tracks.find((t) => t.kind === 'video')?.items.map((c) => c.id),
    );
  });

  it('a proposal on a moved document is stale; nothing is lost', async () => {
    const v = await assembledVideo('Moved');
    const { job } = await recut(v.documentId, v.revision.id, {
      summary: 'Tighter',
      actions: [{ kind: 'tighten' }],
      unsupported: [],
    });
    const caption = v.project.tracks.find((t) => t.kind === 'caption')?.items[0];
    await run(tenantA, (tx) =>
      creativeService.videoOperations.apply(
        A,
        {
          documentId: v.documentId,
          baseRevisionId: v.revision.id,
          operations: [{ op: 'removeCaption', trackId: 'trk_captions', itemId: caption?.id ?? '' }],
          summary: 'person edit',
          origin: 'user',
        },
        tx,
      ),
    );
    const stale = await failure(
      run(tenantA, (tx) =>
        videoAiService.accept(A, { jobId: job.id, baseRevisionId: v.revision.id, groupIds: ['a1'] }, tx),
      ),
    );
    expect(stale).toBeInstanceOf(StaleRevisionError);
  });

  it('cancels a queued job (nothing runs), retries it as a new attempt that completes', async () => {
    const v = await newVideo('Cancelled');
    const job = await start(v.documentId, v.revisionId, {
      kind: 'storyboard',
      brief: { objective: 'Cancel me' },
    });
    const cancelled = await run(tenantA, (tx) =>
      videoAiService.cancel(A, { jobId: job.id, expectedVersion: job.version }, tx),
    );
    expect(cancelled).toMatchObject({ state: 'cancelled', live: false });
    const { runtime, adapter } = runtimeWith([call(STORYBOARD_TOOL, storyboardAnswer())]);
    expect(await drive(job, runtime)).toBe('stopped');
    expect(adapter.requests).toHaveLength(0);
    const retried = await run(tenantA, (tx) =>
      videoAiService.retry(A, { jobId: job.id, expectedVersion: cancelled.version }, tx),
    );
    expect(retried).toMatchObject({ state: 'queued', attempt: 2 });
    expect(await drive(retried, runtime)).toBe('completed');
    expect((await getJob(job.id)).result?.storyboard).not.toBeNull();
  });

  it('fails on a model error and an invalid answer, and retries after a provider failure', async () => {
    const v = await newVideo('Flaky');
    const job = await start(v.documentId, v.revisionId, {
      kind: 'storyboard',
      brief: { objective: 'Flaky' },
    });
    const broken = runtimeWith([{ kind: 'error', error: new Error('provider down') }]);
    expect(await drive(job, broken.runtime)).toBe('failed');
    const failed = await getJob(job.id);
    expect(failed.error?.code).toBe('model_failed');
    const retried = await run(tenantA, (tx) =>
      videoAiService.retry(A, { jobId: job.id, expectedVersion: failed.version }, tx),
    );
    const invalid = runtimeWith([call(STORYBOARD_TOOL, { title: 'x', scenes: [] })]);
    expect(await drive(retried, invalid.runtime)).toBe('failed');
    expect((await getJob(job.id)).error?.code).toBe('model_output_invalid');
  });

  it('reserves the budget before the model call: an exhausted budget fails the job and no model call is made', async () => {
    const v = await newVideo('No budget');
    const job = await start(v.documentId, v.revisionId, {
      kind: 'storyboard',
      brief: { objective: 'Broke' },
    });
    await inTenant(tenantA, () => budgets.setLimit(brandA, 'day', 1));
    try {
      const { runtime, adapter } = runtimeWith([call(STORYBOARD_TOOL, storyboardAnswer())]);
      expect(await drive(job, runtime)).toBe('failed');
      expect(adapter.requests).toHaveLength(0);
      expect((await getJob(job.id)).error?.code).toBe('budget_exhausted');
    } finally {
      await inTenant(tenantA, () => budgets.setLimit(brandA, 'day', 20_000_000));
    }
  });

  it('keeps tenants apart: a foreign job or document is NOT_FOUND', async () => {
    const v = await newVideo('Mine');
    const job = await start(v.documentId, v.revisionId, { kind: 'storyboard', brief: { objective: 'Mine' } });
    const B = manager(tenantB);
    expect(await failure(inTenant(tenantB, () => videoAiService.get(B, { jobId: job.id })))).toBeInstanceOf(
      NotFoundError,
    );
    expect(
      await failure(inTenant(tenantB, () => videoAiService.active(B, { documentId: v.documentId }))),
    ).toBeInstanceOf(NotFoundError);
    const [row] = await tdb.db.select().from(studioVideoJobs).where(eq(studioVideoJobs.id, job.id));
    expect(row?.tenantId).toBe(tenantA);
  });
});
