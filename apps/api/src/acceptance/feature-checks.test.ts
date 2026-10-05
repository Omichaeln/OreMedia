import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyBrandSystemDocument, type BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import type { BrandSuggestionDto } from '@oremedia/contracts/brand-assist';
import type { CreativeDocumentV1 } from '@oremedia/contracts/creative';
import type { AcceptanceConfig } from '../../../../tooling/scripts/acceptance/config';
import { formatAcceptance } from '../../../../tooling/scripts/acceptance/report';
import type { Sessions } from './checks';
import {
  acceptanceLogoSvg,
  brandSystemChecks,
  capModelSpend,
  ensurePhotoAssetVersion,
  factChecks,
  logoChecks,
  pickSuggestion,
  provenanceVerdict,
  runMarker,
  studioChecks,
  videoChecks,
  type StoreState,
} from './feature-checks';
import type { FixtureTenant } from './fixtures';

/**
 * The feature journeys' logic against a local fake deployment (the smoke check's harness pattern): a tRPC origin
 * whose procedures each test scripts over its own in-memory state, and an object store on another port. A journey
 * passes only when the state it reads back agrees; a fake that answers 200 without changing anything fails it.
 */
const TOKEN = 'ses_fake.token.never.printed';
const SIGNATURE = 'SIGNATURE_MUST_NOT_PRINT';

class Refusal {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly message: string,
    readonly details?: Array<{ path: string; issue: string }>,
  ) {}
}
type Handler = (input: Record<string, unknown>) => unknown;

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

const listen = async (handler: Parameters<typeof createServer>[1]): Promise<string> => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const bodyOf = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

/** The deployment: every call is recorded by path; an unscripted procedure answers 404 (and so fails the step). */
async function fakeDeployment(handlers: Record<string, Handler>, store: { putStatus?: number } = {}) {
  const calls: string[] = [];
  const puts: Buffer[] = [];
  const storeOrigin = await listen(async (req, res) => {
    if (req.method !== 'PUT') return res.writeHead(404).end();
    const bytes = await bodyOf(req);
    if ((store.putStatus ?? 200) < 300) puts.push(bytes);
    res.writeHead(store.putStatus ?? 200).end();
  });
  const origin = await listen(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const name = url.pathname.replace(/^\/trpc\//, '');
    calls.push(name);
    const json = (status: number, v: unknown) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, {});
    const handler = handlers[name];
    if (!handler) return json(404, { error: { json: { message: `no procedure ${name}` } } });
    const raw =
      req.method === 'GET'
        ? (url.searchParams.get('input') ?? '{"json":{}}')
        : (await bodyOf(req)).toString();
    const input = ((JSON.parse(raw) as { json?: Record<string, unknown> }).json ?? {}) as Record<
      string,
      unknown
    >;
    try {
      const out = handler(input);
      if (out instanceof Refusal)
        return json(out.status, {
          error: {
            json: {
              message: out.message,
              data: { envelope: { code: out.code, ...(out.details ? { details: out.details } : {}) } },
            },
          },
        });
      return json(200, { result: { data: { json: out } } });
    } catch (err) {
      return json(500, { error: { json: { message: (err as Error).message } } });
    }
  });
  return { origin, storeOrigin, calls, puts };
}

const tenant: FixtureTenant = {
  label: 'A',
  name: 'Acceptance A',
  slug: 'acceptance-a',
  tenantId: 'ten_a',
  operatorEmail: 'operator@example.test',
  operatorUserId: 'usr_op',
  members: {} as FixtureTenant['members'],
  brandId: 'brd_a',
  brandName: 'Acceptance brand',
  publishedVersionId: 'bv_1',
  policyVersionId: 'pol_1',
  servicePrincipalId: 'sp_1',
  channelConnectionIds: [],
  externalReviewerEmail: 'reviewer@example.test',
};

const sessionsFor = (origin: string): Sessions =>
  new Map(
    ['owner', 'brand_manager'].map((role) => [
      `${tenant.slug}:${role}`,
      { baseUrl: origin, token: TOKEN, tenantId: tenant.tenantId },
    ]),
  );

const config = (over: Partial<AcceptanceConfig['journeys']> = {}): AcceptanceConfig => ({
  databaseUrl: 'mysql://unused',
  webOrigin: 'http://unused',
  apiBaseUrl: 'http://unused',
  emailDomain: 'example.test',
  disabledChannels: new Set(),
  repoDir: process.cwd(),
  e2e: { enabled: false },
  load: { enabled: false, expectedPeak: 1, peakMultiplier: 1 },
  modelEval: { enabled: false, taskKinds: [], timeoutMs: 1000, budgetMicros: 0 },
  settle: { revision: null, timeoutMs: 1000 },
  journeys: { modelBudgetMicros: 200_000, timeoutMs: 2000, ...over },
});

const outcomes = (rs: Array<{ name: string; outcome: string }>) => rs.map((r) => [r.name, r.outcome]);
const noSecrets = (rs: Array<{ name: string; outcome: 'pass' | 'fail' | 'skip'; detail: string }>) => {
  const text = rs.map(formatAcceptance).join('\n');
  expect(text).not.toContain(TOKEN.slice(4));
  expect(text).not.toContain(SIGNATURE);
};

const brandDocument = (over: Partial<BrandSystemDocumentV1> = {}): BrandSystemDocumentV1 => {
  const empty = emptyBrandSystemDocument();
  return {
    ...empty,
    tokens: {
      ...empty.tokens,
      colours: [
        { key: 'ink', value: '#172120', role: 'text' },
        { key: 'paper', value: '#F4F6F3', role: 'background' },
      ],
      spacingScale: [4, 8, 16, 24],
      radii: [0, 4],
    },
    ...over,
  };
};

/** The budget procedures over a day/month position; `limits` records what was set. */
function budgetWorld(
  start: { dayLimit?: number; dayCommitted?: number; monthLimit?: number; monthCommitted?: number } = {},
) {
  const state = {
    day: { limitMicros: start.dayLimit ?? 1_000_000, committedMicros: start.dayCommitted ?? 0 },
    month: { limitMicros: start.monthLimit ?? 5_000_000, committedMicros: start.monthCommitted ?? 0 },
    set: [] as string[],
  };
  const view = (p: { limitMicros: number; committedMicros: number }) => ({
    ...p,
    remainingMicros: Math.max(0, p.limitMicros - p.committedMicros),
  });
  const handlers: Record<string, Handler> = {
    'agents.budgets.read': () => ({ day: view(state.day), month: view(state.month) }),
    'agents.budgets.setLimit': (i) => {
      const period = i['period'] as 'day' | 'month';
      state[period].limitMicros = i['limitMicros'] as number;
      state.set.push(`${period}=${String(i['limitMicros'])}`);
      return { period, limitMicros: i['limitMicros'] };
    },
  };
  return { state, handlers };
}

