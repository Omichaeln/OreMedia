import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP, BACKUP, Harness, line, md5, sha256, stamp } from './harness';

/**
 * PR-09: the object backup, the object restore, the integrity check and the recovery guards of the db-backup image
 * (infra/railway/db-backup), run with `sh` against an AWS CLI stand-in (fake-aws.mjs) with separate application and
 * backup stores. The database halves run against MySQL in db-backup.integration.test.ts.
 */
let h: Harness;
beforeEach(() => {
  h = new Harness();
});
afterEach(() => {
  h.cleanup();
});

const objectKey = (bucket: string, sha: string) => `object-backups/test/${bucket}/objects/${sha}`;

function seed(): Record<string, string> {
  const files: Record<string, string> = {
    'assets/ten_a/brd_1/ast_1/ver_1/original': 'first image bytes',
    'assets/ten_a/brd_1/ast_2/ver_1/original': 'second image bytes, a little longer',
    'assets/ten_b/brd_9/ast_3/ver_1/original': 'tenant b image',
  };
  for (const [k, v] of Object.entries(files)) h.put(APP, 'assets', k, v);
  h.put(APP, 'assets', 'quarantine/ten_a/int_1', 'unscanned upload');
  h.put(APP, 'releases', 'releases/ten_a/brd_1/ver_1/render/n1', 'release render', 'video/mp4');
  return files;
}

