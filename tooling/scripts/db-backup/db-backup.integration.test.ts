import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP, BACKUP, Harness, line, sha256, stamp } from './harness';

/**
 * PR-09: the database halves of the db-backup image against a real MySQL (TEST_DATABASE_URL, root): backup.sh dumps a
 * database with its sha256 sidecar and backs up the objects in the same run, verify.sh passes on what it wrote,
 * restore.sh loads the dump into another database after checking the sidecar, refuses a mismatched sidecar and a
 * target that is the source server under another name, and drill.sh times the restore. The object store is the
 * AWS CLI stand-in of the unit suite (harness.ts).
 */
const url = process.env['TEST_DATABASE_URL'];
if (!url) throw new Error('TEST_DATABASE_URL is required for the db-backup integration test');
const u = new URL(url);
if (decodeURIComponent(u.username) !== 'root')
  throw new Error('the db-backup scripts connect as root: TEST_DATABASE_URL must use the root user');
const HOST = u.hostname;
const PW = decodeURIComponent(u.password);
const PORT = u.port || '3306';
const suffix = randomBytes(4).toString('hex');
const SRC = `dbbk_src_${suffix}`;
const DST = `dbbk_dst_${suffix}`;

function sql(query: string, host = HOST): string {
  const r = spawnSync('mysql', ['-h', host, '-uroot', '--connect-timeout=5', '-N', '-e', query], {
    env: { ...process.env, MYSQL_PWD: PW, MYSQL_TCP_PORT: PORT },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`mysql failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** Another name for the same server (localhost over the socket, or a non-loopback address of this machine). */
function aliasHost(): string {
  const uuid = sql('SELECT @@server_uuid');
  const candidates = [
    'localhost',
    ...Object.values(networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => (i as { address: string }).address),
  ].filter((c) => c !== HOST);
  for (const c of candidates) {
    try {
      if (sql('SELECT @@server_uuid', c) === uuid) return c;
    } catch {
      // not reachable under this name
    }
  }
  throw new Error(
    'no second name reaches the test MySQL server (tried localhost and the non-loopback addresses)',
  );
}

/** The real mysqldump, for the stand-ins that cut its output short. */
const MYSQLDUMP = spawnSync('sh', ['-c', 'command -v mysqldump'], { encoding: 'utf8' }).stdout.trim();

let h: Harness;
const db = () => ({ MYSQL_TCP_PORT: PORT, BACKUP_LOCAL_DIR: `${h.dir}/no-volume` });

beforeAll(() => {
  h = new Harness();
  sql(`CREATE DATABASE \`${SRC}\``);
  sql(
    `CREATE TABLE \`${SRC}\`.__drizzle_migrations (id int AUTO_INCREMENT PRIMARY KEY, hash text NOT NULL, created_at bigint);
     CREATE TABLE \`${SRC}\`.brands (id varchar(32) PRIMARY KEY, tenant_id varchar(32) NOT NULL, name text NOT NULL);
     INSERT INTO \`${SRC}\`.__drizzle_migrations (hash, created_at) VALUES ('a', 1), ('b', 2);`,
  );
  const rows = Array.from(
    { length: 400 },
    (_, i) => `('brd_${i}', 'ten_${i % 7}', '${randomBytes(24).toString('hex')}')`,
  );
  sql(`INSERT INTO \`${SRC}\`.brands VALUES ${rows.join(',')}`);
  h.put(APP, 'assets', 'assets/ten_1/brd_1/ast_1/ver_1/original', 'image one');
  h.put(APP, 'assets', 'assets/ten_2/brd_2/ast_2/ver_1/original', 'image two');
  h.put(APP, 'releases', 'releases/ten_1/brd_1/ver_1/render/n1', 'render', 'video/mp4');
});

afterAll(() => {
  sql(`DROP DATABASE IF EXISTS \`${SRC}\`; DROP DATABASE IF EXISTS \`${DST}\``);
  h.cleanup();
});