describe('pure helpers', () => {
  it('runMarker is the UTC timestamp to the second', () => {
    expect(runMarker(new Date('2026-10-04T08:09:10.123Z'))).toBe('20261004080910');
  });

  const suggestion = (over: Partial<BrandSuggestionDto>): BrandSuggestionDto =>
    ({
      id: 'bsug_1',
      section: 'voice',
      path: 'voice.summary',
      op: 'replace',
      status: 'pending',
      changedSince: false,
      provenance: { origin: 'imported' },
      value: 'Plain',
      ...over,
    }) as BrandSuggestionDto;

  it('pickSuggestion takes a pending keyed document item first, never a fact, a removal or a changed item', () => {
    const scalar = suggestion({ id: 'bsug_s' });
    const keyed = suggestion({ id: 'bsug_k', path: 'voice.principles#Say it plainly', op: 'add' });
    expect(pickSuggestion([scalar, keyed])?.id).toBe('bsug_k');
    expect(pickSuggestion([scalar])?.id).toBe('bsug_s');
    expect(
      pickSuggestion([
        suggestion({ id: 'f', section: 'facts', path: 'facts#X' }),
        suggestion({ id: 'r', path: 'voice.principles#Y', op: 'remove' }),
        suggestion({ id: 'c', path: 'voice.principles#Z', changedSince: true }),
        suggestion({ id: 'a', path: 'voice.principles#W', status: 'accepted' }),
      ]),
    ).toBeNull();
  });

  it('provenanceVerdict checks the accepted item’s suggestion and origin, or a field’s value', () => {
    const doc = brandDocument({
      voice: {
        ...emptyBrandSystemDocument().voice,
        summary: 'Plain',
        principles: [
          {
            statement: 'Say it plainly',
            rationale: 'r',
            provenance: { origin: 'imported', suggestionId: 'bsug_k' },
          },
        ],
      },
    });
    const keyed = {
      id: 'bsug_k',
      path: 'voice.principles#Say it plainly',
      provenance: { origin: 'imported' as const },
      value: {},
    };
    expect(provenanceVerdict(doc, keyed)).toEqual({
      ok: true,
      detail: 'voice.principles#Say it plainly: origin imported, suggestion bsug_k',
    });
    expect(provenanceVerdict(doc, { ...keyed, id: 'bsug_other' })).toEqual({
      ok: false,
      reason: 'no item of the brand system names suggestion bsug_other (voice.principles#Say it plainly)',
    });
    expect(provenanceVerdict(doc, { ...keyed, provenance: { origin: 'suggested' } })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('origin imported, the suggestion said suggested'),
    });
    // A writing pattern (a field that is an item) carries provenance too, found wherever it sits.
    const pattern = brandDocument({
      writingPatterns: {
        cta: {
          guidance: 'One call to action',
          dos: [],
          donts: [],
          examples: [],
          provenance: { origin: 'inferred', suggestionId: 'bsug_w' },
        },
      },
    });
    expect(
      provenanceVerdict(pattern, {
        id: 'bsug_w',
        path: 'writingPatterns.cta',
        provenance: { origin: 'inferred' },
        value: {},
      }),
    ).toEqual({ ok: true, detail: 'writingPatterns.cta: origin inferred, suggestion bsug_w' });
    expect(
      provenanceVerdict(doc, {
        id: 's',
        path: 'voice.summary',
        provenance: { origin: 'imported' },
        value: 'Plain',
      }),
    ).toMatchObject({ ok: true });
    expect(
      provenanceVerdict(doc, {
        id: 's',
        path: 'voice.summary',
        provenance: { origin: 'imported' },
        value: 'Loud',
      }),
    ).toMatchObject({ ok: false });
  });

  it('the acceptance logo is a plain SVG whose bytes differ between runs', () => {
    const a = acceptanceLogoSvg(1);
    expect(a).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(a).not.toMatch(/script|href|on\w+=|<!ENTITY|<image|<foreignObject/i);
    expect(acceptanceLogoSvg(2)).not.toBe(a);
  });
});

describe('capModelSpend', () => {
  it('sets the day limit to today’s committed spend plus the cap, raising the month only when short', async () => {
    const b = budgetWorld({ dayCommitted: 30_000, monthLimit: 100_000, monthCommitted: 90_000 });
    const d = await fakeDeployment(b.handlers);
    const api = { baseUrl: d.origin, token: TOKEN, tenantId: 'ten_a' };
    expect(await capModelSpend(api, 'brd_a', 5_000, 200_000)).toEqual({
      ok: true,
      detail: 'estimate 5000 µUSD, cap 200000, day limit 230000 (200000 left)',
    });
    expect(b.state.set).toEqual(['day=230000', 'month=290000']);
  });

  it('refuses an estimate above the cap without touching the limits, and a limit that does not read back', async () => {
    const b = budgetWorld();
    const d = await fakeDeployment({ ...b.handlers, 'agents.budgets.setLimit': () => ({}) });
    const api = { baseUrl: d.origin, token: TOKEN, tenantId: 'ten_a' };
    expect(await capModelSpend(api, 'brd_a', 300_000, 200_000)).toEqual({
      ok: false,
      reason: 'the estimate 300000 µUSD is above the cap 200000 µUSD (ACCEPTANCE_MODEL_BUDGET_MICROS)',
    });
    expect(d.calls).toEqual([]);
    expect(await capModelSpend(api, 'brd_a', 1_000, 200_000)).toEqual({
      ok: false,
      reason: 'the day limit reads 1000000 µUSD after setting 200000',
    });
  });
});

// ---- brand system ------------------------------------------------------------------------------------------