describe('object backup', { timeout: 60_000 }, () => {
  it('copies every object into the backups store under its sha256 and writes a manifest per run', () => {
    const files = seed();
    const r = h.run('object-backup.sh');
    expect(r.status, r.out).toBe(0);
    const bytes = Object.values(files).reduce((s, v) => s + Buffer.byteLength(v), 0);
    expect(r.lines).toContain(`OBJECT_BACKUP_PASS assets 3 ${bytes}`);
    expect(r.lines).toContain(`OBJECT_BACKUP_PASS releases 1 ${Buffer.byteLength('release render')}`);

    const m = h.manifest('assets');
    expect(m.header[0]).toBe('# oremedia object backup manifest v1');
    expect(m.header[1]).toMatch(/^# bucket=assets stamp=\d{8}T\d{6}Z live=3 gone=0 copied=3$/);
    expect(m.rows.map((x) => x.key)).toEqual(Object.keys(files).sort());
    for (const row of m.rows) {
      const body = files[row.key] as string;
      expect(row).toMatchObject({ state: 'live', sha: sha256(body), size: body.length, etag: md5(body) });
      expect(row.contentType).toBe('image/png');
      expect(h.get(BACKUP, 'backups', objectKey('assets', row.sha))?.toString()).toBe(body);
    }
    expect(h.manifest('releases').rows[0]).toMatchObject({ contentType: 'video/mp4' });
    // quarantine/ (unscanned uploads) is excluded by default.
    expect(m.rows.some((x) => x.key.startsWith('quarantine/'))).toBe(false);
    // Every call to the application store used its own key and path-style addressing; the backups store likewise.
    expect(h.calls().every((c) => c.pathStyle)).toBe(true);
    // No credential ever reaches the output.
    expect(r.out).not.toMatch(/backup-secret|app-secret|backup-key|app-key/);
  });

  it('is idempotent: a rerun copies nothing and uploads no content again', () => {
    seed();
    expect(h.run('object-backup.sh').status).toBe(0);
    h.resetCalls();
    const r = h.run('object-backup.sh');
    expect(r.status, r.out).toBe(0);
    expect(r.lines).toContain('OBJECT_BACKUP_PASS assets 0 0');
    expect(r.lines).toContain('OBJECT_BACKUP_PASS releases 0 0');
    const uploads = h.calls().filter((c) => c.cmd === 's3 cp put' && c.key.includes('/objects/'));
    expect(uploads).toEqual([]);
    expect(h.calls().filter((c) => c.cmd === 's3api get-object')).toEqual([]);
    expect(h.manifest('assets').rows).toHaveLength(3);
  });

  it('never writes to or deletes from a source bucket; a deleted key is kept for the retention window, then pruned', () => {
    const files = seed();
    expect(h.run('object-backup.sh').status).toBe(0);
    const gone = 'assets/ten_a/brd_1/ast_1/ver_1/original';
    const goneSha = sha256(files[gone] as string);
    h.remove(APP, 'assets', gone);

    const r = h.run('object-backup.sh');
    expect(r.status, r.out).toBe(0);
    const row = h.manifest('assets').rows.find((x) => x.key === gone);
    expect(row).toMatchObject({ state: 'gone', sha: goneSha });
    expect(h.get(BACKUP, 'backups', objectKey('assets', goneSha))?.toString()).toBe(files[gone]);

    // Within the window: still kept on the next runs.
    expect(h.run('object-backup.sh', [], { BACKUP_RETENTION_DAYS: '14' }).status).toBe(0);
    expect(h.get(BACKUP, 'backups', objectKey('assets', goneSha))).not.toBeNull();

    // Past the window (0 days, a later second): the row and its content are pruned; live content stays.
    const until = Date.now() + 1100;
    while (Date.now() < until) {
      /* the stamps have a resolution of one second */
    }
    const p = h.run('object-backup.sh', [], { BACKUP_RETENTION_DAYS: '0' });
    expect(p.status, p.out).toBe(0);
    expect(p.lines).toContain('OBJECT_BACKUP_PRUNED assets 1 objects past the 0-day retention');
    expect(h.manifest('assets').rows.map((x) => x.key)).not.toContain(gone);
    expect(h.get(BACKUP, 'backups', objectKey('assets', goneSha))).toBeNull();
    for (const k of Object.keys(files).filter((k) => k !== gone))
      expect(h.get(BACKUP, 'backups', objectKey('assets', sha256(files[k] as string)))).not.toBeNull();
    // Only the newest manifest survives a 0-day window.
    expect(h.keys(BACKUP, 'backups', 'object-backups/test/assets/manifests/')).toHaveLength(1);

    const toSource = h.calls().filter((c) => c.endpoint === APP);
    expect(toSource.length).toBeGreaterThan(0);
    expect(new Set(toSource.map((c) => c.cmd))).toEqual(
      new Set(['s3api list-objects-v2', 's3api get-object']),
    );
    // The source object that remained was never rewritten.
    expect(h.keys(APP, 'assets')).toHaveLength(3);
  });

  it('copies a changed object again and keeps the previous content as gone', () => {
    const files = seed();
    expect(h.run('object-backup.sh').status).toBe(0);
    const k = 'assets/ten_b/brd_9/ast_3/ver_1/original';
    h.put(APP, 'assets', k, 'tenant b image, replaced');
    const r = h.run('object-backup.sh');
    expect(r.lines).toContain(`OBJECT_BACKUP_PASS assets 1 ${'tenant b image, replaced'.length}`);
    const rows = h.manifest('assets').rows.filter((x) => x.key === k);
    expect(rows.map((x) => [x.state, x.sha])).toEqual([
      ['live', sha256('tenant b image, replaced')],
      ['gone', sha256(files[k] as string)],
    ]);
  });

  it('is bounded per run and carries the rest over from a cursor', () => {
    for (let i = 1; i <= 5; i++)
      h.put(APP, 'assets', `assets/ten_a/brd_1/ast_${i}/ver_1/original`, `body ${i}`);
    const env = { OBJECT_STORE_BUCKET_RELEASES: '', OBJECT_BACKUP_MAX_OBJECTS: '2' };
    const r1 = h.run('object-backup.sh', [], env);
    expect(r1.status, r1.out).toBe(0);
    expect(r1.lines).toContain('OBJECT_BACKUP_CARRYOVER assets 3 objects left for the next run');
    expect(r1.lines).toContain('OBJECT_BACKUP_PASS assets 2 12');
    expect(h.get(BACKUP, 'backups', 'object-backups/test/assets/cursor')?.toString()).toBe(
      'assets/ten_a/brd_1/ast_2/ver_1/original',
    );
    const r2 = h.run('object-backup.sh', [], env);
    expect(r2.lines).toContain('OBJECT_BACKUP_CARRYOVER assets 1 objects left for the next run');
    expect(h.manifest('assets').rows.map((x) => x.key.split('/')[3])).toEqual([
      'ast_1',
      'ast_2',
      'ast_3',
      'ast_4',
    ]);
    const r3 = h.run('object-backup.sh', [], env);
    expect(r3.lines).toContain('OBJECT_BACKUP_PASS assets 1 6');
    expect(h.get(BACKUP, 'backups', 'object-backups/test/assets/cursor')).toBeNull();
    expect(h.manifest('assets').rows).toHaveLength(5);

    // A byte bound: at least one object per run, then stop before the bound is crossed.
    h.put(APP, 'assets', 'assets/ten_a/brd_1/ast_8/ver_1/original', 'x'.repeat(40));
    h.put(APP, 'assets', 'assets/ten_a/brd_1/ast_9/ver_1/original', 'y'.repeat(40));
    const r4 = h.run('object-backup.sh', [], { ...env, OBJECT_BACKUP_MAX_BYTES: '50' });
    expect(r4.lines).toContain('OBJECT_BACKUP_PASS assets 1 40');
    expect(r4.lines).toContain('OBJECT_BACKUP_CARRYOVER assets 1 objects left for the next run');
  });

  it('fails the run on a download error but keeps the other copies and moves the cursor past it', () => {
    seed();
    const bad = 'assets/ten_a/brd_1/ast_1/ver_1/original';
    const r = h.run('object-backup.sh', [], { FAKE_S3_FAIL_GET_KEYS: bad, OBJECT_BACKUP_MAX_OBJECTS: '2' });
    expect(r.status).toBe(1);
    expect(r.lines).toContain(`OBJECT_BACKUP_ERROR assets ${bad} download failed`);
    expect(line(r, 'OBJECT_BACKUP_FAIL assets 1 errors; copied 1 objects')).toBeDefined();
    expect(h.manifest('assets').rows.map((x) => x.key)).toEqual(['assets/ten_a/brd_1/ast_2/ver_1/original']);
    // The next run starts after the cursor (ast_2), so the remaining key goes first, then the failed one again.
    const r2 = h.run('object-backup.sh', [], { OBJECT_STORE_BUCKET_RELEASES: '' });
    expect(r2.status, r2.out).toBe(0);
    expect(h.manifest('assets').rows).toHaveLength(3);
  });

  it('refuses to back up the backups bucket into itself, and fails on a key outside the key pattern', () => {
    const self = h.run('object-backup.sh', ['backups']);
    expect(self.status).toBe(1);
    expect(self.lines).toContain(
      'OBJECT_BACKUP_FAIL backups is the backups bucket; refusing to back it up into itself',
    );
    h.put(APP, 'assets', 'assets/ten_a/a file with spaces', 'x');
    h.put(APP, 'assets', 'assets/ten_a/ok', 'y');
    const r = h.run('object-backup.sh', ['assets']);
    expect(r.status).toBe(1);
    expect(r.lines).toContain(
      'OBJECT_BACKUP_UNSUPPORTED_KEY assets 1 keys outside the application key pattern were not backed up',
    );
    expect(h.manifest('assets').rows.map((x) => x.key)).toEqual(['assets/ten_a/ok']);
  });

  it('fails without an environment name or prefix rather than writing to an unscoped path', () => {
    const r = h.run('object-backup.sh', [], { OREMEDIA_ENV: undefined });
    expect(r.status).toBe(1);
    expect(line(r, 'OBJECT_BACKUP_FAIL - set OBJECT_BACKUP_PREFIX')).toBeDefined();
  });
});

describe('object restore', { timeout: 60_000 }, () => {
  it('restores a bucket into a scratch prefix and verifies every object against the manifest sha256', () => {
    const files = seed();
    expect(h.run('object-backup.sh').status).toBe(0);
    const r = h.run('restore-objects.sh', [], {
      RESTORE_BUCKET: 'assets',
      DST_BUCKET: 'backups',
      DST_PREFIX: 'restore-scratch/t1/',
      DST_OBJECT_STORE_ENDPOINT: BACKUP,
      DST_OBJECT_STORE_ACCESS_KEY_ID: 'backup-key',
      DST_OBJECT_STORE_SECRET_ACCESS_KEY: 'backup-secret',
    });
    expect(r.status, r.out).toBe(0);
    expect(r.lines.filter((l) => l.startsWith('RESTORE_STEP')).map((l) => l.split(' ')[1])).toEqual([
      'objects-manifest',
      'objects-copied',
      'objects-verified',
    ]);
    expect(line(r, 'OBJECT_RESTORE_PASS 3 objects in ')).toMatch(/^OBJECT_RESTORE_PASS 3 objects in \d+s$/);
    for (const [k, v] of Object.entries(files)) {
      expect(h.get(BACKUP, 'backups', `restore-scratch/t1/${k}`)?.toString()).toBe(v);
      expect(h.contentType(BACKUP, 'backups', `restore-scratch/t1/${k}`)).toBe('image/png');
    }
  });

  it('restores one tenant prefix into another bucket of the application store', () => {
    seed();
    expect(h.run('object-backup.sh').status).toBe(0);
    h.bucket(APP, 'assets-restored');
    const r = h.run('restore-objects.sh', [], {
      RESTORE_BUCKET: 'assets',
      DST_BUCKET: 'assets-restored',
      RESTORE_KEY_PREFIX: 'assets/ten_b/',
    });
    expect(r.status, r.out).toBe(0);
    expect(r.lines).toContain('OBJECT_RESTORE_SELECTED 1 objects, 14 bytes, into s3://assets-restored/');
    expect(h.keys(APP, 'assets-restored')).toEqual(['assets/ten_b/brd_9/ast_3/ver_1/original']);
  });

  it('restores a key deleted from the source only when asked to (RESTORE_INCLUDE_GONE=1)', () => {
    seed();
    expect(h.run('object-backup.sh').status).toBe(0);
    h.remove(APP, 'assets', 'assets/ten_b/brd_9/ast_3/ver_1/original');
    expect(h.run('object-backup.sh').status).toBe(0);
    h.bucket(APP, 'restored');
    const env = { RESTORE_BUCKET: 'assets', DST_BUCKET: 'restored', RESTORE_KEY_PREFIX: 'assets/ten_b/' };
    expect(
      line(h.run('restore-objects.sh', [], env), 'OBJECT_RESTORE_FAIL nothing to restore'),
    ).toBeDefined();
    const r = h.run('restore-objects.sh', [], { ...env, RESTORE_INCLUDE_GONE: '1' });
    expect(r.status, r.out).toBe(0);
    expect(h.get(APP, 'restored', 'assets/ten_b/brd_9/ast_3/ver_1/original')?.toString()).toBe(
      'tenant b image',
    );
  });

  it('fails on corrupt backup content and on a target key that exists with other content, which it never overwrites', () => {
    const files = seed();
    expect(h.run('object-backup.sh').status).toBe(0);
    const k = 'assets/ten_a/brd_1/ast_2/ver_1/original';
    h.corrupt(BACKUP, 'backups', objectKey('assets', sha256(files[k] as string)), 'bit rot');
    h.bucket(APP, 'restored');
    const env = { RESTORE_BUCKET: 'assets', DST_BUCKET: 'restored' };
    const r = h.run('restore-objects.sh', [], env);
    expect(r.status).toBe(1);
    expect(r.lines).toContain(
      `OBJECT_RESTORE_ERROR ${k} backup content does not match its sha256 (corrupt backup)`,
    );
    expect(r.lines).toContain('OBJECT_RESTORE_FAIL 1 objects not copied');

    h.corrupt(BACKUP, 'backups', objectKey('assets', sha256(files[k] as string)), files[k] as string);
    h.put(APP, 'restored', k, 'someone else wrote this');
    const r2 = h.run('restore-objects.sh', [], env);
    expect(r2.status).toBe(1);
    // The two objects the first run restored and the foreign one are all verified, none rewritten.
    expect(r2.lines).toContain(
      'OBJECT_RESTORE_EXISTING 3 keys already in the target: not overwritten, verified below',
    );
    expect(line(r2, `OBJECT_RESTORE_MISMATCH ${k} target sha256`)).toBeDefined();
    expect(h.get(APP, 'restored', k)?.toString()).toBe('someone else wrote this');

    // A rerun into a target that already holds the right content passes without writing it again.
    h.put(APP, 'restored', k, files[k] as string);
    h.resetCalls();
    const r3 = h.run('restore-objects.sh', [], env);
    expect(r3.status, r3.out).toBe(0);
    expect(h.calls().filter((c) => c.cmd === 's3 cp put' && c.key === k)).toEqual([]);
  });

  it('refuses live buckets, the backups bucket outside restore-scratch/, and production without the exact override', () => {
    seed();
    expect(h.run('object-backup.sh').status).toBe(0);
    h.resetCalls();
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ DST_BUCKET: 'assets' }, 'OBJECT_RESTORE_FAIL target bucket is a live source bucket'],
      [{ DST_BUCKET: 'releases' }, 'OBJECT_RESTORE_FAIL target bucket is a live source bucket'],
      [{ DST_BUCKET: 'Assets' }, 'OBJECT_RESTORE_FAIL target bucket is a live source bucket'],
      [
        { DST_BUCKET: 'media', PROTECTED_BUCKETS: 'media' },
        'OBJECT_RESTORE_FAIL target bucket is a live source bucket',
      ],
      [
        { DST_BUCKET: 'backups' },
        'OBJECT_RESTORE_FAIL restoring into the backups bucket needs a target prefix',
      ],
      [
        { DST_BUCKET: 'backups', DST_PREFIX: 'object-backups/test/assets/' },
        'OBJECT_RESTORE_FAIL restoring into the backups bucket needs a target prefix',
      ],
      [
        { DST_BUCKET: 'restored', OREMEDIA_ENV: 'production' },
        'OBJECT_RESTORE_FAIL refusing to run in environment',
      ],
      [
        {
          DST_BUCKET: 'restored',
          OREMEDIA_ENV: undefined,
          RAILWAY_ENVIRONMENT_NAME: 'production',
          OBJECT_BACKUP_PREFIX: 'object-backups/test',
        },
        'OBJECT_RESTORE_FAIL refusing to run in environment',
      ],
      [
        { DST_BUCKET: 'restored', OREMEDIA_ENV: undefined, OBJECT_BACKUP_PREFIX: 'object-backups/test' },
        'OBJECT_RESTORE_FAIL environment name unknown',
      ],
      [
        { DST_BUCKET: 'restored', OREMEDIA_ENV: 'live', OBJECT_BACKUP_PREFIX: 'object-backups/test' },
        "OBJECT_RESTORE_FAIL refusing to run in unrecognised environment 'live'",
      ],
      [
        {
          DST_BUCKET: 'restored',
          OREMEDIA_ENV: 'production',
          RESTORE_ALLOW_PRODUCTION: 'yes',
          OBJECT_BACKUP_PREFIX: 'object-backups/test',
        },
        'OBJECT_RESTORE_FAIL refusing to run in environment',
      ],
    ];
    for (const [env, expected] of cases) {
      const r = h.run('restore-objects.sh', [], { RESTORE_BUCKET: 'assets', ...env });
      expect(r.status, JSON.stringify(env)).toBe(1);
      expect(line(r, expected), `${JSON.stringify(env)}\n${r.out}`).toBeDefined();
    }
    // Refused before any request to a store.
    expect(h.calls()).toEqual([]);

    h.bucket(APP, 'restored');
    const ok = h.run('restore-objects.sh', [], {
      RESTORE_BUCKET: 'assets',
      DST_BUCKET: 'restored',
      OREMEDIA_ENV: 'production',
      OBJECT_BACKUP_PREFIX: 'object-backups/test',
      RESTORE_ALLOW_PRODUCTION: 'restored',
    });
    expect(ok.status, ok.out).toBe(0);
    expect(ok.lines).toContain('RECOVERY_GUARD production override accepted for this target');
  });
});

