import { ParentClosePolicy, proxyActivities, sleep, startChild, workflowInfo } from '@temporalio/workflow';
import type {
  SeoAuditActivitiesV1,
  SeoAuditInputV1,
  SeoAuditSweepActivitiesV1,
  SeoAuditSweepArgsV1,
  SeoAuditSweepInputV1,
} from '@oremedia/contracts/seo-audit';
import {
  NON_RETRYABLE_ERROR_TYPES,
  runSeoAudit,
  runSeoAuditSweep,
  type SeoAuditOutcome,
  type SeoAuditSweepOutcome,
} from './seo-audit.workflow.v1';

/**
 * Ledger R2-4, version 2: the same crawl and weekly sweep as v1 (same activities and payloads, same orchestration in
 * runSeoAudit and runSeoAuditSweep). v1 built its activity set with `{ ...control, ...pages }`: an activity proxy
 * has no own keys, so the spread was empty and every v1 run failed at its first activity. v2 names each activity,
 * and its sweep starts v2 children. Once deployed this file is immutable; changes ship as v3.
 */
export async function seoAuditWorkflowV2(input: SeoAuditInputV1): Promise<SeoAuditOutcome> {
  // The plan reads robots.txt and the sitemap (several bounded fetches); a page is one fetch.
  const control = proxyActivities<
    Pick<SeoAuditActivitiesV1, 'planSeoAudit' | 'finishSeoAudit' | 'pruneSeoAudits'>
  >({
    startToCloseTimeout: '5 minutes',
    retry: { initialInterval: '30s', maximumAttempts: 3, nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES },
  });
  const pages = proxyActivities<Pick<SeoAuditActivitiesV1, 'crawlSeoAuditPage'>>({
    startToCloseTimeout: '2 minutes',
    heartbeatTimeout: '1 minute',
    retry: { initialInterval: '10s', maximumAttempts: 2, nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES },
  });
  const acts: SeoAuditActivitiesV1 = {
    planSeoAudit: control.planSeoAudit,
    finishSeoAudit: control.finishSeoAudit,
    pruneSeoAudits: control.pruneSeoAudits,
    crawlSeoAuditPage: pages.crawlSeoAuditPage,
  };
  return runSeoAudit(acts, input, { now: () => Date.now(), sleep: (ms) => sleep(ms) });
}

export async function seoAuditSweepWorkflowV2(args: SeoAuditSweepArgsV1 = {}): Promise<SeoAuditSweepOutcome> {
  const acts = proxyActivities<SeoAuditSweepActivitiesV1>({
    startToCloseTimeout: '5 minutes',
    retry: { initialInterval: '30s', maximumAttempts: 3 },
  });
  // A schedule starts this with fixed args: the workflow's deterministic clock and run id fill the rest.
  const input: SeoAuditSweepInputV1 = {
    correlationId: args.correlationId ?? `seo-audit-sweep:${workflowInfo().runId}`,
    now: args.now ?? new Date(Date.now()).toISOString(),
  };
  return runSeoAuditSweep(acts, input, {
    async startAudit(child, workflowId) {
      await startChild(seoAuditWorkflowV2, {
        args: [child],
        workflowId,
        parentClosePolicy: ParentClosePolicy.ABANDON,
      });
    },
  });
}
