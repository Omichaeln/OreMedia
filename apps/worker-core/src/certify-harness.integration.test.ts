import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixtureCmsAdapter, FixtureSourceAdapter, fixtureArticleHash } from '@oremedia/module-destinations';
import { FixtureProviderAdapter } from '@oremedia/module-publishing';
import { createProviderIO, type ProviderIO } from '@oremedia/providers';
import {
  cmsConnect,
  cmsDelete,
  cmsRevoke,
  cmsUnpublish,
  cmsUpdate,
  cmsVerify,
  cmsWrite,
} from '../../../tooling/scripts/certify/cms';
import {
  REQUIRED_STEPS,
  attest,
  authUrl,
  comments,
  exchange,
  fileStore,
  find,
  metrics,
  missingSteps,
  pendingStep,
  publish,
  refresh,
  revoke,
  status,
  type CertificationRecord,
  type CertifyBaseDeps,
  type CertifyDeps,
  type CmsDeps,
  type SourceDeps,
} from '../../../tooling/scripts/certify/harness';
import {
  sourceAuthUrl,
  sourceExchange,
  sourceRead,
  sourceRefresh,
  sourceRevoke,
  sourceTargets,
} from '../../../tooling/scripts/certify/source';

/**
 * RA-01: the certification harness end to end, per provider kind, against the fixture adapters (the same ones
 * the publishing and destinations integration tests use), through the session file store and the real
 * ProviderIO: every required step of each kind passes in order, `attest` refuses before the last step passed and
 * writes the record once it has, and nothing in the session, the output or the record is a credential. The
 * harness never sets `certifiedAt` anywhere: the record is what a person edits the capability from.
 */
const TOKENS = [
  'at_fixture_secret',
  'rt_fixture_secret',
  'at_fixture_src',
  'rt_fixture_src',
  'app pass word',
];
const CLIENT = { clientId: 'fixture-client', clientSecret: 'fixture-secret' };

