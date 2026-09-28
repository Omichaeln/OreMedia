import { CommunityReplyWorkflowInputV1 } from '@oremedia/contracts/community';
import { registerOutboxRoute } from '@oremedia/module-operations';
import { CORE_TASK_QUEUE } from '@oremedia/module-publishing';

export const COMMUNITY_REPLY_WORKFLOW_TYPE = 'communityReplyWorkflowV1';
/** One workflow per reply, stable across outbox redeliveries (started with USE_EXISTING). */
export const communityReplyWorkflowId = (responseDraftId: string): string => `reply:${responseDraftId}`;

/**
 * community.reply_requested → communityReplyWorkflowV1 on task queue `core`; the provider call runs on the
 * channel's `publish-<providerKey>` queue, where the credentials are.
 */
export function registerCommunityOutboxRoutes(): void {
  registerOutboxRoute('community.reply_requested', (evt) => {
    const p = evt.payload;
    const input = CommunityReplyWorkflowInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: p['actorKind'], id: p['actorId'] },
      correlationId: evt.correlationId,
      responseDraftId: p['responseDraftId'],
    });
    return {
      workflowType: COMMUNITY_REPLY_WORKFLOW_TYPE,
      taskQueue: CORE_TASK_QUEUE,
      workflowId: communityReplyWorkflowId(input.responseDraftId),
      args: [input],
    };
  });
}
