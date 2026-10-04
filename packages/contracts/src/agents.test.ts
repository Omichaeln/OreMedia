import { describe, expect, it } from 'vitest';
import { RUN_BRIEF_MAX_BYTES, RunStart } from './agents';

const start = (brief: Record<string, unknown>) =>
  RunStart.safeParse({ brandId: 'brd_1', servicePrincipalId: 'sp_1', taskKind: 'copywriting', brief });

describe('RunStart brief bound', () => {
  it('accepts a brief up to the serialised limit and refuses one past it', () => {
    const overhead = JSON.stringify({ objective: '' }).length;
    expect(start({ objective: 'x'.repeat(RUN_BRIEF_MAX_BYTES - overhead) }).success).toBe(true);
    const over = start({ objective: 'x'.repeat(RUN_BRIEF_MAX_BYTES - overhead + 1) });
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.message).toMatch(/^brief_too_large/);
  });

  it('counts bytes, not characters', () => {
    expect(start({ objective: 'é'.repeat(RUN_BRIEF_MAX_BYTES / 2) }).success).toBe(false);
  });

  it('does not count evidence, which is bounded per item and rendered once as evidence', () => {
    const evidence = [{ id: 'ev_1', sourceKind: 'web_page', ref: 'r', text: 'y'.repeat(20_000) }];
    expect(start({ objective: 'write', evidence: [...evidence, ...evidence] }).success).toBe(true);
  });
});
