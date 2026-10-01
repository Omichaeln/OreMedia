import { DestinationVerifyInputV1 } from '@oremedia/contracts/destinations';
import { registerOutboxRoute } from '@oremedia/module-operations';

/** R2-3: one verification workflow per registration of a destination with a secret, on task queue `core`. */
export const CORE_TASK_QUEUE = 'core';
export const DESTINATION_VERIFY_WORKFLOW_TYPE = 'destinationVerifyWorkflowV1';
export const destinationVerifyWorkflowId = (destinationId: string, version: number): string =>
  `destination-verify:${destinationId}:${version}`;

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
}
