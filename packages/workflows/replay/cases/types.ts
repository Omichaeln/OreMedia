import { ApplicationFailure } from '@temporalio/common';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import type { HistoryMeta, QueueEntry } from '../catalogue';

/**
 * A recording case: one execution of one workflow type on a Temporal dev server, against the real queue bundle,
 * with fake activities returning representative results. The recorder (../record.ts) runs it once and retains the
 * history; the case stays here so the reviewer can see what the history represents and how it was produced.
 */
export type Client = TestWorkflowEnvironment['client'];
export type Handle = ReturnType<Client['workflow']['getHandle']>;
/** Fake activities per task queue (`core`, `publish-replay_provider`, …), each an activities interface. */
export type CaseActivities = Record<string, object>;

export interface CaseContext {
  client: Client;
  /** Activity names in call order (every fake records its call before it returns). */
  calls: string[];
  /** Resolves once activity `name` has been called `times` times. */
  untilCall(name: string, times?: number): Promise<void>;
  /** Resolves once the execution's history holds `times` events of `eventType` (e.g. 'TIMER_STARTED'). */
  untilEvent(handle: Handle, eventType: string, times?: number): Promise<void>;
  /** Starts another execution on a task queue of this case (a target for a relay, a parent's sibling). */
  start(workflowType: string, args: unknown[], workflowId: string, taskQueue?: string): Promise<Handle>;
}

export interface RecordingCase {
  workflowType: string;
  /** kebab-case; the history file is <workflowType>/<name>.json. */
  name: string;
  description: string;
  queue: QueueEntry;
  activities(rec: Recorder): CaseActivities;
  /** The workflow arguments; a function when they depend on the time the case runs. */
  args: unknown[] | (() => unknown[]);
  workflowId: string;
  /** Default: the queue entry's first task queue. */
  taskQueue?: string;
  /** Runs after the start (signals, cancellation); may return a different execution to record. */
  drive?(handle: Handle, ctx: CaseContext): Promise<Handle | void>;
  /** Runs before the start (e.g. starts the workflow a relay signals). */
  before?(ctx: CaseContext): Promise<void>;
  /** How the recorded execution must end; `open` takes the history while it waits (a timer, a signal). */
  state: HistoryMeta['state'];
  /** For `open`: the history is taken once this event type is present (default TIMER_STARTED). */
  openAt?: string;
}

/** Wraps fake activities so each call is recorded by name before it runs. */
export type Recorder = <T extends object>(impl: T) => T;

/** A failure the activity host would surface as non-retryable (a domain error no retry can fix). */
export const nonRetryable = (type: string, message = `${type} (replay fixture)`) =>
  ApplicationFailure.nonRetryable(message, type);

/** Synthetic tenant context: no real tenant, user or correlation id ever reaches a retained history. */
export const tenant = (n = 1, correlationId = `corr_replay_${n}`) => ({
  tenantId: `tnt_replay_${n}`,
  actor: { kind: 'user' as const, id: `usr_replay_${n}` },
  correlationId,
});

/** A fixed past instant, so every pull or check of a schedule is already due when the case runs. */
export const LONG_AGO = '2026-01-05T09:00:00.000Z';
export const hash = (c: string) => c.repeat(64);
/** The next scripted answer: each call takes one, the last one repeats. */
export const next = <T>(list: T[]): T => (list.length > 1 ? list.shift() : list[0]) as T;

/** Holds a fake activity until the case opens it (so a signal or cancel lands while the activity runs). */
export function gate(maxWaitMs = 120_000) {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return {
    wait: () => Promise.race([opened, new Promise<void>((resolve) => setTimeout(resolve, maxWaitMs))]),
    open: () => open(),
  };
}
