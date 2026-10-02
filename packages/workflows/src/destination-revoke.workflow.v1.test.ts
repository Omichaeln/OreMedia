import { describe, expect, it } from 'vitest';
import type {
  DestinationRevokeActivitiesV1,
  DestinationRevokeInputV1,
} from '@oremedia/contracts/destinations';
import { runDestinationRevoke } from './destination-revoke.workflow.v1';

describe('destinationRevokeWorkflowV1 orchestration (RA-01)', () => {
  const input: DestinationRevokeInputV1 = {
    tenantId: 'ten_a',
    actor: { kind: 'user', id: 'usr_1' },
    correlationId: 'c',
    destinationId: 'dst_1',
  };

  it('asks the activity once with the ids it was started with and returns what the platform answered', async () => {
    const seen: DestinationRevokeInputV1[] = [];
    const acts: DestinationRevokeActivitiesV1 = {
      revokeDestinationAccess: async (i) => {
        seen.push(i);
        return { outcome: 'revoked' };
      },
    };
    expect(await runDestinationRevoke(acts, input)).toEqual({ outcome: 'revoked' });
    expect(seen).toEqual([input]);
  });

  it('a failed remote revoke is the result of the run, never retried here (the credential is destroyed by the activity)', async () => {
    const acts: DestinationRevokeActivitiesV1 = {
      revokeDestinationAccess: async () => ({ outcome: 'failed', reason: 'http_500' }),
    };
    expect(await runDestinationRevoke(acts, input)).toEqual({ outcome: 'failed', reason: 'http_500' });
  });
});
