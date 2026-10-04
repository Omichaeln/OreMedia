import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo, Socket } from 'node:net';

/*
 * Test-only (PR-03): a stateful WordPress-like site over real loopback HTTP, for the adapter's conditional-write
 * tests. Unlike the scripted FixtureServer it holds posts and answers from their state, so a change made on the
 * site between the adapter's calls is applied to that state and the next answer reflects it. It implements:
 *
 * - core's `/wp-json/wp/v2/posts` (create, read with `context=edit`, and the unconditional update core performs:
 *   WordPress sends no ETag and honours no If-Match, so this update never checks anything either);
 * - the Oremedia conditional-write plugin as infra/wordpress/oremedia-conditional-write implements it: a per-post
 *   write counter advanced by every save made through WordPress (core update, a person's edit, a term or meta
 *   change), the `oremedia_write` field on a post read (counter and a SHA-256 fingerprint over the same row fields
 *   as the plugin's; opaque to the client, which only stores and returns it), `GET /oremedia/v1/capabilities`, and `POST /oremedia/v1/posts/<id>`,
 *   which compares the counter and the fingerprint and applies the write in one step (a single-threaded handler
 *   with no await between the comparison and the write: the in-process equivalent of the plugin's locked
 *   transaction), or answers 412 with the current state and writes nothing;
 * - a second-granular `modified_gmt` under a test clock (so two saves in the same second really share it) and
 *   revisions that can be disabled (`WP_POST_REVISIONS = false`).
 *
 * `beforeNext(method, path, fn)` runs `fn` once, right before the next matching request is evaluated: the external
 * edit injected between the adapter's preflight read and its write.
 */

export interface FakeWordPressPost {
  id: number;
  title: string;
  content: string;
  excerpt: string;
  status: string;
  slug: string;
  categories: number[];
  tags: number[];
  featuredMedia: number;
  /** `YYYY-MM-DDTHH:MM:SS`, UTC, second-granular as WordPress stores it. */
  modifiedGmt: string;
  /** The plugin's write counter (`_oremedia_write_counter`). */
  counter: number;
}

export type FakeWordPressPlugin = 'active' | 'absent' | 'not_transactional' | 'outage';

export interface FakeWordPressRequest {
  method: string;
  path: string;
  body: string;
}

const PLUGIN_ROUTE = '/wp-json/oremedia/v1';
const CORE_ROUTE = '/wp-json/wp/v2';

export class FakeWordPressSite {
  private readonly server: http.Server;
  private readonly sockets = new Set<Socket>();
  private port = 0;
  private nextId = 42;
  private readonly hooks: Array<{ method: string; path: string; fn: () => void }> = [];
  readonly posts = new Map<number, FakeWordPressPost>();
  readonly revisions = new Map<number, Array<Omit<FakeWordPressPost, 'counter'>>>();
  readonly requests: FakeWordPressRequest[] = [];
  /** Whether the conditional-write plugin is installed and what its handshake reports. */
  plugin: FakeWordPressPlugin = 'active';
  /** `WP_POST_REVISIONS`: false keeps no revision at all. */
  revisionsEnabled = true;
  /** The site's clock; `modified_gmt` takes its second. */
  now = new Date('2026-10-04T10:00:00Z');