describe('db-backup against MySQL', { timeout: 120_000 }, () => {
  it('backup.sh dumps the database with a sha256 sidecar and backs up the objects in the same run', () => {
    const r = h.run('backup.sh', [], { ...db(), SRC_HOST: HOST, SRC_DB: SRC, SRC_PW: PW });
    expect(r.status, r.out).toBe(0);
    const pass = line(r, 'DB_BACKUP_PASS oremedia ');
    const m = /s3:\/\/backups\/(\S+) (\d+) bytes binlog=\d sha256=([0-9a-f]{64})$/.exec(pass ?? '');
    expect(m, r.out).not.toBeNull();
    const [, key, size, sum] = m as unknown as [string, string, string, string];
    const dump = h.get(BACKUP, 'backups', key);
    expect(dump?.length).toBe(Number(size));
    expect(sha256(dump as Buffer)).toBe(sum);
    expect(h.get(BACKUP, 'backups', `${key}.sha256`)?.toString()).toBe(`${sum}  ${key.split('/').pop()}\n`);
    expect(line(r, 'DB_BACKUP_DONE ')).toBeDefined();
    expect(r.lines).toContain('OBJECT_BACKUP_PASS assets 2 18');
    expect(r.lines).toContain('OBJECT_BACKUP_PASS releases 1 6');
  });

  it('a failing dump does not skip the object backup, and the run still exits 1', () => {
    h.put(APP, 'assets', 'assets/ten_3/brd_3/ast_3/ver_1/original', 'image three');
    const r = h.run('backup.sh', [], { ...db(), SRC_HOST: HOST, SRC_DB: `${SRC}_missing`, SRC_PW: PW });
    expect(r.status).toBe(1);
    expect(line(r, 'DB_BACKUP_PASS')).toBeUndefined();
    expect(r.lines).toContain('OBJECT_BACKUP_PASS assets 1 11');
  });

  it('verify.sh passes on the dump and the object backup it just wrote', () => {
    const r = h.run('verify.sh', [], db());
    expect(r.status, r.out).toBe(0);
    expect(line(r, 'BACKUP_VERIFY_CHECK ok dump db-backups/test/oremedia/')).toBeDefined();
    expect(r.lines.at(-1)).toMatch(/^BACKUP_VERIFY_PASS \d+ checks$/);
  });

  it('a dump killed mid-stream, or cut short with exit 0, prints DB_BACKUP_FAIL and uploads no dump or sidecar', () => {
    const before = h.keys(BACKUP, 'backups', 'db-backups/test/oremedia/');
    const env = { ...db(), SRC_HOST: HOST, SRC_DB: SRC, SRC_PW: PW };
    try {
      // The real dump's first 20 KB (well over the 1 KB floor once gzipped), then the process is killed.
      h.tool('mysqldump', `"${MYSQLDUMP}" "$@" | head -c 20000\nkill -KILL $$`);
      const killed = h.run('backup.sh', ['--databases'], env);
      expect(killed.status, killed.out).toBe(1);
      expect(killed.lines).toContain(
        'DB_BACKUP_FAIL oremedia mysqldump exited 137, gzip exited 0: dump incomplete, nothing uploaded',
      );
      // Everything but the last line, and exit 0: only the missing trailer gives it away.
      h.tool('mysqldump', `"${MYSQLDUMP}" "$@" | sed '$d'`);
      const cut = h.run('backup.sh', ['--databases'], env);
      expect(cut.status, cut.out).toBe(1);
      expect(cut.lines).toContain(
        "DB_BACKUP_FAIL oremedia dump has no '-- Dump completed' trailer: dump incomplete, nothing uploaded",
      );
    } finally {
      h.tool('mysqldump', `exec "${MYSQLDUMP}" "$@"`);
    }
    expect(h.keys(BACKUP, 'backups', 'db-backups/test/oremedia/')).toEqual(before);
  });

  it('verify.sh fails on a newest dump without the trailer, even with a matching sidecar', () => {
    const dumps = h.keys(BACKUP, 'backups', 'db-backups/test/oremedia/').filter((k) => k.endsWith('.sql.gz'));
    const real = gunzipSync(h.get(BACKUP, 'backups', dumps[dumps.length - 1] as string) as Buffer).toString();
    expect(real.trimEnd().split('\n').at(-1)).toMatch(/^-- Dump completed/);
    const cut = gzipSync(real.trimEnd().split('\n').slice(0, -1).join('\n'));
    const file = `oremedia-${stamp(-1)}.sql.gz`;
    const key = `db-backups/test/oremedia/${file}`;
    h.put(BACKUP, 'backups', key, cut, 'application/gzip');
    h.put(BACKUP, 'backups', `${key}.sha256`, `${sha256(cut)}  ${file}\n`, 'text/plain');
    try {
      const r = h.run('verify.sh', [], db());
      expect(r.status, r.out).toBe(1);
      expect(r.lines).toContain(
        `BACKUP_VERIFY_CHECK FAIL dump ${key}: no '-- Dump completed' trailer (dump cut short)`,
      );
    } finally {
      h.remove(BACKUP, 'backups', key);
      h.remove(BACKUP, 'backups', `${key}.sha256`);
    }
  });

  it('restore.sh checks the sidecar, loads the dump into another database and verifies the tables', () => {
    // The test restores into another database of the source server, so the identity check is waived by naming the
    // exact target; the refusals below run without it.
    const r = h.run('restore.sh', [], {
      ...db(),
      DST_HOST: HOST,
      DST_PW: PW,
      RESTORE_DB: DST,
      RESTORE_ALLOW_UNVERIFIED_TARGET: HOST,
    });
    expect(r.status, r.out).toBe(0);
    expect(r.lines).toContain(
      'RECOVERY_GUARD server identity not verified; RESTORE_ALLOW_UNVERIFIED_TARGET names this target',
    );
    expect(line(r, 'RESTORE_CHECKSUM sha256=')).toMatch(/matches the sidecar$/);
    expect(r.lines.filter((l) => l.startsWith('RESTORE_STEP')).map((l) => l.split(' ')[1])).toEqual([
      'downloaded',
      'checksum-verified',
      'unpacked',
      'loaded',
      'verified',
    ]);
    expect(r.lines).toContain('RESTORE_TABLES expected=2 restored=2 migration_rows=2');
    expect(sql(`SELECT COUNT(*), SUM(CRC32(name)) FROM \`${DST}\`.brands`)).toBe(
      sql(`SELECT COUNT(*), SUM(CRC32(name)) FROM \`${SRC}\`.brands`),
    );
  });

  it('restore.sh refuses the source server under another name, an unset or unreadable source, an empty or unknown environment, production, and a mismatched sidecar, leaving the target as it was', () => {
    sql(`CREATE TABLE \`${DST}\`.marker (id int); INSERT INTO \`${DST}\`.marker VALUES (7)`);
    const base = { ...db(), DST_PW: PW, RESTORE_DB: DST };

    const alias = h.run('restore.sh', [], { ...base, DST_HOST: aliasHost(), SRC_HOST: HOST, SRC_PW: PW });
    expect(alias.status).toBe(1);
    expect(alias.lines).toContain(
      'RESTORE_FAIL target is the same MySQL server as SRC_HOST (server_uuid); refusing to restore over it',
    );

    // Another name for the server, so the name check alone does not decide: the identity check must.
    const other = aliasHost();
    for (const [env, expected] of [
      [{}, 'RESTORE_FAIL SRC_HOST and SRC_PW are required to prove the target is not the source server'],
      [
        { SRC_HOST: HOST, SRC_PW: `${PW}-wrong` },
        'RESTORE_FAIL source server identity (SRC_HOST @@server_uuid) not readable',
      ],
      [
        { SRC_HOST: 'mysql-source.invalid', SRC_PW: PW },
        'RESTORE_FAIL source server identity (SRC_HOST @@server_uuid) not readable',
      ],
      [
        { RESTORE_ALLOW_UNVERIFIED_TARGET: other, OREMEDIA_ENV: undefined },
        'RESTORE_FAIL environment name unknown',
      ],
      [
        { RESTORE_ALLOW_UNVERIFIED_TARGET: other, OREMEDIA_ENV: 'live' },
        "RESTORE_FAIL refusing to run in unrecognised environment 'live'",
      ],
    ] as const) {
      const r = h.run('restore.sh', [], { ...base, DST_HOST: other, ...env });
      expect(r.status, r.out).toBe(1);
      expect(line(r, expected), r.out).toBeDefined();
    }

    const prod = h.run('restore.sh', [], {
      ...base,
      DST_HOST: HOST,
      RAILWAY_ENVIRONMENT_NAME: 'production',
      OREMEDIA_ENV: undefined,
    });
    expect(line(prod, 'RESTORE_FAIL refusing to run in environment')).toBeDefined();

    const dumps = h.keys(BACKUP, 'backups', 'db-backups/test/oremedia/').filter((k) => k.endsWith('.sql.gz'));
    const newest = dumps[dumps.length - 1] as string;
    h.put(BACKUP, 'backups', `${newest}.sha256`, `${sha256('tampered')}  x\n`, 'text/plain');
    const bad = h.run('restore.sh', [], { ...base, DST_HOST: HOST, RESTORE_ALLOW_UNVERIFIED_TARGET: HOST });
    expect(bad.status).toBe(1);
    expect(line(bad, 'RESTORE_FAIL checksum mismatch')).toBeDefined();

    expect(sql(`SELECT id FROM \`${DST}\`.marker`)).toBe('7');
    // The scheduled check catches the same mismatch.
    expect(line(h.run('verify.sh', [], db()), 'BACKUP_VERIFY_FAIL')).toBeDefined();
  });

  it('drill.sh times the database restore and refuses production', () => {
    const r0 = h.run('backup.sh', [], { ...db(), SRC_HOST: HOST, SRC_DB: SRC, SRC_PW: PW });
    expect(r0.status, r0.out).toBe(0);
    const env = {
      ...db(),
      OREMEDIA_ENV: 'staging',
      DST_HOST: HOST,
      DST_PW: PW,
      RESTORE_DB: DST,
      RESTORE_ALLOW_UNVERIFIED_TARGET: HOST,
    };
    const r = h.run('drill.sh', ['db'], env);
    expect(r.status, r.out).toBe(0);
    expect(
      r.lines.filter((l) => l.startsWith('DRILL_STEP')).map((l) => l.split(' ').slice(1, 3).join(' ')),
    ).toEqual(['db-restore start', 'db-restore end']);
    expect(line(r, 'RESTORE_PASS oremedia from ')).toBeDefined();
    expect(r.lines.at(-1)).toMatch(/^DRILL_PASS db in \d+s$/);
    const prod = h.run('drill.sh', ['db'], { ...env, OREMEDIA_ENV: 'production' });
    expect(prod.status).toBe(1);
    expect(line(prod, 'RESTORE_PASS')).toBeUndefined();
    const unverified = h.run('drill.sh', ['db'], { ...env, RESTORE_ALLOW_UNVERIFIED_TARGET: undefined });
    expect(unverified.status).toBe(1);
    expect(line(unverified, 'DRILL_FAIL SRC_HOST and SRC_PW are required')).toBeDefined();
    expect(line(unverified, 'RESTORE_PASS')).toBeUndefined();
  });
});
