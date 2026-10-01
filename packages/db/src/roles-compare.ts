/**
 * R1-G (D-25): compares the grants a database user actually holds (`SHOW GRANTS`) with the role SQL generated from
 * the schema (packages/db/roles/*.sql, `generateRoleSql`), so a deployed environment can prove it runs on the
 * application role rather than root. Pure: the connection lives in `readHeldGrants` (roles.ts); used by
 * `pnpm db:roles:check` (tooling/scripts/db-roles) and the api's `db-roles-apply` entrypoint.
 */
export interface GrantSet {
  /** `table` → the privileges held on it, upper-case, sorted. */
  tables: Map<string, string[]>;
  /**
   * Anything wider than the role: privileges on `*.*` or the whole database (e.g. ALL PRIVILEGES), a wildcard
   * database, GRANT OPTION, PROXY, a routine, a role grant or a GRANT the parser does not understand (fail closed).
   */
  wide: string[];
}

const PRIV_RE = /^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i;

/** Parses one `GRANT …` statement (as SHOW GRANTS prints it, or as the role SQL writes it) into table and privileges. */
export function parseGrant(statement: string): { target: string; privileges: string[] } | null {
  const m = PRIV_RE.exec(statement.trim());
  if (!m) return null;
  const privileges = (m[1] ?? '')
    .replace(/\([^)]*\)/g, '') // column-level grants: the privilege, not its columns
    .split(',')
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean)
    .sort();
  const target = (m[2] ?? '').replace(/`/g, '').trim();
  return { target, privileges };
}

/** Folds grant statements into a GrantSet; `database`-wide and global grants land in `wide`. */
export function grantSetOf(statements: readonly string[], database: string): GrantSet {
  const tables = new Map<string, string[]>();
  const wide: string[] = [];
  for (const s of statements) {
    const text = s.trim();
    if (!/^GRANT\s/i.test(text)) continue;
    if (/WITH\s+GRANT\s+OPTION/i.test(text)) wide.push('GRANT OPTION');
    const g = parseGrant(text);
    if (!g) {
      // A role grant (`GRANT role@host TO user`) or a shape this parser does not know: wider until proven otherwise.
      const roleGrant = /^GRANT\s+(`?[^`\s]+`?@`?[^`\s]*`?)\s+TO\s/i.exec(text);
      wide.push(roleGrant ? `ROLE ${roleGrant[1]}` : 'UNRECOGNISED GRANT');
      continue;
    }
    if (g.privileges.length === 1 && g.privileges[0] === 'USAGE') continue;
    if (g.privileges.includes('PROXY') || /^(PROCEDURE|FUNCTION)\s/i.test(g.target)) {
      wide.push(...g.privileges.map((p) => `${p} ON ${g.target}`));
      continue;
    }
    const [db, table] = g.target.split('.') as [string, string | undefined];
    if (g.target === '*.*' || (db === database && (table === '*' || table === undefined))) {
      wide.push(...g.privileges);
      continue;
    }
    if (/[%_]/.test(db) && db !== database) {
      wide.push(...g.privileges.map((p) => `${p} ON ${g.target}`));
      continue;
    }
    if (db !== database || !table) continue;
    const held = new Set([...(tables.get(table) ?? []), ...g.privileges]);
    tables.set(table, [...held].sort());
  }
  return { tables, wide: [...new Set(wide)].sort() };
}

export interface GrantDiff {
  /** Tables the role expects that the user lacks, or holds with fewer privileges. */
  missing: Array<{ table: string; privileges: string[] }>;
  /** Privileges the user holds beyond the role (an insert-only table with UPDATE, a table the role never names). */
  extra: Array<{ table: string; privileges: string[] }>;
  wide: string[];
  matches: boolean;
}

/** The expected set from the generated SQL versus the held set from SHOW GRANTS. */
export function compareGrants(expected: GrantSet, held: GrantSet): GrantDiff {
  const missing: GrantDiff['missing'] = [];
  const extra: GrantDiff['extra'] = [];
  for (const [table, privileges] of expected.tables) {
    const have = new Set(held.tables.get(table) ?? []);
    const lacking = privileges.filter((p) => !have.has(p));
    if (lacking.length) missing.push({ table, privileges: lacking });
  }
  for (const [table, privileges] of held.tables) {
    const want = new Set(expected.tables.get(table) ?? []);
    const beyond = privileges.filter((p) => !want.has(p));
    if (beyond.length) extra.push({ table, privileges: beyond });
  }
  missing.sort((a, b) => a.table.localeCompare(b.table));
  extra.sort((a, b) => a.table.localeCompare(b.table));
  return { missing, extra, wide: held.wide, matches: !missing.length && !extra.length && !held.wide.length };
}

/** The user and database a MySQL URL names; the password is never read. */
export function userOf(url: string): { user: string; database: string } {
  const u = new URL(url);
  return { user: decodeURIComponent(u.username), database: u.pathname.replace(/^\//, '') };
}

export function formatDiff(role: string, user: string, diff: GrantDiff): string[] {
  const lines: string[] = [];
  if (/^root$/i.test(user))
    lines.push(`FAIL ${role}: connects as root; the ${role} role is not applied (D-25)`);
  if (diff.wide.length)
    lines.push(`FAIL ${role}: database-wide or global privileges held: ${diff.wide.join(', ')}`);
  for (const m of diff.missing) lines.push(`FAIL ${role}: ${m.table} lacks ${m.privileges.join(', ')}`);
  for (const e of diff.extra)
    lines.push(`FAIL ${role}: ${e.table} holds ${e.privileges.join(', ')} beyond the role`);
  if (!lines.length) lines.push(`PASS ${role}: ${user} holds exactly the generated grants`);
  return lines;
}
