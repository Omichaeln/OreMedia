import { describe, expect, it } from 'vitest';
import * as limits from '@oremedia/contracts/seo-audit';
import type {
  SeoAuditActivitiesV1,
  SeoAuditCrawlPageInputV1,
  SeoAuditFinishInputV1,
  SeoAuditInputV1,
  SeoAuditSweepActivitiesV1,
} from '@oremedia/contracts/seo-audit';
import {
  SEO_AUDIT_ACTOR,
  SEO_AUDIT_FETCH_GAP_MS,
  SEO_AUDIT_MAX_DEPTH,
  SEO_AUDIT_MAX_PAGES,
  SEO_AUDIT_RUN_DEADLINE_MS,
  isoWeekOf,
  runSeoAudit,
  runSeoAuditSweep,
  seoAuditWeeklyWorkflowId,
} from './seo-audit.workflow.v1';

const ORIGIN = 'https://site.example';
const input: SeoAuditInputV1 = {
  tenantId: 'ten_a',
  actor: SEO_AUDIT_ACTOR,
  correlationId: 'c:dst_1',
  destinationId: 'dst_1',
  now: '2026-10-05T05:00:00.000Z',
  trigger: 'scheduled',
};

/** A site as a link graph: every page links to what the map says; unknown pages answer 404. */
function fakes(site: Record<string, string[]>, overrides: Partial<SeoAuditActivitiesV1> = {}) {
  const crawled: SeoAuditCrawlPageInputV1[] = [];
  const finished: SeoAuditFinishInputV1[] = [];
  const pruned: string[] = [];
  const acts: SeoAuditActivitiesV1 = {
    planSeoAudit: async () => ({
      outcome: 'planned',
      runId: 'sar_1',
      origin: ORIGIN,
      seeds: [`${ORIGIN}/`],
      limitsHit: [],
    }),
    crawlSeoAuditPage: async (i) => {
      crawled.push(i);
      const links = site[i.url];
      return { outcome: 'crawled', status: links ? 200 : 404, links: links ?? [] };
    },
    finishSeoAudit: async (i) => {
      finished.push(i);
      return { outcome: 'completed', pages: crawled.length };
    },
    pruneSeoAudits: async (i) => {
      pruned.push(i.destinationId);
      return { deleted: 1 };
    },
    ...overrides,
  };
  return { acts, crawled, finished, pruned };
}
const host = (step = 0) => {
  let t = 0;
  const slept: number[] = [];
  return {
    slept,
    host: {
      now: () => {
        t += step;
        return t;
      },
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    },
  };
};

