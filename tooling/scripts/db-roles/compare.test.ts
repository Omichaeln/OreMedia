import { describe, expect, it } from 'vitest';
import { compareGrants, formatDiff, grantSetOf, parseGrant, userOf } from './compare';

const DB = 'oremedia';
const expected = grantSetOf(
  [
    "GRANT SELECT, INSERT, UPDATE, DELETE ON `oremedia`.`brands` TO 'app'@'%';",
    "GRANT SELECT, INSERT ON `oremedia`.`audit_events` TO 'app'@'%';",
    "GRANT SELECT, INSERT, UPDATE ON `oremedia`.`__drizzle_migrations` TO 'app'@'%';",
  ],
  DB,
);

describe('database role check (R1-G, D-25)', () => {
  it('parses a GRANT as SHOW GRANTS prints it and as the role SQL writes it', () => {
    expect(parseGrant('GRANT SELECT, INSERT ON `oremedia`.`audit_events` TO `app`@`%`')).toEqual({
      target: 'oremedia.audit_events',
      privileges: ['INSERT', 'SELECT'],
    });
    expect(parseGrant('GRANT USAGE ON *.* TO `app`@`%`')).toEqual({ target: '*.*', privileges: ['USAGE'] });
    expect(parseGrant('not a grant')).toBeNull();
  });

  it('a user holding exactly the generated grants matches', () => {
    const held = grantSetOf(
      [
        'GRANT USAGE ON *.* TO `app`@`%`',
        'GRANT SELECT, INSERT, UPDATE, DELETE ON `oremedia`.`brands` TO `app`@`%`',
        'GRANT SELECT, INSERT ON `oremedia`.`audit_events` TO `app`@`%`',
        'GRANT SELECT, INSERT, UPDATE ON `oremedia`.`__drizzle_migrations` TO `app`@`%`',
      ],
      DB,
    );
    const diff = compareGrants(expected, held);
    expect(diff).toMatchObject({ missing: [], extra: [], wide: [], matches: true });
    expect(formatDiff('application', 'app', diff)).toEqual([
      'PASS application: app holds exactly the generated grants',
    ]);
  });

  it('root, database-wide privileges, a missing table and UPDATE on an insert-only table each fail by name', () => {
    const root = grantSetOf(['GRANT ALL PRIVILEGES ON *.* TO `root`@`%` WITH GRANT OPTION'], DB);
    expect(compareGrants(expected, root).wide).toEqual(['ALL PRIVILEGES']);
    expect(formatDiff('application', 'root', compareGrants(expected, root))[0]).toContain('connects as root');

    const drifted = grantSetOf(
      [
        'GRANT SELECT, INSERT, UPDATE, DELETE ON `oremedia`.`brands` TO `app`@`%`',
        'GRANT SELECT, INSERT, UPDATE ON `oremedia`.`audit_events` TO `app`@`%`',
        'GRANT SELECT ON `oremedia`.`other_table` TO `app`@`%`',
      ],
      DB,
    );
    const diff = compareGrants(expected, drifted);
    expect(diff.missing).toEqual([
      { table: '__drizzle_migrations', privileges: ['INSERT', 'SELECT', 'UPDATE'] },
    ]);
    expect(diff.extra).toEqual([
      { table: 'audit_events', privileges: ['UPDATE'] },
      { table: 'other_table', privileges: ['SELECT'] },
    ]);
    expect(diff.matches).toBe(false);
    // Another database's grants are not this role's business.
    expect(grantSetOf(['GRANT SELECT ON `elsewhere`.`brands` TO `app`@`%`'], DB).tables.size).toBe(0);
  });

  it('names the user and database of a connection URL (the password, when present, is never read)', () => {
    expect(userOf('mysql://app%40svc@db.internal:3306/oremedia')).toEqual({
      user: 'app@svc',
      database: 'oremedia',
    });
  });
});
