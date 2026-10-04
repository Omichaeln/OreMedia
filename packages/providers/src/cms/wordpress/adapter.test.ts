import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DecryptedCredentials } from '@oremedia/contracts/providers';
import { FixtureServer, fixtureIO, loadScenario, type FixtureIO } from '../../testing';
import { textFingerprint } from '../../shared';
import { RenderedPageError, remoteArticleFingerprint, wordpressCmsAdapter as adapter } from './adapter';

const fx = (name: string, file = 'articles') =>
  loadScenario(new URL(`./fixtures/${file}.json`, import.meta.url), name);
const site = { siteUrl: 'https://site.example', username: 'ore-editor' };
const creds: DecryptedCredentials = { accessToken: 'abcd efgh ijkl mnop', extra: { username: 'ore-editor' } };
const expectedAuth = `Basic ${Buffer.from('ore-editor:abcd efgh ijkl mnop').toString('base64')}`;
/** The hash of a revision of post 42 as the fixture serves it (no terms listed): RA-12 covers title, slug, status and content. */
const hashOf = (status: string, html: string, title = 'Why ore & tar') =>
  remoteArticleFingerprint({ title, slug: 'why-ore-and-tar', status, categories: [], tags: [], html });
const input = {
  title: 'Why ore & tar',
  slug: 'why-ore-and-tar',
  excerpt: 'A short answer.',
  html: '<p>Ore is heavy.</p>',
  categories: ['Guides'],
  tags: ['ore'],
  status: 'draft' as const,
};

