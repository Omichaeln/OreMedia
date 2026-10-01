import { describe, expect, it } from 'vitest';
import type {
  DestinationVerifyActivitiesV1,
  DestinationVerifyInputV1,
} from '@oremedia/contracts/destinations';
import { runDestinationVerify } from './destination-verify.workflow.v1';

describe('destinationVerifyWorkflowV1 orchestration (ledger R2-3)', () => {
  const input: DestinationVerifyInputV1 = {
    tenantId: 'ten_a',
    actor: { kind: 'user', id: 'usr_1' },
    correlationId: 'c',
    destinationId: 'dst_1',
  };

  it('asks the activity once with the ids it was started with and returns what it found', async () => {
    const seen: DestinationVerifyInputV1[] = [];
    const acts: DestinationVerifyActivitiesV1 = {
      verifyDestinationCredential: async (i) => {
        seen.push(i);
        return { ok: true, health: 'healthy' };
      },
    };
    expect(await runDestinationVerify(acts, input)).toEqual({ ok: true, health: 'healthy' });
    expect(seen).toEqual([input]);
  });

  it('a refusal is the result of the run, never retried here (the activity policy owns transient retries)', async () => {
    const acts: DestinationVerifyActivitiesV1 = {
      verifyDestinationCredential: async () => ({ ok: false, reason: 'reconnect_required' }),
    };
    expect(await runDestinationVerify(acts, input)).toEqual({ ok: false, reason: 'reconnect_required' });
  });
});
