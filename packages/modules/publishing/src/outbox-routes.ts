import {
  ChannelRevokeInputV1,
  PublicationReconcileInputV1,
  PublicationRemoteChangeInputV1,
  PublicationSignalV1,
  PublicationWorkflowInputV1,
  RenderedValidationInputV1,
  TokenRefreshWorkflowInputV1,
} from '@oremedia/contracts/publishing';
import { registerOutboxRoute } from '@oremedia/module-operations';

/** Spec 4.4: worker-core hosts task queue `core` (publication, sweeper, token refresh and the signal relay). */
export const CORE_TASK_QUEUE = 'core';
export const PUBLICATION_WORKFLOW_TYPE = 'publicationWorkflowV1';
export const PUBLICATION_RECONCILE_WORKFLOW_TYPE = 'publicationReconcileWorkflowV1';
export const PUBLICATION_SIGNAL_RELAY_WORKFLOW_TYPE = 'publicationSignalRelayV1';
export const TOKEN_REFRESH_WORKFLOW_TYPE = 'tokenRefreshWorkflowV1';
export const PUBLICATION_SWEEPER_WORKFLOW_TYPE = 'publicationSweeperWorkflowV1';
export const PUBLICATION_REMOTE_DELETE_WORKFLOW_TYPE = 'publicationRemoteDeleteWorkflowV1';
export const PUBLICATION_REMOTE_EDIT_WORKFLOW_TYPE = 'publicationRemoteEditWorkflowV1';
/** Hourly Temporal schedule closing remote changes whose workflow was lost (one per namespace). */
export const REMOTE_CHANGE_SWEEP_WORKFLOW_TYPE = 'remoteChangeSweepWorkflowV1';
export const REMOTE_CHANGE_SWEEP_SCHEDULE_ID = 'remote-change-sweep';
/** One always-on sweeper per namespace. */
export const PUBLICATION_SWEEPER_WORKFLOW_ID = 'publication-sweeper';
/** RA-04: the delayed re-validation of a live article's page, one workflow per publication moment. */
export const RENDERED_VALIDATION_WORKFLOW_TYPE = 'renderedValidationWorkflowV1';
export const renderedValidationWorkflowId = (publicationId: string, version: number): string =>
  `pub:${publicationId}:rendered-validation:${version}`;
/** Spec 14.7: the periodic purge of expired account choices, one Temporal schedule per namespace. */
export const CONNECT_CHOICE_PURGE_WORKFLOW_TYPE = 'connectChoicePurgeWorkflowV1';
export const CONNECT_CHOICE_PURGE_SCHEDULE_ID = 'connect-choice-purge';

/** Spec 4.4: one activity queue per provider so a slow platform cannot starve the others. */
export const publishTaskQueue = (providerKey: string): string => `publish-${providerKey}`;
export const tokenRefreshWorkflowId = (channelConnectionId: string): string =>
  `token-refresh:${channelConnectionId}`;
/** RA-01: the remote revoke of a disconnected channel's grant, one workflow per disconnect (the row version). */
export const CHANNEL_REVOKE_WORKFLOW_TYPE = 'channelRevokeWorkflowV1';
export const channelRevokeWorkflowId = (channelConnectionId: string, version: number): string =>
  `channel-revoke:${channelConnectionId}:${version}`;

/**
 * Spec 14.2: publication.scheduled → publicationWorkflowV1 with the stable workflow id the command chose
 * (`pub:<publicationId>`, see common.ts); the outbox row is the dedupe authority. Cancel and reschedule are relayed
 * to the running workflow by a short relay workflow, so the API needs no Temporal client and the signal lands only
 * after the commit. A connect starts the connection's token refresh workflow.
 */