describe('WordPress CMS adapter (ledger R2-3, D-16; spec 14.5 / 14.6)', () => {
  const server = new FixtureServer();
  let io: FixtureIO;
  beforeAll(async () => {
    await server.start();
    io = await fixtureIO(server, { providerKey: adapter.key });
  });
  afterAll(() => server.stop());
  const load = (name: string, file?: string): void => {
    server.load(fx(name, file));
    io.calls.length = 0;
  };

  it('revokeAccess (RA-01): the application password in use is introspected and deleted; one the site refuses is already revoked; a failed deletion is failed', async () => {
    load('revoke_ok', 'access');
    expect(await adapter.revokeAccess(site, creds, io)).toEqual({ outcome: 'revoked' });
    expect(io.calls.map((c) => `${c.mutation ? 'M' : 'R'} ${c.method}`)).toEqual(['R GET', 'M DELETE']);
    expect(server.requests.every((r) => r.headers['authorization'] === expectedAuth)).toBe(true);
    load('revoke_already_gone', 'access');
    expect(await adapter.revokeAccess(site, creds, io)).toEqual({ outcome: 'revoked' });
    load('revoke_refused', 'access');
    expect(await adapter.revokeAccess(site, creds, io)).toMatchObject({
      outcome: 'failed',
      reason: expect.stringMatching(/^http_500/),
    });
  });

  it('verify: the application password over HTTP Basic reaches the editor; a 401 is a reconnect; a reader is refused', async () => {
    load('verify_ok');
    expect(await adapter.verify(site, creds, io)).toEqual({
      ok: true,
      displayName: 'Ore Editor',
      canPublish: true,
    });
    expect(server.requests[0]?.headers['authorization']).toBe(expectedAuth);
    expect(io.calls).toEqual([
      { method: 'GET', url: 'https://site.example/wp-json/wp/v2/users/me?context=edit', mutation: false },
    ]);
    load('verify_unauthorised');
    const denied = await adapter.verify(site, creds, io);
    expect(denied).toMatchObject({ ok: false, reason: 'reconnect_required' });
    if (!denied.ok) expect(denied.detail).not.toContain('abcd');
    load('verify_subscriber');
    expect(await adapter.verify(site, creds, io)).toMatchObject({ ok: false, reason: 'rejected' });
    const refused = await fixtureIO(server, { providerKey: adapter.key, refuse: true });
    expect(await adapter.verify(site, creds, refused)).toMatchObject({ ok: false, reason: 'transient' });
  });

  it('uploadMedia (RA-08): the bytes come from the signed release URL through ProviderIO, land as an attachment with the file name and alt text; a refusal is a reconnect', async () => {
    load('upload_media_ok');
    const media = {
      url: 'https://releases.example/releases/t/b/av_1/original/x.png',
      mime: 'image/png',
      contentHash: 'h'.repeat(64),
      alt: 'The weighbridge',
      filename: 'why-ore-and-tar-1.png',
    };
    expect(await adapter.uploadMedia(site, creds, io, media)).toEqual({
      outcome: 'done',
      media: { remoteId: '77', url: 'https://site.example/wp-content/uploads/2026/10/why-ore-and-tar-1.png' },
    });
    expect(io.calls).toEqual([
      { method: 'GET', url: media.url, mutation: false },
      { method: 'POST', url: 'https://site.example/wp-json/wp/v2/media', mutation: true },
      { method: 'POST', url: 'https://site.example/wp-json/wp/v2/media/77', mutation: true },
    ]);
    const upload = server.requests[1]!;
    expect(upload.headers['content-type']).toBe('image/png');
    expect(upload.headers['content-disposition']).toBe('attachment; filename="why-ore-and-tar-1.png"');
    expect(upload.headers['authorization']).toBe(expectedAuth);
    load('upload_media_forbidden');
    expect(await adapter.uploadMedia(site, creds, io, media)).toMatchObject({
      outcome: 'rejected',
      code: 'reconnect_required',
    });
    // The release must answer with an image: anything else is refused before the site is touched.
    load('upload_media_not_image');
    expect(await adapter.uploadMedia(site, creds, io, media)).toMatchObject({
      outcome: 'rejected',
      code: 'media_unexpected_type',
    });
    expect(io.calls.every((c) => !c.mutation)).toBe(true);
  });

  it("createArticle (RA-08): the uploaded media is the post's featured image and the body references the site's copy", async () => {
    load('create_with_featured');
    const html =
      '<p>Ore is heavy.</p>\n<figure><img src="https://site.example/wp-content/uploads/2026/10/why-ore-and-tar-1.png" alt="The weighbridge"></figure>';
    const result = await adapter.createArticle(
      site,
      creds,
      io,
      {
        ...input,
        html,
        featuredMedia: {
          remoteId: '77',
          url: 'https://site.example/wp-content/uploads/2026/10/why-ore-and-tar-1.png',
        },
      },
      'idem-feat',
    );
    expect(result).toMatchObject({ outcome: 'done', article: { remoteId: '43', status: 'draft', html } });
    const post = JSON.parse(server.requests.at(-1)!.body) as Record<string, unknown>;
    expect(post['featured_media']).toBe(77);
    expect(post['content']).toBe(html);
  });

  it('readArticle: the raw revision with its modified instant and content hash; 404 is absent; 403 a reconnect', async () => {
    load('read_found');
    const found = await adapter.readArticle(site, creds, io, '42');
    expect(found).toEqual({
      outcome: 'found',
      article: {
        remoteId: '42',
        remoteUrl: 'https://site.example/why-ore-and-tar/',
        title: 'Why ore & tar',
        slug: 'why-ore-and-tar',
        status: 'draft',
        modifiedAt: '2026-09-30T10:00:00Z',
        contentHash: hashOf('draft', '<p>Ore is heavy.</p>'),
        html: '<p>Ore is heavy.</p>',
        editUrl: 'https://site.example/wp-admin/post.php?post=42&action=edit',
      },
    });
    // RA-12: the hash moves with the title, the slug, the status or a term, not only the content.
    const base = { title: 'T', slug: 's', status: 'publish', categories: [1], tags: [2], html: '<p>x</p>' };
    for (const change of [
      { title: 'U' },
      { slug: 'other' },
      { status: 'draft' },
      { categories: [3] },
      { tags: [] },
      { html: '<p>y</p>' },
    ])
      expect(remoteArticleFingerprint({ ...base, ...change })).not.toBe(remoteArticleFingerprint(base));
    expect(remoteArticleFingerprint({ ...base, categories: [2, 1], tags: [2] })).toBe(
      remoteArticleFingerprint({ ...base, categories: [1, 2] }),
    );
    expect(remoteArticleFingerprint(base)).not.toBe(textFingerprint('<p>x</p>'));
    expect(io.calls.every((c) => !c.mutation)).toBe(true);
    load('read_absent');
    expect(await adapter.readArticle(site, creds, io, '404')).toEqual({ outcome: 'absent' });
    load('read_forbidden');
    expect(await adapter.readArticle(site, creds, io, '42')).toMatchObject({
      outcome: 'rejected',
      code: 'reconnect_required',
    });
  });

  it('createArticle: terms resolved by exact name over the pages (a missing tag created), then one draft post', async () => {
    load('create_draft');
    const created = await adapter.createArticle(site, creds, io, input, 'idem_1');
    expect(created).toMatchObject({
      outcome: 'done',
      article: {
        remoteId: '42',
        status: 'draft',
        slug: 'why-ore-and-tar',
        remoteUrl: 'https://site.example/?p=42',
      },
    });
    expect(
      io.calls.map((c) => `${c.method} ${new URL(c.url).pathname}${c.mutation ? ' (mutation)' : ''}`),
    ).toEqual([
      'GET /wp-json/wp/v2/categories',
      'GET /wp-json/wp/v2/categories',
      'GET /wp-json/wp/v2/tags',
      'POST /wp-json/wp/v2/tags (mutation)',
      'POST /wp-json/wp/v2/posts (mutation)',
    ]);
    expect(server.requests.at(-1)?.headers['x-oremedia-idempotency-key']).toBe('idem_1');
    expect(server.remaining()).toEqual([]);
  });

  it('createArticle: a 403 is rejected as a reconnect; a 502 after the post was sent is unknown, never retried blindly', async () => {
    load('create_forbidden');
    expect(
      await adapter.createArticle(site, creds, io, { ...input, categories: [], tags: [] }, 'idem_2'),
    ).toMatchObject({
      outcome: 'rejected',
      code: 'reconnect_required',
    });
    load('create_outage_after_send');
    expect(
      await adapter.createArticle(site, creds, io, { ...input, categories: [], tags: [] }, 'idem_3'),
    ).toMatchObject({
      outcome: 'unknown',
      code: 'http_502',
    });
    const refused = await fixtureIO(server, { providerKey: adapter.key, refuse: true });
    expect(
      await adapter.createArticle(site, creds, refused, { ...input, categories: [], tags: [] }, 'idem_4'),
    ).toMatchObject({
      outcome: 'retryable_error',
      code: 'transport_before_send',
    });
  });

  it('updateArticle: a remote that moved since the read-back is a conflict and nothing is written', async () => {
    load('update_conflict');
    const result = await adapter.updateArticle(
      site,
      creds,
      io,
      '42',
      { html: '<p>Ore is heavy and tar is sticky.</p>' },
      { expectedHash: hashOf('publish', '<p>Ore is heavy.</p>'), expectedModifiedAt: '2026-09-30T10:00:00Z' },
    );
    expect(result).toMatchObject({
      outcome: 'conflict',
      current: { title: 'Why ore & tar (edited on the site)', modifiedAt: '2026-09-30T12:30:00Z' },
    });
    expect(io.calls.some((c) => c.mutation)).toBe(false);
    // A remote whose content and identity still hash the same but was touched since (the timestamp moved) is a
    // conflict too: both halves of the precondition hold.
    load('update_ok');
    const touched = await adapter.updateArticle(
      site,
      creds,
      io,
      '42',
      { html: '<p>Ore is heavy and tar is sticky.</p>' },
      { expectedHash: hashOf('publish', '<p>Ore is heavy.</p>'), expectedModifiedAt: '2026-09-30T09:00:00Z' },
    );
    expect(touched).toMatchObject({ outcome: 'conflict' });
    expect(io.calls.some((c) => c.mutation)).toBe(false);
  });

  it("updateArticle (PR-03): with the legacy precondition met the post is written once, through the plugin's conditional endpoint with the read's write token, never core's unconditional update", async () => {
    load('update_ok');
    const result = await adapter.updateArticle(
      site,
      creds,
      io,
      '42',
      { html: '<p>Ore is heavy and tar is sticky.</p>' },
      { expectedHash: hashOf('publish', '<p>Ore is heavy.</p>'), expectedModifiedAt: '2026-09-30T10:00:00Z' },
    );
    expect(result).toMatchObject({
      outcome: 'done',
      article: {
        modifiedAt: '2026-09-30T13:00:00Z',
        contentHash: hashOf('publish', '<p>Ore is heavy and tar is sticky.</p>'),
        writeToken: `wpcw1:9:${'b'.repeat(64)}`,
      },
      previous: {
        modifiedAt: '2026-09-30T10:00:00Z',
        html: '<p>Ore is heavy.</p>',
        writeToken: `wpcw1:7:${'a'.repeat(64)}`,
      },
    });
    expect(io.calls.filter((c) => c.mutation)).toEqual([
      { method: 'POST', url: 'https://site.example/wp-json/oremedia/v1/posts/42', mutation: true },
    ]);
    expect(server.remaining()).toEqual([]);
    expect(server.unmatched).toEqual([]);
  });

  it('updateArticle (PR-03): a site edit that slipped between the read and the write is refused by the site (412) and returned as the current revision; nothing was written', async () => {
    load('update_precondition_failed');
    const result = await adapter.updateArticle(
      site,
      creds,
      io,
      '42',
      { html: '<p>Ore is heavy and tar is sticky.</p>' },
      { expectedHash: hashOf('publish', '<p>Ore is heavy.</p>'), expectedModifiedAt: '2026-09-30T10:00:00Z' },
    );
    expect(result).toMatchObject({
      outcome: 'conflict',
      current: {
        title: 'Why ore & tar (edited on the site)',
        html: '<p>Someone changed this in the window.</p>',
        writeToken: `wpcw1:8:${'c'.repeat(64)}`,
      },
    });
    expect(server.remaining()).toEqual([]);
  });

  it('updateArticle (PR-03): without the plugin (limited mode) an update that replaces content is refused with the current revision and nothing is sent', async () => {
    load('update_limited');
    const result = await adapter.updateArticle(
      site,
      creds,
      io,
      '42',
      { html: '<p>Ore is heavy and tar is sticky.</p>' },
      { expectedHash: hashOf('publish', '<p>Ore is heavy.</p>'), expectedModifiedAt: '2026-09-30T10:00:00Z' },
    );
    expect(result).toMatchObject({
      outcome: 'limited',
      reason: 'extension_absent',
      current: { html: '<p>Ore is heavy.</p>' },
    });
    expect(io.calls.some((c) => c.mutation)).toBe(false);
    expect(server.remaining()).toEqual([]);
  });

  it('unpublishArticle sets a live article back to a draft under the precondition it read (atomically with the plugin, status alone without it); deleteArticle reports one already gone', async () => {
    load('unpublish');
    expect(await adapter.unpublishArticle(site, creds, io, '42')).toMatchObject({
      outcome: 'done',
      article: { status: 'draft', writeToken: `wpcw1:8:${'d'.repeat(64)}` },
    });
    expect(server.remaining()).toEqual([]);
    expect(server.unmatched).toEqual([]);
    load('unpublish_limited');
    expect(await adapter.unpublishArticle(site, creds, io, '42')).toMatchObject({
      outcome: 'done',
      article: { status: 'draft', html: '<p>Ore is heavy.</p>' },
      previous: { status: 'publish' },
    });
    expect(JSON.parse(server.requests.at(-1)!.body)).toEqual({ status: 'draft' });
    expect(server.remaining()).toEqual([]);
    expect(server.unmatched).toEqual([]);
    load('delete_gone');
    expect(await adapter.deleteArticle(site, creds, io, '42')).toEqual({ outcome: 'already_absent' });
    load('delete_ok');
    expect(await adapter.deleteArticle(site, creds, io, '42')).toMatchObject({
      outcome: 'done',
      article: { status: 'trash' },
    });
  });

  it('fetchRendered: follows a same-host redirect, refuses another host, reads against the byte cap, sends no credentials', async () => {
    load('rendered_redirect');
    const page = await adapter.fetchRendered(site, io, 'https://site.example/?p=42', 1024 * 1024);
    expect(page).toMatchObject({
      status: 200,
      truncated: false,
      url: 'https://site.example/why-ore-and-tar/',
    });
    expect(page.html).toContain('<h1>Why ore &amp; tar</h1>');
    expect(server.requests.every((r) => r.headers['authorization'] === undefined)).toBe(true);
    load('rendered_other_host');
    await expect(
      adapter.fetchRendered(site, io, 'https://site.example/why-ore-and-tar/', 1024),
    ).rejects.toBeInstanceOf(RenderedPageError);
    await expect(adapter.fetchRendered(site, io, 'https://other.example/x', 1024)).rejects.toMatchObject({
      code: 'other_host',
    });
    await expect(adapter.fetchRendered(site, io, 'http://site.example/x', 1024)).rejects.toMatchObject({
      name: 'BlockedAddressError',
    });
    // PR-04: the robots and canonical headers travel with the page; absent ones are null.
    load('rendered_headers');
    expect(
      await adapter.fetchRendered(site, io, 'https://site.example/why-ore-and-tar/', 1024 * 1024),
    ).toMatchObject({
      status: 200,
      headers: {
        xRobotsTag: 'noindex, nofollow',
        link: '<https://site.example/why-ore-and-tar/>; rel="canonical"',
      },
    });
    expect(page.headers).toEqual({ xRobotsTag: null, link: null });
    load('rendered_large');
    const large = await adapter.fetchRendered(site, io, 'https://site.example/big/', 16);
    expect(large).toMatchObject({ status: 200, truncated: true, bytes: 16 });
    expect(large.html).toBe('0123456789012345');
  });

  it('classifyError: a 429 before send is a throttle; 401 refresh, 403 reconnect, 404 rejected, 5xx unknown', () => {
    expect(adapter.classifyError({ status: 429, phase: 'before_send' })).toEqual({
      kind: 'rate_limited',
      phase: 'before_send',
    });
    expect(adapter.classifyError({ status: 429, phase: 'after_send' })).toEqual({ kind: 'unknown' });
    expect(adapter.classifyError({ status: 401, phase: 'after_send' })).toEqual({ kind: 'refresh_token' });
    expect(adapter.classifyError({ status: 403, phase: 'after_send' })).toEqual({
      kind: 'reconnect_required',
    });
    expect(adapter.classifyError({ status: 404, phase: 'after_send' })).toEqual({
      kind: 'rejected',
      code: 'http_404',
    });
    expect(adapter.classifyError({ status: 503, phase: 'after_send' })).toEqual({ kind: 'unknown' });
  });
});