describe('backup.sh dump integrity (mysqldump stand-in)', { timeout: 60_000 }, () => {
  // Enough incompressible SQL comments that the gzipped dump is well over the 1 KB floor.
  const body = `echo '-- MySQL dump'; head -c 6000 /dev/urandom | od -An -tx1 | sed 's/^/-- /'`;
  const db = {
    SRC_HOST: 'mysql-source.invalid',
    SRC_DB: 'oremedia',
    SRC_PW: 'pw',
    BACKUP_LOCAL_DIR: '/nonexistent-volume',
  };
  const stored = () => h.keys(BACKUP, 'backups', 'db-backups/test/oremedia/');

  beforeEach(() => {
    h.tool('mysql', 'echo 0');
  });

  it('a dump killed mid-stream prints DB_BACKUP_FAIL and uploads neither the dump nor a sidecar', () => {
    h.tool('mysqldump', `${body}\nkill -KILL $$`);
    const r = h.run('backup.sh', ['--databases'], db);
    expect(r.status, r.out).toBe(1);
    expect(r.lines).toContain(
      'DB_BACKUP_FAIL oremedia mysqldump exited 137, gzip exited 0: dump incomplete, nothing uploaded',
    );
    expect(line(r, 'DB_BACKUP_PASS')).toBeUndefined();
    expect(stored()).toEqual([]);
    expect(h.calls()).toEqual([]);
  });

  it('a dump that exits 0 without the "-- Dump completed" trailer is refused the same way', () => {
    h.tool('mysqldump', body);
    const r = h.run('backup.sh', ['--databases'], db);
    expect(r.status, r.out).toBe(1);
    expect(r.lines).toContain(
      "DB_BACKUP_FAIL oremedia dump has no '-- Dump completed' trailer: dump incomplete, nothing uploaded",
    );
    expect(stored()).toEqual([]);
  });

  it('a complete dump is uploaded with its sidecar', () => {
    h.tool('mysqldump', `${body}\necho '-- Dump completed on 2026-10-05 10:15:00'`);
    const r = h.run('backup.sh', ['--databases'], db);
    expect(r.status, r.out).toBe(0);
    expect(line(r, 'DB_BACKUP_PASS oremedia ')).toBeDefined();
    const keys = stored();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(`${keys[0]}.sha256`);
  });
});

