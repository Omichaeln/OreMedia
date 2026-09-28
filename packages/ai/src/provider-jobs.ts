/**
 * Spec 12.2 model-call recovery: when a generation provider returns a job id (images, video) it is persisted before
 * the activity waits; a retried activity polls that job instead of submitting again. A job belongs to one tool call:
 * the run, the model step, the tool and the model's own tool_use id, so two calls of the same tool in one model step
 * each get their own job while a retry of the same call finds its job.
 */
export interface ProviderJobKey {
  runId: string;
  stepId: string;
  toolName: string;
  /** The model's tool_use id for this call (ModelToolCall.id), as the dispatcher received it. */
  toolCallId: string;
}

export interface ProviderJob {
  brandId: string;
  /** The generator's provider key (ImageGenerator.provider). */
  provider: string;
  providerJobId: string;
}

export type ProviderJobStatus = 'succeeded' | 'failed';

export interface ProviderJobStore {
  /** Records the accepted job; a second persist for the same call keeps the first job. */
  persist(key: ProviderJobKey, job: ProviderJob): Promise<void>;
  find(key: ProviderJobKey): Promise<string | null>;
  /**
   * A job with a second stage (a finished video handed to ingest) moves the call on to that stage's job id, only while
   * the call still holds `from`: a retry then polls the new stage instead of repeating the first one's hand-off.
   */
  advance(key: ProviderJobKey, from: string, to: string): Promise<void>;
  /** The provider reported a terminal outcome; a retry still finds (and polls) the job. */
  finish(key: ProviderJobKey, status: ProviderJobStatus): Promise<void>;
}

const keyOf = (k: ProviderJobKey) => `${k.runId}:${k.stepId}:${k.toolName}:${k.toolCallId}`;

/**
 * In-process store: survives activity retries on the same worker only. Worker processes register the durable store
 * (the agents module's provider_jobs table) through registerProviderJobStore at their composition root; this one
 * remains for unit tests and processes without a database.
 */
export class MemoryProviderJobStore implements ProviderJobStore {
  private readonly jobs = new Map<
    string,
    { providerJobId: string; status: ProviderJobStatus | 'submitted' }
  >();
  async persist(key: ProviderJobKey, job: ProviderJob): Promise<void> {
    if (!this.jobs.has(keyOf(key)))
      this.jobs.set(keyOf(key), { providerJobId: job.providerJobId, status: 'submitted' });
  }
  async find(key: ProviderJobKey): Promise<string | null> {
    return this.jobs.get(keyOf(key))?.providerJobId ?? null;
  }
  async advance(key: ProviderJobKey, from: string, to: string): Promise<void> {
    const job = this.jobs.get(keyOf(key));
    if (job?.providerJobId === from) job.providerJobId = to;
  }
  async finish(key: ProviderJobKey, status: ProviderJobStatus): Promise<void> {
    const job = this.jobs.get(keyOf(key));
    if (job) job.status = status;
  }
}

let store: ProviderJobStore = new MemoryProviderJobStore();
export const registerProviderJobStore = (s: ProviderJobStore): void => {
  store = s;
};
export const providerJobs = (): ProviderJobStore => store;

/**
 * The store registered at the time of each call (not at the time a runtime was built), so dispatch dependencies
 * created before the composition root ran still reach the durable store.
 */
export const registeredProviderJobStore: ProviderJobStore = {
  persist: (key, job) => store.persist(key, job),
  find: (key) => store.find(key),
  advance: (key, from, to) => store.advance(key, from, to),
  finish: (key, status) => store.finish(key, status),
};
