import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { BrandSystemDocumentV1, emptyBrandSystemDocument } from '@oremedia/contracts/brand';
import type {
  AssistSection,
  BrandAssistModelRequestV1,
  BrandAssistModelV1,
} from '@oremedia/contracts/brand-assist';
import {
  BudgetExhaustedError,
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import {
  approvedFacts,
  brandAssistJobs,
  brandSources,
  brandSuggestions,
  brandVersions,
  brands,
} from '@oremedia/db/schema/brand';
import { usageLedger } from '@oremedia/db/schema/billing';
import { outboxEvents } from '@oremedia/db/schema/operations';
import { applyChange, valueAt } from '@oremedia/domain/brand-suggestions';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import { budgets } from '@oremedia/module-billing';
import {
  brandAssistService,
  configureSourceCapture,
  registerAssistModelGate,
  registerSourceAssetResolver,
  registerSourceUploadStore,
} from './assist';
import { createBrandAssistRuntime } from './assist-runtime';
import { htmlToText } from './capture/html-text';
import { ProcessingLimitError } from './capture/isolate';
import { brandService, registerChannelKeySource, resetChannelKeySource } from './service';

/**
 * BSC-4 / BSC-5 against MySQL 8 and a local website: sources (dedupe, refusals, uploads, assets), website capture
 * (robots, a redirect to a private address, an oversized page, the crawl and its pages, duplicate content), the assist
 * runtime with a scripted model (evidence verified against the sources, a fact without a passage stays a suggestion,
 * a person's item is only ever suggested against, preserved items and unknown channels are left alone), decisions
 * (accept into a proposal, edit, reject remembered by fingerprint, accept all, undo), the gates (budget, roles,
 * agents), cancel and partial failure, history (list, compare, restore through a save) and tenant isolation.
 */
const USER = newId('user');
const CREATOR = newId('user');
const ctx = (tenantId: string, userId = USER): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: userId },
  brandIds: 'all',
  correlationId: 'corr_assist',
});
const person = (
  tenantId: string,
  role: 'brand_manager' | 'creator' = 'brand_manager',
  id = USER,
): ResolvedActor => ({
  kind: 'user',
  id,
  tenantId,
  membershipId: `mem_${role}`,
  membershipStatus: 'active',
  role,
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});
const agent = (tenantId: string): ResolvedActor => ({
  kind: 'service_principal',
  id: 'sp_assist_test',
  tenantId,
  status: 'active',
  maxAutonomy: 'create',
  requestAutonomy: 'create',
  grants: [
    { action: 'brand.read', brandIds: 'all' },
    { action: 'brand.edit_standards', brandIds: 'all' },
  ],
});

const PAGE = (title: string, body: string, extra = '') =>
  `<!doctype html><html lang="en"><head><title>${title}</title>${extra}<script>var x = "ignore me";</script><style>p{}</style></head>` +
  `<body><header><nav><a href="/about">About</a><a href="/products">Products</a><a href="/login">Log in</a></nav></header>` +
  `<main>${body}</main><footer>Cookie settings · Footer links</footer></body></html>`;

function site(): Promise<{ server: Server; base: string }> {
  const routes: Record<string, () => { status: number; headers?: Record<string, string>; body?: string }> = {
    '/robots.txt': () => ({
      status: 200,
      body: 'User-agent: *\nDisallow: /private\nSitemap: /sitemap.xml\n',
    }),
    '/sitemap.xml': () => ({ status: 200, body: '<urlset><url><loc>/team</loc></url></urlset>' }),
    '/': () => ({
      status: 200,
      body: PAGE(
        'Ore Roasters',
        '<h1>Ore Roasters</h1><p>We roast single-origin coffee in small batches in Leeds.</p><ul><li>Traceable to the farm</li><li>Roasted on Tuesdays</li></ul>',
        '<link rel="canonical" href="/">',
      ),
    }),
    '/about': () => ({
      status: 200,
      body: PAGE(
        'About us',
        '<h2>Our story</h2><p>Founded in 2014 by two baristas. Every bag names its farm.</p>',
      ),
    }),
    '/products': () => ({
      status: 200,
      body: PAGE('Products', '<p>Three roasts: light, medium and dark.</p>'),
    }),
    '/private/plan': () => ({ status: 200, body: PAGE('Private', '<p>secret</p>') }),
    '/moved': () => ({ status: 302, headers: { location: 'https://10.1.2.3/' } }),
    '/big': () => ({ status: 200, body: PAGE('Big', `<p>${'x'.repeat(3 * 1024 * 1024)}</p>`) }),
    '/home': () => ({ status: 301, headers: { location: '/' } }),
    '/shop': () => ({ status: 200, body: PAGE('Shop', '<p>Bags of coffee, posted weekly.</p>') }),
  };
  const server = createServer((req, res) => {
    const route = routes[(req.url ?? '/').split('?')[0] as string];
    if (!route) {
      res.writeHead(404).end('not found');
      return;
    }
    const r = route();
    res.writeHead(r.status, { 'content-type': 'text/html; charset=utf-8', ...(r.headers ?? {}) });
    res.end(r.body ?? '');
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({ server, base: `http://127.0.0.1:${address.port}` });
    }),
  );
}

type Script = Partial<Record<AssistSection, (req: BrandAssistModelRequestV1) => unknown>>;
function scriptedModel(script: Script, seen: BrandAssistModelRequestV1[] = []): BrandAssistModelV1 {
  return {
    async propose(req) {
      seen.push(req);
      const step = script[req.section];
      if (!step) throw new Error(`model unavailable for ${req.section}`);
      return {
        raw: step(req),
        parseError: null,
        usage: { inputTokens: 1000, outputTokens: 200 },
        costMicros: 1500,
      };
    },
  };
}
const meta = (evidence: Array<{ sourceId: string; excerpt: string }>, basis = 'stated', extra = {}) => ({
  rationale: 'Supported by the sources.',
  basis,
  confidence: 'high',
  evidence,
  ...extra,
});

