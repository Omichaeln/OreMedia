import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderAdapter, ProviderIO } from '@oremedia/providers';
import { facebookPageCapability } from '@oremedia/providers';
import {
  authUrl,
  exchange,
  fileStore,
  find,
  metrics,
  pendingStep,
  publish,
  recordingIO,
  redactUrl,
  type CertifyDeps,
  type CertifySession,
  type Recording,
} from './harness';

const TOKEN = 'fixture-token-1234';

/** A scripted adapter: records the calls it receives and answers like a platform would. */
function fakeAdapter(calls: string[]): ProviderAdapter {
  return {
    key: 'facebook_page',
    capability: facebookPageCapability,
    async authorizationUrl({ state }) {
      calls.push('authorizationUrl');
      return { url: `https://platform.test/oauth?state=${state}` };
    },
    async exchangeCode({ code }) {
      calls.push(`exchangeCode:${code}`);
      return {
        remoteAccountId: 'page_1',
        displayName: 'Test page',
        grantedScopes: ['pages_show_list', 'pages_manage_posts'],
        credentials: { accessToken: TOKEN },
        alternatives: [{ remoteAccountId: 'page_2', displayName: 'Other page' }],
      };
    },
    async refresh() {
      return { ok: false, reason: 'reconnect_required' };
    },
    validateVariant: (v) =>
      v.text.length > 10 ? { ok: false, issues: [{ issue: 'too_long' }] } : { ok: true, issues: [] },
    measureText: (t) => ({ length: t.length, limit: 10 }),
    async publish(req) {
      calls.push(`publish:${req.text}:${req.remoteAccountId}`);
      return { outcome: 'pending', pending: { remoteJobId: 'job_1', data: {} } };
    },
    async checkStatus() {
      calls.push('checkStatus');
      return { status: 'ready' };
    },
    async finalize() {
      calls.push('finalize');
      return { status: 'completed', remotePostId: 'post_9', remoteUrl: 'https://platform.test/post_9' };
    },
    async findRemotePost(req) {
      calls.push(`find:${req.textFingerprint.slice(0, 8)}`);
      return {
        status: 'found',
        remotePostId: 'post_9',
        remoteUrl: 'https://platform.test/post_9',
        matchedBy: 'fingerprint',
      };
    },
    async fetchPostMetrics(req) {
      calls.push(`metrics:${req.remotePostId}`);
      return [
        {
          nativeName: facebookPageCapability.analytics.post[0]!,
          value: 3,
          windowStart: req.window.start,
          windowEnd: req.window.end,
          completeness: 'complete' as const,
        },
      ];
    },
    classifyError: () => ({ kind: 'unknown' }),
  };
}

function harness() {
  const calls: string[] = [];
  const lines: string[] = [];
  let session: CertifySession = { providerKey: 'facebook_page' };
  const deps: CertifyDeps = {
    adapter: fakeAdapter(calls),
    io: {} as ProviderIO,
    client: () => ({ clientId: 'app', clientSecret: 'secret' }),
    load: () => session,
    save: (s) => {
      session = s;
    },
    now: () => new Date('2026-09-25T12:00:00Z'),
    out: (l) => lines.push(l),
  };
  return { deps, calls, lines, session: () => session };
}

