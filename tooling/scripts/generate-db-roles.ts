/** Writes packages/db/roles/app-role.sql, retention-role.sql and deletion-role.sql from the schema (spec 6.1, 17.5). Run from the oremedia root. */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateDeletionRoleSql, generateRetentionRoleSql, generateRoleSql } from '@oremedia/db/roles';

const dir = path.resolve(process.cwd(), 'packages/db/roles');
for (const [file, sql] of [
  ['app-role.sql', generateRoleSql('__DB_NAME__', '__APP_USER__')],
  ['retention-role.sql', generateRetentionRoleSql('__DB_NAME__', '__RETENTION_USER__')],
  ['deletion-role.sql', generateDeletionRoleSql('__DB_NAME__', '__DELETION_USER__')],
] as const) {
  const out = path.join(dir, file);
  writeFileSync(out, sql);
  console.error(`wrote ${out}`);
}