export function registerPublishingOutboxRoutes(): void {
  registerOutboxRoute('publication.scheduled', (evt) => {
    const p = evt.payload;
    const input = PublicationWorkflowInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: p['actorKind'], id: p['actorId'] },
      correlationId: evt.correlationId,
      publicationId: p['publicationId'],
    });
    return {
      workflowType: PUBLICATION_WORKFLOW_TYPE,
      taskQueue: CORE_TASK_QUEUE,
      workflowId: String(p['workflowId']),
      args: [input],
    };
  });
  const relay =
    (signal: 'cancel' | 'reschedule') => (evt: Parameters<Parameters<typeof registerOutboxRoute>[1]>[0]) => {
      const input = PublicationSignalV1.parse({ workflowId: String(evt.payload['workflowId']), signal });
      return {
        workflowType: PUBLICATION_SIGNAL_RELAY_WORKFLOW_TYPE,
        taskQueue: CORE_TASK_QUEUE,
        workflowId: `${input.workflowId}:signal:${evt.id}`,
        args: [input],
      };
    };
  // RA-01: a disconnect whose provider can revoke the grant remotely leaves the credential for the worker: the
  // workflow revokes it at the platform and destroys the row. A disconnect without one (`not_supported`, the
  // credential already destroyed) stays informational.
  registerOutboxRoute('channel.disconnected', (evt) => {
    const p = evt.payload;
    if (p['remoteRevoke'] !== 'requested') return null;
    const input = ChannelRevokeInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: p['actorKind'], id: p['actorId'] },
      correlationId: evt.correlationId,
      channelConnectionId: p['channelConnectionId'],
    });
    return {
      workflowType: CHANNEL_REVOKE_WORKFLOW_TYPE,
      taskQueue: CORE_TASK_QUEUE,
      workflowId: channelRevokeWorkflowId(input.channelConnectionId, evt.aggregateVersion),
      args: [input],
    };
  });
  registerOutboxRoute('publication.cancel_requested', relay('cancel'));
  registerOutboxRoute('publication.rescheduled', relay('reschedule'));
  registerOutboxRoute('publication.reconcile_requested', (evt) => {
    const p = evt.payload;
    const input = PublicationReconcileInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: p['actorKind'], id: p['actorId'] },
      correlationId: evt.correlationId,
      publicationId: p['publicationId'],
      attemptId: p['attemptId'] ?? null,
      providerKey: p['providerKey'],
    });
    return {
      workflowType: PUBLICATION_RECONCILE_WORKFLOW_TYPE,
      taskQueue: CORE_TASK_QUEUE,
      workflowId: String(p['workflowId']),
      args: [input],
    };
  });
  // A remote change (publication.delete_remote / edit_remote) runs in its own workflow per request; an event
  // recorded before changes were carried out has no changeId and stays informational (nothing to start).
  const remoteChange =
    (workflowType: string) => (evt: Parameters<Parameters<typeof registerOutboxRoute>[1]>[0]) => {
      const p = evt.payload;
      if (typeof p['changeId'] !== 'string') return null;
      const input = PublicationRemoteChangeInputV1.parse({
        tenantId: evt.tenantId,
        actor: { kind: p['requestedByKind'], id: p['requestedById'] },
        correlationId: evt.correlationId,
        publicationId: p['publicationId'],
        changeId: p['changeId'],
        providerKey: p['providerKey'],
      });
      return {
        workflowType,
        taskQueue: CORE_TASK_QUEUE,
        workflowId: String(p['workflowId']),
        args: [input],
      };
    };
  registerOutboxRoute(
    'publication.delete_remote_requested',
    remoteChange(PUBLICATION_REMOTE_DELETE_WORKFLOW_TYPE),
  );
  registerOutboxRoute(
    'publication.edit_remote_requested',
    remoteChange(PUBLICATION_REMOTE_EDIT_WORKFLOW_TYPE),
  );
  // RA-04: publication.rendered_validation_due (emitted with `availableAt` at the first delay) → the re-validation
  // workflow, which checks the page again at each delay after publishedAt.
  registerOutboxRoute('publication.rendered_validation_due', (evt) => {
    const p = evt.payload;
    const input = RenderedValidationInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: p['actorKind'], id: p['actorId'] },
      correlationId: evt.correlationId,
      publicationId: p['publicationId'],
      publishedAt: p['publishedAt'],
    });
    return {
      workflowType: RENDERED_VALIDATION_WORKFLOW_TYPE,
      taskQueue: CORE_TASK_QUEUE,
      workflowId: String(p['workflowId']),
      args: [input],
    };
  });
  registerOutboxRoute('channel.connected', (evt) => {
    const p = evt.payload;
    const input = TokenRefreshWorkflowInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: p['actorKind'], id: p['actorId'] },
      correlationId: evt.correlationId,
      channelConnectionId: p['channelConnectionId'],
    });
    return {
      workflowType: TOKEN_REFRESH_WORKFLOW_TYPE,
      taskQueue: CORE_TASK_QUEUE,
      workflowId: tokenRefreshWorkflowId(input.channelConnectionId),
      args: [input],
    };
  });
}