/** A faithful brand: versions, a text source, one assist job that is ready after two reads, its suggestions. */
function brandWorld(opts: { saveLies?: boolean; jobNeverFinishes?: boolean; spent?: number } = {}) {
  const b = budgetWorld();
  const versions = new Map<
    string,
    {
      id: string;
      number: number;
      state: string;
      document: BrandSystemDocumentV1;
      contentHash: string;
      version: number;
    }
  >();
  const hash = (d: BrandSystemDocumentV1) => JSON.stringify(d);
  const v1 = brandDocument();
  versions.set('bv_1', {
    id: 'bv_1',
    number: 1,
    state: 'published',
    document: v1,
    contentHash: hash(v1),
    version: 1,
  });
  versions.set('bv_stale', {
    id: 'bv_stale',
    number: 2,
    state: 'draft',
    document: v1,
    contentHash: hash(v1),
    version: 3,
  });
  const brand = { id: 'brd_a', publishedVersionId: 'bv_1', version: 1 };
  const sources: Array<{ id: string; title: string; version: number; removed: boolean }> = [
    { id: 'bsrc_old', title: 'Acceptance voice notes', version: 0, removed: false },
  ];
  let jobReads = 0;
  let cancelled = false;
  let n = 2;
  const principle = 'voice.principles#Say run it out loud';
  const suggestion: BrandSuggestionDto = {
    id: 'bsug_1',
    jobId: 'baj_1',
    brandId: 'brd_a',
    section: 'voice',
    path: principle,
    label: 'Principle',
    op: 'add',
    value: { statement: 'Say run it out loud', rationale: 'Stated.' },
    current: null,
    valueText: null,
    currentText: null,
    provenance: { origin: 'imported' },
    rationale: 'Stated in the notes.',
    uncertainty: null,
    conflicts: [],
    evidence: [],
    againstUserItem: false,
    changedSince: false,
    status: 'pending',
    decidedByName: null,
    decidedAt: null,
    batchId: null,
    factId: null,
    createdAt: '2026-10-04T00:00:00.000Z',
    version: 0,
  };
  const apply = (id: string, document: BrandSystemDocumentV1) => {
    versions.set(id, {
      id,
      number: ++n,
      state: 'published',
      document,
      contentHash: hash(document),
      version: 1,
    });
    if (!opts.saveLies) brand.publishedVersionId = id;
    return { versionId: id, changed: true };
  };
  const handlers: Record<string, Handler> = {
    ...b.handlers,
    'brand.get': () => brand,
    'brand.versions.get': (i) =>
      versions.get(i['versionId'] as string) ?? new Refusal(404, 'NOT_FOUND', 'no version'),
    'brand.versions.list': () => ({ items: [...versions.values()], nextCursor: null }),
    'brand.system.discardProposal': (i) => {
      versions.get(i['versionId'] as string)!.state = 'retired';
      return {};
    },
    'brand.sources.list': () => ({ items: sources.filter((s) => !s.removed), nextCursor: null }),
    'brand.sources.remove': (i) => {
      sources.find((s) => s.id === i['sourceId'])!.removed = true;
      return {};
    },
    'brand.sources.add': (i) => {
      expect(i['kind']).toBe('text');
      sources.push({ id: 'bsrc_new', title: i['title'] as string, version: 0, removed: false });
      return { sourceId: 'bsrc_new', version: 0, duplicate: false };
    },
    'brand.sources.get': () => ({ status: 'captured', charCount: 300 }),
    'brand.assist.estimate': () => ({ estimateMicros: 4_000, blockers: [] }),
    'brand.assist.start': () => ({ jobId: 'baj_1', state: 'queued' }),
    'brand.assist.get': () => ({
      id: 'baj_1',
      state: opts.jobNeverFinishes || ++jobReads < 2 ? 'proposing' : 'ready',
      spentMicros: opts.spent ?? 3_100,
      reservedMicros: 4_000,
      error: null,
    }),
    'brand.assist.cancel': () => {
      cancelled = true;
      return {};
    },
    'brand.suggestions.list': (i) => ({
      items: i['status'] && i['status'] !== suggestion.status ? [] : [suggestion],
      nextCursor: null,
    }),
    'brand.suggestions.accept': () => {
      const base = versions.get(brand.publishedVersionId)!.document;
      const document: BrandSystemDocumentV1 = {
        ...base,
        voice: {
          ...base.voice,
          principles: [
            {
              statement: 'Say run it out loud',
              rationale: 'Stated.',
              provenance: { origin: 'imported', suggestionId: 'bsug_1' },
            },
          ],
        },
      };
      versions.set('bv_prop', {
        id: 'bv_prop',
        number: ++n,
        state: 'draft',
        document,
        contentHash: hash(document),
        version: 1,
      });
      suggestion.status = 'accepted';
      return { proposalVersionId: 'bv_prop', decided: ['bsug_1'], skipped: [] };
    },
    'brand.system.save': (i) => {
      const proposal = i['proposal'] as { versionId: string } | undefined;
      if (proposal) versions.get(proposal.versionId)!.state = 'retired';
      return apply(`bv_${n + 1}`, i['document'] as BrandSystemDocumentV1);
    },
    'brand.history.restore': (i) => apply(`bv_${n + 1}`, versions.get(i['versionId'] as string)!.document),
  };
  return { handlers, versions, brand, sources, budget: b.state, cancelled: () => cancelled };
}

describe('brandSystemChecks', () => {
  it('a job through the worker, one suggestion accepted and applied with its provenance, then the start restored', async () => {
    const w = brandWorld();
    const d = await fakeDeployment(w.handlers);
    const results = await brandSystemChecks(config(), sessionsFor(d.origin), tenant, { pollMs: 1 });
    expect(outcomes(results), JSON.stringify(results)).toEqual([
      ['brand-system:source', 'pass'],
      ['brand-system:budget', 'pass'],
      ['brand-system:assist', 'pass'],
      ['brand-system:accept', 'pass'],
      ['brand-system:publish', 'pass'],
      ['brand-system:provenance', 'pass'],
      ['brand-system:restore', 'pass'],
    ]);
    const by = Object.fromEntries(results.map((r) => [r.name, r.detail]));
    expect(by['brand-system:source']).toContain('discarded stale proposal(s) bv_stale');
    expect(by['brand-system:assist']).toBe(
      'baj_1 ready, 1 suggestion(s); spent 3100 µUSD of the 200000 cap (reserved 4000)',
    );
    expect(by['brand-system:provenance']).toBe(
      'voice.principles#Say run it out loud: origin imported, suggestion bsug_1',
    );
    expect(w.budget.set).toContain('day=200000');
    // The applied system holds the start's document again, and this run's source and the old one are removed.
    expect(w.versions.get(w.brand.publishedVersionId)!.contentHash).toBe(w.versions.get('bv_1')!.contentHash);
    expect(w.sources.every((s) => s.removed)).toBe(true);
    noSecrets(results);
  });

  it('a save the brand does not reflect fails the publish step, and the journey stops there', async () => {
    const w = brandWorld({ saveLies: true });
    const d = await fakeDeployment(w.handlers);
    const results = await brandSystemChecks(config(), sessionsFor(d.origin), tenant, { pollMs: 1 });
    expect(results.at(-1)).toMatchObject({
      name: 'brand-system:publish',
      outcome: 'fail',
      detail: expect.stringMatching(
        /^brand\.system\.save answered bv_\d+, but the brand reads bv_1 as applied$/,
      ),
    });
    expect(w.sources.every((s) => s.removed)).toBe(true); // the source is removed even so
  });

  it('a job that does not finish is cancelled and fails with what it spent; spend above the cap fails', async () => {
    const w = brandWorld({ jobNeverFinishes: true });
    const d = await fakeDeployment(w.handlers);
    const results = await brandSystemChecks(config({ timeoutMs: 20 }), sessionsFor(d.origin), tenant, {
      pollMs: 1,
    });
    expect(results.at(-1)).toMatchObject({
      name: 'brand-system:assist',
      outcome: 'fail',
      detail: expect.stringContaining('baj_1 still proposing after 0.02 s'),
    });
    expect(results.at(-1)!.detail).toContain('cancelled; spent 3100 µUSD of the 200000 cap');
    expect(w.cancelled()).toBe(true);
    const over = brandWorld({ spent: 250_000 });
    const d2 = await fakeDeployment(over.handlers);
    const r2 = await brandSystemChecks(config(), sessionsFor(d2.origin), tenant, { pollMs: 1 });
    expect(r2.at(-1)).toMatchObject({
      name: 'brand-system:assist',
      outcome: 'fail',
      detail: expect.stringContaining('above the cap'),
    });
  });

  it('a model budget of 0 skips the journey without calling the api', async () => {
    const d = await fakeDeployment({});
    expect(await brandSystemChecks(config({ modelBudgetMicros: 0 }), sessionsFor(d.origin), tenant)).toEqual([
      {
        name: 'brand-system',
        outcome: 'skip',
        detail: 'ACCEPTANCE_MODEL_BUDGET_MICROS=0: the model journeys are switched off',
      },
    ]);
    expect(d.calls).toEqual([]);
  });
});

