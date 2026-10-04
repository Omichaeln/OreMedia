import {
  ScheduleAlreadyRunning,
  type Client,
  type ScheduleOverlapPolicy,
  type ScheduleDescription,
  type ScheduleSpec,
} from '@temporalio/client';
import { decodeScheduleSpec, encodeScheduleSpec } from '@temporalio/client/lib/schedule-helpers.js';
import type { Duration } from '@temporalio/common';
import { msToNumber } from '@temporalio/common/lib/time.js';
import { logger } from '@oremedia/observability';

/**
 * A worker-owned Temporal schedule as the code wants it now: one per namespace, starting `workflowType` on
 * `taskQueue`. Only structured calendars and intervals are accepted (a cron string is compiled by the server, so it
 * could not be compared with what describe() returns).
 */
export interface DesiredSchedule {
  scheduleId: string;
  spec: Pick<ScheduleSpec, 'calendars' | 'intervals'>;
  action: { workflowType: string; taskQueue: string; args: unknown[] };
  policies: { overlap: ScheduleOverlapPolicy; catchupWindow: Duration; pauseOnFailure?: boolean };
}

export type ScheduleDrift = 'spec' | 'action' | 'policies';

/**
 * describe() returns the server's form of a spec (calendar fields as ranges, empty comment and timezone, intervals
 * in ms): both sides go through the SDK's own encoder and decoder, then the server's empty defaults are dropped.
 */
function canonicalSpec(spec: ScheduleSpec): string {
  const decoded = decodeScheduleSpec(encodeScheduleSpec(spec));
  return JSON.stringify({
    calendars: decoded.calendars?.map(({ comment, ...fields }) => ({ ...fields, comment: comment || null })),
    intervals: decoded.intervals?.map((i) => ({ every: i.every, offset: i.offset || 0 })),
    skip: decoded.skip ?? [],
    startAt: decoded.startAt ?? null,
    endAt: decoded.endAt ?? null,
    jitter: decoded.jitter || 0,
    timezone: decoded.timezone || null,
  });
}

/** The parts of an existing schedule that differ from the desired one (names only; empty when it matches). */
export function scheduleDrift(current: ScheduleDescription, desired: DesiredSchedule): ScheduleDrift[] {
  const drift: ScheduleDrift[] = [];
  if (canonicalSpec(current.spec) !== canonicalSpec(desired.spec)) drift.push('spec');
  const action = current.action;
  if (
    action.workflowType !== desired.action.workflowType ||
    action.taskQueue !== desired.action.taskQueue ||
    JSON.stringify(action.args ?? []) !== JSON.stringify(desired.action.args)
  )
    drift.push('action');
  const policies = current.policies;
  if (
    policies.overlap !== desired.policies.overlap ||
    policies.catchupWindow !== msToNumber(desired.policies.catchupWindow) ||
    policies.pauseOnFailure !== (desired.policies.pauseOnFailure ?? false)
  )
    drift.push('policies');
  return drift;
}

/**
 * Creates the schedule, or brings an existing one in line with the code: describe it, compare spec, action and
 * policies, and update only what differs. It is never deleted and recreated (the history and the paused state
 * stay). An update replaces the spec, the action's workflow type, queue and args, and the policies; it keeps the
 * state as described (paused, note, remaining actions), the action's workflow id, memo and headers, and it sends no
 * trigger or backfill, so it takes no extra action: the server computes the next times from the new spec onward.
 */
export async function ensureScheduleReconciled(
  client: Client,
  desired: DesiredSchedule,
): Promise<'created' | 'reconciled' | 'unchanged'> {
  const { scheduleId, spec, action, policies } = desired;
  try {
    await client.schedule.create({
      scheduleId,
      spec,
      action: { type: 'startWorkflow', ...action },
      policies,
    });
    logger().info({ status: scheduleId }, 'schedule created');
    return 'created';
  } catch (err) {
    if (!(err instanceof ScheduleAlreadyRunning)) throw err;
  }
  // One per namespace; joined, then reconciled with the code.
  const handle = client.schedule.getHandle(scheduleId);
  const drift = scheduleDrift(await handle.describe(), desired);
  if (drift.length === 0) return 'unchanged';
  await handle.update((previous) => ({
    spec,
    action: { ...previous.action, type: 'startWorkflow', ...action },
    policies: { ...previous.policies, ...policies },
    state: previous.state,
  }));
  logger().info({ status: `${scheduleId}:${drift.join(',')}` }, 'schedule reconciled');
  return 'reconciled';
}