describe('verify.sh', { timeout: 60_000 }, () => {
  function seedDump(
    name: string,
    minutesAgo: number,
    body = gzipSync(`-- dump\nCREATE TABLE t (id int);\n-- Dump completed on 2026-10-05 10:15:00\n`),
  ) {
    const file = `${name}-${stamp(minutesAgo)}.sql.gz`;
    const key = `db-backups/test/${name}/${file}`;
    h.put(BACKUP, 'backups', key, body, 'application/gzip');
    h.put(BACKUP, 'backups', `${key}.sha256`, `${sha256(body)}  ${file}\n`, 'text/plain');
    return key;
  }

  it('passes on a fresh dump with a matching sidecar and a fresh manifest whose sampled objects match', () => {
    seed();
    expect(h.run('object-backup.sh').status).toBe(0);
    seedDump('oremedia', 5);
    const r = h.run('verify.sh');
    expect(r.status, r.out).toBe(0);
    expect(r.lines.at(-1)).toMatch(/^BACKUP_VERIFY_PASS \d+ checks$/);
    expect(line(r, 'BACKUP_VERIFY_CHECK ok dump db-backups/test/oremedia/')).toBeDefined();
    expect(r.lines.filter((l) => l.endsWith(": ends with the '-- Dump completed' trailer"))).toHaveLength(1);
    expect(r.lines.filter((l) => / objects assets: assets\/.* sha256 and size match$/.test(l))).toHaveLength(
      3,
    );
  });

  it('fails on a sidecar mismatch, a corrupt gzip, a stale dump, a stale manifest and corrupt object content', () => {
    const files = seed();
    expect(h.run('object-backup.sh').status).toBe(0);
    const key = seedDump('oremedia', 5);
    h.put(BACKUP, 'backups', `${key}.sha256`, `${'0'.repeat(64)}  x\n`, 'text/plain');
    let r = h.run('verify.sh');
    expect(r.status).toBe(1);
    expect(line(r, `BACKUP_VERIFY_CHECK FAIL dump ${key}: sha256`)).toBeDefined();
    expect(line(r, 'BACKUP_VERIFY_FAIL 1 of')).toBeDefined();

    // A truncated dump with a matching sidecar fails gzip -t.
    const truncated = gzipSync(randomBytes(5000)).subarray(0, 2000);
    const key2 = seedDump('oremedia', 1, truncated);
    r = h.run('verify.sh');
    expect(line(r, `BACKUP_VERIFY_CHECK FAIL dump ${key2}: gzip -t failed`)).toBeDefined();

    // Stale: an hour-old dump and manifest only.
    for (const k of h.keys(BACKUP, 'backups', 'db-backups/test/oremedia/')) h.remove(BACKUP, 'backups', k);
    seedDump('oremedia', 60);
    const m = h.manifest('assets').name;
    const old = m.replace(/manifest-\d{8}T\d{6}Z/, `manifest-${stamp(45)}`);
    h.put(BACKUP, 'backups', old, h.get(BACKUP, 'backups', m) as Buffer, 'application/gzip');
    h.remove(BACKUP, 'backups', m);
    const k = 'assets/ten_a/brd_1/ast_1/ver_1/original';
    h.corrupt(BACKUP, 'backups', objectKey('assets', sha256(files[k] as string)), 'rot');
    r = h.run('verify.sh', [], { VERIFY_OBJECT_SAMPLE: '10' });
    expect(r.status).toBe(1);
    expect(line(r, 'BACKUP_VERIFY_CHECK FAIL dump db-backups/test/oremedia/oremedia-')).toMatch(
      /60m old \(limit 30m\)$/,
    );
    expect(line(r, 'BACKUP_VERIFY_CHECK FAIL objects assets: manifest')).toMatch(/45m old \(limit 30m\)$/);
    expect(r.lines).toContain(
      `BACKUP_VERIFY_CHECK FAIL objects assets: ${k} content ${sha256(files[k] as string)} missing or does not match`,
    );
  });

  it('fails on a newest dump without the "-- Dump completed" trailer, even with a matching sidecar', () => {
    seed();
    expect(h.run('object-backup.sh').status).toBe(0);
    seedDump('oremedia', 10);
    const key = seedDump(
      'oremedia',
      2,
      gzipSync('-- dump\nCREATE TABLE t (id int);\nINSERT INTO t VALUES (1'),
    );
    const r = h.run('verify.sh');
    expect(r.status, r.out).toBe(1);
    expect(r.lines).toContain(`BACKUP_VERIFY_CHECK ok dump ${key}: sha256 matches the sidecar`);
    expect(r.lines).toContain(
      `BACKUP_VERIFY_CHECK FAIL dump ${key}: no '-- Dump completed' trailer (dump cut short)`,
    );
    expect(line(r, 'BACKUP_VERIFY_FAIL 1 of')).toBeDefined();
  });

  it('fails when there is no dump or no object backup at all', () => {
    const r = h.run('verify.sh', [], { VERIFY_NAMES: 'oremedia temporal' });
    expect(r.status).toBe(1);
    expect(r.lines).toContain(
      'BACKUP_VERIFY_CHECK FAIL dump oremedia: no dump under db-backups/test/oremedia/',
    );
    expect(r.lines).toContain(
      'BACKUP_VERIFY_CHECK FAIL dump temporal: no dump under db-backups/test/temporal/',
    );
    expect(r.lines).toContain(
      'BACKUP_VERIFY_CHECK FAIL objects assets: no manifest under object-backups/test/assets/manifests/',
    );
  });
});