  constructor(readonly origin = 'https://site.example') {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Clears posts, recordings and hooks; the plugin active, revisions on, the clock at its start. */
  reset(): this {
    this.posts.clear();
    this.revisions.clear();
    this.requests.length = 0;
    this.hooks.length = 0;
    this.plugin = 'active';
    this.revisionsEnabled = true;
    this.now = new Date('2026-10-04T10:00:00Z');
    this.nextId = 42;
    return this;
  }

  tick(seconds: number): void {
    this.now = new Date(this.now.getTime() + seconds * 1000);
  }

  /** A published post as the site holds it (counter 1: the plugin was active when it was created). */
  seed(fields: Partial<Omit<FakeWordPressPost, 'id' | 'counter' | 'modifiedGmt'>> = {}): FakeWordPressPost {
    const post: FakeWordPressPost = {
      id: this.nextId++,
      title: 'Why ore & tar',
      content: '<p>Ore is heavy.</p>',
      excerpt: '',
      status: 'publish',
      slug: 'why-ore-and-tar',
      categories: [],
      tags: [],
      featuredMedia: 0,
      modifiedGmt: this.gmt(),
      counter: 1,
      ...fields,
    };
    this.posts.set(post.id, post);
    this.saveRevision(post);
    return post;
  }

  /** Runs `fn` once, right before the next request matching method and path is evaluated. */
  beforeNext(method: string, path: string, fn: () => void): void {
    this.hooks.push({ method: method.toUpperCase(), path, fn });
  }

  /**
   * Someone saves the post through WordPress (the block editor, wp-cli, another REST client): the row changes,
   * `modified_gmt` takes the clock's second and the plugin's hooks advance the counter.
   */
  editAsPerson(
    id: number,
    changes: Partial<Pick<FakeWordPressPost, 'title' | 'content' | 'excerpt' | 'status'>>,
  ): void {
    const post = this.mustGet(id);
    Object.assign(post, changes, { modifiedGmt: this.gmt() });
    post.counter += 1;
    this.saveRevision(post);
  }

  /** A term or featured-image change: the row and its `modified_gmt` stay as they are; only the counter moves. */
  changeTermsAsPerson(id: number, tags: number[]): void {
    const post = this.mustGet(id);
    post.tags = tags;
    post.counter += 1;
  }

  /** A writer that bypasses every WordPress hook (a direct table update): the row changes, the counter does not. */
  editBypassingHooks(id: number, content: string): void {
    this.mustGet(id).content = content;
  }

  /** The fingerprint of the row over the fields the plugin covers (opaque to the adapter, compared here only). */
  fingerprint(post: FakeWordPressPost): string {
    const fields = [
      post.title,
      post.content,
      post.excerpt,
      post.status,
      post.slug,
      '',
      '0',
      '0',
      post.modifiedGmt.replace('T', ' '),
    ];
    return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
  }

  private gmt(): string {
    return this.now.toISOString().slice(0, 19);
  }

  private mustGet(id: number): FakeWordPressPost {
    const post = this.posts.get(id);
    if (!post) throw new Error(`no post ${id}`);
    return post;
  }

  private saveRevision(post: FakeWordPressPost): void {
    if (!this.revisionsEnabled) return;
    const { counter: _counter, ...row } = post;
    const list = this.revisions.get(post.id) ?? [];
    list.unshift({ ...row, tags: [...row.tags], categories: [...row.categories] });
    this.revisions.set(post.id, list);
  }

  private json(post: FakeWordPressPost): Record<string, unknown> {
    return {
      id: post.id,
      link: post.status === 'publish' ? `${this.origin}/${post.slug}/` : `${this.origin}/?p=${post.id}`,
      slug: post.slug,
      status: post.status,
      modified_gmt: post.modifiedGmt,
      title: { raw: post.title, rendered: post.title },
      content: { raw: post.content, rendered: post.content },
      excerpt: { raw: post.excerpt, rendered: post.excerpt },
      categories: post.categories,
      tags: post.tags,
      featured_media: post.featuredMedia,
      ...(this.plugin === 'absent'
        ? {}
        : { oremedia_write: { version: post.counter, fingerprint: this.fingerprint(post), protocol: 1 } }),
    };
  }

  /** Core's update: applies the fields it is given, unconditionally (as WordPress does), and saves. */
  private applyCoreUpdate(post: FakeWordPressPost, body: Record<string, unknown>): void {
    if (typeof body['title'] === 'string') post.title = body['title'];
    if (typeof body['content'] === 'string') post.content = body['content'];
    if (typeof body['excerpt'] === 'string') post.excerpt = body['excerpt'];
    if (typeof body['status'] === 'string') post.status = body['status'];
    if (typeof body['slug'] === 'string') post.slug = body['slug'];
    if (Array.isArray(body['categories'])) post.categories = body['categories'] as number[];
    if (Array.isArray(body['tags'])) post.tags = body['tags'] as number[];
    if (typeof body['featured_media'] === 'number') post.featuredMedia = body['featured_media'];
    post.modifiedGmt = this.gmt();
    // pre_post_update and wp_after_insert_post both advance the counter where the plugin is installed.
    if (this.plugin !== 'absent') post.counter += 2;
    this.saveRevision(post);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', this.baseUrl);
      const method = (req.method ?? 'GET').toUpperCase();
      const path = decodeURIComponent(url.pathname);
      this.requests.push({ method, path, body: raw });
      const hook = this.hooks.findIndex((h) => h.method === method && h.path === path);
      if (hook >= 0) {
        const [h] = this.hooks.splice(hook, 1);
        h?.fn();
      }
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        send(400, { code: 'rest_invalid_json' });
        return;
      }
      const noRoute = () =>
        send(404, { code: 'rest_no_route', message: 'No route was found.', data: { status: 404 } });

      if (path.startsWith(PLUGIN_ROUTE)) {
        if (this.plugin === 'absent') return noRoute();
        if (this.plugin === 'outage') return send(503, { code: 'service_unavailable' });
        if (method === 'GET' && path === `${PLUGIN_ROUTE}/capabilities`)
          return send(200, {
            plugin: 'oremedia-conditional-write',
            version: '1.0.0',
            protocol: 1,
            features: {
              conditional_update: this.plugin === 'active',
              write_counter: true,
              fingerprint: 'sha256-v1',
            },
          });
        const m = /^\/wp-json\/oremedia\/v1\/posts\/(\d+)$/.exec(path);
        if (method === 'POST' && m) {
          if (this.plugin === 'not_transactional')
            return send(501, { code: 'oremedia_not_transactional', data: { status: 501 } });
          const post = this.posts.get(Number(m[1]));
          if (!post) return send(404, { code: 'rest_post_invalid_id', data: { status: 404 } });
          // Compare and write with nothing in between (the plugin's locked transaction).
          if (
            body['expected_version'] !== post.counter ||
            body['expected_fingerprint'] !== this.fingerprint(post)
          )
            return send(412, {
              code: 'oremedia_precondition_failed',
              message: 'The post changed since the revision the client last read; nothing was written.',
              data: {
                status: 412,
                current: {
                  version: post.counter,
                  fingerprint: this.fingerprint(post),
                  post: this.json(post),
                },
              },
            });
          this.applyCoreUpdate(post, (body['post'] ?? {}) as Record<string, unknown>);
          return send(200, {
            version: post.counter,
            fingerprint: this.fingerprint(post),
            protocol: 1,
            post: this.json(post),
          });
        }
        return noRoute();
      }

      if (path === `${CORE_ROUTE}/posts` && method === 'POST') {
        const post = this.seed({ status: 'draft' });
        this.applyCoreUpdate(post, body);
        return send(201, this.json(post));
      }
      const revisions = /^\/wp-json\/wp\/v2\/posts\/(\d+)\/revisions$/.exec(path);
      if (revisions && method === 'GET')
        return send(
          200,
          (this.revisions.get(Number(revisions[1])) ?? []).map((r, i) => ({
            id: 900 + i,
            parent: r.id,
            slug: `${r.id}-revision`,
            status: 'inherit',
            modified_gmt: r.modifiedGmt,
            title: { raw: r.title },
            content: { raw: r.content },
          })),
        );
      const single = /^\/wp-json\/wp\/v2\/posts\/(\d+)$/.exec(path);
      if (single) {
        const post = this.posts.get(Number(single[1]));
        if (!post) return send(404, { code: 'rest_post_invalid_id', data: { status: 404 } });
        if (method === 'GET') return send(200, this.json(post));
        if (method === 'POST') {
          this.applyCoreUpdate(post, body);
          return send(200, this.json(post));
        }
      }
      if (/^\/wp-json\/wp\/v2\/(categories|tags)$/.test(path)) {
        if (method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json', 'x-wp-totalpages': '1' });
          res.end('[]');
          return;
        }
        return send(201, { id: 500 + this.requests.length, name: body['name'] });
      }
      return noRoute();
    });
  }
}
