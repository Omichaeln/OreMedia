import { describe, expect, it } from 'vitest';
import { ApprovalBindingV1, bindingTargetId } from './approval';
import { FrozenManifestV1 } from './review';

const target = {
  textHash: 'a'.repeat(64),
  altTextHashes: [],
  settingsHash: 'b'.repeat(64),
  exportHashes: [],
};
const binding = (t: Record<string, unknown>) => ({
  v: 1,
  tenantId: 'ten_1',
  brandId: 'brd_1',
  contentRevisionId: 'pr_1',
  brandVersionId: 'bv_1',
  policyVersionId: 'pol_1',
  targets: [{ ...target, ...t }],
  timing: { kind: 'exact', at: '2026-10-01T09:00:00.000Z' },
});
const manifest = (entry: Record<string, unknown>) => ({
  v: 1,
  contentRevisionId: 'pr_1',
  contentHash: 'c'.repeat(64),
  creativeRevisionIds: [],
  exports: [{ exportId: 'exp_1', contentHash: 'd'.repeat(64), ...entry }],
  captions: [{ text: 'x', altTexts: [], settingsHash: 'e'.repeat(64), ...entry }],
  timing: { kind: 'exact', at: '2026-10-01T09:00:00.000Z' },
  brandVersionId: 'bv_1',
  policyVersionId: 'pol_1',
});

describe('a bound target and a manifest entry name exactly one of a channel or a destination (R2-3)', () => {
  it('a channel alone or a destination alone parses, and the target id is the one that is set', () => {
    const channel = ApprovalBindingV1.parse(binding({ channelConnectionId: 'cc_1' }));
    const destination = ApprovalBindingV1.parse(binding({ destinationId: 'dst_1' }));
    expect(bindingTargetId(channel.targets[0]!)).toBe('cc_1');
    expect(bindingTargetId(destination.targets[0]!)).toBe('dst_1');
    expect(FrozenManifestV1.safeParse(manifest({ channelConnectionId: 'cc_1' })).success).toBe(true);
    expect(FrozenManifestV1.safeParse(manifest({ destinationId: 'dst_1' })).success).toBe(true);
  });

  it('neither, both, or an empty id is refused', () => {
    for (const t of [
      {},
      { channelConnectionId: 'cc_1', destinationId: 'dst_1' },
      { channelConnectionId: '' },
    ]) {
      expect(ApprovalBindingV1.safeParse(binding(t)).success).toBe(false);
      expect(FrozenManifestV1.safeParse(manifest(t)).success).toBe(false);
    }
  });
});