describe('restore.sh guards and checksum (before any database is touched)', { timeout: 60_000 }, () => {
  const db = {
    DST_HOST: 'mysql-restore.invalid',
    DST_PW: 'pw',
    RESTORE_DB: 'oremedia',
    RESTORE_ALLOW_UNVERIFIED_TARGET: 'mysql-restore.invalid',
  };

  it('refuses a target that is a source host, and production without the exact override, before any request', () => {
    for (const [env, expected] of [
      [{ SRC_HOST: 'MySQL-Restore.invalid' }, 'RESTORE_FAIL target host is a source database host'],
      [{ SRC2_HOST: 'mysql-restore.invalid' }, 'RESTORE_FAIL target host is a source database host'],
      [
        { PROTECTED_DB_HOSTS: 'a.invalid mysql-restore.invalid' },
        'RESTORE_FAIL target host is a source database host',
      ],
      [{ OREMEDIA_ENV: 'production' }, 'RESTORE_FAIL refusing to run in environment'],
      [
        { OREMEDIA_ENV: 'Production', RESTORE_ALLOW_PRODUCTION: '1' },
        'RESTORE_FAIL refusing to run in environment',
      ],
    ] as const) {
      const r = h.run('restore.sh', [], { ...db, ...env });
      expect(r.status, r.out).toBe(1);
      expect(line(r, expected), r.out).toBeDefined();
    }
    expect(h.calls()).toEqual([]);
  });

  it('refuses an empty or unrecognised environment name before any request', () => {
    for (const [env, expected] of [
      [{ OREMEDIA_ENV: undefined }, 'RESTORE_FAIL environment name unknown'],
      [{ OREMEDIA_ENV: '', RAILWAY_ENVIRONMENT_NAME: '' }, 'RESTORE_FAIL environment name unknown'],
      [{ OREMEDIA_ENV: 'live' }, "RESTORE_FAIL refusing to run in unrecognised environment 'live'"],
      [
        { OREMEDIA_ENV: undefined, RAILWAY_ENVIRONMENT_NAME: 'main' },
        "RESTORE_FAIL refusing to run in unrecognised environment 'main'",
      ],
    ] as const) {
      const r = h.run('restore.sh', [], { ...db, ...env });
      expect(r.status, r.out).toBe(1);
      expect(line(r, expected), r.out).toBeDefined();
    }
    expect(h.calls()).toEqual([]);
    // A known name gets past the environment guard (and, with nothing stored, stops at the missing dump).
    for (const name of ['staging', 'Staging-EU', 'development', 'local']) {
      const r = h.run('restore.sh', [], { ...db, OREMEDIA_ENV: name });
      expect(line(r, 'RESTORE_FAIL no dump under'), r.out).toBeDefined();
    }
  });

  it("refuses unless the source server's identity is readable and differs from the target's, or the exact override is set", () => {
    const strict = { ...db, RESTORE_ALLOW_UNVERIFIED_TARGET: undefined };
    // @@server_uuid per host: the source answers, the target answers what TARGET_UUID says (nothing: unreadable).
    h.tool(
      'mysql',
      'case "$*" in *mysql-source.invalid*) [ -n "$SOURCE_UUID" ] && echo "$SOURCE_UUID" && exit 0; exit 1 ;; esac\n' +
        '[ -n "$TARGET_UUID" ] && echo "$TARGET_UUID" && exit 0\nexit 1',
    );
    const src = { SRC_HOST: 'mysql-source.invalid', SRC_PW: 'pw' };
    const required =
      'RESTORE_FAIL SRC_HOST and SRC_PW are required to prove the target is not the source server';
    for (const [env, expected] of [
      [{}, required],
      [{ SRC_HOST: 'mysql-source.invalid' }, required],
      [{ ...src }, 'RESTORE_FAIL source server identity (SRC_HOST @@server_uuid) not readable'],
      [
        { ...src, TARGET_UUID: 'uuid-b' },
        'RESTORE_FAIL source server identity (SRC_HOST @@server_uuid) not readable',
      ],
      [{ ...src, SOURCE_UUID: 'uuid-a' }, 'RESTORE_FAIL target server identity (@@server_uuid) not readable'],
      [
        { ...src, SOURCE_UUID: 'uuid-a', TARGET_UUID: 'uuid-a' },
        'RESTORE_FAIL target is the same MySQL server as SRC_HOST (server_uuid)',
      ],
      // The override must name the exact target host, and never excuses a matching identity.
      [{ RESTORE_ALLOW_UNVERIFIED_TARGET: '1' }, required],
      [{ RESTORE_ALLOW_UNVERIFIED_TARGET: 'MYSQL-RESTORE.invalid' }, required],
      [
        {
          ...src,
          SOURCE_UUID: 'uuid-a',
          TARGET_UUID: 'uuid-a',
          RESTORE_ALLOW_UNVERIFIED_TARGET: 'mysql-restore.invalid',
        },
        'RESTORE_FAIL target is the same MySQL server as SRC_HOST (server_uuid)',
      ],
    ] as const) {
      const r = h.run('restore.sh', [], { ...strict, ...env });
      expect(r.status, `${JSON.stringify(env)}\n${r.out}`).toBe(1);
      expect(line(r, expected), `${JSON.stringify(env)}\n${r.out}`).toBeDefined();
    }
    expect(h.calls()).toEqual([]);

    const differs = h.run('restore.sh', [], {
      ...strict,
      ...src,
      SOURCE_UUID: 'uuid-a',
      TARGET_UUID: 'uuid-b',
    });
    expect(differs.lines).toContain("RECOVERY_GUARD target server identity differs from SRC_HOST's");
    expect(line(differs, 'RESTORE_FAIL no dump under'), differs.out).toBeDefined();
    const unverified = h.run('restore.sh', [], {
      ...strict,
      ...src,
      SOURCE_UUID: 'uuid-a',
      RESTORE_ALLOW_UNVERIFIED_TARGET: 'mysql-restore.invalid',
    });
    expect(unverified.lines).toContain(
      'RECOVERY_GUARD server identity not verified; RESTORE_ALLOW_UNVERIFIED_TARGET names this target',
    );
    expect(line(unverified, 'RESTORE_FAIL no dump under'), unverified.out).toBeDefined();
  });

  it('fails on a dump whose sha256 sidecar does not match, and on a dump without a sidecar', () => {
    const body = gzipSync('CREATE TABLE a (id int);\n'.repeat(100));
    const file = `oremedia-${stamp()}.sql.gz`;
    h.put(BACKUP, 'backups', `db-backups/test/oremedia/${file}`, body, 'application/gzip');
    let r = h.run('restore.sh', [], db);
    expect(r.status).toBe(1);
    expect(line(r, `RESTORE_FAIL no sha256 sidecar for db-backups/test/oremedia/${file}`)).toBeDefined();

    h.put(
      BACKUP,
      'backups',
      `db-backups/test/oremedia/${file}.sha256`,
      `${sha256('other')}  ${file}\n`,
      'text/plain',
    );
    r = h.run('restore.sh', [], db);
    expect(r.status).toBe(1);
    expect(r.lines).toContain(
      `RESTORE_FAIL checksum mismatch: sidecar ${sha256('other')}, dump ${sha256(body)}`,
    );
    // The sidecar is never taken for the newest dump.
    expect(r.lines).toContain(`RESTORE_SOURCE s3://backups/db-backups/test/oremedia/${file}`);
  });
});

