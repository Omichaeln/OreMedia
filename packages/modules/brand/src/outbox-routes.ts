import { BrandAssistInputV1, BrandAssistSignalV1 } from '@oremedia/contracts/brand-assist';
import { registerOutboxRoute } from '@oremedia/module-operations';

/** BSC-4: assist jobs run on task queue `agents` (worker-core: the model adapter, billing and the brand module). */
export const BRAND_ASSIST_TASK_QUEUE = 'agents';
export const BRAND_ASSIST_WORKFLOW_TYPE = 'brandAssistWorkflowV1';
export const BRAND_ASSIST_SIGNAL_RELAY_WORKFLOW_TYPE = 'brandAssistSignalRelayV1';
export const brandAssistWorkflowId = (jobId: string): string => `brand-assist:${jobId}`;

/**
 * brand.assist_requested → brandAssistWorkflowV1 (workflow id `brand-assist:<jobId>`; the outbox row is the dedupe
 * authority), run as the person or agent who asked so every activity re-checks their grants. A cancellation is
 * relayed to the running workflow by a short relay workflow that signals it, after the cancel committed (as agent
 * runs are cancelled).
 */
export function registerBrandOutboxRoutes(): void {
  registerOutboxRoute('brand.assist_requested', (evt) => {
    const p = evt.payload;
    const input = BrandAssistInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: p['actorKind'], id: p['actorId'] },
      correlationId: evt.correlationId,
      brandId: p['brandId'],
      jobId: p['jobId'],
    });
    return {
      workflowType: BRAND_ASSIST_WORKFLOW_TYPE,
      taskQueue: BRAND_ASSIST_TASK_QUEUE,
      workflowId: brandAssistWorkflowId(input.jobId),
      args: [input],
    };
  });
  registerOutboxRoute('brand.assist_cancel_requested', (evt) => {
    const signal = BrandAssistSignalV1.parse({
      workflowId: brandAssistWorkflowId(String(evt.payload['jobId'])),
      signal: 'cancelBrandAssist',
    });
    return {
      workflowType: BRAND_ASSIST_SIGNAL_RELAY_WORKFLOW_TYPE,
      taskQueue: BRAND_ASSIST_TASK_QUEUE,
      workflowId: `${signal.workflowId}:signal:${evt.id}`,
      args: [signal],
    };
  });
}