describe('certification harness against the fixture adapters (RA-01, CI)', () => {
  let root = '';
  let io: ProviderIO;
  const lines: string[] = [];
  const base = <K extends CertifyBaseDeps['kind']>(kind: K, key: string): CertifyBaseDeps & { kind: K } => {
    const store = fileStore(root, key);
    return {
      kind,
      key,
      io,
      client: () => CLIENT,
      load: store.load,
      save: store.save,
      now: () => new Date(),
      out: (l) => lines.push(l),
      recordingsFile: path.join(root, '.certify', key, 'recordings', 'test.json'),
    };
  };
  const written: CertificationRecord[] = [];

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'certify-ci-'));
    io = createProviderIO({
      providerKey: 'fixture',
      tenantId: 'certification',
      timeoutMs: 5_000,
      limiter: { acquire: async () => undefined },
      insecureAllowLoopback: true, // the fixture provider's post-creating call goes to a loopback endpoint
    });
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    const everything = `${lines.join('\n')}\n${JSON.stringify(written)}`;
    for (const token of TOKENS) expect(everything).not.toContain(token);
  });

  it('channel: connect, publish with its read-back, refresh, metrics, comments, revoke proven by the refused refresh; then attest', async () => {
    const adapter = new FixtureProviderAdapter({
      analytics: { post: ['likes'], account: [], latencyHours: 1 },
      comments: { read: true, reply: false },
    });
    adapter.behaviour = { kind: 'accept' };
    const deps: CertifyDeps = { ...base('channel', adapter.key), adapter };
    expect(() => attest(deps, () => undefined, 'test')).toThrow(/cannot be attested/);
    await authUrl(deps, 'https://app.test/certify-callback');
    await exchange(deps, 'code_1', deps.load().auth!.state);
    await publish(deps, { text: 'Certification run', media: [] });
    expect(deps.load().lastPublish?.remotePostId ?? deps.load().lastPublish?.pending).toBeTruthy();
    if (deps.load().lastPublish?.pending) {
      await pendingStep(deps, 'status');
      await pendingStep(deps, 'finalize');
    }
    await find(deps);
    await refresh(deps);
    await metrics(deps, 'post', 24);
    await comments(deps, {});
    expect(missingSteps('channel', deps.load())).toEqual(['revoke']);
    expect(() => attest(deps, () => undefined, 'test')).toThrow(/revoke has not passed/);
    await revoke(deps);
    expect(adapter.calls.at(-1)).toMatch(/^revokeAccess:/);
    await refresh(deps); // the revoked grant is refused: the proof of the revoke step
    expect(missingSteps('channel', deps.load())).toEqual([]);
    status(deps);
    expect(lines.at(-1)).toContain('Every required step passed.');
    const record = attest(deps, (r) => written.push(r), 'test');
    expect(Object.keys(record.steps)).toEqual([...REQUIRED_STEPS.channel]);
    expect(Object.values(record.steps).every((s) => s.ok)).toBe(true);
    // PR-06: only the capabilities this run exercised are attested; the rest stay uncertified.
    expect(Object.keys(record.capabilities).sort()).toEqual(
      ['analytics', 'connect', 'publish_text', 'token_refresh'].sort(),
    );
    expect(record.capabilities.connect?.environment).toBe('test');
    // The session file never leaves its owner, and the record goes beside it.
    const store = fileStore(root, adapter.key);
    store.writeCertification(record);
    expect(JSON.parse(readFileSync(store.certificationFile, 'utf8'))).toEqual(record);
  });

  it('source: connect, targets, read, refresh, revoke proven by the refused refresh; attest refuses until then', async () => {
    const adapter = new FixtureSourceAdapter('ga4_property');
    adapter.reportRows = {
      'ga4.engagement': [
        {
          date: new Date().toISOString().slice(0, 10),
          dimensions: {},
          metrics: { sessions: 3, engagedSessions: 1, keyEvents: 0 },
        },
      ],
    };
    const deps: SourceDeps = { ...base('source', adapter.key), adapter };
    await sourceAuthUrl(deps, 'https://app.test/certify-callback');
    await sourceExchange(deps, 'code_2', deps.load().auth!.state);
    await sourceTargets(deps);
    await sourceRead(deps, 'ga4.engagement', 7);
    await sourceRefresh(deps);
    expect(missingSteps('source', deps.load())).toEqual(['revoke']);
    expect(() => attest(deps, () => undefined, 'test')).toThrow(/revoke has not passed/);
    await sourceRevoke(deps);
    expect(adapter.revokeCalls).toHaveLength(1);
    await sourceRefresh(deps);
    expect(missingSteps('source', deps.load())).toEqual([]);
    const record = attest(deps, (r) => written.push(r), 'test');
    expect(record).toMatchObject({ key: 'ga4_property', kind: 'source' });
    expect(Object.keys(record.steps)).toEqual([...REQUIRED_STEPS.source]);
  });

  it('cms: connect (verified), write and update with their read-back, unpublish, delete proven absent, revoke proven by the refused verify', async () => {
    const adapter = new FixtureCmsAdapter();
    const deps: CmsDeps = { ...base('cms', adapter.key), adapter };
    await cmsConnect(deps, { siteUrl: 'https://site.example', username: 'ore-editor' }, 'app pass word');
    await cmsWrite(deps, { title: 'Certification', html: '<p>one</p>', publish: false });
    const article = deps.load().cms?.article;
    const remote = adapter.articles.get(article!.remoteId)!;
    expect(article?.contentHash).toBe(remote.contentHash);
    expect(remote.contentHash).toBe(fixtureArticleHash(remote)); // the read-back hash is the adapter's own
    await cmsUpdate(deps, '<p>two</p>');
    expect(adapter.articles.get(article!.remoteId)?.html).toBe('<p>two</p>');
    await cmsUnpublish(deps);
    await cmsDelete(deps);
    expect(adapter.articles.has(article!.remoteId)).toBe(false);
    expect(missingSteps('cms', deps.load())).toEqual(['revoke']);
    expect(() => attest(deps, () => undefined, 'test')).toThrow(/revoke has not passed/);
    await cmsRevoke(deps);
    await cmsVerify(deps);
    expect(missingSteps('cms', deps.load())).toEqual([]);
    const record = attest(deps, (r) => written.push(r), 'test');
    expect(record).toMatchObject({ key: 'cms_site', kind: 'cms' });
    expect(Object.keys(record.steps)).toEqual([...REQUIRED_STEPS.cms]);
  });

  it('a step that fails is recorded as failed and keeps the provider unattestable (a failed write, an update on a moved remote)', async () => {
    const adapter = new FixtureCmsAdapter();
    const deps: CmsDeps = { ...base('cms', `${adapter.key}_failing`), adapter };
    await cmsConnect(deps, { siteUrl: 'https://site.example', username: 'ore-editor' }, 'app pass word');
    adapter.writeBehaviour = 'forbidden';
    await cmsWrite(deps, { title: 'Refused', html: '<p>x</p>', publish: false });
    expect(deps.load().evidence?.['write']).toMatchObject({
      ok: false,
      detail: 'rejected: reconnect_required',
    });
    adapter.writeBehaviour = 'ok';
    await cmsWrite(deps, { title: 'Written', html: '<p>x</p>', publish: false });
    expect(deps.load().evidence?.['write']).toMatchObject({ ok: true });
    // The remote moves between the read-back and the update: the update is a conflict, recorded as failed.
    const remoteId = deps.load().cms!.article!.remoteId;
    const current = adapter.articles.get(remoteId)!;
    adapter.articles.set(remoteId, { ...current, html: '<p>edited on the site</p>', contentHash: 'moved' });
    await cmsUpdate(deps, '<p>y</p>');
    expect(deps.load().evidence?.['update']).toMatchObject({ ok: false, detail: 'conflict' });
    expect(() => attest(deps, () => undefined, 'test')).toThrow(
      /update, unpublish, delete, revoke have not passed/,
    );
  });
});
