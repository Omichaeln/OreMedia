import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createBrandAssistActivities,
  createBrandSourceCaptureActivities,
  createBrandSourceExtractActivities,
} from '@oremedia/activities';
import {
  FakeModelAdapter,
  brandAssistModelGate,
  configureRoutingPolicy,
  createBrandAssistModel,
  resetRoutingPolicies,
  type ModelConfig,
} from '@oremedia/ai';
import { BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import {
  SOURCE_DOCUMENT_MAX_BYTES,
  type AssistSection,
  type BrandAssistActivitiesV1,
} from '@oremedia/contracts/brand-assist';
import type { ModelRequest } from '@oremedia/contracts/agents';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction, type Tx } from '@oremedia/db';
import { brandAssistJobs, brandSources, brandSuggestions, brandVersions } from '@oremedia/db/schema/brand';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import {
  brandAssistService,
  brandService,
  configureSourceCapture,
  createBrandAssistRuntime,
  registerAssistModelGate,
  registerSourceUploadStore,
} from '@oremedia/module-brand';
import { docx, pdfWithText } from '@oremedia/module-brand/testing';
import { runBrandAssist } from '@oremedia/workflows/brand-assist.workflow.v1';
import { seedTwoTenants, type SeededTenant } from '../../../tooling/test-fixtures/src/seed';

/**
 * BSC-4 end to end on MySQL 8: the deployed orchestration (runBrandAssist) over the real activities of the three
 * workers (tenant context and grants re-loaded per activity), a local website, documents in an in-memory object
 * store and the scripted model through the production model wrapper (routing asserted, usage priced). Website only,
 * documents only and both together; a provider failure that succeeds on retry; a routing refusal that stops the job
 * before any call; and a re-import after a person accepted, edited, rejected and applied suggestions.
 */
const SITE: Record<string, string> = {
  '/robots.txt': 'User-agent: *\nDisallow:\n',
  '/': '<html><head><title>Ore Roasters</title></head><body><nav><a href="/about">About</a></nav><main><h1>Ore Roasters</h1><p>We roast single-origin coffee in Leeds.</p></main></body></html>',
  '/about':
    '<html><head><title>About</title></head><body><main><p>Founded in 2014 by two baristas.</p></main></body></html>',
};

const cfg: ModelConfig = {
  provider: 'fake',
  model: 'scripted',
  maxOutputTokens: 4000,
  timeoutMs: 10_000,
  inputMicrosPerMillionTokens: 1_000_000,
  outputMicrosPerMillionTokens: 2_000_000,
};

/** The section the prompt is for, read back from the user turn the wrapper builds. */
const sectionOf = (req: ModelRequest): AssistSection => {
  const text =
    req.messages[0]!.content[0]!.type === 'text'
      ? (req.messages[0]!.content[0] as { text: string }).text
      : '';
  const label = /^Section: (.+)\.$/m.exec(text)?.[1] ?? '';
  return (
    (
      { 'Voice & personality': 'voice', Facts: 'facts', Vocabulary: 'vocabulary' } as Record<
        string,
        AssistSection
      >
    )[label] ?? 'voice'
  );
};
/** The ids of the sources shown to the model (its evidence blocks). */
const sourceIdsOf = (req: ModelRequest): string[] => [
  ...new Set([...req.system.matchAll(/id="(bsrc_[0-9A-Z]+)"/g)].map((m) => m[1]!)),
];
const meta = (sourceId: string | undefined, excerpt: string) => ({
  rationale: 'From the sources.',
  basis: sourceId ? 'stated' : 'suggested',
  confidence: 'high',
  evidence: sourceId ? [{ sourceId, excerpt }] : [],
});

/** What the scripted model answers per section, citing the first source it was shown. */
function answer(req: ModelRequest): string {
  const section = sectionOf(req);
  const ids = sourceIdsOf(req);
  const quote = (needle: string) => (req.system.includes(needle) ? ids.find(Boolean) : undefined);
  if (section === 'facts')
    return JSON.stringify({
      facts: [
        {
          statement: 'Founded in 2014.',
          category: 'company',
          ...meta(quote('Founded in 2014 by two baristas.'), 'Founded in 2014 by two baristas.'),
        },
      ],
      questions: [],
    });
  if (section === 'vocabulary')
    return JSON.stringify({
      terms: [{ value: { term: 'blend', usage: 'avoid', alternatives: ['roast'] }, ...meta(undefined, '') }],
      remove: [],
      questions: [],
    });
  return JSON.stringify({
    summary: {
      value: 'We roast single-origin coffee and say so plainly.',
      ...meta(quote('We roast single-origin coffee'), 'We roast single-origin coffee'),
    },
    personality: [
      { value: { trait: 'Plain-spoken' }, ...meta(quote('We write plainly.'), 'We write plainly.') },
    ],
    principles: [],
    styleRules: [],
    claimRules: [],
    remove: [],
    questions: [],
  });
}

