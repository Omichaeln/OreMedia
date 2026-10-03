import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { emptyBrandSystemDocument, type BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import type { CreativeDocumentV1, Element } from '@oremedia/contracts/creative';
import { BudgetExhaustedError, NotFoundError, ValidationFailedError } from '@oremedia/contracts/errors';
import type {
  GenerationRequest,
  ModelFill,
  StudioGenerationInputV1,
  StudioGenerationRuntimeV1,
} from '@oremedia/contracts/generation';
import type { ResolvedActorUser } from '@oremedia/contracts/policy';
import type { ProviderCapabilityV1 } from '@oremedia/contracts/providers';
import type { z } from 'zod';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { tenants } from '@oremedia/db/schema/access';
import { budgetReservations, usageLedger } from '@oremedia/db/schema/billing';
import { approvedFacts, brands } from '@oremedia/db/schema/brand';
import { creativeRevisions, studioGenerationJobs } from '@oremedia/db/schema/creative';
import { outboxEvents } from '@oremedia/db/schema/operations';
import { newId } from '@oremedia/domain/ids';
import { operationsOfGroups } from '@oremedia/editor/generation';
import { instantiateStarter, starterByKey, type StarterBrand } from '@oremedia/editor/starters/index';
import {
  FakeModelAdapter,
  STUDIO_FILL_TOOL,
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
  generationErrorCode,
  generationService,
  registerAssetAuthoriser,
  registerChannelCapabilitySource,
  registerGenerationAssetSource,
  resetAssetAuthoriser,
  resetChannelCapabilitySource,
  resetGenerationAssetSource,
} from '@oremedia/module-creative';
import { createStudioGenerationRuntime } from './studio-generation';

/**
 * STU-1b against MySQL 8 with a scripted model: generation into a built-in starter (editable text, shape and logo
 * elements kept), locks and scope enforced by the server, facts that are not in force refused, the budget reserved
 * before the call and refused when exhausted, cancel, retry after a provider failure, idempotent start, reattach,
 * selective accept of a proposal, adaptation into a story without touching the original page, and variations.
 */
const USER = 'usr_stu1b_test';
const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: USER },
  brandIds: 'all',
  correlationId: 'corr_stu1b',
});
const manager = (tenantId: string): ResolvedActorUser => ({
  kind: 'user',
  id: USER,
  tenantId,
  membershipId: 'mem_stu1b',
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
      { key: 'mist', value: '#D3DAD5', role: 'neutral' },
    ],
    typeRoles: (['display', 'heading', 'body', 'label', 'caption'] as const).map((role, i) => ({
      role,
      fontAssetId: 'ast_font',
      weight: 600,
      minSizePx: [40, 28, 18, 14, 12][i]!,
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
      clearSpaceRatio: 0.5,
      minWidthPx: 120,
    },
  ],
});

const starterBrand = (brandVersionId: string): StarterBrand => ({
  brandVersionId,
  colours: brandDocument().tokens.colours,
  typeRoles: brandDocument().tokens.typeRoles.map((t) => ({
    role: t.role,
    fontAssetVersionId: 'av_font',
    weight: t.weight,
    minSizePx: t.minSizePx,
  })),
  logos: [
    {
      variant: 'primary',
      assetVersionId: 'av_logo',
      aspect: 10 / 3,
      minWidthPx: 120,
      allowedBackgroundColourKeys: ['paper'],
    },
  ],
});

const instagram = {
  key: 'instagram',
  version: 1,
  text: {
    maxLength: 2200,
    weighted: false,
    supportsLinks: false,
    supportsMentions: true,
    supportsHashtags: true,
  },
  media: {
    image: {
      mimes: ['image/png'],
      minWidth: 320,
      maxWidth: 1440,
      aspectRatios: [{ min: 0.5, max: 1.91 }],
      maxBytes: 8e6,
      maxCount: 10,
    },
    carousel: { min: 2, max: 10 },
    altText: true,
    publicUrlFetch: { required: true, processingWindowSec: 60 },
  },
  certifiedAt: '2026-01-01T00:00:00.000Z',
} as unknown as ProviderCapabilityV1;

