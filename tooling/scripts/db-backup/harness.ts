import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

/**
 * Test harness for the db-backup scripts (infra/railway/db-backup): runs them with `sh` (dash on CI, so POSIX only)
 * against fake-aws.mjs, an AWS CLI stand-in over a directory per endpoint. Two stores: the application's (assets
 * and releases buckets) and the backups store, each with its own access key, so a script that sends a request to
 * the wrong store with the wrong credentials fails.
 */
export const SCRIPTS = resolve(import.meta.dirname, '../../../infra/railway/db-backup');
export const APP = 'http://app-store.test';
export const BACKUP = 'http://backup-store.test';

export interface Run {
  status: number;
  out: string;
  lines: string[];
}

export interface CallLog {
  endpoint: string;
  pathStyle: boolean;
  cmd: string;
  bucket: string;
  key: string;
}

export function sha256(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('hex');
}

export function md5(body: Buffer | string): string {
  return createHash('md5').update(body).digest('hex');
}

export class Harness {
  readonly dir = mkdtempSync(join(tmpdir(), 'db-backup-test-'));
  readonly root = join(this.dir, 'stores');
  readonly logFile = join(this.dir, 'calls.jsonl');
  private readonly bin = join(this.dir, 'bin');
  private readonly tmp = join(this.dir, 'tmp');

  constructor() {
    mkdirSync(this.bin, { recursive: true });
    mkdirSync(this.tmp, { recursive: true });
    const aws = join(this.bin, 'aws');
    writeFileSync(
      aws,
      `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, 'fake-aws.mjs')}" "$@"\n`,
    );
    chmodSync(aws, 0o755);
    for (const b of ['assets', 'releases']) this.bucket(APP, b);
    for (const b of ['backups', 'scratch']) this.bucket(BACKUP, b);
  }

  /** The variables of the db-backup service: the backups store, the application store and the source buckets. */
  env(extra: Record<string, string | undefined> = {}): Record<string, string> {
    const base: Record<string, string | undefined> = {
      PATH: `${this.bin}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
      HOME: this.dir,
      TMPDIR: this.tmp,
      FAKE_S3_ROOT: this.root,
      FAKE_S3_LOG: this.logFile,
      FAKE_S3_KEYS: JSON.stringify({ [APP]: 'app-key', [BACKUP]: 'backup-key' }),
      OBJECT_STORE_ENDPOINT: BACKUP,
      OBJECT_STORE_ACCESS_KEY_ID: 'backup-key',
      OBJECT_STORE_SECRET_ACCESS_KEY: 'backup-secret',
      BACKUP_BUCKET: 'backups',
      BACKUP_PREFIX: 'db-backups/test',
      SRC_OBJECT_STORE_ENDPOINT: APP,
      SRC_OBJECT_STORE_ACCESS_KEY_ID: 'app-key',
      SRC_OBJECT_STORE_SECRET_ACCESS_KEY: 'app-secret',
      OBJECT_STORE_BUCKET_ASSETS: 'assets',
      OBJECT_STORE_BUCKET_RELEASES: 'releases',
      OREMEDIA_ENV: 'test',
      ...extra,
    };
    return Object.fromEntries(Object.entries(base).filter((e): e is [string, string] => e[1] !== undefined));
  }

  run(script: string, args: string[] = [], extra: Record<string, string | undefined> = {}): Run {
    const r = spawnSync('sh', [join(SCRIPTS, script), ...args], {
      env: this.env(extra),
      encoding: 'utf8',
      timeout: 120_000,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    return { status: r.status ?? -1, out, lines: out.split('\n').filter(Boolean) };
  }

  /** Puts an executable `name` (a POSIX sh script body) first on the scripts' PATH, e.g. a stand-in mysqldump. */
  tool(name: string, script: string): void {
    const file = join(this.bin, name);
    writeFileSync(file, `#!/bin/sh\n${script}\n`);
    chmodSync(file, 0o755);
  }

  bucket(endpoint: string, name: string): void {
    mkdirSync(join(this.root, encodeURIComponent(endpoint), name), { recursive: true });
  }

  private paths(endpoint: string, bucket: string, key: string) {
    const b = join(this.root, encodeURIComponent(endpoint), bucket);
    return {
      object: join(b, 'objects', encodeURIComponent(key)),
      meta: join(b, 'meta', `${encodeURIComponent(key)}.json`),
      dirs: [join(b, 'objects'), join(b, 'meta')],
    };
  }

  put(endpoint: string, bucket: string, key: string, body: Buffer | string, contentType = 'image/png'): void {
    const p = this.paths(endpoint, bucket, key);
    for (const d of p.dirs) mkdirSync(d, { recursive: true });
    writeFileSync(p.object, body);
    writeFileSync(p.meta, JSON.stringify({ contentType }));
  }

  /** Overwrites an object's bytes without touching its metadata (corruption in place). */
  corrupt(endpoint: string, bucket: string, key: string, body: Buffer | string): void {
    writeFileSync(this.paths(endpoint, bucket, key).object, body);
  }

  get(endpoint: string, bucket: string, key: string): Buffer | null {
    const p = this.paths(endpoint, bucket, key).object;
    return existsSync(p) ? readFileSync(p) : null;
  }

  contentType(endpoint: string, bucket: string, key: string): string {
    return JSON.parse(readFileSync(this.paths(endpoint, bucket, key).meta, 'utf8')).contentType;
  }

  keys(endpoint: string, bucket: string, prefix = ''): string[] {
    const d = join(this.root, encodeURIComponent(endpoint), bucket, 'objects');
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .map((f) => decodeURIComponent(f))
      .filter((k) => k.startsWith(prefix))
      .sort();
  }

  /** Deletes a key, as a delete in the store would. */
  remove(endpoint: string, bucket: string, key: string): void {
    const p = this.paths(endpoint, bucket, key);
    rmSync(p.object, { force: true });
    rmSync(p.meta, { force: true });
  }

  /** The newest manifest of a source bucket's backup: header lines and rows. */
  manifest(bucket: string): { name: string; header: string[]; rows: ManifestRow[] } {
    const names = this.keys(BACKUP, 'backups', `object-backups/test/${bucket}/manifests/`);
    const name = names[names.length - 1];
    if (!name) throw new Error(`no manifest for ${bucket}`);
    const body = this.get(BACKUP, 'backups', name);
    if (!body) throw new Error(`manifest ${name} unreadable`);
    const lines = gunzipSync(body).toString('utf8').split('\n').filter(Boolean);
    return {
      name,
      header: lines.filter((l) => l.startsWith('#')),
      rows: lines
        .filter((l) => !l.startsWith('#'))
        .map((l) => {
          const [state, sha, size, etag, contentType, since, key] = l.split('\t') as [
            string,
            string,
            string,
            string,
            string,
            string,
            string,
          ];
          return { state, sha, size: Number(size), etag, contentType, since, key };
        }),
    };
  }

  calls(): CallLog[] {
    if (!existsSync(this.logFile)) return [];
    return readFileSync(this.logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as CallLog);
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  resetCalls(): void {
    writeFileSync(this.logFile, '');
  }
}

export interface ManifestRow {
  state: string;
  sha: string;
  size: number;
  etag: string;
  contentType: string;
  since: string;
  key: string;
}

/** A UTC stamp as the scripts write it (20261005T101500Z), `minutesAgo` before now. */
export function stamp(minutesAgo = 0): string {
  return new Date(Date.now() - minutesAgo * 60_000)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

export function line(run: Run, prefix: string): string | undefined {
  return run.lines.find((l) => l.startsWith(prefix));
}
