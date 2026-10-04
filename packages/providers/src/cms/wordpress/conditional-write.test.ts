import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DecryptedCredentials } from '@oremedia/contracts/providers';
import { FakeWordPressSite, fixtureIO, type FixtureIO } from '../../testing';
import type { CmsRemoteArticle } from '../../cms-contract';
import { wordpressCmsAdapter as adapter } from './adapter';

/*
 * PR-03 against a stateful WordPress-like site that implements the conditional-write plugin's semantics (see
 * testing/wordpress-site.ts; the plugin itself is tested against a real WordPress in
 * infra/wordpress/oremedia-conditional-write/tests). Each stale-write case injects a change on the site after the
 * adapter's last read and before its write is evaluated, and proves the write refused and the content untouched.
 */
const site = { siteUrl: 'https://site.example', username: 'ore-editor' };
const creds: DecryptedCredentials = { accessToken: 'abcd efgh ijkl mnop', extra: { username: 'ore-editor' } };
const WRITE = '/wp-json/oremedia/v1/posts/42';
const APPROVED = '<p>The approved edit.</p>';

describe('WordPress conditional writes (PR-03)', () => {
  const wp = new FakeWordPressSite();
  let io: FixtureIO;
  beforeAll(async () => {
    await wp.start();
    io = await fixtureIO(wp, { providerKey: adapter.key });
  });
  afterAll(() => wp.stop());
  beforeEach(() => {
    wp.reset();
    io.calls.length = 0;
  });

  /** The read-back the product stores after its own write (the precondition of its next edit). */
  const readBack = async (): Promise<CmsRemoteArticle> => {
    const read = await adapter.readArticle(site, creds, io, '42');
    if (read.outcome !== 'found') throw new Error(read.outcome);
    io.calls.length = 0;
    return read.article;
  };
  const mutations = () =>
    io.calls.filter((c) => c.mutation).map((c) => `${c.method} ${new URL(c.url).pathname}`);

  it('the handshake: conditional with the plugin on transactional storage; limited without it or without transactions; unknown on an outage', async () => {
    expect(await adapter.writeSafety(site, creds, io)).toEqual({
      mode: 'conditional',
      mechanism: 'oremedia-conditional-write',
      version: '1.0.0',
    });
    wp.plugin = 'absent';
    expect(await adapter.writeSafety(site, creds, io)).toEqual({
      mode: 'limited',
      reason: 'extension_absent',
    });
    wp.plugin = 'not_transactional';
    expect(await adapter.writeSafety(site, creds, io)).toEqual({
      mode: 'limited',
      reason: 'extension_not_transactional',
    });
    wp.plugin = 'outage';
    expect(await adapter.writeSafety(site, creds, io)).toEqual({ mode: 'unknown', reason: 'http_503' });
    expect(io.calls.every((c) => !c.mutation)).toBe(true);
  });

  it('a read carries the write token; an edit with the stored token is one conditional write and returns the next token', async () => {
    wp.seed();
    const stored = await readBack();
    expect(stored.writeToken).toMatch(/^wpcw1:1:[0-9a-f]{64}$/);
    const result = await adapter.updateArticle(
      site,
      creds,
      io,
      '42',
      { html: APPROVED },
      {
        expectedWriteToken: stored.writeToken!,
      },
    );
    expect(result).toMatchObject({ outcome: 'done', article: { html: APPROVED } });
    expect(mutations()).toEqual([`POST ${WRITE}`]);
    // No preflight read with a stored token: the site's comparison is the only one.
    expect(io.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /wp-json/oremedia/v1/capabilities',
      `POST ${WRITE}`,
    ]);
    expect(wp.posts.get(42)?.content).toBe(APPROVED);
    const next = result.outcome === 'done' ? result.article.writeToken : undefined;
    expect(next).toMatch(/^wpcw1:3:/);
    expect(next).toBe((await readBack()).writeToken);
  });

  it('an edit made on the site after the read-back: the stored token is stale, the write is refused with the current revision, the edit untouched', async () => {
    wp.seed();
    const stored = await readBack();
    wp.tick(60);
    wp.editAsPerson(42, { content: '<p>The person’s edit.</p>' });
    const result = await adapter.updateArticle(
      site,
      creds,
      io,
      '42',
      { html: APPROVED },
      {
        expectedWriteToken: stored.writeToken!,
      },
    );
    expect(result).toMatchObject({ outcome: 'conflict', current: { html: '<p>The person’s edit.</p>' } });
    expect(wp.posts.get(42)?.content).toBe('<p>The person’s edit.</p>');
  });

  it('an edit injected between the preflight read and the write (legacy read-back without a token) is refused by the site, content untouched', async () => {
    wp.seed();
    const stored = await readBack();
    wp.tick(5);
    wp.beforeNext('POST', WRITE, () => wp.editAsPerson(42, { content: '<p>Saved in the window.</p>' }));
    const result = await adapter.updateArticle(
      site,
      creds,
      io,
      '42',
      { html: APPROVED },
      {
        expectedHash: stored.contentHash,
        expectedModifiedAt: stored.modifiedAt,
      },
    );
    // The preflight read matched (nothing had changed yet); the site refused the write it then received.
    expect(io.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /wp-json/oremedia/v1/capabilities',
      'GET /wp-json/wp/v2/posts/42',
      `POST ${WRITE}`,
    ]);
    expect(result).toMatchObject({ outcome: 'conflict', current: { html: '<p>Saved in the window.</p>' } });
    expect(wp.posts.get(42)?.content).toBe('<p>Saved in the window.</p>');
  });

  it('same second: a content save whose modified_gmt equals the read-back, and a term change that leaves the row alone, are both refused', async () => {
    wp.seed();
    const stored = await readBack();
    // The clock does not move: the save lands in the same second as the read-back.
    wp.editAsPerson(42, { content: '<p>Same-second save.</p>' });
    expect((await readBack()).modifiedAt).toBe(stored.modifiedAt);
    let result = await adapter.updateArticle(
      site,
      creds,
      io,
      '42',
      { html: APPROVED },
      {
        expectedWriteToken: stored.writeToken!,
      },
    );
    expect(result).toMatchObject({ outcome: 'conflict' });
    expect(wp.posts.get(42)?.content).toBe('<p>Same-second save.</p>');

    const again = await readBack();
    wp.beforeNext('POST', WRITE, () => wp.changeTermsAsPerson(42, [7]));
    result = await adapter.updateArticle(
      site,
      creds,
      io,
      '42',
      { html: APPROVED },
      {
        expectedWriteToken: again.writeToken!,
      },
    );
    expect(result).toMatchObject({ outcome: 'conflict' });
    expect(wp.posts.get(42)).toMatchObject({
      content: '<p>Same-second save.</p>',
      modifiedGmt: '2026-10-04T10:00:00',
    });
  });

  it('revision history disabled: the precondition does not depend on revisions, the injected edit is still refused', async () => {
    wp.revisionsEnabled = false;
    wp.seed();
    const stored = await readBack();
    wp.beforeNext('POST', WRITE, () => wp.editAsPerson(42, { content: '<p>No revisions kept.</p>' }));
    const result = await adapter.updateArticle(
      site,
      creds,
      io,
      '42',
      { html: APPROVED },
      {
        expectedWriteToken: stored.writeToken!,
      },
    );
    expect(result).toMatchObject({ outcome: 'conflict' });
    expect(wp.posts.get(42)?.content).toBe('<p>No revisions kept.</p>');
    expect(wp.revisions.get(42)).toBeUndefined();
  });

  it('a writer that bypasses WordPress hooks (counter unchanged) is caught by the row fingerprint', async () => {
    wp.seed();
    const stored = await readBack();
    wp.beforeNext('POST', WRITE, () => wp.editBypassingHooks(42, '<p>Direct table update.</p>'));
    const result = await adapter.updateArticle(
      site,
      creds,
      io,
      '42',
      { html: APPROVED },
      {
        expectedWriteToken: stored.writeToken!,
      },
    );
    expect(result).toMatchObject({ outcome: 'conflict' });
    expect(wp.posts.get(42)?.content).toBe('<p>Direct table update.</p>');
  });

  it('limited mode: without the plugin an edit is refused before anything is sent and the site keeps its content; a status-only revert still runs and keeps the content', async () => {
    wp.plugin = 'absent';
    wp.seed();
    const stored = await readBack();
    expect(stored.writeToken).toBeUndefined();
    wp.editAsPerson(42, { content: '<p>The person’s edit.</p>' });
    const result = await adapter.updateArticle(
      site,
      creds,
      io,
      '42',
      { html: APPROVED },
      {
        expectedHash: stored.contentHash,
        expectedModifiedAt: stored.modifiedAt,
      },
    );
    expect(result).toMatchObject({ outcome: 'limited', reason: 'extension_absent' });
    expect(mutations()).toEqual([]);
    expect(wp.posts.get(42)?.content).toBe('<p>The person’s edit.</p>');
    // Even a matching precondition does not unlock a content write in limited mode.
    const fresh = await readBack();
    expect(
      await adapter.updateArticle(
        site,
        creds,
        io,
        '42',
        { html: APPROVED, title: 'New title' },
        {
          expectedHash: fresh.contentHash,
          expectedModifiedAt: fresh.modifiedAt,
        },
      ),
    ).toMatchObject({ outcome: 'limited' });
    expect(mutations()).toEqual([]);
    const reverted = await adapter.unpublishArticle(site, creds, io, '42');
    expect(reverted).toMatchObject({
      outcome: 'done',
      article: { status: 'draft', html: '<p>The person’s edit.</p>' },
    });
    expect(mutations()).toEqual(['POST /wp-json/wp/v2/posts/42']);
  });

  it('a non-transactional site is limited; an unreadable handshake sends nothing and is retried', async () => {
    wp.seed();
    const stored = await readBack();
    wp.plugin = 'not_transactional';
    expect(
      await adapter.updateArticle(
        site,
        creds,
        io,
        '42',
        { html: APPROVED },
        { expectedWriteToken: stored.writeToken! },
      ),
    ).toMatchObject({ outcome: 'limited', reason: 'extension_not_transactional' });
    wp.plugin = 'outage';
    expect(
      await adapter.updateArticle(
        site,
        creds,
        io,
        '42',
        { html: APPROVED },
        { expectedWriteToken: stored.writeToken! },
      ),
    ).toMatchObject({ outcome: 'retryable_error', code: 'write_safety_unknown' });
    expect(mutations()).toEqual([]);
    expect(wp.posts.get(42)?.content).toBe('<p>Ore is heavy.</p>');
  });
});