describe('certification harness commands', () => {
  it('auth-url keeps state and verifier; exchange checks the state and never prints the token', async () => {
    const h = harness();
    await authUrl(h.deps, 'https://app.test/certify-callback');
    const issued = h.session().auth!;
    expect(issued.redirectUri).toBe('https://app.test/certify-callback');
    await expect(exchange(h.deps, 'code_1', 'not-the-state')).rejects.toThrow(/state does not match/);
    await exchange(h.deps, 'code_1', issued.state);
    expect(h.calls).toEqual(['authorizationUrl', 'exchangeCode:code_1']);
    expect(h.session().auth).toBeUndefined();
    expect(h.session().grant?.remoteAccountId).toBe('page_1');
    const printed = h.lines.join('\n');
    expect(printed).not.toContain(TOKEN);
    expect(printed).toContain(`[${TOKEN.length} chars]`);
    // Missing scopes are reported against the capability's requiredScopes.
    expect(printed).toContain('"missingScopes"');
    expect(printed).toContain('read_insights');
    expect(printed).toContain('Other page');
  });

  it('publish → status → finalize → find follows one post; the capability refuses an invalid variant before sending', async () => {
    const h = harness();
    await authUrl(h.deps, 'https://app.test/cb');
    await exchange(h.deps, 'c', h.session().auth!.state);
    await publish(h.deps, { text: 'far too long for the limit', media: [] });
    expect(h.calls.some((c) => c.startsWith('publish'))).toBe(false);
    await publish(h.deps, { text: 'Hello', media: [] });
    expect(h.session().lastPublish?.pending).toEqual({ remoteJobId: 'job_1', data: {} });
    await pendingStep(h.deps, 'status');
    await pendingStep(h.deps, 'finalize');
    expect(h.session().lastPublish?.remotePostId).toBe('post_9');
    await find(h.deps);
    await metrics(h.deps, 'post', 24);
    expect(h.calls.slice(2)).toEqual([
      'publish:Hello:page_1',
      'checkStatus',
      'finalize',
      expect.stringMatching(/^find:[0-9a-f]{8}$/),
      'metrics:post_9',
    ]);
    // Declared metrics the platform did not return are listed, never reported as zero.
    const last = h.lines.at(-1)!;
    expect(last).toContain('"notReturned"');
    expect(last).toContain('"unavailable": []');
  });

  it('commands that need an account or a publish say which step to run first', async () => {
    const h = harness();
    await expect(find(h.deps)).rejects.toThrow(/run auth-url, then exchange/);
    await expect(exchange(h.deps, 'c')).rejects.toThrow(/run auth-url first/);
  });
});

describe('recording and storage', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('records each exchange with credential query parameters and body tokens redacted, without consuming the body', async () => {
    const recorded: Recording[] = [];
    const inner: ProviderIO = {
      request: async () => ({
        res: new Response(JSON.stringify({ access_token: TOKEN, id: 'post_1' }), {
          status: 200,
          headers: { 'x-app-usage': '{"call_count":5}', 'set-cookie': 'sid=abc' },
        }) as never,
        phase: 'after_send',
      }),
    };
    const io = recordingIO(
      inner,
      (r) => recorded.push(r),
      () => new Date('2026-09-25T12:00:00Z'),
    );
    const { res } = await io.request(
      `https://graph.test/me?fields=id&access_token=${TOKEN}`,
      { method: 'POST' },
      { mutation: true },
    );
    expect(await res.json()).toEqual({ access_token: TOKEN, id: 'post_1' });
    expect(recorded).toHaveLength(1);
    const r = recorded[0]!;
    expect(r).toMatchObject({ method: 'POST', mutation: true, status: 200 });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(r.url).toBe('https://graph.test/me?fields=id&access_token=[redacted]');
    // Rate-limit and request-id headers are kept; cookies and anything credential-like are not.
    expect(r.headers).toMatchObject({ 'x-app-usage': '{"call_count":5}' });
    expect(Object.keys(r.headers ?? {})).not.toContain('set-cookie');
    expect(redactUrl('https://x.test/cb?code=abc&state=s')).toBe('https://x.test/cb?code=[redacted]&state=s');
  });

  it('keeps the session in a file only its owner can read, and forget removes it', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'certify-'));
    const store = fileStore(dir, 'facebook_page');
    expect(store.load()).toEqual({ providerKey: 'facebook_page' });
    store.save({ providerKey: 'facebook_page', grant: undefined });
    const file = path.join(dir, '.certify', 'facebook_page', 'session.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ providerKey: 'facebook_page' });
    store.forget();
    expect(store.load()).toEqual({ providerKey: 'facebook_page' });
  });
});
