import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import {
  approvedFacts,
  brandAssistJobs,
  brands,
  brandSources,
  brandVersions,
  policyVersions,
} from '@oremedia/db/schema/brand';
import { memberships, sessions, tenants, users } from '@oremedia/db/schema/access';
import { runInTenant } from '@oremedia/db';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { registerSkillResolver, type ResolvedSkill } from '@oremedia/ai';
import { loadBuiltinPackage, seedBuiltinSkills } from '@oremedia/module-skills';
import { budgets } from '@oremedia/module-billing';
import { resolveTenantContext } from '@oremedia/module-access';
import { createBrandAssistRuntime, registerAssistModelGate } from '@oremedia/module-brand';
import { BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import type { BrandAssistModelV1 } from '@oremedia/contracts/brand-assist';
import {
  configureCredentialBroker,
  configureChannelActivation,
  configurePublishingProviders,
  FixtureProviderAdapter,
  LocalKms,
  registerProviderClients,
  FIXTURE_PROVIDER_KEY,
} from '@oremedia/module-publishing';
import { ProviderRegistry } from '@oremedia/providers';
import type { AcceptanceConfig } from '../../../tooling/scripts/acceptance/config';
import {
  ensureTaskKindSkill,
  isolationChecks,
  journeyChecks,
  prepareModelEvalBudget,
  sessionKey,
  signInFixtures,
} from './acceptance/checks';
import { mutate, query, signInWithPassword, sleep } from './acceptance/client';
import { brandSystemChecks, factChecks, logoChecks, videoChecks } from './acceptance/feature-checks';
import {
  FIXTURE_ROLES,
  FIXTURE_TENANTS,
  fixtureEmail,
  provisionFixtures,
  provisionTenant,
  teardownFixtures,
  type FixtureTenant,
} from './acceptance/fixtures';
import { composeModules } from './composition';
import { createServer } from './server';
import { configureRateLimiter } from './trpc';

/**
 * The staging acceptance fixtures against MySQL and the real Express app (docs/runbooks/staging-acceptance.md):
 * provisioning is idempotent (a second run finds every row and creates nothing), every generated credential signs
 * in through the deployed password endpoint with the Origin the api expects, the earlier run's password stops
 * working, the api checks the job runs (isolation, the review journey) pass against the fixtures, and the teardown
 * leaves nothing usable behind. No credential is printed by any of it.
 */
describe('staging acceptance fixtures and checks (in-process api)', () => {
  let tdb: TestDatabase;
  let http: Server;
  let origin = '';
  const DOMAIN = 'example.test';

  beforeAll(async () => {
    tdb = await createTestDatabase();
    configureRateLimiter();
    composeModules();
    await seedBuiltinSkills(); // the platform built-ins exist on staging (seeded at deploy); the fixture imports its own copy
    http = createHttpServer();
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    http.on('request', createServer({ auth: null, webOrigin: origin }));
  });
  afterAll(async () => {
    await new Promise<void>((r) => http.close(() => r()));
    await tdb?.drop();
  });

  const config = (): AcceptanceConfig => ({
    databaseUrl: tdb.url,
    webOrigin: origin,
    apiBaseUrl: origin,
    emailDomain: DOMAIN,
    disabledChannels: new Set(),
    repoDir: process.cwd(),
    e2e: { enabled: false },
    load: { enabled: false, expectedPeak: 1, peakMultiplier: 1 },
    modelEval: { enabled: false, taskKinds: [], timeoutMs: 1000, budgetMicros: 0 },
    settle: { revision: null, timeoutMs: 1000 },
    journeys: { modelBudgetMicros: 200_000, timeoutMs: 30_000 },
  });

  const ids = (t: FixtureTenant) => ({
    tenantId: t.tenantId,
    operatorUserId: t.operatorUserId,
    members: Object.fromEntries(
      Object.values(t.members).map((m) => [
        m.role,
        { membershipId: m.membershipId, userId: m.userId, email: m.email },
      ]),
    ),
    brandId: t.brandId,
    publishedVersionId: t.publishedVersionId,
    policyVersionId: t.policyVersionId,
    servicePrincipalId: t.servicePrincipalId,
  });

  let first: FixtureTenant[] = [];
  let second: FixtureTenant[] = [];

  it('provisions two companies with a member per role, a published brand version, an active policy and an agent', async () => {
    first = await provisionFixtures({ emailDomain: DOMAIN, webOrigin: origin });
    expect(first.map((t) => t.slug)).toEqual(FIXTURE_TENANTS.map((t) => t.slug));
    for (const t of first) {
      expect(Object.keys(t.members).sort()).toEqual([...FIXTURE_ROLES].sort());
      for (const m of Object.values(t.members)) {
        expect(m.email).toBe(fixtureEmail(t.slug, m.role, DOMAIN));
        expect(m.password.length).toBeGreaterThanOrEqual(12);
      }
      const [tenant] = await tdb.db.select().from(tenants).where(eq(tenants.id, t.tenantId));
      expect(tenant).toMatchObject({ slug: t.slug, name: t.name, status: 'active' });
      const rows = await tdb.db.select().from(memberships).where(eq(memberships.tenantId, t.tenantId));
      // The operator (owner, no password) plus one active member per role; every invitation was claimed.
      expect(rows).toHaveLength(FIXTURE_ROLES.length + 1);
      expect(rows.every((m) => m.status === 'active')).toBe(true);
      const [brand] = await tdb.db.select().from(brands).where(eq(brands.id, t.brandId));
      expect(brand).toMatchObject({ status: 'active', publishedVersionId: t.publishedVersionId });
      const [version] = await tdb.db
        .select()
        .from(brandVersions)
        .where(eq(brandVersions.id, t.publishedVersionId));
      expect(version).toMatchObject({ brandId: t.brandId, state: 'published' });
      const [policy] = await tdb.db
        .select()
        .from(policyVersions)
        .where(eq(policyVersions.id, t.policyVersionId));
      expect(policy).toMatchObject({ brandId: t.brandId, state: 'active' });
      expect(t.channelConnectionIds).toEqual([]); // no certified provider: never a real account
      const [operator] = await tdb.db.select().from(users).where(eq(users.id, t.operatorUserId));
      expect(operator?.passwordHash).toBeNull();
    }
    // Two different companies, two different brands.
    expect(first[0]!.tenantId).not.toBe(first[1]!.tenantId);
    expect(first[0]!.brandId).not.toBe(first[1]!.brandId);
  }, 120_000);

  it('a second run is idempotent: the same rows, fresh passwords, and the earlier passwords no longer sign in', async () => {
    second = await provisionFixtures({ emailDomain: DOMAIN, webOrigin: origin });
    expect(second.map(ids)).toEqual(first.map(ids));
    for (const [i, t] of second.entries()) {
      const before = first[i]!;
      for (const m of Object.values(t.members)) {
        expect(m.password).not.toBe(before.members[m.role].password);
        const stale = await signInWithPassword(origin, m.email, before.members[m.role].password);
        expect(stale).toMatchObject({ ok: false, status: 401 });
      }
      const rows = await tdb.db.select().from(memberships).where(eq(memberships.tenantId, t.tenantId));
      expect(rows).toHaveLength(FIXTURE_ROLES.length + 1);
      const versions = await tdb.db.select().from(brandVersions).where(eq(brandVersions.brandId, t.brandId));
      expect(versions).toHaveLength(1);
    }
    // The in-process redemptions left no session behind: only the HTTP sign-ins below create any.
    for (const t of second)
      for (const m of Object.values(t.members)) {
        const live = (await tdb.db.select().from(sessions).where(eq(sessions.userId, m.userId))).filter(
          (s) => !s.revokedAt,
        );
        expect(live).toEqual([]);
      }
  }, 120_000);

  it('every generated credential signs in through /auth/password/sign-in, and the api checks pass on the fixtures', async () => {
    const cfg = config();
    configureRateLimiter(); // a fresh window: the password route is limited per address (the stale attempts above)
    const signedIn = await signInFixtures(cfg, second);
    expect(signedIn.results.map((r) => r.outcome)).toEqual(signedIn.results.map(() => 'pass'));
    expect(signedIn.results).toHaveLength(FIXTURE_TENANTS.length * FIXTURE_ROLES.length);
    expect(signedIn.sessions.size).toBe(FIXTURE_TENANTS.length * FIXTURE_ROLES.length);
    for (const s of signedIn.sessions.values()) expect(s.token).toMatch(/^ses_/);

    const [a, b] = second as [FixtureTenant, FixtureTenant];
    const isolation = await isolationChecks(signedIn.sessions, a, b);
    expect(isolation.map((r) => [r.name, r.outcome])).toEqual([
      ['isolation:brand-get', 'pass'],
      ['isolation:tenant-header', 'pass'],
      ['isolation:brand-list', 'pass'],
    ]);
    // No certified provider in the registry, so no channel: the package is created and the rest is skipped, not failed.
    const journey = await journeyChecks(signedIn.sessions, a, 'no certified provider');
    expect(journey.map((r) => [r.name, r.outcome])).toEqual([
      ['journey:package-create', 'pass'],
      ['journey:variants', 'skip'],
      ['journey:review-request', 'skip'],
      ['journey:external-reviewer-link', 'skip'],
      ['journey:external-reviewer-read', 'skip'],
      ['journey:approve', 'skip'],
      ['journey:schedule', 'skip'],
    ]);
    expect(journey.every((r) => r.outcome !== 'skip' || r.detail.includes('no certified provider'))).toBe(
      true,
    );
    // No detail carries a session token, a reviewer link token or a password.
    const everything = [...signedIn.results, ...isolation, ...journey].map((r) => r.detail).join('\n');
    for (const s of signedIn.sessions.values()) expect(everything).not.toContain(s.token);
    for (const t of second)
      for (const m of Object.values(t.members)) expect(everything).not.toContain(m.password);
    expect(everything).not.toMatch(/\brl_/);
  }, 120_000);

  it('with a certified channel on the fixture brand the journey runs to a scheduled, then cancelled, publication', async () => {
    // The test fixture provider stands in for a certified channel (never registered in production: staging has
    // none today, so the job skips these steps there). Connected through the deployed connect path as a publisher.
    configurePublishingProviders({
      registry: new ProviderRegistry().register(new FixtureProviderAdapter()),
      insecureAllowLoopback: true,
    });
    configureCredentialBroker({ kms: new LocalKms('acceptance-test-master-secret-0123456789') });
    registerProviderClients(() => ({ clientId: 'fixture-client', clientSecret: 'fixture-secret' }));
    // RA-01: the api composed its activation from the environment, where the fixture provider's app credentials
    // are not named; the clients above stand in for them, so the provider counts as ready here.
    configureChannelActivation(() => ({ disabled: false, credentialRefs: [] }));
    configureRateLimiter();
    const [a] = second as [FixtureTenant, FixtureTenant];
    let signedIn = await signInFixtures(config(), [a]);
    const publisher = signedIn.sessions.get(sessionKey(a, 'publisher'))!;
    const started = await mutate<{ state: string }>(publisher, 'publishing.channels.connect.start', {
      brandId: a.brandId,
      providerKey: FIXTURE_PROVIDER_KEY,
      redirectUri: `${origin}/connect/callback`,
    });
    expect(started.error).toBe('');
    const completed = await mutate<{ outcome: string }>(publisher, 'publishing.channels.connect.complete', {
      state: started.data!.state,
      code: 'good',
    });
    expect(completed.data?.outcome).toBe('connected');

    // A third provisioning finds the connection (and, as every run does, rotates the passwords: new sessions).
    const [spec] = FIXTURE_TENANTS;
    const again = await provisionTenant(spec, { emailDomain: DOMAIN, webOrigin: origin });
    expect(ids(again)).toEqual(ids(a));
    expect(again.channelConnectionIds).toHaveLength(1);
    second = [again, second[1]!];
    configureRateLimiter();
    signedIn = await signInFixtures(config(), [again]);
    const journey = await journeyChecks(signedIn.sessions, again, 'fixture provider');
    expect(journey.map((r) => [r.name, r.outcome])).toEqual([
      ['journey:package-create', 'pass'],
      ['journey:variants', 'pass'],
      ['journey:review-request', 'pass'],
      ['journey:external-reviewer-link', 'pass'],
      ['journey:external-reviewer-read', 'pass'],
      ['journey:approve', 'pass'],
      ['journey:schedule', 'pass'],
      ['journey:schedule-cancel', 'pass'],
    ]);
    const everything = journey.map((r) => r.detail).join('\n');
    expect(everything).not.toMatch(/\b(rl|ses)_/);
  }, 120_000);

  it('facts: propose, approve, review, conflict, expiry and withdraw, each read back, and again on a rerun', async () => {
    configureRateLimiter();
    const [a] = second as [FixtureTenant, FixtureTenant];
    const { sessions: signedIn } = await signInFixtures(config(), [a]);
    const steps = [
      ['facts:propose', 'pass'],
      ['facts:approve', 'pass'],
      ['facts:review', 'pass'],
      ['facts:conflict', 'pass'],
      ['facts:expiry', 'pass'],
      ['facts:withdraw', 'pass'],
    ];
    const first = await factChecks(signedIn, a);
    expect(
      first.map((r) => [r.name, r.outcome]),
      JSON.stringify(first),
    ).toEqual(steps);
    const rows = await tdb.db.select().from(approvedFacts).where(eq(approvedFacts.brandId, a.brandId));
    // The withdrawn fact, the superseded rival and the expired fact withdrawn as cleanup: nothing stays in force.
    expect(rows.map((f) => f.state).sort()).toEqual(['revoked', 'revoked', 'superseded']);
    await sleep(1100); // the next run's marker (to the second) differs, so its statements are new facts
    const again = await factChecks(signedIn, a);
    expect(
      again.map((r) => [r.name, r.outcome]),
      JSON.stringify(again),
    ).toEqual(steps);
  }, 120_000);

  it('logo and video: without an object store the upload steps skip with the reason, never pass', async () => {
    configureRateLimiter();
    const [a] = second as [FixtureTenant, FixtureTenant];
    const { sessions: signedIn } = await signInFixtures(config(), [a]);
    const logo = await logoChecks(config(), signedIn, a, { pollMs: 10 });
    expect(logo.results.map((r) => [r.name, r.outcome])).toEqual([
      ['logo:upload', 'skip'],
      ['logo:approve', 'skip'],
      ['logo:primary', 'skip'],
    ]);
    expect(logo.results[0]!.detail).toMatch(/^the object store did not take the upload: /);
    expect(logo.store).toMatchObject({ usable: false });
    const video = await videoChecks(config(), signedIn, a, logo.store, { pollMs: 10 });
    expect(video).toEqual([{ name: 'video:upload', outcome: 'skip', detail: logo.results[0]!.detail }]);
  }, 120_000);

  it('brand system: a setup job through the worker runtime, a suggestion accepted and applied with provenance, then restored', async () => {
    configureRateLimiter();
    const [a] = second as [FixtureTenant, FixtureTenant];
    const { sessions: signedIn } = await signInFixtures(config(), [a]);
    registerAssistModelGate({
      describe: () => ({
        provider: 'fake',
        model: 'scripted',
        maxOutputTokens: 2000,
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 2_000_000,
      }),
      assertRouting: async () => {},
    });
    // The model worker-core calls on staging, scripted: one principle quoted from the pasted notes.
    const model: BrandAssistModelV1 = {
      async propose(req) {
        const evidence = req.evidence[0]!;
        const quote = /One of our principles: "([^"]+)"/.exec(evidence.text)![1]!;
        return {
          raw: {
            personality: [],
            principles: [
              {
                value: { statement: quote, rationale: 'The notes state it.' },
                rationale: 'Stated in the voice notes.',
                basis: 'stated',
                confidence: 'high',
                evidence: [{ sourceId: evidence.id, excerpt: quote }],
              },
            ],
            styleRules: [],
            claimRules: [],
            remove: [],
            questions: [],
          },
          parseError: null,
          usage: { inputTokens: 900, outputTokens: 150 },
          costMicros: 1200,
        };
      },
    };
    const owner = a.members.owner;
    const requester = await resolveTenantContext(
      { kind: 'user', userId: owner.userId, sessionId: 'acceptance-test', selectedTenantId: a.tenantId },
      a.tenantId,
      'acceptance-test',
    );
    /** The workflow's steps for the job the check starts, as worker-core runs them (brandAssistWorkflowV1). */
    const driveQueuedJob = async () => {
      for (let i = 0; i < 400; i++) {
        const [job] = await tdb.db
          .select()
          .from(brandAssistJobs)
          .where(and(eq(brandAssistJobs.brandId, a.brandId), eq(brandAssistJobs.state, 'queued')));
        if (job) {
          const rt = createBrandAssistRuntime({ model });
          const inp = {
            tenantId: a.tenantId,
            actor: { kind: 'user' as const, id: owner.userId },
            correlationId: 'acceptance-test',
            brandId: a.brandId,
            jobId: job.id,
          };
          await runInTenant(requester.context, async () => {
            await rt.beginBrandAssist(inp);
            const prepared = await rt.prepareBrandAssistProposals(inp, requester.actor);
            for (const section of prepared.sections) await rt.proposeBrandAssistSection({ ...inp, section });
            await rt.finishBrandAssist({ ...inp, cancelled: false, failure: prepared.reason });
          });
          return job.id;
        }
        await sleep(25);
      }
      throw new Error('the check started no assist job');
    };
    const [before] = await tdb.db.select().from(brands).where(eq(brands.id, a.brandId));
    const [results, jobId] = await Promise.all([
      brandSystemChecks(config(), signedIn, a, { pollMs: 20 }),
      driveQueuedJob(),
    ]);
    expect(
      results.map((r) => [r.name, r.outcome]),
      JSON.stringify(results),
    ).toEqual([
      ['brand-system:source', 'pass'],
      ['brand-system:budget', 'pass'],
      ['brand-system:assist', 'pass'],
      ['brand-system:accept', 'pass'],
      ['brand-system:publish', 'pass'],
      ['brand-system:provenance', 'pass'],
      ['brand-system:restore', 'pass'],
    ]);
    const by = Object.fromEntries(results.map((r) => [r.name, r.detail]));
    expect(by['brand-system:assist']).toContain(jobId);
    expect(by['brand-system:assist']).toMatch(/spent 1200 µUSD of the 200000 cap/);
    expect(by['brand-system:provenance']).toMatch(
      /^voice\.principles#Say run \d{14} out loud: origin \w+, suggestion bsug_/,
    );
    // The day limit is what today already committed plus the cap.
    const day = (
      await query<{ day: { limitMicros: number; committedMicros: number } }>(
        signedIn.get(sessionKey(a, 'owner'))!,
        'agents.budgets.read',
        { brandId: a.brandId },
      )
    ).data!.day;
    expect(day.limitMicros).toBeLessThanOrEqual(day.committedMicros + 200_000);
    // The brand system is what it was before the journey (a new version with the same content), and the source is gone.
    const [after] = await tdb.db.select().from(brands).where(eq(brands.id, a.brandId));
    expect(after!.publishedVersionId).not.toBe(before!.publishedVersionId);
    const [was] = await tdb.db
      .select()
      .from(brandVersions)
      .where(eq(brandVersions.id, before!.publishedVersionId!));
    const [now] = await tdb.db
      .select()
      .from(brandVersions)
      .where(eq(brandVersions.id, after!.publishedVersionId!));
    expect(now!.contentHash).toBe(was!.contentHash);
    expect(BrandSystemDocumentV1.parse(now!.document).voice.principles ?? []).toEqual([]);
    const sources = await tdb.db.select().from(brandSources).where(eq(brandSources.brandId, a.brandId));
    expect(sources.every((src) => src.removedAt !== null)).toBe(true);
  }, 120_000);

  /**
   * The copywriting skill a run would resolve, as the agents module's own tests stand it in (a published, bound
   * skill needs a graded evaluation, which worker-core runs with a model): its budget is what a run reserves.
   */
  const copywritingSkill: ResolvedSkill = {
    skillVersionId: 'sv_01HACCEPTANCESKILL00000000',
    skillId: 'skl_01HACCEPTANCESKILL0000000',
    key: 'acceptance-copywriting',
    versionNumber: 1,
    manifest: {
      schemaVersion: 1,
      key: 'acceptance-copywriting',
      title: 'Acceptance copywriting',
      description: 'test',
      taskKinds: ['copywriting'],
      inputSchema: {},
      outputSchema: { type: 'object' },
      requiredContext: ['brand_snapshot'],
      allowedTools: ['brand.getSnapshot', 'facts.list'],
      budgets: {
        maxSteps: 6,
        maxTokens: 100_000,
        maxCostMicros: 2_000_000,
        maxVariants: 3,
        deadlineSeconds: 900,
      },
      modelCompatibility: [],
      instructionsPath: 'SKILL.md',
    },
    instructions: 'Write on-brand copy citing approved facts.',
    references: [],
  };

  it('model evaluation: the built-in copywriting skill is imported for the company and its evaluation requested, once', async () => {
    configureRateLimiter();
    const [a] = second as [FixtureTenant, FixtureTenant];
    const { sessions: signedIn } = await signInFixtures(config(), [a]);
    const owner = signedIn.get(sessionKey(a, 'owner'))!;
    type Skill = { id: string; key: string; versions: Array<{ number: number; state: string }> };
    const tenantSkills = async () =>
      (
        await query<{ items: Array<{ id: string; key: string }> }>(owner, 'skills.list', {
          scope: 'tenant',
          page: { limit: 100 },
        })
      ).data!.items.filter((s) => s.key === 'brand-copywriting');
    expect(await tenantSkills()).toEqual([]);
    // No worker grades the evaluation here: the helper imports, requests the evaluation and reports the wait.
    const first = await ensureTaskKindSkill(owner, a, 'copywriting', { timeoutMs: 1, pollMs: 1 });
    expect(first).toMatchObject({ ok: false, reason: expect.stringContaining('did not pass') });
    const [imported] = await tenantSkills();
    expect(imported).toBeDefined();
    // The company's copy, not the platform built-in of the same key (which skills.list at tenant scope omits).
    const platform = (
      await query<{ items: Array<{ id: string; key: string; scope: string }> }>(owner, 'skills.list', {
        scope: 'platform',
        page: { limit: 100 },
      })
    ).data!.items.find((s) => s.key === 'brand-copywriting');
    expect(platform).toBeDefined();
    expect(imported!.id).not.toBe(platform!.id);
    const got = (await query<Skill>(owner, 'skills.get', { skillId: imported!.id })).data!;
    expect(got.versions).toEqual([expect.objectContaining({ number: 1, state: 'sandbox_evaluation' })]);
    // A second run finds the company's copy and imports nothing.
    const again = await ensureTaskKindSkill(owner, a, 'copywriting', { timeoutMs: 1, pollMs: 1 });
    expect(again).toMatchObject({ ok: false, reason: expect.stringContaining('sandbox_evaluation') });
    expect(await tenantSkills()).toHaveLength(1);
    expect((await query<Skill>(owner, 'skills.get', { skillId: imported!.id })).data!.versions).toHaveLength(
      1,
    );
    expect(await ensureTaskKindSkill(owner, a, 'brand_review', { timeoutMs: 1 })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no built-in skill'),
    });
  }, 120_000);

  it('model evaluation: a company copy imported from an older package gets the current package as its next version, and that version is evaluated', async () => {
    configureRateLimiter();
    const [, b] = second as [FixtureTenant, FixtureTenant];
    const { sessions: signedIn } = await signInFixtures(config(), [b]);
    const owner = signedIn.get(sessionKey(b, 'owner'))!;
    type Version = { id: string; number: number; state: string; packageHash: string };
    type Skill = { id: string; key: string; versions: Version[] };
    // An earlier build's package: the same key with other instructions and cases (staging's copy was imported
    // before the brand-copywriting package and its injection case changed, and kept being graded as version 1).
    const pkg = await loadBuiltinPackage('brand-copywriting');
    const older = await mutate<{ skillId: string }>(owner, 'skills.import', {
      files: pkg.files.map((f) =>
        f.path === 'SKILL.md' ? { ...f, content: `${f.content}\n\nAn earlier revision.\n` } : f,
      ),
      scope: 'tenant',
      cases: pkg.cases.map((c) => ({ ...c, title: `${c.title} (earlier)` })),
    });
    expect(older.status).toBe(200);
    const skillId = older.data!.skillId;
    const versions = async () =>
      (await query<Skill>(owner, 'skills.get', { skillId })).data!.versions.sort(
        (x, y) => x.number - y.number,
      );
    const [v1] = await versions();
    expect(v1).toMatchObject({ number: 1, state: 'draft' });

    const first = await ensureTaskKindSkill(owner, b, 'copywriting', { timeoutMs: 1, pollMs: 1 });
    expect(first).toMatchObject({
      ok: false,
      reason: expect.stringContaining('(version 2 is draft'),
    });
    const [old, current] = await versions();
    // Version 1 is left as it was; version 2 pins this build's package and is the one sent for grading.
    expect(old).toMatchObject({ id: v1!.id, state: 'draft', packageHash: v1!.packageHash });
    expect(current).toMatchObject({ number: 2, state: 'sandbox_evaluation' });
    expect(current!.packageHash).not.toBe(v1!.packageHash);
    // It pins the content this build ships, not the earlier revision.
    const exported = await query<{ files: Array<{ path: string; content: string }> }>(
      owner,
      'skills.export',
      {
        skillVersionId: current!.id,
      },
    );
    expect(exported.data!.files.find((f) => f.path === 'SKILL.md')!.content).not.toContain(
      'An earlier revision.',
    );

    // A re-run finds the current version and imports nothing more.
    const again = await ensureTaskKindSkill(owner, b, 'copywriting', { timeoutMs: 1, pollMs: 1 });
    expect(again).toMatchObject({
      ok: false,
      reason: expect.stringContaining('version 2 is sandbox_evaluation'),
    });
    expect(await versions()).toHaveLength(2);
  }, 120_000);

  it('model evaluation: the budget preparation makes room for the run under a tight brand day limit', async () => {
    configureRateLimiter();
    registerSkillResolver(async () => [copywritingSkill]);
    const [a] = second as [FixtureTenant, FixtureTenant];
    const { sessions: signedIn } = await signInFixtures(config(), [a]);
    const owner = signedIn.get(sessionKey(a, 'owner'))!;
    const limits = {
      brandId: a.brandId,
      servicePrincipalId: a.servicePrincipalId,
      taskKind: 'copywriting',
      requestedAutonomy: 'create' as const,
    };
    type Limits = { reservedMicros: number; canStart: boolean; blockers: Array<{ code: string }> };
    // A day limit below what one run reserves: the api refuses the start, and the reservation itself.
    expect(
      (await mutate(owner, 'agents.budgets.setLimit', { brandId: a.brandId, period: 'day', limitMicros: 1 }))
        .status,
    ).toBe(200);
    const tight = (await query<Limits>(owner, 'agents.runs.effectiveLimits', limits)).data!;
    expect(tight.reservedMicros).toBeGreaterThan(0);
    expect(tight.canStart).toBe(false);
    expect(tight.blockers.map((b) => b.code)).toContain('budget_exhausted_day');
    const ctx = {
      tenantId: a.tenantId,
      actor: { kind: 'user' as const, id: a.members.owner.userId },
      brandIds: 'all' as const,
      correlationId: 'acceptance-test',
    };
    const deadline = new Date(Date.now() + 60_000);
    await expect(
      runInTenant(ctx, () =>
        budgets.reserveSpend(a.brandId, 'run_acceptance_tight', tight.reservedMicros, deadline),
      ),
    ).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });

    const room = await prepareModelEvalBudget(owner, a, 'copywriting', 250_000);
    expect(room, JSON.stringify(room)).toMatchObject({ ok: true, reservedMicros: tight.reservedMicros });
    if (!room.ok) throw new Error(room.reason);
    expect(room.dayLimitMicros).toBeGreaterThanOrEqual(tight.reservedMicros * 2);
    const ready = (await query<Limits>(owner, 'agents.runs.effectiveLimits', limits)).data!;
    expect(ready.canStart).toBe(true);
    // The reservation a run makes now fits, and a second preparation accounts for what it still holds.
    const held = await runInTenant(ctx, () =>
      budgets.reserveSpend(a.brandId, 'run_acceptance_held', tight.reservedMicros, deadline),
    );
    expect(held.reservedMicros).toBe(tight.reservedMicros);
    const again = await prepareModelEvalBudget(owner, a, 'copywriting', 250_000);
    expect(again).toMatchObject({ ok: true });
    expect((await query<Limits>(owner, 'agents.runs.effectiveLimits', limits)).data!.canStart).toBe(true);
  }, 120_000);

  it('teardown locks every fixture account: the passwords stop working and every session is revoked', async () => {
    const results = await teardownFixtures({ emailDomain: DOMAIN, webOrigin: origin });
    expect(results.map((r) => [r.name, r.outcome])).toEqual(
      FIXTURE_TENANTS.map((t) => [`teardown:${t.slug}`, 'pass']),
    );
    configureRateLimiter();
    for (const t of second)
      for (const m of Object.values(t.members)) {
        expect(await signInWithPassword(origin, m.email, m.password)).toMatchObject({
          ok: false,
          status: 401,
        });
        const live = (await tdb.db.select().from(sessions).where(eq(sessions.userId, m.userId))).filter(
          (s) => !s.revokedAt,
        );
        expect(live).toEqual([]);
      }
  }, 120_000);
});
