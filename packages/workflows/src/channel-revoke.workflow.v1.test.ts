import { describe, expect, it } from 'vitest';
import type { ChannelRevokeActivitiesV1, ChannelRevokeInputV1 } from '@oremedia/contracts/publishing';
import { runChannelRevoke } from './channel-revoke.workflow.v1';

describe('channelRevokeWorkflowV1 orchestration (RA-01)', () => {
  const input: ChannelRevokeInputV1 = {
    tenantId: 'ten_a',
    actor: { kind: 'user', id: 'usr_1' },
    correlationId: 'c',
    channelConnectionId: 'cc_1',
  };

  it('asks the activity once with the ids it was started with and returns what the platform answered', async () => {
    const seen: ChannelRevokeInputV1[] = [];
    const acts: ChannelRevokeActivitiesV1 = {
      revokeChannelAccess: async (i) => {
        seen.push(i);
        return { outcome: 'revoked' };
      },
    };
    expect(await runChannelRevoke(acts, input)).toEqual({ outcome: 'revoked' });
    expect(seen).toEqual([input]);
  });

  it('a failed remote revoke is the result of the run, never retried here (the credential is destroyed by the activity)', async () => {
    const acts: ChannelRevokeActivitiesV1 = {
      revokeChannelAccess: async () => ({ outcome: 'failed', reason: 'http_500' }),
    };
    expect(await runChannelRevoke(acts, input)).toEqual({ outcome: 'failed', reason: 'http_500' });
  });
});
