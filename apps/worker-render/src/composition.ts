import { assertEgressAllowed } from '@oremedia/module-access';
import { configureEgressGuard } from '@oremedia/providers';

/**
 * Wires what worker-render needs from other modules (same shape as worker-core's and worker-ingest's composition,
 * much smaller). The brand assist runtime the media worker builds carries provider I/O (createProviderIO): its
 * egress guard refuses a demo company (architecture §4.4), and an unwired guard refuses everything in production, so
 * the process wires it before any worker starts. Called by worker.ts and by tests.
 */
export function composeModules(): void {
  configureEgressGuard((tenantId) => assertEgressAllowed(tenantId));
}
