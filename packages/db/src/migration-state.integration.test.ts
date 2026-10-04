import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing';
import { readJournal, readMigrationState } from './migrate';

/**
 * readMigrationState (the staging acceptance job's settle step, docs/runbooks/staging-acceptance.md): a database one
 * migration behind the bundled journal is reported pending with the applied and expected `when`, and up to date once
 * the migrator has run the rest.
 */
describe('readMigrationState', () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    const journal = await readJournal();
    const previous = journal.at(-2);
    if (!previous) throw new Error('the journal needs two migrations for this test');
    tdb = await createTestDatabase({ migrationsUpTo: previous.tag });
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('reports the pending migration, then up to date after the migrator runs', async () => {
    const journal = await readJournal();
    const last = journal.at(-1)!;
    const previous = journal.at(-2)!;

    const behind = await readMigrationState();
    expect(behind).toEqual({
      expectedTag: last.tag,
      expectedAt: last.when,
      appliedAt: previous.when,
      upToDate: false,
    });

    await tdb.migrateToHead();
    expect(await readMigrationState()).toEqual({
      expectedTag: last.tag,
      expectedAt: last.when,
      appliedAt: last.when,
      upToDate: true,
    });
  });
});
