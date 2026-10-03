import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationsFolder } from './migrate';

/**
 * The drizzle MySQL migrator applies a migration only when its journal `when` is newer than the last one applied, so
 * a migration merged with an older `when` than one already deployed is skipped forever. Every journal entry must
 * therefore follow the previous one: idx 0, 1, 2… with no gap, `when` strictly increasing, tags numbered by idx, and
 * each snapshot chained to the previous snapshot (prevId), so two branches that both chain from the same parent are
 * caught before they merge.
 */
interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}
const folder = migrationsFolder();
const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
  entries: JournalEntry[];
};
const snapshotOf = (e: JournalEntry) =>
  JSON.parse(
    readFileSync(join(folder, 'meta', `${String(e.idx).padStart(4, '0')}_snapshot.json`), 'utf8'),
  ) as { id: string; prevId: string };

describe('migration journal (drizzle applies by `when`)', () => {
  it('idx runs 0, 1, 2… with no gap and each tag carries its idx', () => {
    journal.entries.forEach((e, i) => {
      expect(e.idx, `entry ${i}`).toBe(i);
      expect(e.tag.startsWith(`${String(i).padStart(4, '0')}_`), e.tag).toBe(true);
      expect(existsSync(join(folder, `${e.tag}.sql`)), `${e.tag}.sql`).toBe(true);
    });
  });

  it('`when` strictly increases in idx order', () => {
    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1] as JournalEntry;
      const cur = journal.entries[i] as JournalEntry;
      expect(cur.when, `${cur.tag} must be newer than ${prev.tag}`).toBeGreaterThan(prev.when);
    }
  });

  it("each snapshot's prevId is the previous snapshot's id", () => {
    for (let i = 1; i < journal.entries.length; i++) {
      const prev = snapshotOf(journal.entries[i - 1] as JournalEntry);
      const cur = snapshotOf(journal.entries[i] as JournalEntry);
      expect(cur.prevId, `${(journal.entries[i] as JournalEntry).tag}`).toBe(prev.id);
    }
  });
});