describe('brand assist jobs end to end (BSC-4)', () => {
  let tdb: TestDatabase;
  let tenant: SeededTenant;
  let server: Server;
  let base = '';
  let brandId = '';
  let owner: ResolvedActor;
  const objects = new Map<string, Buffer>();
  let firstJobId = '';
  const ctx = () => ({
    tenantId: tenant.tenantId,
    actor: { kind: 'user' as const, id: tenant.ownerUserId },
    brandIds: 'all' as const,
    correlationId: 'corr_assist_e2e',
  });
  const run = <T>(fn: (tx: Tx) => Promise<T>) => runInTenant(ctx(), () => withTransaction(fn));

  /** The three workers' activities as registered, with Temporal's retry of the model call emulated (2 attempts). */
  function workers(adapter: FakeModelAdapter) {
    const control = createBrandAssistActivities(
      createBrandAssistRuntime({ model: createBrandAssistModel({ adapter, modelConfig: cfg }) }),
    );
    const acts: BrandAssistActivitiesV1 = {
      ...control,
      proposeBrandAssistSection: async (input) => {
        try {
          return await control.proposeBrandAssistSection(input);
        } catch {
          return control.proposeBrandAssistSection(input);
        }
      },
    };
    const capture = createBrandSourceCaptureActivities(createBrandAssistRuntime());
    const extract = createBrandSourceExtractActivities(
      createBrandAssistRuntime({
        objects: {
          head: async (k) => {
            const o = objects.get(k);
            return o ? { bytes: o.length } : null;
          },
          get: async (k, range) => objects.get(k)?.subarray(range.start, range.end + 1) ?? null,
          delete: async (k) => void objects.delete(k),
        },
      }),
    );
    return { acts, capture, extract };
  }
  async function runJob(
    sections: AssistSection[],
    sourceIds: string[],
    adapter: FakeModelAdapter,
    instruction?: string,
  ) {
    const started = await run((tx) =>
      brandAssistService.assist.start(
        owner,
        { brandId, kind: 'setup', sections, sourceIds, ...(instruction ? { instruction } : {}) },
        tx,
      ),
    );
    const w = workers(adapter);
    const input = {
      tenantId: tenant.tenantId,
      actor: { kind: 'user' as const, id: tenant.ownerUserId },
      correlationId: `corr_${started.jobId}`,
      brandId,
      jobId: started.jobId,
    };
    const result = await runBrandAssist(w.acts, w.capture, w.extract, input, {
      cancelled: () => false,
      nonCancellable: (fn) => fn(),
    });
    const job = (
      await tdb.db.select().from(brandAssistJobs).where(eq(brandAssistJobs.id, started.jobId))
    )[0]!;
    const suggestions = await tdb.db
      .select()
      .from(brandSuggestions)
      .where(eq(brandSuggestions.jobId, started.jobId));
    return { result, job, suggestions };
  }
  const addDocument = async (
    fileName: string,
    mime: 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: Buffer,
  ) => {
    const added = await run((tx) =>
      brandAssistService.sources.add(
        owner,
        { kind: 'document', brandId, fileName, mime, byteSize: bytes.length },
        tx,
      ),
    );
    const key = (await tdb.db.select().from(brandSources).where(eq(brandSources.id, added.sourceId)))[0]!
      .storageKey!;
    objects.set(key, bytes); // the browser's PUT to the signed URL
    return added.sourceId;
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ({ tenantA: tenant } = await seedTwoTenants(tdb.db));
    brandId = tenant.brandIds[0];
    owner = {
      kind: 'user',
      id: tenant.ownerUserId,
      tenantId: tenant.tenantId,
      membershipId: tenant.ownerMembershipId,
      membershipStatus: 'active',
      role: 'owner',
      allBrands: true,
      brandGrants: [],
      mfaEnrolled: false,
    };
    server = createServer((req, res) => {
      const body = SITE[(req.url ?? '/').split('?')[0]!];
      res
        .writeHead(body ? 200 : 404, {
          'content-type': req.url === '/robots.txt' ? 'text/plain' : 'text/html',
        })
        .end(body ?? '');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    configureSourceCapture({ insecureAllowLoopback: true });
    configureRoutingPolicy({
      schemaVersion: 1,
      defaultModel: 'scripted',
      permittedVendors: ['fake'],
      permittedRegions: [],
      deniedModels: [],
    });
    registerAssistModelGate(brandAssistModelGate(cfg));
    registerSourceUploadStore({
      signUpload: async (key) => ({
        url: `https://store.example.test/${key}`,
        expiresAt: new Date(Date.now() + 60_000),
      }),
      delete: async (key) => void objects.delete(key),
    });
  });
  afterAll(async () => {
    configureSourceCapture({});
    resetRoutingPolicies();
    registerAssistModelGate(null);
    registerSourceUploadStore(null);
    await new Promise<void>((r) => server?.close(() => r()));
    await tdb?.drop();
  });

  it('website only: the site is read on the capture worker and each section cites it', async () => {
    const site = await run((tx) =>
      brandAssistService.sources.add(owner, { kind: 'url', brandId, url: `${base}/` }, tx),
    );
    const adapter = new FakeModelAdapter((req) => ({ kind: 'done', text: answer(req) }));
    const { result, job, suggestions } = await runJob(['voice', 'facts'], [site.sourceId], adapter);
    firstJobId = job.id;
    expect(result).toEqual({ state: 'ready', suggestions: 3 });
    expect(job.progress.stages).toMatchObject({
      capturing: { status: 'done', done: 1, total: 1 },
      extracting: { status: 'skipped' },
    });
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[0]!.system).toContain('trust="untrusted"');
    const fact = suggestions.find((s) => s.section === 'facts')!;
    expect(fact).toMatchObject({ path: 'facts#Founded in 2014.', provenance: { origin: 'imported' } });
    expect(fact.evidence).toEqual([
      { sourceId: site.sourceId, excerpt: 'Founded in 2014 by two baristas.', verified: true },
    ]);
  });

  it('documents only: PDF and Word text is read on the media worker and the uploads are deleted once read', async () => {
    const pdf = await addDocument(
      'guide.pdf',
      'application/pdf',
      pdfWithText(['We write plainly.', 'We never shout.']),
    );
    const word = await addDocument(
      'voice.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      docx([{ text: 'Voice', style: 'Heading1' }, 'We roast single-origin coffee and we write plainly.']),
    );
    const adapter = new FakeModelAdapter((req) => ({ kind: 'done', text: answer(req) }));
    const { result, job, suggestions } = await runJob(['voice'], [pdf, word], adapter);
    expect(result.state).toBe('ready');
    expect(job.progress.stages).toMatchObject({
      capturing: { status: 'skipped' },
      extracting: { status: 'done', done: 2, total: 2 },
    });
    const rows = await tdb.db.select().from(brandSources).where(eq(brandSources.brandId, brandId));
    expect(rows.find((r) => r.id === word)).toMatchObject({
      status: 'captured',
      storageKey: null,
      text: '# Voice\n\nWe roast single-origin coffee and we write plainly.',
    });
    expect(rows.find((r) => r.id === pdf)).toMatchObject({ status: 'captured', detail: '1 page' });
    expect(objects.size).toBe(0);
    // The model read both documents as evidence; what it suggested again is already pending, so nothing repeats.
    expect(adapter.requests[0]!.system).toContain(`id="${pdf}"`);
    expect(adapter.requests[0]!.system).toContain('We never shout.');
    expect(adapter.requests[0]!.system).toContain('# Voice');
    expect(suggestions).toEqual([]);
  });

  it('an upload larger than its declared size is refused from its size alone, never downloaded, and deleted', async () => {
    const big = await addDocument('big.pdf', 'application/pdf', pdfWithText(['small']));
    const key = (await tdb.db.select().from(brandSources).where(eq(brandSources.id, big)))[0]!.storageKey!;
    objects.set(key, Buffer.alloc(SOURCE_DOCUMENT_MAX_BYTES + 1, 0x20)); // the PUT sent more than it declared
    const adapter = new FakeModelAdapter((req) => ({ kind: 'done', text: answer(req) }));
    const { job } = await runJob(['voice'], [big], adapter);
    expect(job.state).toBe('failed');
    const row = (await tdb.db.select().from(brandSources).where(eq(brandSources.id, big)))[0]!;
    expect(row).toMatchObject({ status: 'unsupported', reason: 'too_large', storageKey: null, text: null });
    expect(objects.has(key)).toBe(false);
    expect(adapter.requests).toHaveLength(0);
  });

  it('website and documents together, with a provider failure that succeeds on retry', async () => {
    const site = await run((tx) =>
      brandAssistService.sources.add(owner, { kind: 'url', brandId, url: `${base}/about` }, tx),
    );
    const doc = await addDocument('notes.pdf', 'application/pdf', pdfWithText(['Avoid the word blend.']));
    let calls = 0;
    const adapter = new FakeModelAdapter((req) =>
      ++calls === 1
        ? { kind: 'error', error: new Error('provider 503') }
        : { kind: 'done', text: answer(req) },
    );
    const { result, job } = await runJob(['vocabulary'], [site.sourceId, doc], adapter);
    expect(result).toEqual({ state: 'ready', suggestions: 1 });
    expect(adapter.requests).toHaveLength(2);
    expect(job.progress.stages).toMatchObject({ capturing: { done: 1 }, extracting: { done: 1 } });
  });

  it('a routing policy that does not permit the model stops the job before any model call', async () => {
    const notes = await run((tx) =>
      brandAssistService.sources.add(
        owner,
        { kind: 'text', brandId, title: 'Routing', text: 'Routing test notes.' },
        tx,
      ),
    );
    configureRoutingPolicy({
      schemaVersion: 1,
      defaultModel: 'scripted',
      permittedVendors: ['anthropic'],
      permittedRegions: [],
      deniedModels: [],
    });
    try {
      await expect(
        run((tx) =>
          brandAssistService.assist.start(
            owner,
            { brandId, kind: 'setup', sections: ['voice'], sourceIds: [notes.sourceId] },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ reason: 'model_routing_denied' });
    } finally {
      configureRoutingPolicy({
        schemaVersion: 1,
        defaultModel: 'scripted',
        permittedVendors: ['fake'],
        permittedRegions: [],
        deniedModels: [],
      });
    }
  });

  it('a re-import keeps what people decided: applied and edited items are not re-suggested, rejected ones neither', async () => {
    const site = await run((tx) =>
      brandAssistService.sources.add(owner, { kind: 'url', brandId, url: `${base}/` }, tx),
    );
    const adapter = () => new FakeModelAdapter((req) => ({ kind: 'done', text: answer(req) }));
    // The first import's suggestions are pending from the first test; decide them now.
    const first = await tdb.db.select().from(brandSuggestions).where(eq(brandSuggestions.jobId, firstJobId));
    const summary = first.find((s) => s.path === 'voice.summary')!;
    const trait = first.find((s) => s.path === 'voice.personality#Plain-spoken')!;
    const fact = first.find((s) => s.section === 'facts')!;
    await run((tx) =>
      brandAssistService.suggestions.reject(owner, { brandId, suggestionIds: [summary.id] }, tx),
    );
    const edited = await run((tx) =>
      brandAssistService.suggestions.edit(
        owner,
        { brandId, suggestionId: trait.id, value: { trait: 'Plain-spoken', note: 'Our words.' } },
        tx,
      ),
    );
    await run((tx) =>
      brandAssistService.suggestions.accept(owner, { brandId, suggestionIds: [fact.id] }, tx),
    );
    // The person applies the proposal through the normal save.
    const proposal = (
      await tdb.db.select().from(brandVersions).where(eq(brandVersions.id, edited.proposalVersionId!))
    )[0]!;
    const brand = await runInTenant(ctx(), () => brandService.get(owner, brandId));
    await run((tx) =>
      brandService.system.save(
        owner,
        {
          brandId,
          basedOnVersionId: brand.publishedVersionId,
          document: BrandSystemDocumentV1.parse(proposal.document),
          proposal: { versionId: proposal.id, expectedVersion: proposal.version },
        },
        tx,
      ),
    );
    const again = await runJob(['voice', 'facts'], [site.sourceId], adapter(), 're-import');
    expect(again.result.state).toBe('ready');
    // Rejected (the summary), applied as the person wrote it (the trait keeps their note: the model's version adds
    // nothing to it) and the fact already proposed: none of them comes back.
    expect(again.suggestions.map((x) => x.path)).toEqual([]);
    const applied = await runInTenant(ctx(), () => brandService.get(owner, brandId));
    const doc = BrandSystemDocumentV1.parse(
      (await tdb.db.select().from(brandVersions).where(eq(brandVersions.id, applied.publishedVersionId!)))[0]!
        .document,
    );
    expect(doc.voice.personality).toEqual([
      { trait: 'Plain-spoken', note: 'Our words.', provenance: { origin: 'user', suggestionId: trait.id } },
    ]);
  });
});
