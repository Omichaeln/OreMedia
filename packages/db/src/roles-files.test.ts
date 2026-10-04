import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateRetentionRoleSql, generateRoleSql } from './roles';

/**
 * The committed role files are what db-roles applies in every environment, so they must equal what the schema
 * generates. A table added without regenerating them (seo_finding_work in RA-11) left the application role without
 * a grant on it. Regenerate with `pnpm tsx tooling/scripts/generate-db-roles.ts`.
 */
const committed = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../roles/${file}`, import.meta.url)), 'utf8');

describe('committed database role files', () => {
  it('app-role.sql equals the generated application role', () => {
    expect(committed('app-role.sql')).toBe(generateRoleSql('__DB_NAME__', '__APP_USER__'));
  });
  it('retention-role.sql equals the generated retention role', () => {
    expect(committed('retention-role.sql')).toBe(
      generateRetentionRoleSql('__DB_NAME__', '__RETENTION_USER__'),
    );
  });
});
