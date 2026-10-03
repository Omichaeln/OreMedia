import { DestinationRevokeInputV1, DestinationVerifyInputV1 } from '@oremedia/contracts/destinations';
import { SeoAuditInputV1 } from '@oremedia/contracts/seo-audit';
import { INGEST_METRICS_TASK_QUEUE } from '@oremedia/module-measurement';
import { registerOutboxRoute } from '@oremedia/module-operations';

/** R2-3: one verification workflow per registration of a destination with a secret, on task queue `core`. */
export const CORE_TASK_QUEUE = 'core';
export const DESTINATION_VERIFY_WORKFLOW_TYPE = 'destinationVerifyWorkflowV1';
export const destinationVerifyWorkflowId = (destinationId: string, version: number): string =>
  `destination-verify:${destinationId}:${version}`;
/** RA-01: the remote revoke of a disconnected destination's grant, one workflow per disconnect (the row version). */
export const DESTINATION_REVOKE_WORKFLOW_TYPE = 'destinationRevokeWorkflowV1';
export const destinationRevokeWorkflowId = (destinationId: string, version: number): string =>
  `destination-revoke:${destinationId}:${version}`;
/** R2-4: an on-demand audit crawls on worker-ingest's `ingest-metrics` queue, one workflow per run row. */
export const SEO_AUDIT_WORKFLOW_TYPE = 'seoAuditWorkflowV1';
export const seoAuditWorkflowId = (runId: string): string => `seo-audit:${runId}`;

/**
 * destination.registered with `verify` → destinationVerifyWorkflowV1 (the worker opens the sealed secret, asks the
 * adapter and sets the health). A registration without a secret to verify (R2-0 register, an OAuth grant that
 * already listed its targets) stays informational: nothing to start.
 */
export function registerDestinationOutboxRoutes(): void {
  registerOutboxRoute('destination.registered', (evt) => {
    const p = evt.payload;
    if (p['verify'] !== true) return null;
    const input = DestinationVerifyInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: p['actorKind'], id: p['actorId'] },
      correlationId: evt.correlationId,
      destinationId: p['destinationId'],
    });
    return {
      workflowType: DESTINATION_VERIFY_WORKFLOW_TYPE,
      taskQueue: CORE_TASK_QUEUE,
      workflowId: destinationVerifyWorkflowId(input.destinationId, evt.aggregateVersion),
      args: [input],
    };
  });
  // RA-01: a disconnect whose kind can revoke the grant remotely leaves the credential for the worker: the
  // workflow revokes it at the platform and destroys the row. A disconnect without one stays informational.
  registerOutboxRoute('destination.disconnected', (evt) => {
    const p = evt.payload;
    if (p['remoteRevoke'] !== 'requested') return null;
    const input = DestinationRevokeInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: p['actorKind'], id: p['actorId'] },
      correlationId: evt.correlationId,
      destinationId: p['destinationId'],
    });
    return {
      workflowType: DESTINATION_REVOKE_WORKFLOW_TYPE,
      taskQueue: CORE_TASK_QUEUE,
      workflowId: destinationRevokeWorkflowId(input.destinationId, evt.aggregateVersion),
      args: [input],
    };
  });
  // destination.audit_requested → seoAuditWorkflowV1 (R2-4): the run row exists; the worker crawls and closes it.
  registerOutboxRoute('destination.audit_requested', (evt) => {
    const p = evt.payload;
    const input = SeoAuditInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: p['actorKind'], id: p['actorId'] },
      correlationId: evt.correlationId,
      destinationId: p['destinationId'],
      now: new Date().toISOString(),
      trigger: 'on_demand',
      runId: p['runId'],
    });
    return {
      workflowType: SEO_AUDIT_WORKFLOW_TYPE,
      taskQueue: INGEST_METRICS_TASK_QUEUE,
      workflowId: seoAuditWorkflowId(input.runId as string),
      args: [input],
    };
  });
}