const fillCall = (...variations: ModelFill[]): FakeModelStep => ({
  kind: 'tool_calls',
  toolCalls: [{ name: STUDIO_FILL_TOOL, arguments: { variations } }],
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
  return draft.versionId;
}

describe('STU-1b studio generation against MySQL 8 (scripted model)', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandB = newId('brand');
  const A = manager(tenantA);
  const factInForce = newId('approvedFact');
  const factRevoked = newId('approvedFact');
  let versionA = '';
  const modelConfig = { ...modelConfigFromEnv({}), provider: 'fake', model: 'fake-model' };
  const runtimeWith = (script: FakeModelStep[]) => {
    const adapter = new FakeModelAdapter(script);
    return { adapter, runtime: createStudioGenerationRuntime({ adapter, modelConfig }) };
  };

  /** The workflow's order, as the activities would run it (the orchestration itself is tested on Temporal). */
  async function drive(
    job: { id: string; attempt: number },
    runtime: StudioGenerationRuntimeV1,
    tenantId = tenantA,
  ) {
    const input: StudioGenerationInputV1 = {
      tenantId,
      actor: { kind: 'user', id: USER },
      correlationId: 'corr_stu1b',
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
        const code = generationErrorCode(err);
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

  async function starterDocument(key = 'post-photo-feature') {
    const { document } = instantiateStarter(starterByKey(key)!, starterBrand(versionA));
    const created = await run(tenantA, (tx) =>
      creativeService.documents.create(
        A,
        {
          brandId: brandA,
          title: `Generated ${key}`,
          document,
          contentType: document.contentType,
          source: { kind: 'starter', starterKey: key },
        },
        tx,
      ),
    );
    return {
      documentId: created.documentId,
      revisionId: created.revisionId,
      document: (await head(created.documentId)).snapshot,
    };
  }
  const head = (documentId: string) =>
    inTenant(tenantA, () => creativeService.documents.get(A, { documentId })).then((d) => d.revision);
  const el = (doc: CreativeDocumentV1, name: string, page = 0): Element =>
    doc.pages[page]!.elements.find((e) => e.name.startsWith(name))!;
  const start = (documentId: string, baseRevisionId: string, request: z.input<typeof GenerationRequest>) =>
    run(tenantA, (tx) => generationService.start(A, { documentId, baseRevisionId, request }, tx));
  const getJob = (jobId: string) => inTenant(tenantA, () => generationService.get(A, { jobId }));

  beforeAll(async () => {
    tdb = await createTestDatabase();
    registerBrandAssetKindSource(
      async (_b, ids) =>
        new Map(ids.map((id) => [id, id === 'ast_font' ? ('font' as const) : ('logo' as const)])),
    );
    registerAssetAuthoriser(async () => undefined);
    registerGenerationAssetSource(async () => [
      {
        assetId: 'ast_photo',
        assetVersionId: 'av_photo',
        kind: 'image',
        altText: 'Product photograph',
        semanticRole: 'product',
      },
      {
        assetId: 'ast_photo2',
        assetVersionId: 'av_photo2',
        kind: 'image',
        altText: null,
        semanticRole: null,
      },
    ]);
    registerChannelCapabilitySource(() => [instagram]);
    for (const t of [tenantA, tenantB])
      setTenantRoutingPolicy(t, {
        schemaVersion: 1,
        defaultModel: 'fake-model',
        permittedVendors: ['fake'],
        permittedRegions: [],
        deniedModels: [],
      });
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'stu1b-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'stu1b-b-' + tenantB.slice(-6).toLowerCase() },
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
        kind: 'offer',
        statement: '20% off in October',
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
    versionA = await publishBrand(tenantA, brandA);
    await publishBrand(tenantB, brandB);
  });
  afterAll(async () => {
    resetBrandAssetKindSource();
    resetAssetAuthoriser();
    resetGenerationAssetSource();
    resetChannelCapabilitySource();
    resetRoutingPolicies();
    await tdb?.drop();
  });

  it('generates into a fresh starter: one revision with editable text, the image placed, the logo kept, inputs recorded', async () => {
    const d = await starterDocument();
    const headline = el(d.document, 'Headline');
    const body = el(d.document, 'Body');
    const area = el(d.document, 'Image area');
    const logo = d.document.pages[0]!.elements.find((e) => e.type === 'logo')!;
    const preflight = await inTenant(tenantA, () =>
      generationService.preflight(A, {
        documentId: d.documentId,
        baseRevisionId: d.revisionId,
        request: {
          kind: 'generate',
          brief: { keyMessage: 'October offer', channelKeys: ['instagram'], factIds: [factInForce] },
        },
      }),
    );
    expect(preflight.blocking).toBe(false);
    expect(preflight.inputs.fresh).toBe(true);
    expect(preflight.inputs.facts).toEqual([
      { id: factInForce, statement: '20% off in October', effective: true },
    ]);
    expect(preflight.cost.totalMicros).toBeGreaterThan(0);
    expect(preflight.constraints.some((c) => c.kind === 'logo_rule')).toBe(true);

    const job = await start(d.documentId, d.revisionId, {
      kind: 'generate',
      brief: { keyMessage: 'October offer', channelKeys: ['instagram'], factIds: [factInForce] },
    });
    expect(job).toMatchObject({ state: 'queued', attempt: 1, live: true });
    const outbox = await tdb.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventType, 'creative.generation_requested'));
    expect(outbox.some((e) => e.payload['jobId'] === job.id)).toBe(true);

    const { runtime, adapter } = runtimeWith([
      fillCall({
        summary: 'October offer',
        edits: [
          {
            label: 'Headline',
            pageId: 'page_1',
            elementId: headline.id,
            text: '20% off in October',
            factIds: [factInForce],
          },
          { label: 'Body', pageId: 'page_1', elementId: body.id, text: 'This month only, in every store.' },
          { label: 'Photo', pageId: 'page_1', elementId: area.id, assetVersionId: 'av_photo' },
          {
            label: 'Logo',
            pageId: 'page_1',
            elementId: logo.id,
            box: { x: 10, y: 10, width: 200, height: 60 },
          },
        ],
      }),
    ]);
    expect(await drive(job, runtime)).toBe('completed');
    // The model saw the guidance, the facts by id and the slots; it was asked for the strict tool.
    const req = adapter.requests[0]!;
    expect(req.tools.map((t) => t.name)).toEqual([STUDIO_FILL_TOOL]);
    expect(req.system).toContain(factInForce);
    expect(req.system).not.toContain(factRevoked);
    expect(req.messages[0]!.content[0]).toMatchObject({ type: 'text' });

    const done = await getJob(job.id);
    expect(done).toMatchObject({ state: 'completed', progress: 100, live: false });
    expect(done.result?.refused).toEqual([
      expect.objectContaining({ elementId: logo.id, reason: 'element_logo' }),
    ]);
    expect(done.resultRevisionIds).toHaveLength(1);
    const rev = await head(d.documentId);
    expect(rev.id).toBe(done.resultRevisionIds[0]);
    expect(rev).toMatchObject({ number: 2, authorKind: 'agent' });
    expect(rev.generationInputs).toMatchObject({
      jobId: job.id,
      kind: 'generate',
      brandVersionId: versionA,
      assetVersionIds: ['av_photo'],
      factIds: [factInForce],
      variation: 0,
    });
    expect(rev.generationInputs?.modelCallRefs).toEqual([`sgj:${job.id}:1:model`]);
    const page = rev.snapshot.pages[0]!;
    // Editable structure: text stays text (with the cited fact), the logo is untouched, the image is a raster element.
    expect(page.elements.find((e) => e.id === headline.id)).toMatchObject({
      type: 'text',
      text: '20% off in October',
      factRefs: [factInForce],
    });
    expect(page.elements.find((e) => e.id === logo.id)).toEqual(logo);
    expect(page.elements.find((e) => e.type === 'image')).toMatchObject({
      assetVersionId: 'av_photo',
      transform: area.transform,
    });
    expect(page.elements.map((e) => e.type)).toEqual(['background', 'image', 'text', 'text', 'logo']);
    // The model call was charged once against the job's reservation, which is settled.
    const ledger = await tdb.db
      .select()
      .from(usageLedger)
      .where(eq(usageLedger.sourceRef, `sgj:${job.id}:1:model`));
    expect(ledger).toHaveLength(1);
    const jobRow = (
      await tdb.db.select().from(studioGenerationJobs).where(eq(studioGenerationJobs.id, job.id))
    )[0]!;
    const reservation = (
      await tdb.db.select().from(budgetReservations).where(eq(budgetReservations.runId, jobRow.budgetRunId!))
    )[0]!;
    expect(reservation.state).toBe('settled');
    expect(jobRow.costSpentMicros).toBe(ledger[0]!.costMicros);
  });

  it('start is idempotent per document, base revision and inputs; the studio reattaches to the live job', async () => {
    const d = await starterDocument();
    const request = { kind: 'generate' as const, brief: { keyMessage: 'Same intent' } };
    const first = await start(d.documentId, d.revisionId, request);
    const again = await start(d.documentId, d.revisionId, {
      kind: 'generate',
      brief: { keyMessage: 'Same intent', variations: 1 },
    });
    expect(again.id).toBe(first.id);
    const other = await start(d.documentId, d.revisionId, {
      kind: 'generate',
      brief: { keyMessage: 'Another intent' },
    });
    expect(other.id).not.toBe(first.id);
    const active = await inTenant(tenantA, () => generationService.active(A, { documentId: d.documentId }));
    expect(active.items.map((j) => j.id).sort()).toEqual([first.id, other.id].sort());
    // Foreign tenants see nothing.
    await expect(
      inTenant(tenantB, () => generationService.get(manager(tenantB), { jobId: first.id })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('facts that are not in force refuse the start; a model citing one has that edit refused', async () => {
    const d = await starterDocument();
    await expect(
      start(d.documentId, d.revisionId, {
        kind: 'generate',
        brief: { keyMessage: 'Claim', factIds: [factRevoked] },
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    const headline = el(d.document, 'Headline');
    const body = el(d.document, 'Body');
    const job = await start(d.documentId, d.revisionId, {
      kind: 'generate',
      brief: { keyMessage: 'Claims' },
    });
    const { runtime } = runtimeWith([
      fillCall({
        summary: 's',
        edits: [
          {
            label: 'Headline',
            pageId: 'page_1',
            elementId: headline.id,
            text: 'Best in town',
            factIds: [factRevoked],
          },
          { label: 'Body', pageId: 'page_1', elementId: body.id, text: 'Open every day.' },
        ],
      }),
    ]);
    expect(await drive(job, runtime)).toBe('completed');
    const done = await getJob(job.id);
    expect(done.result?.refused.map((r) => r.reason)).toEqual([`fact_not_effective:${factRevoked}`]);
    const page = (await head(d.documentId)).snapshot.pages[0]!;
    expect(page.elements.find((e) => e.id === headline.id)).toMatchObject({
      text: headline.type === 'text' ? headline.text : '',
    });
  });

  it('a document a person has edited gets a proposal; locked elements are refused; part of it is accepted with the job reference', async () => {
    const d = await starterDocument();
    const headline = el(d.document, 'Headline');
    const body = el(d.document, 'Body');
    const lockedRev = await run(tenantA, (tx) =>
      creativeService.operations.apply(
        A,
        {
          documentId: d.documentId,
          baseRevisionId: d.revisionId,
          operations: [{ op: 'setLock', pageId: 'page_1', elementId: body.id, locked: true }],
          summary: 'Lock body',
          origin: 'user',
        },
        tx,
      ),
    );
    const base = lockedRev.revision.id;
    const job = await start(d.documentId, base, {
      kind: 'generate',
      brief: { keyMessage: 'Spring', channelKeys: ['instagram'] },
    });
    const { runtime } = runtimeWith([
      fillCall({
        summary: 'Spring',
        edits: [
          { label: 'Headline', pageId: 'page_1', elementId: headline.id, text: 'Spring is here' },
          { label: 'Headline colour', pageId: 'page_1', elementId: headline.id, colourToken: 'accent' },
          { label: 'Body', pageId: 'page_1', elementId: body.id, text: 'Locked text' },
          {
            label: 'Photo',
            pageId: 'page_1',
            elementId: el(d.document, 'Image area').id,
            assetVersionId: 'av_photo2',
          },
        ],
      }),
    ]);
    expect(await drive(job, runtime)).toBe('completed');
    const done = await getJob(job.id);
    expect(done.resultRevisionIds).toEqual([]); // nothing replaced the person's work
    expect(done.result?.refused.map((r) => r.reason)).toEqual(['element_locked']);
    const proposal = done.result!.proposal!;
    expect(proposal.baseRevisionId).toBe(base);
    expect(proposal.groups.map((g) => g.label)).toEqual(['Headline; Headline colour', 'Photo']);
    expect((await head(d.documentId)).id).toBe(base);

    // Selective accept: only the photo group, as the agent's batch, with the job reference.
    const photo = proposal.groups.find((g) => g.label === 'Photo')!;
    const operations = operationsOfGroups(proposal.operations, proposal.groups, [photo.id]);
    await expect(
      run(tenantA, (tx) =>
        creativeService.operations.apply(
          A,
          {
            documentId: d.documentId,
            baseRevisionId: base,
            operations: proposal.operations,
            summary: 'All',
            origin: 'agent',
            generation: { jobId: job.id, groupIds: [photo.id] },
          },
          tx,
        ),
      ),
    ).rejects.toThrow(/not those of the chosen proposal groups/);
    const accepted = await run(tenantA, (tx) =>
      creativeService.operations.apply(
        A,
        {
          documentId: d.documentId,
          baseRevisionId: base,
          operations,
          summary: proposal.summary,
          origin: 'agent',
          generation: { jobId: job.id, groupIds: [photo.id] },
        },
        tx,
      ),
    );
    expect(accepted.revision.generationInputs).toMatchObject({ jobId: job.id, acceptedGroupIds: [photo.id] });
    const page = accepted.revision.snapshot.pages[0]!;
    expect(page.elements.find((e) => e.id === headline.id)).toEqual(headline); // the group left out
    expect(page.elements.some((e) => e.type === 'image' && e.assetVersionId === 'av_photo2')).toBe(true);
  });

  it('a refinement is scoped: edits outside the selection are refused and only the selection changes', async () => {
    const d = await starterDocument();
    const headline = el(d.document, 'Headline');
    const body = el(d.document, 'Body');
    const job = await start(d.documentId, d.revisionId, {
      kind: 'refine',
      refine: {
        instruction: 'Shorten this headline without changing the layout',
        scope: { pageId: 'page_1', elementIds: [headline.id] },
      },
    });
    const { runtime } = runtimeWith([
      fillCall({
        summary: 'Shorter headline',
        edits: [
          { label: 'Shorter headline', pageId: 'page_1', elementId: headline.id, text: 'Save 20%' },
          { label: 'Body', pageId: 'page_1', elementId: body.id, text: 'Out of scope' },
        ],
      }),
    ]);
    expect(await drive(job, runtime)).toBe('completed');
    const done = await getJob(job.id);
    expect(done.result?.refused).toEqual([
      expect.objectContaining({ elementId: body.id, reason: 'element_out_of_scope' }),
    ]);
    const proposal = done.result!.proposal!;
    expect(proposal.scope).toEqual({ pageId: 'page_1', elementIds: [headline.id] });
    expect(proposal.operations).toEqual([
      { op: 'setText', pageId: 'page_1', elementId: headline.id, text: 'Save 20%', factRefs: [] },
    ]);
    // Accepting it applies under the same scope check.
    const accepted = await run(tenantA, (tx) =>
      creativeService.operations.apply(
        A,
        {
          documentId: d.documentId,
          baseRevisionId: d.revisionId,
          operations: proposal.operations,
          summary: proposal.summary,
          origin: 'agent',
          generation: { jobId: job.id, groupIds: ['g1'] },
        },
        tx,
      ),
    );
    expect(accepted.revision.snapshot.pages[0]!.elements.find((e) => e.id === headline.id)).toMatchObject({
      text: 'Save 20%',
    });
  });

  it('adapts a page into a vertical story as a new page; the original page is not touched', async () => {
    const d = await starterDocument();
    const job = await start(d.documentId, d.revisionId, {
      kind: 'refine',
      refine: {
        instruction: 'Adapt into a vertical story',
        scope: { pageId: 'page_1' },
        action: { kind: 'adapt', formatKey: 'ig_story_9x16' },
      },
    });
    const storyPage = 'page_1_ig_story_9x16';
    const headline = el(d.document, 'Headline');
    const { runtime, adapter } = runtimeWith([
      fillCall({
        summary: 'Story',
        edits: [
          {
            label: 'Story headline',
            pageId: storyPage,
            elementId: headline.id,
            text: 'Swipe up for October',
          },
          { label: 'Original', pageId: 'page_1', elementId: headline.id, text: 'Must not change' },
        ],
      }),
    ]);
    expect(await drive(job, runtime)).toBe('completed');
    expect(adapter.requests[0]!.messages[0]!.content[0]).toMatchObject({
      text: expect.stringContaining(storyPage),
    });
    const done = await getJob(job.id);
    expect(done.result?.refused.map((r) => r.reason)).toEqual(['page_not_in_scope']);
    const proposal = done.result!.proposal!;
    expect(proposal.groups).toHaveLength(1);
    expect(proposal.operations[0]).toEqual({
      op: 'createFormatVariant',
      sourcePageId: 'page_1',
      formatKey: 'ig_story_9x16',
    });
    // The reflowed logo leaves the story's safe area and agents may not move a logo: the proposal says so, and it
    // cannot be accepted as the agent's; the person takes it as their own and moves the logo.
    expect(proposal.findings).toEqual([
      expect.objectContaining({ code: 'safe_area', severity: 'blocking', pageId: storyPage }),
    ]);
    const accept = (origin: 'agent' | 'user') =>
      run(tenantA, (tx) =>
        creativeService.operations.apply(
          A,
          {
            documentId: d.documentId,
            baseRevisionId: d.revisionId,
            operations: proposal.operations,
            summary: proposal.summary,
            origin,
            generation: { jobId: job.id, groupIds: ['g1'] },
          },
          tx,
        ),
      );
    await expect(accept('agent')).rejects.toThrow(/no blocking findings/);
    const accepted = await accept('user');
    expect(accepted.revision).toMatchObject({
      authorKind: 'user',
      generationInputs: { jobId: job.id, acceptedGroupIds: ['g1'] },
    });
    const pages = accepted.revision.snapshot.pages;
    expect(pages.map((p) => p.id)).toEqual(['page_1', storyPage]);
    expect(pages[0]).toEqual(d.document.pages[0]);
    expect(pages[1]!.elements.find((e) => e.id === headline.id)).toMatchObject({
      text: 'Swipe up for October',
    });
  });

  it('variations: the first fills this document, each further one a copy of it', async () => {
    const d = await starterDocument();
    const headline = el(d.document, 'Headline');
    const job = await start(d.documentId, d.revisionId, {
      kind: 'generate',
      brief: { keyMessage: 'Two takes', variations: 2 },
    });
    const { runtime } = runtimeWith([
      fillCall(
        {
          summary: 'One',
          edits: [{ label: 'H', pageId: 'page_1', elementId: headline.id, text: 'Take one' }],
        },
        {
          summary: 'Two',
          edits: [{ label: 'H', pageId: 'page_1', elementId: headline.id, text: 'Take two' }],
        },
      ),
    ]);
    expect(await drive(job, runtime)).toBe('completed');
    const done = await getJob(job.id);
    expect(done.resultDocumentIds).toHaveLength(2);
    expect(done.resultDocumentIds[0]).toBe(d.documentId);
    const copy = await inTenant(tenantA, () =>
      creativeService.documents.get(A, { documentId: done.resultDocumentIds[1]! }),
    );
    expect(copy.title).toContain('variation 2');
    expect(copy.revision.snapshot.pages[0]!.elements.find((e) => e.id === headline.id)).toMatchObject({
      text: 'Take two',
    });
    expect(copy.revision.generationInputs).toMatchObject({ jobId: job.id, variation: 1 });
  });

  it('cancel stops the job before anything is saved and releases the reservation', async () => {
    const d = await starterDocument();
    const job = await start(d.documentId, d.revisionId, {
      kind: 'generate',
      brief: { keyMessage: 'Cancel me' },
    });
    const { runtime, adapter } = runtimeWith([fillCall({ summary: 's', edits: [] })]);
    const input: StudioGenerationInputV1 = {
      tenantId: tenantA,
      actor: { kind: 'user', id: USER },
      correlationId: 'c',
      jobId: job.id,
      attempt: 1,
    };
    await inTenant(tenantA, () => runtime.begin(input));
    await inTenant(tenantA, () => runtime.reserve(input));
    const fresh = await getJob(job.id);
    const cancelled = await run(tenantA, (tx) =>
      generationService.cancel(A, { jobId: job.id, expectedVersion: fresh.version }, tx),
    );
    expect(cancelled.state).toBe('cancelled');
    expect(await drive(job, runtime)).toBe('stopped');
    expect(adapter.requests).toHaveLength(0);
    expect((await head(d.documentId)).id).toBe(d.revisionId);
    const row = (
      await tdb.db.select().from(studioGenerationJobs).where(eq(studioGenerationJobs.id, job.id))
    )[0]!;
    const reservation = (
      await tdb.db.select().from(budgetReservations).where(eq(budgetReservations.runId, row.budgetRunId!))
    )[0]!;
    expect(reservation.state).toBe('released');
    const relay = await tdb.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventType, 'creative.generation_cancel_requested'));
    expect(relay.some((e) => e.payload['jobId'] === job.id)).toBe(true);
  });

  it('a provider failure fails the job; retry runs a new attempt that completes', async () => {
    const d = await starterDocument();
    const headline = el(d.document, 'Headline');
    const job = await start(d.documentId, d.revisionId, { kind: 'generate', brief: { keyMessage: 'Flaky' } });
    const broken = runtimeWith([{ kind: 'error', error: new Error('provider unavailable') }]);
    expect(await drive(job, broken.runtime)).toBe('failed');
    const failed = await getJob(job.id);
    expect(failed).toMatchObject({ state: 'failed', error: { code: 'model_failed' } });
    const retried = await run(tenantA, (tx) =>
      generationService.retry(A, { jobId: job.id, expectedVersion: failed.version }, tx),
    );
    expect(retried).toMatchObject({ state: 'queued', attempt: 2, error: null });
    const ok = runtimeWith([
      fillCall({
        summary: 's',
        edits: [{ label: 'H', pageId: 'page_1', elementId: headline.id, text: 'Second try' }],
      }),
    ]);
    // The old attempt's workflow is superseded: its steps stop.
    expect(await drive({ id: job.id, attempt: 1 }, ok.runtime)).toBe('stopped');
    expect(await drive(retried, ok.runtime)).toBe('completed');
    expect((await getJob(job.id)).state).toBe('completed');
  });

  it('an exhausted budget fails the job before any model call', async () => {
    const d = await starterDocument();
    const job = await start(d.documentId, d.revisionId, {
      kind: 'generate',
      brief: { keyMessage: 'Too dear' },
    });
    await inTenant(tenantA, () => budgets.setLimit(brandA, 'day', 1));
    try {
      const { runtime, adapter } = runtimeWith([fillCall({ summary: 's', edits: [] })]);
      expect(await drive(job, runtime)).toBe('failed');
      expect(adapter.requests).toHaveLength(0);
      expect(await getJob(job.id)).toMatchObject({ error: { code: 'budget_exhausted' } });
      // The preflight says so before a start.
      const pre = await inTenant(tenantA, () =>
        generationService.preflight(A, {
          documentId: d.documentId,
          baseRevisionId: d.revisionId,
          request: { kind: 'generate', brief: { keyMessage: 'x' } },
        }),
      );
      expect(pre.issues.map((i) => i.code)).toContain('budget_insufficient');
    } finally {
      await inTenant(tenantA, () => budgets.setLimit(brandA, 'day', 20_000_000));
    }
  });

  it('a document that moved on while the job ran fails it as stale; nothing is saved', async () => {
    const d = await starterDocument();
    const headline = el(d.document, 'Headline');
    const job = await start(d.documentId, d.revisionId, { kind: 'generate', brief: { keyMessage: 'Race' } });
    await run(tenantA, (tx) =>
      creativeService.operations.apply(
        A,
        {
          documentId: d.documentId,
          baseRevisionId: d.revisionId,
          operations: [{ op: 'setText', pageId: 'page_1', elementId: headline.id, text: 'Mine' }],
          summary: 'Edit',
          origin: 'user',
        },
        tx,
      ),
    );
    const { runtime } = runtimeWith([
      fillCall({
        summary: 's',
        edits: [{ label: 'H', pageId: 'page_1', elementId: headline.id, text: 'Theirs' }],
      }),
    ]);
    expect(await drive(job, runtime)).toBe('failed');
    expect(await getJob(job.id)).toMatchObject({ error: { code: 'stale_document' } });
    const revs = await tdb.db
      .select()
      .from(creativeRevisions)
      .where(and(eq(creativeRevisions.documentId, d.documentId)));
    expect(revs).toHaveLength(2);
  });

  it('variations placing an image in an image area, with a brand template layout, each start from the base revision at the job brand version', async () => {
    const d = await starterDocument();
    const headline = el(d.document, 'Headline');
    const area = el(d.document, 'Image area');
    // An approved brand template made of the same starter: its headline and body are slots.
    const t = await run(tenantA, (tx) =>
      creativeService.templates.create(A, { brandId: brandA, name: 'Photo layout' }, tx),
    );
    const tv = await run(tenantA, (tx) =>
      creativeService.templates.createVersion(
        A,
        {
          templateId: t.templateId,
          document: d.document,
          slots: [
            { key: 'headline', elementId: headline.id, kind: 'text' },
            { key: 'body', elementId: el(d.document, 'Body').id, kind: 'text' },
          ],
          formats: ['square_1080'],
        },
        tx,
      ),
    );
    await run(tenantA, (tx) =>
      creativeService.templates.approve(
        A,
        { templateId: t.templateId, templateVersionId: tv.templateVersionId, expectedVersion: 0 },
        tx,
      ),
    );
    const jobBrandVersion = (await head(d.documentId)).brandVersionId;
    const job = await start(d.documentId, d.revisionId, {
      kind: 'generate',
      brief: {
        keyMessage: 'Two photos',
        variations: 2,
        layout: { kind: 'template', templateVersionId: tv.templateVersionId },
      },
    });
    const fill = (n: number, asset: string): ModelFill => ({
      summary: `Take ${n}`,
      edits: [
        { label: 'Headline', pageId: 'page_1', elementId: headline.id, text: `Take ${n}` },
        { label: 'Photo', pageId: 'page_1', elementId: area.id, assetVersionId: asset },
      ],
    });
    const { runtime } = runtimeWith([fillCall(fill(1, 'av_photo'), fill(2, 'av_photo2'))]);
    // A newer brand version is published while the job runs: the copy stays at the job's version.
    await publishBrand(tenantA, brandA);
    expect(await drive(job, runtime)).toBe('completed');
    const done = await getJob(job.id);
    expect(done.resultDocumentIds).toHaveLength(2);
    expect(done.result?.refused).toEqual([]);
    for (const [i, documentId] of done.resultDocumentIds.entries()) {
      const got = await inTenant(tenantA, () => creativeService.documents.get(A, { documentId }));
      const page = got.revision.snapshot.pages[0]!;
      expect(got.revision.number).toBe(2);
      expect(got.revision.brandVersionId).toBe(jobBrandVersion);
      expect(got.revision.generationInputs).toMatchObject({
        brandVersionId: jobBrandVersion,
        variation: i,
        templateVersionId: tv.templateVersionId,
      });
      expect(got.revision.snapshot.templateVersionId).toBe(tv.templateVersionId);
      expect(page.elements.find((e) => e.id === headline.id)).toMatchObject({ text: `Take ${i + 1}` });
      const images = page.elements.filter((e) => e.type === 'image');
      expect(images).toEqual([
        expect.objectContaining({ assetVersionId: i === 0 ? 'av_photo' : 'av_photo2' }),
      ]);
    }
    // Each revision records its share of the one model call.
    const shares = await Promise.all(
      done.resultRevisionIds.map(
        async (revisionId, i) =>
          (
            await inTenant(tenantA, () =>
              creativeService.revisions.get(A, { documentId: done.resultDocumentIds[i]!, revisionId }),
            )
          ).generationInputs?.costMicros,
      ),
    );
    expect(shares[0]).toBe(Math.ceil(done.costSpentMicros / 2));
  });

  it('a late step of a cancelled attempt never settles the reservation of the attempt that replaced it', async () => {
    const d = await starterDocument();
    const headline = el(d.document, 'Headline');
    const job = await start(d.documentId, d.revisionId, {
      kind: 'generate',
      brief: { keyMessage: 'Quick retry' },
    });
    const { runtime } = runtimeWith([
      fillCall({
        summary: 's',
        edits: [{ label: 'H', pageId: 'page_1', elementId: headline.id, text: 'Second' }],
      }),
    ]);
    const input = (attempt: number): StudioGenerationInputV1 => ({
      tenantId: tenantA,
      actor: { kind: 'user', id: USER },
      correlationId: 'c',
      jobId: job.id,
      attempt,
    });
    await inTenant(tenantA, () => runtime.begin(input(1)));
    await inTenant(tenantA, () => runtime.reserve(input(1)));
    const cancelled = await run(tenantA, (tx) =>
      generationService.cancel(A, { jobId: job.id, expectedVersion: 0 }, tx),
    );
    const retried = await run(tenantA, (tx) =>
      generationService.retry(A, { jobId: job.id, expectedVersion: cancelled.version }, tx),
    );
    await inTenant(tenantA, () => runtime.begin(input(2)));
    await inTenant(tenantA, () => runtime.reserve(input(2)));
    // The first attempt's workflow wakes up late: its settle and any spend touch only its own reservation.
    await inTenant(tenantA, () => runtime.settle(input(1)));
    const row = (
      await tdb.db.select().from(studioGenerationJobs).where(eq(studioGenerationJobs.id, job.id))
    )[0]!;
    const reservations = await tdb.db
      .select()
      .from(budgetReservations)
      .where(eq(budgetReservations.brandId, brandA));
    const second = reservations.find((r) => r.runId === row.budgetRunId)!;
    expect(row.attempt).toBe(2);
    expect(second.state).toBe('held');
    const first = reservations.find(
      (r) => r.runId !== row.budgetRunId && r.runId.startsWith(row.budgetRunId!.slice(0, -1)),
    );
    expect(first?.state).toBe('released');
    expect(await drive(retried, runtime)).toBe('completed');
  });

  it('a proposal never holds more operations than a batch can: further edits are refused, the stored result reads back', async () => {
    const d = await starterDocument();
    const headline = el(d.document, 'Headline');
    const edited = await run(tenantA, (tx) =>
      creativeService.operations.apply(
        A,
        {
          documentId: d.documentId,
          baseRevisionId: d.revisionId,
          operations: [{ op: 'setText', pageId: 'page_1', elementId: headline.id, text: 'Mine' }],
          summary: 'Edit',
          origin: 'user',
        },
        tx,
      ),
    );
    const job = await start(d.documentId, edited.revision.id, {
      kind: 'generate',
      brief: { keyMessage: 'Many edits' },
    });
    const edits = Array.from({ length: 60 }, (_, i) => ({
      label: `Step ${i}`,
      pageId: 'page_1',
      elementId: headline.id,
      sizePx: 64 + (i % 5),
      weight: 700,
      box: { x: 97 + (i % 3), y: 651, width: 880 - (i % 4), height: 169 },
    }));
    const { runtime } = runtimeWith([fillCall({ summary: 'Many', edits })]);
    expect(await drive(job, runtime)).toBe('completed');
    const done = await getJob(job.id);
    expect(done.result!.proposal!.operations.length).toBeLessThanOrEqual(100);
    expect(done.result!.refused.some((r) => r.reason === 'too_many_operations')).toBe(true);
    const active = await inTenant(tenantA, () => generationService.active(A, { documentId: d.documentId }));
    expect(active.last?.id).toBe(job.id);
  });

  it('a fact that stopped being in force between the proposal and the accept refuses the accept as the agent', async () => {
    const d = await starterDocument();
    const headline = el(d.document, 'Headline');
    const expiring = newId('approvedFact');
    await tdb.db.insert(approvedFacts).values({
      id: expiring,
      tenantId: tenantA,
      brandId: brandA,
      kind: 'offer',
      statement: 'Free shipping this week',
      evidence: [],
      state: 'approved',
      proposedByKind: 'user',
      proposedById: USER,
    });
    const job = await start(d.documentId, d.revisionId, {
      kind: 'refine',
      refine: {
        instruction: 'Say free shipping',
        scope: { pageId: 'page_1', elementIds: [headline.id] },
        factIds: [expiring],
      },
    });
    const { runtime } = runtimeWith([
      fillCall({
        summary: 's',
        edits: [
          {
            label: 'Claim',
            pageId: 'page_1',
            elementId: headline.id,
            text: 'Free shipping',
            factIds: [expiring],
          },
        ],
      }),
    ]);
    expect(await drive(job, runtime)).toBe('completed');
    const proposal = (await getJob(job.id)).result!.proposal!;
    expect(proposal.findings.filter((f) => f.severity === 'blocking')).toEqual([]);
    await tdb.db
      .update(approvedFacts)
      .set({ validUntil: new Date(Date.now() - 1000) })
      .where(eq(approvedFacts.id, expiring));
    await expect(
      run(tenantA, (tx) =>
        creativeService.operations.apply(
          A,
          {
            documentId: d.documentId,
            baseRevisionId: d.revisionId,
            operations: proposal.operations,
            summary: proposal.summary,
            origin: 'agent',
            generation: { jobId: job.id, groupIds: ['g1'] },
          },
          tx,
        ),
      ),
    ).rejects.toThrow(/no blocking findings/);
  });

  it('a cancel while the model call runs: the call cost is ledgered against the closed reservation and recorded, nothing is saved', async () => {
    const d = await starterDocument();
    const headline = el(d.document, 'Headline');
    const job = await start(d.documentId, d.revisionId, {
      kind: 'generate',
      brief: { keyMessage: 'Cancel mid-call' },
    });
    const inner = new FakeModelAdapter([
      fillCall({
        summary: 's',
        edits: [{ label: 'H', pageId: 'page_1', elementId: headline.id, text: 'Late' }],
      }),
    ]);
    const adapter = {
      provider: 'fake',
      async complete(req: Parameters<typeof inner.complete>[0]) {
        const current = await getJob(job.id);
        await run(tenantA, (tx) =>
          generationService.cancel(A, { jobId: job.id, expectedVersion: current.version }, tx),
        );
        return inner.complete(req);
      },
    };
    const runtime = createStudioGenerationRuntime({ adapter, modelConfig });
    expect(await drive(job, runtime)).toBe('stopped');
    const row = (
      await tdb.db.select().from(studioGenerationJobs).where(eq(studioGenerationJobs.id, job.id))
    )[0]!;
    expect(row.state).toBe('cancelled');
    expect(row.costSpentMicros).toBeGreaterThan(0);
    const reservation = (
      await tdb.db.select().from(budgetReservations).where(eq(budgetReservations.runId, row.budgetRunId!))
    )[0]!;
    // The call had already cost what it cost: it stays against the caps (released rows count their consumption).
    expect(reservation).toMatchObject({ state: 'released', consumedMicros: row.costSpentMicros });
    const charged = await tdb.db
      .select()
      .from(usageLedger)
      .where(eq(usageLedger.reservationId, reservation.id));
    expect(charged.map((c) => c.costMicros)).toEqual([row.costSpentMicros]);
    expect((await head(d.documentId)).id).toBe(d.revisionId);
  });

  it('spend of a cancelled attempt still counts toward the brand-day cap after a retry', async () => {
    const d = await starterDocument();
    const headline = el(d.document, 'Headline');
    const before = await inTenant(tenantA, () => budgets.summary(brandA));
    const job = await start(d.documentId, d.revisionId, {
      kind: 'generate',
      brief: { keyMessage: 'Spend then cancel' },
    });
    const { runtime } = runtimeWith([
      fillCall({
        summary: 's',
        edits: [{ label: 'H', pageId: 'page_1', elementId: headline.id, text: 'Spent' }],
      }),
    ]);
    const input: StudioGenerationInputV1 = {
      tenantId: tenantA,
      actor: { kind: 'user', id: USER },
      correlationId: 'c',
      jobId: job.id,
      attempt: 1,
    };
    // Attempt 1 reserves and its model call is charged while the reservation is held; then the person cancels
    // before the save and retries.
    await inTenant(tenantA, () => runtime.begin(input));
    await inTenant(tenantA, () => runtime.reserve(input));
    expect((await inTenant(tenantA, () => runtime.callModel(input, A))).proceed).toBe(true);
    const spent = (await getJob(job.id)).costSpentMicros;
    expect(spent).toBeGreaterThan(0);
    const current = await getJob(job.id);
    const cancelled = await run(tenantA, (tx) =>
      generationService.cancel(A, { jobId: job.id, expectedVersion: current.version }, tx),
    );
    await run(tenantA, (tx) =>
      generationService.retry(A, { jobId: job.id, expectedVersion: cancelled.version }, tx),
    );
    const after = await inTenant(tenantA, () => budgets.summary(brandA));
    expect(after.day.committedMicros - before.day.committedMicros).toBe(spent);
    // The cap holds with it: one micro over what remains is refused, exactly what remains fits.
    const over = newId('agentRun');
    const fits = newId('agentRun');
    const deadline = new Date(Date.now() + 60_000);
    await expect(
      inTenant(tenantA, () => budgets.reserveSpend(brandA, over, after.day.remainingMicros + 1, deadline)),
    ).rejects.toBeInstanceOf(BudgetExhaustedError);
    await inTenant(tenantA, async () => {
      await budgets.reserveSpend(brandA, fits, after.day.remainingMicros, deadline);
      await budgets.release(fits);
    });
  });
});
