import { proxyActivities, sleep } from '@temporalio/workflow';
import type {
  RenderedValidationActivitiesV1,
  RenderedValidationInputV1,
  RenderedValidationResultV1,
} from '@oremedia/contracts/publishing';

/**
 * RA-04 (task queue `core`), started by the outbox from publication.rendered_validation_due, which markPublished
 * emits with `availableAt` at the first delay after a live article is published: the rendered page is checked
 * again at each delay (2 and 15 minutes after publish; the activity records the evidence and the verification),
 * so a page that changed, lost its canonical or stopped being indexable after the first look is found. A
 * publication that is no longer a live article is skipped and the run ends. The payload carries ids only (R5).
 * Once deployed this file is immutable; changes ship as v2.
 */
export const RENDERED_VALIDATION_DELAYS_MS = [2 * 60_000, 15 * 60_000] as const;

export interface RenderedValidationHost {
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface RenderedValidationOutcomeV1 {
  results: RenderedValidationResultV1[];
}

/** Each delay counts from publishedAt; a delay already past when the run reaches it is checked at once. */
export async function runRenderedValidation(
  acts: RenderedValidationActivitiesV1,
  input: RenderedValidationInputV1,
  host: RenderedValidationHost,
): Promise<RenderedValidationOutcomeV1> {
  const publishedAt = new Date(input.publishedAt).getTime();
  const results: RenderedValidationResultV1[] = [];
  for (const delay of RENDERED_VALIDATION_DELAYS_MS) {
    const waitMs = publishedAt + delay - host.now();
    if (waitMs > 0) await host.sleep(waitMs);
    const result = await acts.validateRenderedPublication(input);
    results.push(result);
    if (result.outcome === 'skipped') break;
  }
  return { results };
}

export async function renderedValidationWorkflowV1(
  input: RenderedValidationInputV1,
): Promise<RenderedValidationOutcomeV1> {
  const acts = proxyActivities<RenderedValidationActivitiesV1>({
    startToCloseTimeout: '2 minutes',
    heartbeatTimeout: '1 minute',
    retry: {
      initialInterval: '30s',
      maximumAttempts: 3,
      nonRetryableErrorTypes: ['PolicyDenied', 'ValidationFailed', 'NotFound', 'CapabilityUnsupported'],
    },
  });
  return runRenderedValidation(acts, input, { sleep: (ms) => sleep(ms), now: () => Date.now() });
}