// ---- facts -------------------------------------------------------------------------------------------------

interface FakeFact {
  id: string;
  state: string;
  statement: string;
  validFrom: string | null;
  validUntil: string | null;
  reviewedAt: string | null;
  reviewDueAt: string | null;
  revokeReason: string | null;
  supersededByFactId: string | null;
  conflicts: Array<{ id: string; factId?: string; status: string }>;
  version: number;
}

/** Facts with the transitions the brand module implements; `lies` names a mutation that answers 200 and does nothing. */
function factWorld(lies?: string) {
  const facts = new Map<string, FakeFact>();
  let n = 0;
  const dto = (f: FakeFact) => {
    const now = Date.now();
    const expired = f.validUntil !== null && Date.parse(f.validUntil) <= now;
    return {
      ...f,
      effective:
        f.state === 'approved' && !expired && (f.validFrom === null || Date.parse(f.validFrom) <= now),
      expired,
      reviewDue: f.state === 'approved' && f.reviewDueAt !== null && Date.parse(f.reviewDueAt) <= now,
    };
  };
  const touch = (name: string, id: string, patch: Partial<FakeFact>) => {
    const f = facts.get(id)!;
    if (lies !== name) Object.assign(f, patch, { version: f.version + 1 });
    return { factId: id };
  };
  const handlers: Record<string, Handler> = {
    'brand.facts.propose': (i) => {
      const id = `fct_${++n}`;
      facts.set(id, {
        id,
        state: 'proposed',
        statement: i['statement'] as string,
        validFrom: (i['validFrom'] as string) ?? null,
        validUntil: (i['validUntil'] as string) ?? null,
        reviewedAt: null,
        reviewDueAt: null,
        revokeReason: null,
        supersededByFactId: null,
        conflicts: ((i['conflicts'] as Array<{ factId: string }>) ?? []).map((c, k) => ({
          id: `c${k + 1}`,
          factId: c.factId,
          status: 'open',
        })),
        version: 0,
      });
      return { factId: id, version: 0, duplicate: false };
    },
    'brand.facts.approve': (i) =>
      touch('approve', i['factId'] as string, {
        state: 'approved',
        reviewDueAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      }),
    'brand.facts.markReviewed': (i) =>
      touch('markReviewed', i['factId'] as string, {
        reviewedAt: new Date().toISOString(),
        reviewDueAt: i['nextReviewDueAt'] as string,
      }),
    'brand.facts.resolveConflict': (i) => {
      const f = facts.get(i['factId'] as string)!;
      const other = f.conflicts.find((c) => c.id === i['conflictId'])!.factId!;
      return touch('resolveConflict', f.id, {
        state: 'superseded',
        supersededByFactId: other,
        conflicts: f.conflicts.map((c) => ({ ...c, status: 'resolved' })),
      });
    },
    'brand.facts.withdraw': (i) =>
      touch('withdraw', i['factId'] as string, { state: 'revoked', revokeReason: i['reason'] as string }),
    'brand.facts.list': (i) => {
      let items = [...facts.values()].filter((f) => (i['ids'] as string[]).includes(f.id)).map(dto);
      if (i['effective']) items = items.filter((f) => f.effective);
      if (i['hasConflicts']) items = items.filter((f) => f.conflicts.some((c) => c.status === 'open'));
      if (i['expiringWithinDays'])
        items = items.filter(
          (f) =>
            f.state === 'approved' &&
            f.validUntil !== null &&
            Date.parse(f.validUntil) <= Date.now() + (i['expiringWithinDays'] as number) * 86_400_000,
        );
      return { items, nextCursor: null };
    },
  };
  return { handlers, facts };
}

describe('factChecks', () => {
  it('every transition reads back: propose, approve, review, conflict, expiry, withdraw', async () => {
    const w = factWorld();
    const d = await fakeDeployment(w.handlers);
    const results = await factChecks(sessionsFor(d.origin), tenant);
    expect(outcomes(results), JSON.stringify(results)).toEqual([
      ['facts:propose', 'pass'],
      ['facts:approve', 'pass'],
      ['facts:review', 'pass'],
      ['facts:conflict', 'pass'],
      ['facts:expiry', 'pass'],
      ['facts:withdraw', 'pass'],
    ]);
    expect([...w.facts.values()].map((f) => f.state)).toEqual(['revoked', 'superseded', 'revoked']);
  });

  it('a mark-reviewed that answers 200 but stores nothing fails the review step and stops the journey', async () => {
    const w = factWorld('markReviewed');
    const d = await fakeDeployment(w.handlers);
    const results = await factChecks(sessionsFor(d.origin), tenant);
    expect(outcomes(results)).toEqual([
      ['facts:propose', 'pass'],
      ['facts:approve', 'pass'],
      ['facts:review', 'fail'],
    ]);
    expect(results[2]!.detail).toMatch(/^fct_1 next review \S+, expected \S+$/);
  });

  it('a withdraw that does not take fails the withdraw step', async () => {
    const d = await fakeDeployment(factWorld('withdraw').handlers);
    const results = await factChecks(sessionsFor(d.origin), tenant);
    expect(results.at(-1)).toMatchObject({
      name: 'facts:withdraw',
      outcome: 'fail',
      detail: 'fct_1 reads approved, reason none',
    });
  });
});

// ---- uploads: logo and video -------------------------------------------------------------------------------

interface FakeAsset {
  id: string;
  kind: string;
  name: string;
  state: string;
  rightsState: string;
  version: number;
  currentVersion: {
    id: string;
    mime: string;
    width: number | null;
    height: number | null;
    durationMs: number | null;
  };
  derivatives: Array<{ purpose: string }>;
}

/**
 * Upload intents and assets: an accepted upload becomes an asset of the declared kind, pending review, or approved
 * when the uploader holds asset.approve (`uploaderApproves`, spec 9.1 step 8, as the owner does on a deployment).
 * Approve is the asset machine's pending_review transition only, refused otherwise as the service refuses it.
 */
