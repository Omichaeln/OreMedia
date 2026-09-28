import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearOutboxRoutes, outboxRouteFor, type OutboxEventRecord } from '@oremedia/module-operations';
import {
  CORE_TASK_QUEUE,
  PUBLICATION_REMOTE_DELETE_WORKFLOW_TYPE,
  PUBLICATION_REMOTE_EDIT_WORKFLOW_TYPE,
  registerPublishingOutboxRoutes,
} from './outbox-routes';

const event = (eventType: string, payload: Record<string, unknown>): OutboxEventRecord => ({
  id: 'evt_1',
  tenantId: 'ten_A',
  aggregateType: 'publication',
  aggregateId: 'pub_1',
  aggregateVersion: 3,
  eventType,
  schemaVersion: 1,
  payload,
  correlationId: 'corr_1',
  attempts: 0,
  availableAt: new Date(),
  createdAt: new Date(),
});

describe('remote change outbox routes', () => {
  beforeAll(() => registerPublishingOutboxRoutes());
  afterAll(() => clearOutboxRoutes());

  it('a delete or edit request starts its own workflow on core, id and input from the event', () => {
    const payload = {
      publicationId: 'pub_1',
      remotePostId: 'post_1',
      requestedByKind: 'user',
      requestedById: 'usr_1',
      changeId: 'prc_1',
      providerKey: 'linkedin_page',
      workflowId: 'pub:pub_1:remote:prc_1',
    };
    const input = {
      tenantId: 'ten_A',
      actor: { kind: 'user', id: 'usr_1' },
      correlationId: 'corr_1',
      publicationId: 'pub_1',
      changeId: 'prc_1',
      providerKey: 'linkedin_page',
    };
    expect(outboxRouteFor('publication.delete_remote_requested')!(event('x', payload))).toEqual({
      workflowType: PUBLICATION_REMOTE_DELETE_WORKFLOW_TYPE,
      taskQueue: CORE_TASK_QUEUE,
      workflowId: 'pub:pub_1:remote:prc_1',
      args: [input],
    });
    expect(outboxRouteFor('publication.edit_remote_requested')!(event('x', payload))).toMatchObject({
      workflowType: PUBLICATION_REMOTE_EDIT_WORKFLOW_TYPE,
      args: [input],
    });
  });

  it('a delete request recorded before changes were carried out (no changeId) starts nothing', () => {
    const legacy = {
      publicationId: 'pub_1',
      remotePostId: 'post_1',
      requestedByKind: 'user',
      requestedById: 'u',
    };
    expect(outboxRouteFor('publication.delete_remote_requested')!(event('x', legacy))).toBeNull();
  });
});