describe('seoAuditWorkflowV1 orchestration (ledger R2-4)', () => {
  it('its caps are the contract’s (the workflow file is immutable, the contract documents them)', () => {
    expect(SEO_AUDIT_MAX_PAGES).toBe(limits.SEO_AUDIT_MAX_PAGES);
    expect(SEO_AUDIT_MAX_DEPTH).toBe(limits.SEO_AUDIT_MAX_DEPTH);
    expect(SEO_AUDIT_FETCH_GAP_MS).toBe(limits.SEO_AUDIT_FETCH_GAP_MS);
    expect(SEO_AUDIT_RUN_DEADLINE_MS).toBe(limits.SEO_AUDIT_RUN_DEADLINE_MS);
  });

  it('crawls breadth-first from the seeds, once per URL, pausing between fetches, then finishes and prunes', async () => {
    const f = fakes({
      [`${ORIGIN}/`]: [`${ORIGIN}/a`, `${ORIGIN}/b`],
      [`${ORIGIN}/a`]: [`${ORIGIN}/b`, `${ORIGIN}/a/1`],
      [`${ORIGIN}/b`]: [`${ORIGIN}/`],
      [`${ORIGIN}/a/1`]: [],
    });
    const h = host();
    const out = await runSeoAudit(f.acts, input, h.host);
    expect(f.crawled.map((c) => [c.url.slice(ORIGIN.length), c.depth])).toEqual([
      ['/', 0],
      ['/a', 1],
      ['/b', 1],
      ['/a/1', 2],
    ]);
    expect(f.crawled.every((c) => c.runId === 'sar_1')).toBe(true);
    expect(h.slept).toEqual([250, 250, 250]); // no pause before the first fetch
    expect(f.finished).toEqual([{ ...input, runId: 'sar_1', limitsHit: [], failedPages: 0 }]);
    expect(f.pruned).toEqual(['dst_1']);
    expect(out).toEqual({
      outcome: 'completed',
      reason: null,
      runId: 'sar_1',
      crawled: 4,
      failed: 0,
      limitsHit: [],
      pruned: 1,
    });
  });

  it('stops at MAX_PAGES and records the cap; the frontier left behind is dropped', async () => {
    const site: Record<string, string[]> = {};
    for (let i = 0; i < SEO_AUDIT_MAX_PAGES + 50; i++) site[`${ORIGIN}/p${i}`] = [`${ORIGIN}/p${i + 1}`];
    site[`${ORIGIN}/`] = Object.keys(site);
    const f = fakes(site);
    const out = await runSeoAudit(f.acts, input, host().host);
    expect(f.crawled).toHaveLength(SEO_AUDIT_MAX_PAGES);
    expect(out.limitsHit).toEqual(['max_pages']);
    expect(f.finished[0]?.limitsHit).toEqual(['max_pages']);
  });

  it('does not follow links beyond MAX_DEPTH and records the cap only when something was left', async () => {
    const chain: Record<string, string[]> = { [`${ORIGIN}/`]: [`${ORIGIN}/d1`] };
    for (let d = 1; d <= SEO_AUDIT_MAX_DEPTH + 2; d++) chain[`${ORIGIN}/d${d}`] = [`${ORIGIN}/d${d + 1}`];
    const f = fakes(chain);
    const out = await runSeoAudit(f.acts, input, host().host);
    expect(f.crawled.map((c) => c.depth)).toEqual([0, 1, 2, 3]);
    expect(out.limitsHit).toEqual(['max_depth']);
    const shallow = fakes({ [`${ORIGIN}/`]: [`${ORIGIN}/a`], [`${ORIGIN}/a`]: [] });
    expect((await runSeoAudit(shallow.acts, input, host().host)).limitsHit).toEqual([]);
  });

  it('stops at the run deadline (the workflow clock) and records it', async () => {
    const f = fakes({
      [`${ORIGIN}/`]: [`${ORIGIN}/a`, `${ORIGIN}/b`],
      [`${ORIGIN}/a`]: [],
      [`${ORIGIN}/b`]: [],
    });
    // Every clock read advances by half the deadline: the first fetch runs, the check before the second trips.
    const out = await runSeoAudit(f.acts, input, host(SEO_AUDIT_RUN_DEADLINE_MS / 2 + 1).host);
    expect(f.crawled).toHaveLength(1);
    expect(out.limitsHit).toEqual(['deadline']);
  });

  it('a page whose activity fails is counted and the crawl goes on; a robots-skipped page is not counted', async () => {
    const f = fakes(
      { [`${ORIGIN}/`]: [`${ORIGIN}/boom`, `${ORIGIN}/private`, `${ORIGIN}/ok`], [`${ORIGIN}/ok`]: [] },
      {
        crawlSeoAuditPage: async (i) => {
          if (i.url.endsWith('/boom')) throw new Error('activity failed');
          if (i.url.endsWith('/private')) return { outcome: 'skipped', reason: 'robots' };
          return {
            outcome: 'crawled',
            status: 200,
            links: i.depth === 0 ? [`${ORIGIN}/boom`, `${ORIGIN}/private`, `${ORIGIN}/ok`] : [],
          };
        },
      },
    );
    const out = await runSeoAudit(f.acts, input, host().host);
    expect(out).toMatchObject({ outcome: 'completed', reason: 'failed_pages=1', crawled: 2, failed: 1 });
    expect(f.finished[0]?.failedPages).toBe(1);
  });

  it('a run closed elsewhere ends without finishing or pruning; a skipped plan ends at once', async () => {
    const closed = fakes(
      {},
      { crawlSeoAuditPage: async () => ({ outcome: 'skipped', reason: 'not_running' }) },
    );
    expect(await runSeoAudit(closed.acts, input, host().host)).toMatchObject({
      outcome: 'failed',
      reason: 'not_running',
    });
    expect(closed.finished).toHaveLength(0);
    const skipped = fakes({}, { planSeoAudit: async () => ({ outcome: 'skipped', reason: 'no_policy' }) });
    expect(await runSeoAudit(skipped.acts, input, host().host)).toMatchObject({
      outcome: 'skipped',
      reason: 'no_policy',
      runId: null,
    });
    expect(skipped.crawled).toHaveLength(0);
  });

  it('a failed prune never fails the audit', async () => {
    const f = fakes({ [`${ORIGIN}/`]: [] }, { pruneSeoAudits: async () => Promise.reject(new Error('db')) });
    expect(await runSeoAudit(f.acts, input, host().host)).toMatchObject({ outcome: 'completed', pruned: 0 });
  });
});

describe('seoAuditSweepWorkflowV1 orchestration', () => {
  const sweepInput = { correlationId: 'sweep', now: '2026-10-05T05:00:00.000Z' };
  it('weekly ids are deterministic per ISO week', () => {
    expect(isoWeekOf('2026-10-05T05:00:00.000Z')).toBe('2026-W41');
    expect(isoWeekOf('2026-01-01T00:00:00.000Z')).toBe('2026-W01'); // a Thursday
    expect(isoWeekOf('2027-01-01T00:00:00.000Z')).toBe('2026-W53'); // a Friday of a 53-week year
    expect(isoWeekOf('2027-01-04T00:00:00.000Z')).toBe('2027-W01');
    expect(seoAuditWeeklyWorkflowId('dst_1', '2026-10-11T23:59:00.000Z')).toBe('seo-audit:dst_1:2026-W41');
  });
  it('starts one scheduled child per target with the weekly id; a child already started this week is counted, a failure skipped', async () => {
    const acts: SeoAuditSweepActivitiesV1 = {
      listSeoAuditTargets: async () => [
        { tenantId: 'ten_a', destinationId: 'dst_1' },
        { tenantId: 'ten_a', destinationId: 'dst_dup' },
        { tenantId: 'ten_b', destinationId: 'dst_bad' },
      ],
    };
    const started: Array<[SeoAuditInputV1, string]> = [];
    const out = await runSeoAuditSweep(acts, sweepInput, {
      async startAudit(child, id) {
        if (child.destinationId === 'dst_dup')
          throw Object.assign(new Error('dup'), { name: 'WorkflowExecutionAlreadyStartedError' });
        if (child.destinationId === 'dst_bad') throw new Error('temporal down');
        started.push([child, id]);
      },
    });
    expect(out).toEqual({ targets: 3, started: 1, alreadyStarted: 1, failed: 1 });
    expect(started).toEqual([
      [
        {
          tenantId: 'ten_a',
          actor: SEO_AUDIT_ACTOR,
          correlationId: 'sweep:dst_1',
          destinationId: 'dst_1',
          now: sweepInput.now,
          trigger: 'scheduled',
        },
        'seo-audit:dst_1:2026-W41',
      ],
    ]);
  });
});