function assetWorld(
  storeOrigin: () => string,
  opts: { reject?: string; existing?: FakeAsset[]; uploaderApproves?: boolean } = {},
) {
  const assets = new Map<string, FakeAsset>((opts.existing ?? []).map((a) => [a.id, a]));
  const intents = new Map<string, { kind: string; mime: string; name: string }>();
  let n = 0;
  const handlers: Record<string, Handler> = {
    'assets.uploads.createIntent': (i) => {
      const id = `upi_${++n}`;
      intents.set(id, {
        kind: i['kind'] as string,
        mime: i['declaredMime'] as string,
        name: i['originalFilename'] as string,
      });
      return { intentId: id, uploadUrl: `${storeOrigin()}/quarantine/${id}?X-Amz-Signature=${SIGNATURE}` };
    },
    'assets.uploads.complete': () => ({ state: 'uploaded' }),
    'assets.uploads.get': (i) => {
      const intent = intents.get(i['intentId'] as string)!;
      if (opts.reject)
        return { state: 'rejected', assetId: null, rejectionReason: opts.reject, rejectionDetail: null };
      const id = `ast_${i['intentId'] as string}`;
      if (!assets.has(id))
        assets.set(id, {
          id,
          kind: intent.kind,
          name: intent.name,
          state: opts.uploaderApproves ? 'approved' : 'pending_review',
          rightsState: 'unknown',
          version: 1,
          currentVersion: {
            id: `av_${id}`,
            mime: intent.mime,
            width: intent.kind === 'video' ? 320 : 300,
            height: intent.kind === 'video' ? 240 : 90,
            durationMs: intent.kind === 'video' ? 2000 : null,
          },
          derivatives: (intent.kind === 'video'
            ? ['thumbnail', 'poster', 'strip', 'proxy']
            : ['thumbnail', 'png']
          ).map((purpose) => ({ purpose })),
        });
      return { state: 'accepted', assetId: id, rejectionReason: null, rejectionDetail: null };
    },
    'assets.get': (i) => assets.get(i['assetId'] as string) ?? new Refusal(404, 'NOT_FOUND', 'no asset'),
    'assets.list': (i) => ({
      items: [...assets.values()].filter((a) => (i['kinds'] as string[]).includes(a.kind)),
      nextCursor: null,
    }),
    'assets.rights.set': (i) => {
      assets.get(i['assetId'] as string)!.rightsState = 'recorded';
      return {};
    },
    'assets.approve': (i) => {
      const a = assets.get(i['assetId'] as string)!;
      if (a.state !== 'pending_review')
        return new Refusal(400, 'VALIDATION_FAILED', 'Validation failed', [
          { path: 'assetId', issue: `asset_${a.state}` },
        ]);
      Object.assign(a, { state: 'approved', version: a.version + 1 });
      return { state: 'approved' };
    },
    'assets.retire': (i) => {
      const a = assets.get(i['assetId'] as string)!;
      Object.assign(a, { state: 'retired', version: a.version + 1 });
      return { state: 'retired' };
    },
  };
  return { handlers, assets };
}

/** The brand side the logo and studio journeys save into. */
function systemWorld(document: BrandSystemDocumentV1) {
  const versions = new Map([
    ['bv_1', { id: 'bv_1', number: 1, state: 'published', document, contentHash: 'h1', version: 1 }],
  ]);
  const brand = { id: 'brd_a', publishedVersionId: 'bv_1', version: 1 };
  let n = 1;
  const handlers: Record<string, Handler> = {
    'brand.get': () => brand,
    'brand.versions.get': (i) =>
      versions.get(i['versionId'] as string) ?? new Refusal(404, 'NOT_FOUND', 'no version'),
    'brand.system.save': (i) => {
      const id = `bv_${++n}`;
      versions.set(id, {
        id,
        number: n,
        state: 'published',
        document: i['document'] as BrandSystemDocumentV1,
        contentHash: `h${n}`,
        version: 1,
      });
      brand.publishedVersionId = id;
      return { versionId: id, changed: true };
    },
  };
  return { handlers, brand, versions };
}

const oldLogo: FakeAsset = {
  id: 'ast_old',
  kind: 'logo',
  name: 'oremedia-acceptance-logo-20261001000000.svg',
  state: 'approved',
  rightsState: 'recorded',
  version: 3,
  currentVersion: { id: 'av_old', mime: 'image/svg+xml', width: 300, height: 90, durationMs: null },
  derivatives: [{ purpose: 'png' }],
};