describe('brand sources, assist jobs, suggestions and history (BSC-4/5) against MySQL 8', () => {
  let tdb: TestDatabase;
  let web: { server: Server; base: string };
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandB = newId('brand');
  const A = person(tenantA);
  const uploads: string[] = [];
  let publishedId = '';

  const run = <T>(fn: (tx: Tx) => Promise<T>, tenantId = tenantA) =>
    runInTenant(ctx(tenantId), () => withTransaction(fn));
  const read = <T>(fn: () => Promise<T>, tenantId = tenantA) => runInTenant(ctx(tenantId), fn);
  const addUrl = (url: string, actor = A) =>
    run((tx) => brandAssistService.sources.add(actor, { kind: 'url', brandId: brandA, url }, tx));
  const addText = (title: string, text: string) =>
    run((tx) => brandAssistService.sources.add(A, { kind: 'text', brandId: brandA, title, text }, tx));
  const start = (
    sections: AssistSection[],
    sourceIds: string[],
    extra: Record<string, unknown> = {},
    actor = A,
  ) =>
    run((tx) =>
      brandAssistService.assist.start(
        actor,
        { brandId: brandA, kind: 'setup', sections, sourceIds, ...extra },
        tx,
      ),
    );
  const job = async (jobId: string) =>
    (await tdb.db.select().from(brandAssistJobs).where(eq(brandAssistJobs.id, jobId)))[0]!;
  const source = async (id: string) =>
    (await tdb.db.select().from(brandSources).where(eq(brandSources.id, id)))[0]!;
  const suggestions = async (jobId: string) =>
    tdb.db.select().from(brandSuggestions).where(eq(brandSuggestions.jobId, jobId));
  const input = (jobId: string) => ({
    tenantId: tenantA,
    actor: { kind: 'user' as const, id: USER },
    correlationId: 'c',
    brandId: brandA,
    jobId,
  });

  /** The workflow's order of steps, run directly against the runtime (the orchestration itself is tested in workers). */
  async function drive(jobId: string, model: BrandAssistModelV1) {
    const rt = createBrandAssistRuntime({ model });
    const inp = input(jobId);
    return read(async () => {
      const plan = await rt.beginBrandAssist(inp);
      for (const sourceId of plan.urlSourceIds) await rt.captureBrandSourceUrl({ ...inp, sourceId });
      const prepared = await rt.prepareBrandAssistProposals(inp, A);
      if (prepared.outcome === 'run')
        for (const section of prepared.sections)
          try {
            await rt.proposeBrandAssistSection({ ...inp, section });
          } catch (err) {
            await rt.recordBrandAssistSectionFailure({ ...inp, section, reason: (err as Error).name });
          }
      return rt.finishBrandAssist({ ...inp, cancelled: false, failure: prepared.reason });
    });
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    web = await site();
    configureSourceCapture({ insecureAllowLoopback: true });
    registerChannelKeySource(() => ['linkedin_page', 'instagram_business']);
    registerAssistModelGate({
      describe: () => ({
        provider: 'fake',
        model: 'scripted',
        maxOutputTokens: 4000,
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 2_000_000,
      }),
      assertRouting: async () => {},
    });
    registerSourceUploadStore({
      signUpload: async (key) => {
        uploads.push(key);
        return {
          url: `https://store.example.test/${key}?signed`,
          expiresAt: new Date(Date.now() + 3_600_000),
        };
      },
      delete: async () => {},
    });
    registerSourceAssetResolver(async (brandId, assetVersionId) =>
      brandId === brandA && assetVersionId.startsWith('av_logo')
        ? {
            assetId: 'ast_logo',
            assetVersionId,
            name: 'Ore wordmark',
            kind: 'logo',
            state: assetVersionId.endsWith('pending') ? 'pending_review' : 'approved',
            mime: 'image/svg+xml',
            bytes: 2048,
            altText: 'The word Ore in a rounded serif',
            width: 400,
            height: 120,
            storageKey: `assets/${tenantA}/${brandA}/ast_logo/${assetVersionId}/original`,
          }
        : null,
    );
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'assist-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'assist-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(users).values([
      { id: USER, email: `assist-${USER}@example.test`, name: 'Rudo Moyo' },
      { id: CREATOR, email: `assist-${CREATOR}@example.test`, name: 'Tafadzwa' },
    ]);
    await tdb.db.insert(memberships).values([
      {
        id: newId('membership'),
        tenantId: tenantA,
        userId: USER,
        role: 'brand_manager',
        status: 'active',
        allBrands: true,
      },
      {
        id: newId('membership'),
        tenantId: tenantA,
        userId: CREATOR,
        role: 'creator',
        status: 'active',
        allBrands: true,
      },
    ]);
    await tdb.db.insert(brands).values([
      {
        id: brandA,
        tenantId: tenantA,
        name: 'Ore Roasters',
        timezone: 'UTC',
        defaultLocale: 'en-GB',
        status: 'active',
      },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    // The applied brand system: a principle a person wrote, and one the AI suggested earlier.
    const document = BrandSystemDocumentV1.parse({
      ...emptyBrandSystemDocument(),
      voice: {
        ...emptyBrandSystemDocument().voice,
        summary: 'Warm and plain.',
        principles: [
          { statement: 'Say what it does', rationale: 'People decide fast.', provenance: { origin: 'user' } },
          { statement: 'Be brief', rationale: 'Short reads.', provenance: { origin: 'suggested' } },
        ],
      },
    });
    const saved = await run((tx) =>
      brandService.system.save(A, { brandId: brandA, basedOnVersionId: null, document }, tx),
    );
    publishedId = saved.versionId as string;
  });
  afterAll(async () => {
    resetChannelKeySource();
    registerAssistModelGate(null);
    registerSourceUploadStore(null);
    registerSourceAssetResolver(null);
    configureSourceCapture({});
    await new Promise<void>((r) => web?.server.close(() => r()));
    await tdb?.drop();
  });

  describe('sources', () => {
    it('adds a website once (the same address again is the same source); refuses http and private addresses', async () => {
      const a = await addUrl(`${web.base}/`);
      expect(a).toMatchObject({ duplicate: false, version: 0, upload: null });
      expect(await addUrl(`${web.base}/#top`)).toMatchObject({ sourceId: a.sourceId, duplicate: true });
      await expect(addUrl('http://example.com/')).rejects.toMatchObject({
        details: [{ path: 'url', issue: 'not_https' }],
      });
      await expect(addUrl('https://10.0.0.8/')).rejects.toMatchObject({
        details: [{ path: 'url', issue: 'blocked_address' }],
      });
      // Only the standard https port (the loopback test server is the one exception).
      configureSourceCapture({});
      try {
        await expect(addUrl('https://example.com:8443/')).rejects.toMatchObject({
          details: [{ path: 'url', issue: 'unsupported_port' }],
        });
      } finally {
        configureSourceCapture({ insecureAllowLoopback: true });
      }
      expect(await source(a.sourceId)).toMatchObject({ status: 'pending', kind: 'url', createdById: USER });
    });

    it('captures pasted text at once and deduplicates it by content', async () => {
      const t = await addText('Tone notes', 'We write  plainly.\r\n\r\n\r\nWe never shout.');
      const row = await source(t.sourceId);
      expect(row).toMatchObject({
        status: 'captured',
        text: 'We write plainly.\n\nWe never shout.',
        charCount: 34,
      });
      expect(row.contentHash).toHaveLength(64);
      expect(await addText('Again', 'We write plainly.\n\nWe never shout.')).toMatchObject({
        sourceId: t.sourceId,
        duplicate: true,
      });
    });

    it('a document is uploaded to a tenant-prefixed key and stays pending until a job reads it', async () => {
      const d = await run((tx) =>
        brandAssistService.sources.add(
          A,
          {
            kind: 'document',
            brandId: brandA,
            fileName: 'guide.pdf',
            mime: 'application/pdf',
            byteSize: 1200,
          },
          tx,
        ),
      );
      expect(d.upload).toMatchObject({ contentType: 'application/pdf' });
      expect(uploads.at(-1)).toBe(`quarantine/${tenantA}/${d.sourceId}`);
      expect(await source(d.sourceId)).toMatchObject({
        status: 'pending',
        storageKey: `quarantine/${tenantA}/${d.sourceId}`,
      });
    });

    it('an approved logo is evidence by its description only; an unapproved or foreign asset is refused', async () => {
      const l = await run((tx) =>
        brandAssistService.sources.add(
          A,
          { kind: 'brand_asset', brandId: brandA, assetVersionId: 'av_logo1' },
          tx,
        ),
      );
      const row = await source(l.sourceId);
      expect(row).toMatchObject({ status: 'captured', storageKey: null, title: 'Ore wordmark' });
      expect(row.text).toContain('The word Ore in a rounded serif');
      await expect(
        run((tx) =>
          brandAssistService.sources.add(
            A,
            { kind: 'brand_asset', brandId: brandA, assetVersionId: 'av_logo_pending' },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      await expect(
        run((tx) =>
          brandAssistService.sources.add(
            A,
            { kind: 'brand_asset', brandId: brandA, assetVersionId: 'av_other' },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('a creator may not add sources; an agent may', async () => {
      await expect(
        addUrl(`${web.base}/products`, person(tenantA, 'creator', CREATOR)),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      expect(await addUrl(`${web.base}/products`, agent(tenantA))).toMatchObject({ duplicate: false });
    });
  });

  describe('website capture', () => {
    it('reads the site within its caps: start page, navigation pages first, no scripts, styles or boilerplate', async () => {
      const s = await addUrl(`${web.base}/`); // the source added above, still pending
      const j = await start(['voice'], [s.sourceId]);
      const rt = createBrandAssistRuntime();
      const plan = await read(() => rt.beginBrandAssist(input(j.jobId)));
      expect(plan.urlSourceIds).toEqual([s.sourceId]);
      expect(await read(() => rt.captureBrandSourceUrl({ ...input(j.jobId), sourceId: s.sourceId }))).toEqual(
        {
          sourceId: s.sourceId,
          status: 'captured',
          reason: null,
        },
      );
      const row = await source(s.sourceId);
      // Navigation first (the log-in link is never followed), then the sitemap's /team, which does not exist.
      expect(row.pages?.map((p) => new URL(p.url).pathname)).toEqual(['/', '/about', '/products']);
      expect(row.detail).toBe('1 page skipped (http_error)');
      expect(row.pages?.[0]).toMatchObject({ title: 'Ore Roasters', canonicalUrl: `${web.base}/` });
      expect(row.text).toContain('# Ore Roasters');
      expect(row.text).toContain('- Traceable to the farm');
      expect(row.text).toContain('Founded in 2014 by two baristas.');
      expect(row.text).not.toContain('ignore me');
      expect(row.text).not.toContain('Cookie settings');
      expect(row.text).not.toContain('Log in');
      expect((await job(j.jobId)).progress.stages.capturing).toMatchObject({ done: 1, total: 1 });
    });

    it('honours robots.txt, refuses a redirect to a private address and skips an oversized page', async () => {
      const cases: Array<[string, string, string]> = [
        ['/private/plan', 'inaccessible', 'robots_disallowed'],
        ['/moved', 'inaccessible', 'blocked_address'],
        ['/big', 'unsupported', 'too_large'],
      ];
      for (const [path, status, reason] of cases) {
        const s = await addUrl(`${web.base}${path}`);
        const j = await start(['voice'], [s.sourceId], { instruction: path });
        const rt = createBrandAssistRuntime();
        await read(() => rt.beginBrandAssist(input(j.jobId)));
        expect(
          await read(() => rt.captureBrandSourceUrl({ ...input(j.jobId), sourceId: s.sourceId })),
        ).toMatchObject({
          status,
          reason,
        });
        expect(await source(s.sourceId)).toMatchObject({ status, reason, text: null });
      }
    });

    it('a secondary page the parser fails on or stops is skipped; the source keeps what was read', async () => {
      const s = await addUrl(`${web.base}/shop`);
      const j = await start(['voice'], [s.sourceId], { instruction: 'shop' });
      const rt = createBrandAssistRuntime({
        isolate: () => ({
          pageText: async (html, url) => {
            if (url.endsWith('/about')) throw new Error('parser crashed');
            if (url.endsWith('/products')) throw new ProcessingLimitError('stopped after 10 s');
            return htmlToText(html, url);
          },
          extract: async () => {
            throw new Error('not used');
          },
          close: async () => {},
        }),
      });
      await read(() => rt.beginBrandAssist(input(j.jobId)));
      expect(
        await read(() => rt.captureBrandSourceUrl({ ...input(j.jobId), sourceId: s.sourceId })),
      ).toMatchObject({ status: 'captured' });
      const row = await source(s.sourceId);
      expect(row.pages?.map((p) => new URL(p.url).pathname)).toEqual(['/shop']);
      expect(row.detail).toBe('3 pages skipped (capture_failed)');
      expect(row.text).toContain('Bags of coffee');
    });

    it('an address that redirects to a page already read is captured as a duplicate of it', async () => {
      const first = (
        await tdb.db
          .select()
          .from(brandSources)
          .where(and(eq(brandSources.brandId, brandA), eq(brandSources.url, `${web.base}/`)))
      )[0]!;
      const home = await addUrl(`${web.base}/home`);
      const j = await start(['voice'], [home.sourceId], { instruction: 'home' });
      const rt = createBrandAssistRuntime();
      await read(() => rt.beginBrandAssist(input(j.jobId)));
      await read(() => rt.captureBrandSourceUrl({ ...input(j.jobId), sourceId: home.sourceId }));
      expect(await source(home.sourceId)).toMatchObject({
        status: 'captured',
        contentHash: first.contentHash,
        duplicateOfSourceId: first.id,
      });
      // A duplicate is not evidence twice: an estimate over it counts it as not usable.
      const e = await read(() =>
        brandAssistService.assist.estimate(A, {
          brandId: brandA,
          kind: 'setup',
          sections: ['voice'],
          sourceIds: [home.sourceId],
        }),
      );
      expect(e.sources).toEqual({ usable: 0, pending: 0, unusable: 1 });
    });
  });

  describe('assist jobs and suggestions', () => {
    let textId = '';
    let jobId = '';
    const seen: BrandAssistModelRequestV1[] = [];
    const script: Script = {
      voice: (req) => ({
        summary: {
          value: 'Plain-spoken and warm; we explain before we sell.',
          ...meta([{ sourceId: req.evidence[0]!.id, excerpt: 'We write plainly.' }]),
        },
        tone: { value: ['warm', 'plain'], ...meta([], 'suggested') },
        personality: [
          {
            value: { trait: 'Curious' },
            ...meta([{ sourceId: req.evidence[0]!.id, excerpt: 'this passage is not in any source' }]),
          },
        ],
        principles: [
          {
            value: { statement: 'Say what it does', rationale: 'Rewritten by the model.' },
            ...meta([{ sourceId: req.evidence[0]!.id, excerpt: 'We never shout.' }]),
          },
          {
            value: { statement: 'Never shout', rationale: 'Calm copy.' },
            ...meta([{ sourceId: req.evidence[0]!.id, excerpt: 'We never shout.' }], 'inferred'),
          },
        ],
        styleRules: [],
        claimRules: [],
        remove: [{ collection: 'voice.principles', key: 'Be brief', ...meta([], 'suggested') }],
        questions: [{ question: 'British or American spelling?', why: 'Both appear.' }],
      }),
      facts: (req) => ({
        facts: [
          {
            statement: 'Roasts are named after their farms.',
            category: 'product',
            ...meta([{ sourceId: req.evidence[0]!.id, excerpt: 'Our roasts are named after farms.' }]),
          },
          // Said to be stated, but the passage is in no source of this job: a suggestion, never a fact.
          {
            statement: 'Founded in 2014.',
            category: 'company',
            ...meta([{ sourceId: req.evidence[0]!.id, excerpt: 'Founded in 2014 by two baristas.' }]),
          },
          { statement: 'The best coffee in Leeds.', category: 'claim', ...meta([], 'suggested') },
        ],
        questions: [],
      }),
      channels: () => ({
        baseline: [{ field: 'cta', value: 'One call to action, last.', ...meta([], 'suggested') }],
        channels: [
          {
            providerKey: 'linkedin_page',
            value: { captionStyle: 'First person plural.' },
            ...meta([], 'suggested'),
          },
          { providerKey: 'myspace', value: { captionStyle: 'Nostalgic.' }, ...meta([], 'suggested') },
        ],
        questions: [],
      }),
    };

    beforeAll(async () => {
      textId = (
        await addText('Voice notes', 'We write plainly. We never shout. Our roasts are named after farms.')
      ).sourceId;
    });

    it('an estimate names the cost per section and nothing stops it', async () => {
      const e = await read(() =>
        brandAssistService.assist.estimate(A, {
          brandId: brandA,
          kind: 'setup',
          sections: ['voice', 'facts'],
          sourceIds: [textId],
        }),
      );
      expect(e.sections.map((s) => s.section)).toEqual(['voice', 'facts']);
      expect(e.estimateMicros).toBe(e.sections.reduce((n, s) => n + s.costMicros, 0));
      expect(e.estimateMicros).toBeGreaterThan(0);
      expect(e.blockers).toEqual([]);
      expect(e.sources).toEqual({ usable: 1, pending: 0, unusable: 0 });
    });

    it('starts once (an identical request joins the running job) and is routed through the outbox', async () => {
      const first = await start(['voice', 'facts', 'channels'], [textId]);
      jobId = first.jobId;
      expect(await start(['channels', 'voice', 'facts'], [textId])).toMatchObject({ jobId, duplicate: true });
      const events = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, jobId));
      expect(events.map((e) => e.eventType)).toEqual(['brand.assist_requested']);
      expect(events[0]!.payload).toMatchObject({ jobId, brandId: brandA, actorKind: 'user', actorId: USER });
    });

    it('proposes per section with verified evidence; never invents facts; suggests against a person’s item', async () => {
      const finished = await drive(jobId, scriptedModel(script, seen));
      expect(finished.state).toBe('ready');
      const j = await job(jobId);
      expect(j.progress.sections).toMatchObject({
        voice: { status: 'ready' },
        facts: { status: 'ready' },
        channels: { status: 'ready' },
      });
      expect(j.spentMicros).toBe(4500);
      expect(j.questions).toEqual([
        {
          id: 'q1',
          section: 'voice',
          question: 'British or American spelling?',
          why: 'Both appear.',
          answer: null,
        },
      ]);
      // The prompt carried the evidence as untrusted items, the approved guidance and the known channels.
      expect(seen[0]!.evidence[0]).toMatchObject({ id: textId, trust: 'untrusted' });
      expect(seen[0]!.guidance.voice.summary).toBe('Warm and plain.');
      const rows = await suggestions(jobId);
      const at = (path: string) => rows.find((r) => r.path === path);
      expect(at('voice.summary')).toMatchObject({ op: 'replace', provenance: { origin: 'imported' } });
      expect(at('voice.summary')!.evidence).toEqual([
        { sourceId: textId, excerpt: 'We write plainly.', verified: true },
      ]);
      // A passage not found in the source: the item is a suggestion, and says so.
      expect(at('voice.personality#Curious')).toMatchObject({
        op: 'add',
        provenance: { origin: 'suggested' },
      });
      expect(at('voice.personality#Curious')!.uncertainty).toContain('not found in the sources');
      // An inferred pattern from one passage is low confidence.
      expect(at('voice.principles#Never shout')!.provenance).toMatchObject({
        origin: 'inferred',
        confidence: 'low',
      });
      // A person's principle is not overwritten: the suggestion is made against it and flagged.
      expect(at('voice.principles#Say what it does')).toMatchObject({
        op: 'replace',
        againstUserItem: 'yes',
      });
      expect(at('voice.principles#Be brief')).toMatchObject({ op: 'remove' });
      // Facts: one stated by a source (verified passage), one whose passage is in no source, one unsourced claim.
      expect(at('facts#Roasts are named after their farms.')!.provenance).toMatchObject({
        origin: 'imported',
      });
      expect(at('facts#Founded in 2014.')!.provenance.origin).toBe('suggested');
      expect(at('facts#Founded in 2014.')!.uncertainty).toContain('not found in the sources');
      expect(at('facts#The best coffee in Leeds.')).toMatchObject({ provenance: { origin: 'suggested' } });
      // Unknown channels are never suggested.
      expect(rows.some((r) => r.path.includes('myspace'))).toBe(false);
      expect(at('channelGuidance#linkedin_page')!.payload).toMatchObject({
        providerKey: 'linkedin_page',
        captionStyle: 'First person plural.',
        preferredFormats: [],
        ctaConventions: '',
      });
      // No fact was written: suggestions only.
      expect(await tdb.db.select().from(approvedFacts).where(eq(approvedFacts.brandId, brandA))).toEqual([]);
      // The reservation was settled at what was spent.
      expect(
        (await read(() => budgets.summary(brandA))).reservations.find((r) => r.runId === jobId),
      ).toMatchObject({
        state: 'settled',
        consumedMicros: 4500,
      });
    });

    it('lists suggestions with the current value, readable text and their sources', async () => {
      const list = await read(() =>
        brandAssistService.suggestions.list(A, {
          brandId: brandA,
          jobId,
          section: 'voice',
          page: { limit: 50 },
        }),
      );
      const summary = list.items.find((s) => s.path === 'voice.summary')!;
      expect(summary).toMatchObject({
        label: 'Voice summary',
        current: 'Warm and plain.',
        currentText: 'Warm and plain.',
        valueText: 'Plain-spoken and warm; we explain before we sell.',
      });
      expect(summary.evidence[0]).toMatchObject({ sourceTitle: 'Voice notes', verified: true });
      const user = list.items.find((s) => s.path === 'voice.principles#Say what it does')!;
      expect(user.againstUserItem).toBe(true);
      expect(user.conflicts.some((c) => c.note.includes('A person wrote'))).toBe(true);
    });

    it('a creator and an agent cannot decide; a person accepts into a new proposal with provenance', async () => {
      const rows = await suggestions(jobId);
      const summary = rows.find((r) => r.path === 'voice.summary')!;
      await expect(
        run((tx) =>
          brandAssistService.suggestions.accept(
            person(tenantA, 'creator', CREATOR),
            { brandId: brandA, suggestionIds: [summary.id] },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      await expect(
        run((tx) =>
          brandAssistService.suggestions.accept(
            agent(tenantA),
            { brandId: brandA, suggestionIds: [summary.id] },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ reason: 'propose_only' });
      const res = await run((tx) =>
        brandAssistService.suggestions.accept(A, { brandId: brandA, suggestionIds: [summary.id] }, tx),
      );
      expect(res.decided).toEqual([summary.id]);
      const proposal = (
        await tdb.db.select().from(brandVersions).where(eq(brandVersions.id, res.proposalVersionId!))
      )[0]!;
      expect(proposal.state).toBe('draft');
      const doc = BrandSystemDocumentV1.parse(proposal.document);
      expect(doc.voice.summary).toBe('Plain-spoken and warm; we explain before we sell.');
      expect(doc.voice.principles?.find((p) => p.statement === 'Say what it does')?.provenance?.origin).toBe(
        'user',
      );
      // Nothing was applied: the published brand system is unchanged.
      const brand = (await tdb.db.select().from(brands).where(eq(brands.id, brandA)))[0]!;
      expect(brand.publishedVersionId).toBe(publishedId);
      expect(
        (await tdb.db.select().from(brandSuggestions).where(eq(brandSuggestions.id, summary.id)))[0],
      ).toMatchObject({
        status: 'accepted',
        appliedProposalVersionId: res.proposalVersionId,
        appliedBefore: 'Warm and plain.',
      });
    });

    it('edit writes the person’s wording as theirs; an edit that renames the item is refused', async () => {
      const rows = await suggestions(jobId);
      const trait = rows.find((r) => r.path === 'voice.personality#Curious')!;
      await expect(
        run((tx) =>
          brandAssistService.suggestions.edit(
            A,
            { brandId: brandA, suggestionId: trait.id, value: { trait: 'Nosy' } },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ details: [{ path: 'value', issue: 'key_changed' }] });
      const res = await run((tx) =>
        brandAssistService.suggestions.edit(
          A,
          { brandId: brandA, suggestionId: trait.id, value: { trait: 'Curious', note: 'We ask first.' } },
          tx,
        ),
      );
      const doc = BrandSystemDocumentV1.parse(
        (await tdb.db.select().from(brandVersions).where(eq(brandVersions.id, res.proposalVersionId!)))[0]!
          .document,
      );
      expect(doc.voice.personality).toEqual([
        { trait: 'Curious', note: 'We ask first.', provenance: { origin: 'user', suggestionId: trait.id } },
      ]);
    });

    it('a rejected suggestion is remembered: regenerating does not suggest it again', async () => {
      const rows = await suggestions(jobId);
      const tone = rows.find((r) => r.path === 'voice.tone')!;
      await run((tx) =>
        brandAssistService.suggestions.reject(A, { brandId: brandA, suggestionIds: [tone.id] }, tx),
      );
      const again = await start(['voice'], [textId], { instruction: 'again' });
      await drive(again.jobId, scriptedModel(script));
      const next = await suggestions(again.jobId);
      expect(next.some((r) => r.path === 'voice.tone')).toBe(false); // rejected
      expect(next.some((r) => r.path === 'voice.summary')).toBe(false); // already accepted (same value)
      expect(next.some((r) => r.path === 'voice.principles#Never shout')).toBe(false); // already pending
    });

    it('accepting a fact proposes it with its origin and sources; accept all accepts the rest of a section', async () => {
      const rows = await suggestions(jobId);
      const claim = rows.find((r) => r.path === 'facts#The best coffee in Leeds.')!;
      const stated = rows.find((r) => r.path === 'facts#Roasts are named after their farms.')!;
      const res = await run((tx) =>
        brandAssistService.suggestions.accept(
          A,
          { brandId: brandA, suggestionIds: [stated.id, claim.id] },
          tx,
        ),
      );
      const facts = await tdb.db.select().from(approvedFacts).where(eq(approvedFacts.brandId, brandA));
      const byStatement = (t: string) => facts.find((f) => f.statement === t)!;
      expect(res.factIds).toHaveLength(2);
      expect(byStatement('Roasts are named after their farms.')).toMatchObject({
        state: 'proposed',
        origin: 'extracted',
        sources: [
          {
            kind: 'document',
            ref: 'Voice notes',
            title: 'Voice notes',
            excerpt: 'Our roasts are named after farms.',
          },
        ],
      });
      // An unsourced claim is proposed as a suggestion: approving it later needs a reviewer note (BSC-3).
      expect(byStatement('The best coffee in Leeds.')).toMatchObject({
        state: 'proposed',
        origin: 'suggested',
        sources: [],
      });
      const all = await run((tx) =>
        brandAssistService.suggestions.acceptAll(A, { brandId: brandA, jobId, section: 'channels' }, tx),
      );
      expect(all.decided).toHaveLength(2);
      const doc = BrandSystemDocumentV1.parse(
        (await tdb.db.select().from(brandVersions).where(eq(brandVersions.id, all.proposalVersionId!)))[0]!
          .document,
      );
      expect(doc.channelBaseline?.cta).toBe('One call to action, last.');
      expect(doc.channelGuidance.map((c) => c.providerKey)).toEqual(['linkedin_page']);
    });

    it('undo puts the last batch back and the suggestions become pending again', async () => {
      const res = await run((tx) => brandAssistService.suggestions.undo(A, { brandId: brandA }, tx));
      expect(res.decided).toHaveLength(2);
      const doc = BrandSystemDocumentV1.parse(
        (await tdb.db.select().from(brandVersions).where(eq(brandVersions.id, res.proposalVersionId!)))[0]!
          .document,
      );
      expect(doc.channelBaseline?.cta).toBeUndefined();
      expect(doc.channelGuidance).toEqual([]);
      expect(doc.voice.summary).toBe('Plain-spoken and warm; we explain before we sell.'); // an earlier batch stays
      const rows = await suggestions(jobId);
      expect(rows.filter((r) => r.section === 'channels').every((r) => r.status === 'pending')).toBe(true);
      // Undo of the fact batch withdraws the facts it proposed.
      const factUndo = await run((tx) => brandAssistService.suggestions.undo(A, { brandId: brandA }, tx));
      expect(factUndo.decided).toHaveLength(2);
      const facts = await tdb.db.select().from(approvedFacts).where(eq(approvedFacts.brandId, brandA));
      expect(facts.map((f) => f.state)).toEqual(['revoked', 'revoked']);
    });

    it('a suggestion whose item a person changed since is refused, and shown as changed; a proposal in review takes none', async () => {
      const pending = (await suggestions(jobId)).filter(
        (r) => r.section === 'channels' && r.status === 'pending',
      );
      const [target, other] = pending;
      const draft = (
        await tdb.db
          .select()
          .from(brandVersions)
          .where(and(eq(brandVersions.brandId, brandA), eq(brandVersions.state, 'draft')))
      )[0]!;
      // A person writes the item after the suggestion was made.
      const before = BrandSystemDocumentV1.parse(draft.document);
      const edited = applyChange(before, {
        path: target!.path,
        op: valueAt(before, target!.path) === undefined ? 'add' : 'replace',
        value: target!.op === 'remove' ? valueAt(before, target!.path) : target!.payload,
        provenance: { origin: 'user' },
      });
      await tdb.db
        .update(brandVersions)
        .set({ document: edited, contentHash: hashCanonical(edited) })
        .where(eq(brandVersions.id, draft.id));
      const listed = await read(() =>
        brandAssistService.suggestions.list(A, {
          brandId: brandA,
          jobId,
          section: 'channels',
          page: { limit: 50 },
        }),
      );
      expect(listed.items.find((i) => i.id === target!.id)?.changedSince).toBe(true);
      const res = await run((tx) =>
        brandAssistService.suggestions.accept(A, { brandId: brandA, suggestionIds: [target!.id] }, tx),
      );
      expect(res).toMatchObject({
        decided: [],
        skipped: [{ suggestionId: target!.id, reason: 'changed_since' }],
      });
      expect(
        BrandSystemDocumentV1.parse(
          (await tdb.db.select().from(brandVersions).where(eq(brandVersions.id, draft.id)))[0]!.document,
        ),
      ).toEqual(edited);
      // Sent for review: suggestions wait until it is back.
      await tdb.db.update(brandVersions).set({ state: 'in_review' }).where(eq(brandVersions.id, draft.id));
      await expect(
        run((tx) =>
          brandAssistService.suggestions.accept(A, { brandId: brandA, suggestionIds: [other!.id] }, tx),
        ),
      ).rejects.toMatchObject({ details: [{ issue: 'proposal_in_review' }] });
      await tdb.db
        .update(brandVersions)
        .set({ state: 'draft', document: before, contentHash: hashCanonical(before) })
        .where(eq(brandVersions.id, draft.id));
    });

    it('answers start a follow-up section job that carries them', async () => {
      const follow = await run((tx) =>
        brandAssistService.assist.answer(
          A,
          { brandId: brandA, jobId, answers: [{ questionId: 'q1', answer: 'British.' }] },
          tx,
        ),
      );
      const j = await job(follow.jobId);
      expect(j).toMatchObject({
        kind: 'section',
        sections: ['voice'],
        parentJobId: jobId,
        answers: [{ question: 'British or American spelling?', answer: 'British.' }],
      });
      expect((await job(jobId)).questions[0]!.answer).toBe('British.');
    });
  });

  describe('gates, cancel and partial failure', () => {
    let textId = '';
    beforeAll(async () => {
      textId = (await addText('Gate notes', 'Gate test source text that is long enough.')).sourceId;
    });

    it('a start over the brand’s remaining budget is refused before anything is written', async () => {
      await read(() => budgets.setLimit(brandA, 'day', 10));
      await expect(start(['voice'], [textId], { instruction: 'over budget' })).rejects.toBeInstanceOf(
        BudgetExhaustedError,
      );
      const e = await read(() =>
        brandAssistService.assist.estimate(A, {
          brandId: brandA,
          kind: 'setup',
          sections: ['voice'],
          sourceIds: [textId],
        }),
      );
      expect(e.blockers.map((b) => b.code)).toContain('budget_exhausted_day');
      await read(() => budgets.setLimit(brandA, 'day', 20_000_000));
    });

    it('a job whose budget is gone by the time it runs fails without calling the model', async () => {
      const j = await start(['voice'], [textId], { instruction: 'budget gone' });
      await read(() => budgets.setLimit(brandA, 'day', 10));
      const seen: BrandAssistModelRequestV1[] = [];
      const done = await drive(j.jobId, scriptedModel({}, seen));
      await read(() => budgets.setLimit(brandA, 'day', 20_000_000));
      expect(done.state).toBe('failed');
      expect((await job(j.jobId)).error).toBe('budget_exhausted_day');
      expect(seen).toEqual([]);
    });

    it('two attempts of one section that overlap (a timed-out attempt still running) insert its suggestions once; each attempt is charged once', async () => {
      const j = await start(['voice'], [textId], { instruction: 'overlap' });
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      const scripted = scriptedModel({
        voice: () => ({
          personality: [{ value: { trait: 'Overlapping-attempt trait' }, ...meta([], 'suggested') }],
          principles: [],
          styleRules: [],
          claimRules: [],
          remove: [],
          questions: [],
        }),
      });
      let calls = 0;
      // The first attempt's model call is held until the second attempt has finished the section.
      const rt = createBrandAssistRuntime({
        model: {
          async propose(req) {
            const n = ++calls;
            if (n === 1) await gate;
            // Each attempt words its answer differently, as a model does.
            const out = await scripted.propose(req);
            const raw = out.raw as Record<string, unknown>;
            return {
              ...out,
              raw: {
                ...raw,
                personality: [{ value: { trait: `Attempt ${n} trait` }, ...meta([], 'suggested') }],
              },
            };
          },
        },
      });
      const inp = input(j.jobId);
      await read(() => rt.beginBrandAssist(inp));
      await read(() => rt.prepareBrandAssistProposals(inp, A));
      const hooks = (attempt: number) => ({ heartbeat: () => {}, attempt });
      const first = read(() => rt.proposeBrandAssistSection({ ...inp, section: 'voice' }, hooks(1)));
      while (calls === 0) await new Promise((r) => setTimeout(r, 10));
      const second = await read(() => rt.proposeBrandAssistSection({ ...inp, section: 'voice' }, hooks(2)));
      release();
      expect(second).toMatchObject({ outcome: 'ready', suggestions: 1 });
      expect(await first).toMatchObject({ outcome: 'ready', suggestions: 1 });
      expect((await suggestions(j.jobId)).map((r) => r.path)).toEqual(['voice.personality#Attempt 2 trait']);
      const charges = await tdb.db
        .select()
        .from(usageLedger)
        .where(eq(usageLedger.sourceRef, `brand-assist:${j.jobId}:voice`));
      expect(charges.map((c) => c.idempotencyKey).sort()).toEqual([
        `brand-assist:${j.jobId}:voice:a1`,
        `brand-assist:${j.jobId}:voice:a2`,
      ]);
      // A replay of attempt 2 neither charges again nor adds anything.
      await read(() => rt.proposeBrandAssistSection({ ...inp, section: 'voice' }, hooks(2)));
      expect(await suggestions(j.jobId)).toHaveLength(1);
    });

    it('a model call that finishes after the job was settled is still ledgered and counts toward the caps', async () => {
      const before = await read(() => budgets.summary(brandA));
      const j = await start(['voice'], [textId], { instruction: 'late charge' });
      const scripted = scriptedModel({
        voice: () => ({
          personality: [],
          principles: [],
          styleRules: [],
          claimRules: [],
          remove: [],
          questions: [],
        }),
      });
      // The job is settled (its remainder released) while the section's model call is still running.
      const rt = createBrandAssistRuntime({
        model: {
          async propose(req) {
            await budgets.settle(j.jobId);
            return scripted.propose(req);
          },
        },
      });
      const inp = input(j.jobId);
      await read(() => rt.beginBrandAssist(inp));
      await read(() => rt.prepareBrandAssistProposals(inp, A));
      await read(() =>
        rt.proposeBrandAssistSection({ ...inp, section: 'voice' }, { heartbeat: () => {}, attempt: 1 }),
      );
      const charges = await tdb.db
        .select()
        .from(usageLedger)
        .where(eq(usageLedger.sourceRef, `brand-assist:${j.jobId}:voice`));
      expect(charges.map((c) => c.idempotencyKey)).toEqual([`brand-assist:${j.jobId}:voice:a1`]);
      const cost = charges[0]!.costMicros;
      expect(cost).toBeGreaterThan(0);
      const after = await read(() => budgets.summary(brandA));
      expect(after.reservations.find((r) => r.runId === j.jobId)).toMatchObject({
        state: 'settled',
        consumedMicros: cost,
      });
      expect(after.day.committedMicros - before.day.committedMicros).toBe(cost);
      // A replay of the same attempt charges nothing more.
      await read(() =>
        rt.proposeBrandAssistSection({ ...inp, section: 'voice' }, { heartbeat: () => {}, attempt: 1 }),
      );
      expect(
        await tdb.db
          .select()
          .from(usageLedger)
          .where(eq(usageLedger.sourceRef, `brand-assist:${j.jobId}:voice`)),
      ).toHaveLength(1);
    });

    it('cancel stops the next section; the job ends cancelled and its reservation is settled', async () => {
      const j = await start(['voice', 'facts'], [textId], { instruction: 'cancel' });
      const rt = createBrandAssistRuntime({
        model: scriptedModel({
          voice: () => ({
            personality: [],
            principles: [],
            styleRules: [],
            claimRules: [],
            remove: [],
            questions: [],
          }),
        }),
      });
      const inp = input(j.jobId);
      await read(() => rt.beginBrandAssist(inp));
      await read(() => rt.prepareBrandAssistProposals(inp, A));
      await read(() => rt.proposeBrandAssistSection({ ...inp, section: 'voice' }));
      await run((tx) => brandAssistService.assist.cancel(A, { brandId: brandA, jobId: j.jobId }, tx));
      expect(await read(() => rt.proposeBrandAssistSection({ ...inp, section: 'facts' }))).toMatchObject({
        outcome: 'skipped',
        reason: 'cancelled',
      });
      expect(
        await read(() => rt.finishBrandAssist({ ...inp, cancelled: false, failure: null })),
      ).toMatchObject({ state: 'cancelled' });
      const events = await tdb.db
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.aggregateId, j.jobId),
            eq(outboxEvents.eventType, 'brand.assist_cancel_requested'),
          ),
        );
      expect(events[0]!.payload).toMatchObject({ workflowId: `brand-assist:${j.jobId}` });
    });

    it('a section whose model keeps failing fails alone: the job is partly ready', async () => {
      const j = await start(['voice', 'facts'], [textId], { instruction: 'partial' });
      const done = await drive(j.jobId, scriptedModel({ facts: () => ({ facts: [], questions: [] }) }));
      expect(done.state).toBe('partially_ready');
      expect((await job(j.jobId)).progress.sections).toMatchObject({
        voice: { status: 'failed' },
        facts: { status: 'ready' },
      });
    });

    it('an answer that does not match the section’s schema is refused, charged and failed (never repaired)', async () => {
      const j = await start(['facts'], [textId], { instruction: 'bad json' });
      const done = await drive(
        j.jobId,
        scriptedModel({ facts: () => ({ facts: [{ statement: 'x' }], questions: [], extra: true }) }),
      );
      expect(done.state).toBe('failed');
      expect((await job(j.jobId)).spentMicros).toBe(1500);
    });
  });

  describe('history and isolation', () => {
    it('lists applied versions with who, when and what changed; compares; restores through a save', async () => {
      const second = BrandSystemDocumentV1.parse({
        ...emptyBrandSystemDocument(),
        voice: { ...emptyBrandSystemDocument().voice, summary: 'Changed summary.' },
        vocabulary: [{ term: 'roast', usage: 'preferred', alternatives: [] }],
      });
      const saved = await run((tx) =>
        brandService.system.save(A, { brandId: brandA, basedOnVersionId: publishedId, document: second }, tx),
      );
      const history = await read(() =>
        brandAssistService.history.list(A, { brandId: brandA, page: { limit: 10 } }),
      );
      expect(history.items.map((h) => [h.versionId, h.current, h.appliedByName])).toEqual([
        [saved.versionId, true, 'Rudo Moyo'],
        [publishedId, false, 'Rudo Moyo'],
      ]);
      expect(history.items[0]!.changedSections).toEqual(['Voice & personality', 'Vocabulary']);
      const diff = await read(() =>
        brandAssistService.history.compare(A, { brandId: brandA, versionId: publishedId }),
      );
      expect(diff.sections.find((s) => s.section === 'voice')!.changes).toContainEqual({
        change: 'changed',
        item: 'Voice summary',
        before: 'Warm and plain.',
        after: 'Changed summary.',
      });
      await expect(
        run((tx) =>
          brandAssistService.history.restore(
            A,
            { brandId: brandA, versionId: saved.versionId!, basedOnVersionId: saved.versionId },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ details: [{ path: 'versionId', issue: 'already_current' }] });
      await expect(
        run((tx) =>
          brandAssistService.history.restore(
            A,
            { brandId: brandA, versionId: publishedId, basedOnVersionId: publishedId },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      const restored = await run((tx) =>
        brandAssistService.history.restore(
          A,
          { brandId: brandA, versionId: publishedId, basedOnVersionId: saved.versionId },
          tx,
        ),
      );
      expect(restored).toMatchObject({ changed: true, restoredFromVersionId: publishedId });
      const now = (
        await tdb.db.select().from(brandVersions).where(eq(brandVersions.id, restored.versionId!))
      )[0]!;
      expect(now.state).toBe('published');
      expect(hashCanonical(BrandSystemDocumentV1.parse(now.document).voice.summary)).toBe(
        hashCanonical('Warm and plain.'),
      );
      await expect(
        run((tx) =>
          brandAssistService.history.restore(
            person(tenantA, 'creator', CREATOR),
            { brandId: brandA, versionId: saved.versionId!, basedOnVersionId: restored.versionId },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
    });

    it('another tenant’s ids are not found anywhere', async () => {
      const B = person(tenantB);
      const anyJob = (
        await tdb.db.select().from(brandAssistJobs).where(eq(brandAssistJobs.brandId, brandA))
      )[0]!;
      const anySuggestion = (
        await tdb.db.select().from(brandSuggestions).where(eq(brandSuggestions.brandId, brandA))
      )[0]!;
      const anySource = (
        await tdb.db.select().from(brandSources).where(eq(brandSources.brandId, brandA))
      )[0]!;
      const inB = <T>(fn: (tx: Tx) => Promise<T>) => run(fn, tenantB);
      await expect(
        inB((tx) => brandAssistService.sources.list(B, { brandId: brandA, page: { limit: 5 } }, tx)),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        inB((tx) => brandAssistService.sources.get(B, { brandId: brandB, sourceId: anySource.id }, tx)),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        inB((tx) => brandAssistService.assist.get(B, { brandId: brandB, jobId: anyJob.id }, tx)),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        inB((tx) =>
          brandAssistService.assist.start(
            B,
            { brandId: brandB, kind: 'setup', sections: ['voice'], sourceIds: [anySource.id] },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        inB((tx) =>
          brandAssistService.suggestions.accept(
            B,
            { brandId: brandB, suggestionIds: [anySuggestion.id] },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        inB((tx) => brandAssistService.history.compare(B, { brandId: brandB, versionId: publishedId }, tx)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