describe('drill.sh', { timeout: 60_000 }, () => {
  it('refuses production, an empty or unrecognised environment, an unverified source and a live bucket; marks manual steps with timestamps', () => {
    expect(
      line(
        h.run('drill.sh', ['objects'], { OREMEDIA_ENV: undefined }),
        'DRILL_FAIL environment name unknown',
      ),
    ).toBeDefined();
    const prod = h.run('drill.sh', ['objects'], { OREMEDIA_ENV: 'production', DST_BUCKET: 'restored' });
    expect(prod.status).toBe(1);
    expect(line(prod, 'DRILL_FAIL refusing to run in environment')).toBeDefined();
    const unknown = h.run('drill.sh', ['objects'], { OREMEDIA_ENV: 'main', DST_BUCKET: 'restored' });
    expect(unknown.status).toBe(1);
    expect(line(unknown, "DRILL_FAIL refusing to run in unrecognised environment 'main'")).toBeDefined();
    const noSource = h.run('drill.sh', ['db'], {
      OREMEDIA_ENV: 'staging',
      DST_HOST: 'x.invalid',
      DST_PW: 'p',
    });
    expect(noSource.status).toBe(1);
    expect(line(noSource, 'DRILL_FAIL SRC_HOST and SRC_PW are required')).toBeDefined();
    const live = h.run('drill.sh', ['objects'], { DST_BUCKET: 'assets' });
    expect(line(live, 'DRILL_FAIL target bucket is a live source bucket')).toBeDefined();
    const dbProd = h.run('drill.sh', ['db'], {
      OREMEDIA_ENV: 'production',
      DST_HOST: 'x.invalid',
      DST_PW: 'p',
    });
    expect(line(dbProd, 'DRILL_FAIL refusing to run in environment')).toBeDefined();
    expect(h.calls()).toEqual([]);
    const mark = h.run('drill.sh', ['mark', 'kill-switches', 'start']);
    expect(mark.lines[0]).toMatch(/^DRILL_MARK kill-switches start \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ \d+$/);
  });

  it('times an object restore of each bucket into a scratch prefix', () => {
    seed();
    expect(h.run('object-backup.sh').status).toBe(0);
    const r = h.run('drill.sh', ['objects'], {
      DST_BUCKET: 'backups',
      DST_OBJECT_STORE_ENDPOINT: BACKUP,
      DST_OBJECT_STORE_ACCESS_KEY_ID: 'backup-key',
      DST_OBJECT_STORE_SECRET_ACCESS_KEY: 'backup-secret',
    });
    expect(r.status, r.out).toBe(0);
    const steps = r.lines.filter((l) => l.startsWith('DRILL_STEP'));
    expect(steps.map((l) => l.split(' ').slice(1, 3).join(' '))).toEqual([
      'objects-restore-assets start',
      'objects-restore-assets end',
      'objects-restore-releases start',
      'objects-restore-releases end',
    ]);
    expect(steps[1]).toMatch(/ end \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ elapsed=\d+s$/);
    expect(r.lines.filter((l) => l.startsWith('OBJECT_RESTORE_PASS'))).toHaveLength(2);
    expect(h.keys(BACKUP, 'backups', 'restore-scratch/drill-')).toHaveLength(4);
    expect(r.lines.at(-1)).toMatch(/^DRILL_PASS objects in \d+s$/);
  });
});