describe('logoChecks', () => {
  it('uploads a safe SVG, approves it with rights and makes it the primary logo, retiring the earlier one', async () => {
    let store = '';
    const assets = assetWorld(() => store, { existing: [oldLogo] });
    const system = systemWorld(
      brandDocument({
        logoRules: [
          {
            assetId: 'ast_old',
            assetVersionId: 'av_old',
            variant: 'primary',
            allowedBackgroundColourKeys: [],
            clearSpaceRatio: 0.5,
            minWidthPx: 100,
          },
        ],
      }),
    );
    const d = await fakeDeployment({ ...assets.handlers, ...system.handlers });
    store = d.storeOrigin;
    const { results, store: state } = await logoChecks(config(), sessionsFor(d.origin), tenant, {
      pollMs: 1,
    });
    expect(outcomes(results), JSON.stringify(results)).toEqual([
      ['logo:upload', 'pass'],
      ['logo:approve', 'pass'],
      ['logo:primary', 'pass'],
    ]);
    expect(state).toEqual({ usable: true, detail: 'the SVG logo upload reached the store' });
    expect(d.puts[0]!.toString()).toMatch(/^<svg /);
    const applied = system.versions.get(system.brand.publishedVersionId)!.document.logoRules;
    expect(applied).toEqual([
      {
        assetId: 'ast_upi_1',
        assetVersionId: 'av_ast_upi_1',
        variant: 'primary',
        allowedBackgroundColourKeys: ['paper'],
        clearSpaceRatio: 0.25,
        minWidthPx: 120,
        preferredFormat: 'svg',
      },
    ]);
    expect(results[2]!.detail).toContain('(was ast_old); retired earlier acceptance logo(s) ast_old');
    expect(assets.assets.get('ast_old')!.state).toBe('retired');
    noSecrets(results);
  });

  it('an owner’s upload is approved at ingest: the journey records rights and does not approve it again', async () => {
    let store = '';
    const assets = assetWorld(() => store, { uploaderApproves: true });
    const system = systemWorld(brandDocument());
    const d = await fakeDeployment({ ...assets.handlers, ...system.handlers });
    store = d.storeOrigin;
    const { results } = await logoChecks(config(), sessionsFor(d.origin), tenant, { pollMs: 1 });
    expect(outcomes(results), JSON.stringify(results)).toEqual([
      ['logo:upload', 'pass'],
      ['logo:approve', 'pass'],
      ['logo:primary', 'pass'],
    ]);
    expect(results[1]!.detail).toBe(
      'ast_upi_1 approved at ingest (the uploader holds asset.approve) with its rights recorded',
    );
    expect(d.calls).not.toContain('assets.approve');
    expect(assets.assets.get('ast_upi_1')).toMatchObject({ state: 'approved', rightsState: 'recorded' });
  });

  it('a refused approve fails with the validation issue the api named', async () => {
    let store = '';
    const assets = assetWorld(() => store);
    const d = await fakeDeployment({
      ...assets.handlers,
      'assets.approve': () =>
        new Refusal(400, 'VALIDATION_FAILED', 'Validation failed', [
          { path: 'assetId', issue: 'asset_rejected' },
        ]),
    });
    store = d.storeOrigin;
    const { results } = await logoChecks(config(), sessionsFor(d.origin), tenant, { pollMs: 1 });
    expect(results.at(-1)).toMatchObject({ name: 'logo:approve', outcome: 'fail' });
    expect(results.at(-1)!.detail).toMatch(
      /^assets\.approve \(the asset read pending_review at version 1\): HTTP 400 VALIDATION_FAILED: Validation failed \[assetId: asset_rejected\] \(HTTP 400/,
    );
  });

  it('a store that refuses the PUT skips every step with the exact reason and marks the store unusable', async () => {
    let store = '';
    const assets = assetWorld(() => store);
    const d = await fakeDeployment(assets.handlers, { putStatus: 403 });
    store = d.storeOrigin;
    const { results, store: state } = await logoChecks(config(), sessionsFor(d.origin), tenant, {
      pollMs: 1,
    });
    const reason = 'the object store did not take the upload: PUT to the object store: HTTP 403';
    expect(results).toEqual(
      ['logo:upload', 'logo:approve', 'logo:primary'].map((name) => ({
        name,
        outcome: 'skip',
        detail: reason,
      })),
    );
    expect(state).toEqual({ usable: false, reason });
    // An intent the api cannot sign (a store misconfiguration answers INTERNAL) is the store too.
    const d2 = await fakeDeployment({
      'assets.uploads.createIntent': () => new Refusal(500, 'INTERNAL', 'store'),
    });
    const r2 = await logoChecks(config(), sessionsFor(d2.origin), tenant, { pollMs: 1 });
    expect(r2.results.every((r) => r.outcome === 'skip')).toBe(true);
    expect(r2.results[0]!.detail).toContain('assets.uploads.createIntent: HTTP 500 INTERNAL: store');
  });

  it('an ingest rejection fails the upload (the store worked), and a logo without its PNG rendition fails', async () => {
    let store = '';
    const rejected = assetWorld(() => store, { reject: 'svg_script' });
    const d = await fakeDeployment(rejected.handlers);
    store = d.storeOrigin;
    const { results, store: state } = await logoChecks(config(), sessionsFor(d.origin), tenant, {
      pollMs: 1,
    });
    expect(results).toEqual([{ name: 'logo:upload', outcome: 'fail', detail: 'upi_1 rejected: svg_script' }]);
    expect(state.usable).toBe(true);
    const bare = assetWorld(() => store);
    bare.handlers['assets.get'] = (i) => ({ ...bare.assets.get(i['assetId'] as string)!, derivatives: [] });
    const d2 = await fakeDeployment(bare.handlers);
    store = d2.storeOrigin;
    const r2 = await logoChecks(config(), sessionsFor(d2.origin), tenant, { pollMs: 1 });
    expect(r2.results).toMatchObject([
      {
        name: 'logo:upload',
        outcome: 'fail',
        detail: expect.stringContaining('expected a logo kept as SVG with a PNG rendition'),
      },
    ]);
  });
});

describe('ensurePhotoAssetVersion (the Studio browser suite’s hero image)', () => {
  const usable: StoreState = { usable: true, detail: 'ok' };

  it('uploads a PNG photo, records its rights and approves it; the version it returns is approved with rights', async () => {
    let store = '';
    const assets = assetWorld(() => store);
    const d = await fakeDeployment(assets.handlers);
    store = d.storeOrigin;
    const photo = await ensurePhotoAssetVersion(config(), sessionsFor(d.origin), tenant, usable, {
      pollMs: 1,
    });
    expect(photo).toEqual({
      assetVersionId: 'av_ast_upi_1',
      detail: 'uploaded and approved photo ast_upi_1',
    });
    expect(d.puts[0]!.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a'); // a PNG
    expect(assets.assets.get('ast_upi_1')).toMatchObject({
      kind: 'photo',
      state: 'approved',
      rightsState: 'recorded',
    });
    expect(assets.assets.get('ast_upi_1')!.name).toMatch(/^oremedia-acceptance-photo-\d{14}\.png$/);
    expect(d.calls).toContain('assets.approve');
  });

  it('reuses an earlier run’s approved photo with rights, and does not approve again what ingest approved', async () => {
    const earlier: FakeAsset = {
      ...oldLogo,
      id: 'ast_photo',
      kind: 'photo',
      name: 'oremedia-acceptance-photo-20261001000000.png',
      state: 'approved', // set here: the logo journey's test retires the shared oldLogo object
      rightsState: 'recorded',
      currentVersion: { id: 'av_photo', mime: 'image/png', width: 64, height: 64, durationMs: null },
    };
    const reused = assetWorld(() => '', {
      existing: [{ ...earlier, id: 'ast_norights', rightsState: 'unknown' }, earlier],
    });
    const d = await fakeDeployment(reused.handlers);
    expect(await ensurePhotoAssetVersion(config(), sessionsFor(d.origin), tenant, usable)).toEqual({
      assetVersionId: 'av_photo',
      detail: 'approved photo ast_photo',
    });
    expect(d.calls).not.toContain('assets.uploads.createIntent');

    let store = '';
    const atIngest = assetWorld(() => store, { uploaderApproves: true });
    const d2 = await fakeDeployment(atIngest.handlers);
    store = d2.storeOrigin;
    const photo = await ensurePhotoAssetVersion(config(), sessionsFor(d2.origin), tenant, usable, {
      pollMs: 1,
    });
    expect(photo.assetVersionId).toBe('av_ast_upi_1');
    expect(d2.calls).not.toContain('assets.approve');
  });

  it('has none without a usable store, or when ingest rejects the photo, and says why', async () => {
    const d = await fakeDeployment({});
    expect(
      await ensurePhotoAssetVersion(config(), sessionsFor(d.origin), tenant, {
        usable: false,
        reason: 'PUT refused',
      }),
    ).toEqual({ assetVersionId: null, detail: 'PUT refused' });
    expect(d.calls).toEqual([]);
    let store = '';
    const rejected = assetWorld(() => store, { reject: 'image_decode_failed' });
    const d2 = await fakeDeployment(rejected.handlers);
    store = d2.storeOrigin;
    expect(
      await ensurePhotoAssetVersion(config(), sessionsFor(d2.origin), tenant, usable, { pollMs: 1 }),
    ).toEqual({ assetVersionId: null, detail: 'photo upload: upi_1 rejected: image_decode_failed' });
  });
});

describe('videoChecks', () => {
  const usable: StoreState = { usable: true, detail: 'ok' };

  it('uploads the repository clip, reads back duration, poster and proxy, then retires it', async () => {
    let store = '';
    const assets = assetWorld(() => store, {
      existing: [{ ...oldLogo, id: 'ast_clip_old', kind: 'video', name: 'oremedia-acceptance-clip.webm' }],
    });
    const d = await fakeDeployment(assets.handlers);
    store = d.storeOrigin;
    const results = await videoChecks(config(), sessionsFor(d.origin), tenant, usable, { pollMs: 1 });
    expect(outcomes(results), JSON.stringify(results)).toEqual([
      ['video:upload', 'pass'],
      ['video:cleanup', 'pass'],
    ]);
    expect(results[0]!.detail).toBe(
      'ast_upi_1: 2000 ms, 320x240, renditions [thumbnail, poster, strip, proxy]',
    );
    expect(d.puts[0]!.subarray(0, 4).toString('hex')).toBe('1a45dfa3'); // the WebM (EBML) clip itself
    expect(assets.assets.get('ast_clip_old')!.state).toBe('retired'); // an earlier run's leftover first
    expect(assets.assets.get('ast_upi_1')!.state).toBe('retired');
  });

  it('skips with the store’s reason, or when the clip is missing; never passes', async () => {
    const d = await fakeDeployment({});
    expect(
      await videoChecks(config(), sessionsFor(d.origin), tenant, { usable: false, reason: 'PUT refused' }),
    ).toEqual([{ name: 'video:upload', outcome: 'skip', detail: 'PUT refused' }]);
    const missing = await videoChecks(
      { ...config(), repoDir: '/nonexistent' },
      sessionsFor(d.origin),
      tenant,
      usable,
    );
    expect(missing).toMatchObject([
      {
        name: 'video:upload',
        outcome: 'skip',
        detail: expect.stringContaining('no test clip at tooling/test-fixtures/media/clip.webm'),
      },
    ]);
    expect(d.calls).toEqual([]);
  });
});

// ---- Studio ------------------------------------------------------------------------------------------------

/** The creative side: documents and revisions, generation jobs, renders, packages and review requests. */
function studioWorld(
  opts: {
    proposal?: boolean;
    renderFails?: boolean;
    estimateMicros?: number;
    budget?: Parameters<typeof budgetWorld>[0];
    blocking?: { code: string; message: string };
  } = {},
) {
  const b = budgetWorld(opts.budget);
  const estimate = opts.estimateMicros ?? 6_000;
  const system = systemWorld(
    brandDocument({
      tokens: {
        ...brandDocument().tokens,
        typeRoles: [{ role: 'body', fontAssetId: 'ast_font', weight: 400, minSizePx: 16 }],
      },
    }),
  );
  const revisions = new Map<
    string,
    {
      id: string;
      number: number;
      authorKind: string;
      snapshot: CreativeDocumentV1;
      generationInputs: unknown;
    }
  >();
  const doc = { id: 'cdoc_1', currentRevisionId: '' };
  let jobReads = 0;
  let renderReads = 0;
  const commit = (snapshot: CreativeDocumentV1, authorKind: string, generationInputs: unknown = null) => {
    const id = `crev_${revisions.size + 1}`;
    revisions.set(id, { id, number: revisions.size + 1, authorKind, snapshot, generationInputs });
    doc.currentRevisionId = id;
    return { revision: { id } };
  };
  const applyOps = (
    snapshot: CreativeDocumentV1,
    ops: Array<{ op: string; elementId: string; text: string }>,
  ) => ({
    ...snapshot,
    pages: snapshot.pages.map((p) => ({
      ...p,
      elements: p.elements.map((e) => {
        const op = ops.find((o) => o.op === 'setText' && o.elementId === e.id);
        return op && e.type === 'text' ? { ...e, text: op.text } : e;
      }),
    })),
  });
  let headlineId = '';
  const handlers: Record<string, Handler> = {
    ...b.handlers,
    ...system.handlers,
    'assets.fonts.list': () => ({
      items: [{ assetId: 'ast_font', assetVersionId: 'av_font', state: 'approved', family: 'Karla' }],
    }),
    'creative.documents.create': (i) => {
      const snapshot = i['document'] as CreativeDocumentV1;
      headlineId = snapshot.pages[0]!.elements.find((e) => e.semanticRole === 'headline')!.id;
      const { revision } = commit(snapshot, 'user');
      return { documentId: doc.id, revisionId: revision.id };
    },
    'creative.documents.get': () => doc,
    'creative.revisions.get': (i) =>
      revisions.get(i['revisionId'] as string) ?? new Refusal(404, 'NOT_FOUND', 'no revision'),
    'creative.operations.applyBatch': (i) => {
      const base = revisions.get(i['baseRevisionId'] as string)!;
      const ops = i['operations'] as Array<{ op: string; elementId: string; text: string }>;
      const generation = i['generation'] as { jobId: string; groupIds: string[] } | undefined;
      return commit(
        applyOps(base.snapshot, ops),
        i['origin'] as string,
        generation
          ? {
              jobId: generation.jobId,
              acceptedGroupIds: generation.groupIds,
              brandVersionId: 'bv_1',
              costMicros: 900,
            }
          : null,
      );
    },
    // As the service answers: no channel in the brief is a warning; the estimate above what the brand's day or
    // month has left blocks (budget_insufficient).
    'creative.generation.preflight': () => {
      const left = Math.min(
        b.state.day.limitMicros - b.state.day.committedMicros,
        b.state.month.limitMicros - b.state.month.committedMicros,
      );
      const issues = [
        { code: 'no_destination', severity: 'warning', message: 'No destination channel' },
        ...(opts.blocking ? [{ ...opts.blocking, severity: 'blocking' }] : []),
        ...(estimate > left
          ? [{ code: 'budget_insufficient', severity: 'blocking', message: 'More than what remains' }]
          : []),
      ];
      return {
        blocking: issues.some((i) => i.severity === 'blocking'),
        issues,
        cost: { totalMicros: estimate },
      };
    },
    'creative.generation.start': () => ({ id: 'sgj_1', state: 'queued' }),
    'creative.generation.get': () => ({
      id: 'sgj_1',
      state: ++jobReads < 2 ? 'generating' : 'completed',
      costReservedMicros: 6_000,
      costSpentMicros: 900,
      error: null,
      version: 2,
      result: {
        revisions: [],
        refused: [],
        findings: [],
        proposal:
          opts.proposal === false
            ? null
            : {
                baseRevisionId: 'crev_2',
                summary: 'Generated: delivery week',
                operations: [
                  { op: 'setText', pageId: 'p', elementId: headlineId, text: 'Free delivery all week' },
                  { op: 'setText', pageId: 'p', elementId: 'el_other', text: 'Other' },
                ],
                groups: [
                  { id: 'g1', label: 'Headline', operationIndexes: [0], elementIds: [headlineId] },
                  { id: 'g2', label: 'Body', operationIndexes: [1], elementIds: ['el_other'] },
                ],
              },
      },
    }),
    'creative.renders.request': () => ({ renderJobId: 'rjob_1', state: 'pending' }),
    'creative.renders.get': () =>
      ++renderReads < 2
        ? { state: 'rendering', error: null, exports: [] }
        : opts.renderFails
          ? { state: 'failed', error: 'storage unavailable', exports: [] }
          : { state: 'ready', error: null, exports: [{ id: 'rexp_1' }] },
    'content.packages.create': () => ({ contentPackageId: 'cpkg_1', contentRevisionId: 'crv_1' }),
    'content.packages.listForDocument': () => ({
      items: [{ package: { id: 'cpkg_1' }, pinnedRevisionId: doc.currentRevisionId, stale: false }],
    }),
    'content.variants.generate': () => ({ created: ['cvar_1'] }),
    'review.requests.create': () => ({ reviewRequestId: 'rr_1' }),
    'review.requests.get': () => ({ revisionState: 'in_review' }),
  };
  return { handlers, revisions, doc, budget: b.state, system };
}

describe('studioChecks', () => {
  const usable: StoreState = { usable: true, detail: 'ok' };

  it('starter document, a person’s edit, generation with a proposal, one group accepted with inputs, render, review', async () => {
    const w = studioWorld();
    const d = await fakeDeployment(w.handlers);
    const withChannel = { ...tenant, channelConnectionIds: ['chc_1'] };
    const results = await studioChecks(config(), sessionsFor(d.origin), withChannel, usable, 'fixture', {
      pollMs: 1,
    });
    expect(outcomes(results), JSON.stringify(results)).toEqual([
      ['studio:document', 'pass'],
      ['studio:edit', 'pass'],
      ['studio:generate', 'pass'],
      ['studio:accept', 'pass'],
      ['studio:render', 'pass'],
      ['studio:package', 'pass'],
      ['studio:review-request', 'pass'],
    ]);
    const by = Object.fromEntries(results.map((r) => [r.name, r.detail]));
    expect(by['studio:document']).toBe('cdoc_1 from starter post-bold-headline (square_1080)');
    expect(by['studio:generate']).toBe(
      'sgj_1 proposed 2 operation(s) in 2 group(s); estimate 6000 µUSD, cap 200000, day limit 200000 (200000 left); reserved 6000 µUSD, spent 900 of the 200000 cap',
    );
    expect(by['studio:accept']).toBe(
      'group "Headline" accepted as revision crev_3: inputs of sgj_1 (brand version bv_1, cost 900 µUSD)',
    );
    // Only the accepted group's operation reached the document.
    const accepted = w.revisions
      .get('crev_3')!
      .snapshot.pages[0]!.elements.find((e) => e.semanticRole === 'headline');
    expect(accepted?.type === 'text' ? accepted.text : null).toBe('Free delivery all week');
    // The brand's own font was resolved into the starter's text layers.
    const first = w.revisions.get('crev_1')!.snapshot.pages[0]!.elements.filter((e) => e.type === 'text');
    expect(first.every((e) => e.type === 'text' && e.style.fontAssetVersionId === 'av_font')).toBe(true);
  });

  it('an earlier journey’s spend under today’s limit does not block generation: the cap is applied, then the preflight asked again', async () => {
    // As on staging: brand assist set today's limit to committed + cap and spent part of it, leaving less than the
    // generation estimate; the preflight blocks with budget_insufficient until the cap is applied again.
    const w = studioWorld({
      estimateMicros: 162_400,
      budget: { dayLimit: 258_395, dayCommitted: 120_110 },
    });
    const d = await fakeDeployment(w.handlers);
    const results = await studioChecks(config(), sessionsFor(d.origin), tenant, usable, 'fixture', {
      pollMs: 1,
    });
    const by = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(by['studio:generate'], JSON.stringify(results)).toMatchObject({ outcome: 'pass' });
    expect(by['studio:generate']!.detail).toContain('estimate 162400 µUSD, cap 200000, day limit 320110');
    expect(d.calls.filter((c) => c === 'creative.generation.preflight')).toHaveLength(2);
    expect(w.budget.set).toEqual(['day=320110']);
  });

  it('a preflight block other than the budget fails before any limit is changed', async () => {
    const w = studioWorld({
      estimateMicros: 162_400,
      budget: { dayLimit: 258_395, dayCommitted: 120_110 },
      blocking: { code: 'brief_missing_message', message: 'Say what the graphic should achieve' },
    });
    const d = await fakeDeployment(w.handlers);
    const results = await studioChecks(config(), sessionsFor(d.origin), tenant, usable, 'fixture', {
      pollMs: 1,
    });
    expect(results.at(-1)).toMatchObject({ name: 'studio:generate', outcome: 'fail' });
    expect(results.at(-1)!.detail).toContain('brief_missing_message (Say what the graphic should achieve)');
    expect(w.budget.set).toEqual([]);
    expect(d.calls).not.toContain('creative.generation.start');
  });

  it('a budget the cap cannot make room for still fails, naming the preflight and the cap', async () => {
    const w = studioWorld({ estimateMicros: 162_400, budget: { monthLimit: 100_000 } });
    const d = await fakeDeployment({
      ...w.handlers,
      // A month limit the api holds at the entitlement: the raise does not take.
      'agents.budgets.setLimit': (i) =>
        i['period'] === 'month'
          ? new Refusal(400, 'VALIDATION_FAILED', 'above the entitlement')
          : w.handlers['agents.budgets.setLimit']!(i),
    });
    const results = await studioChecks(config(), sessionsFor(d.origin), tenant, usable, 'fixture', {
      pollMs: 1,
    });
    expect(results.at(-1)).toMatchObject({ name: 'studio:generate', outcome: 'fail' });
    expect(d.calls).not.toContain('creative.generation.start');
  });

  it('without a channel the review request skips; with the store unusable the render skips; model off skips generation', async () => {
    const w = studioWorld();
    const d = await fakeDeployment(w.handlers);
    const results = await studioChecks(
      config({ modelBudgetMicros: 0 }),
      sessionsFor(d.origin),
      tenant,
      { usable: false, reason: 'PUT refused' },
      'no certified provider',
      { pollMs: 1 },
    );
    expect(outcomes(results)).toEqual([
      ['studio:document', 'pass'],
      ['studio:edit', 'pass'],
      ['studio:generate', 'skip'],
      ['studio:accept', 'skip'],
      ['studio:render', 'skip'],
      ['studio:package', 'pass'],
      ['studio:review-request', 'skip'],
    ]);
    expect(results[4]!.detail).toBe('PUT refused');
    expect(results[6]!.detail).toBe(
      'no usable channel connection on the fixture brand (no certified provider)',
    );
    expect(d.calls).not.toContain('creative.generation.start');
  });

  it('a generation that saves no proposal fails, and a failed render fails with its error', async () => {
    const none = studioWorld({ proposal: false });
    const d = await fakeDeployment(none.handlers);
    const results = await studioChecks(config(), sessionsFor(d.origin), tenant, usable, 'x', { pollMs: 1 });
    expect(results.at(-1)).toMatchObject({
      name: 'studio:generate',
      outcome: 'fail',
      detail: expect.stringContaining('sgj_1 completed without a proposal on revision crev_2'),
    });
    const broken = studioWorld({ renderFails: true });
    const d2 = await fakeDeployment(broken.handlers);
    const r2 = await studioChecks(config(), sessionsFor(d2.origin), tenant, usable, 'x', { pollMs: 1 });
    expect(r2.find((r) => r.name === 'studio:render')).toEqual({
      name: 'studio:render',
      outcome: 'fail',
      detail: 'rjob_1 failed: storage unavailable',
    });
  });

  it('with no approved font face to be had, every step skips with the reason', async () => {
    const w = studioWorld();
    w.handlers['assets.fonts.list'] = () => ({ items: [] });
    w.handlers['assets.fonts.importGoogle'] = () => new Refusal(500, 'INTERNAL', 'store unreachable');
    const d = await fakeDeployment(w.handlers);
    const results = await studioChecks(config(), sessionsFor(d.origin), tenant, usable, 'x', { pollMs: 1 });
    expect(results.map((r) => r.outcome)).toEqual(Array(7).fill('skip'));
    expect(results[0]!.detail).toMatch(
      /^no approved font face: font import: HTTP 500 INTERNAL: store unreachable/,
    );
  });
});
