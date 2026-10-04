import { max } from 'drizzle-orm';
import { bigint, mysqlTable, serial, text } from 'drizzle-orm/mysql-core';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { configureDatabase, getDb } from './client';

/**
 * Runs versioned migrations (drizzle-kit generate output). This is the only supported way to change the schema.
 * `prisma db push --accept-data-loss`-style pushes are prohibited (spec 2.1.11, 20.4 R6).
 */
export async function runMigrations(url: string, opts: { migrationsFolder?: string } = {}): Promise<void> {
  const db = configureDatabase({ url, connectionLimit: 2 });
  await migrate(db, { migrationsFolder: opts.migrationsFolder ?? migrationsFolder() });
}

/** Bundled builds ship the SQL files next to the bundle and set OREMEDIA_MIGRATIONS_DIR. */
export const migrationsFolder = (): string =>
  process.env['OREMEDIA_MIGRATIONS_DIR'] ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** One entry of a migrations folder's `meta/_journal.json` (drizzle-kit generate output). */
export interface JournalEntry {
  idx: number;
  tag: string;
  /** Milliseconds; the migrator records it as the applied migration's `created_at`. */
  when: number;
}

/** The journal of a migrations folder (default: the bundled one), in order. */
export async function readJournal(folder: string = migrationsFolder()): Promise<JournalEntry[]> {
  const journal = JSON.parse(await readFile(path.join(folder, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };
  return journal.entries;
}

/**
 * The drizzle migrator's own bookkeeping table (drizzle-orm/mysql2/migrator: one row per applied migration, its
 * `created_at` the journal entry's `when`). Declared here, outside ./schema, so drizzle-kit never generates it.
 */
const drizzleMigrations = mysqlTable('__drizzle_migrations', {
  id: serial('id').primaryKey(),
  hash: text('hash').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }),
});

export interface MigrationState {
  /** The last migration of the journal and its `when`; null when the journal is empty. */
  expectedTag: string | null;
  expectedAt: number | null;
  /** The latest applied migration's `created_at`; null when none is applied (or the table does not exist yet). */
  appliedAt: number | null;
  /** Every journal migration is applied: the latest applied `created_at` is at or after the last `when`. */
  upToDate: boolean;
}

const noSuchTable = (err: unknown): boolean =>
  (err as { code?: string } | undefined)?.code === 'ER_NO_SUCH_TABLE' ||
  (err as { cause?: { code?: string } } | undefined)?.cause?.code === 'ER_NO_SUCH_TABLE';

/**
 * Whether the configured database has applied every migration of the journal (default: the bundled one), compared
 * the way the migrator decides what to run: the latest applied `created_at` against the last entry's `when`.
 */
export async function readMigrationState(folder: string = migrationsFolder()): Promise<MigrationState> {
  const last = (await readJournal(folder)).at(-1) ?? null;
  let appliedAt: number | null = null;
  try {
    const [row] = await getDb()
      .select({ latest: max(drizzleMigrations.createdAt) })
      .from(drizzleMigrations);
    appliedAt = row?.latest == null ? null : Number(row.latest);
  } catch (err) {
    if (!noSuchTable(err)) throw err;
  }
  return {
    expectedTag: last?.tag ?? null,
    expectedAt: last?.when ?? null,
    appliedAt,
    upToDate: last === null || (appliedAt !== null && appliedAt >= last.when),
  };
}
