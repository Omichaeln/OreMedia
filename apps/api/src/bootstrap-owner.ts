/**
 * Operator entrypoint (docs/runbooks/deploy-railway.md "First owner"): creates a company and its owner, then exits.
 * The owner then signs in with Google using the same email; there is no self-sign-up.
 *
 *   node dist/bootstrap-owner.js --email owner@example.com --name "Owner Name" --company "Company" --slug company
 */
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { startTelemetry, stopTelemetry } from '@oremedia/observability';
import { closeDatabase, configureDatabase } from '@oremedia/db';
import { accessService } from '@oremedia/module-access';

const log = startTelemetry({ service: 'oremedia-api-bootstrap-owner' });
const url = process.env['DATABASE_URL'];
if (!url) {
  log.error({}, 'DATABASE_URL is required');
  process.exit(2);
}
const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    company: { type: 'string' },
    slug: { type: 'string' },
  },
});
if (!values.email || !values.company || !values.slug) {
  log.error(
    {},
    'usage: bootstrap-owner --email <email> --company <name> --slug <slug> [--name <owner name>]',
  );
  process.exit(2);
}
try {
  configureDatabase({ url });
  const result = await accessService.bootstrapOwner(
    {
      email: values.email,
      name: values.name ?? values.email,
      tenant: { name: values.company, slug: values.slug },
    },
    `bootstrap-${randomUUID()}`,
  );
  log.info(
    {
      tenantId: result.tenantId,
      userId: result.userId,
      status: result.userCreated ? 'user created' : 'user existed',
    },
    'company and owner created',
  );
} catch (err) {
  log.error({ errorMessage: err instanceof Error ? err.message : String(err) }, 'bootstrap failed');
  process.exitCode = 1;
} finally {
  await closeDatabase();
  await stopTelemetry();
}
