import { closeDatabase } from './client';
import { runMigrations } from './migrate';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

try {
  await runMigrations(url);
  await closeDatabase();
  console.error('migrations applied');
} catch (err) {
  console.error(err);
  await closeDatabase();
  process.exit(1);
}
