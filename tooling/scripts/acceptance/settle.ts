import { fail, pass, safeDetail, type AcceptanceResult } from './report';

/**
 * The settle step of the acceptance job (docs/runbooks/staging-acceptance.md, "Reading the log"). The job redeploys
 * on the same push as the api, so it waits before provisioning anything until staging serves this push: the api's
 * /health answers 200 with `revision` equal to the job's own commit (skipped, and said so, when either is unknown),
 * and the database has applied every migration of the bundled journal, both on `required` consecutive probes
 * `intervalMs` apart. Past the deadline it returns `ACCEPTANCE_FAIL settle` naming the condition that still failed,
 * with the observed and expected values (commits and migration times, never a credential).
 */
export interface HealthObservation {
  /** The HTTP status of /health; 0 when no answer arrived. */
  status: number;
  /** The `revision` the api reports; null when absent. */
  revision: string | null;
  error?: string;
}

export interface MigrationObservation {
  expectedTag: string | null;
  expectedAt: number | null;
  appliedAt: number | null;
  upToDate: boolean;
}

export interface SettleProbes {
  health(): Promise<HealthObservation>;
  migrations(): Promise<MigrationObservation>;
}

export interface SettleOptions {
  /** The job's own commit (RAILWAY_GIT_COMMIT_SHA); null = unknown. */
  revision: string | null;
  timeoutMs: number;
  intervalMs?: number;
  /** How many consecutive settled probes count as settled. */
  required?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  print: (line: string) => void;
}

const errorText = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : 'failed');

/** The reason the api condition fails, or null when it holds; `skipNote` says why the revision is not compared. */
function judgeHealth(
  h: HealthObservation,
  expected: string | null,
): { reason: string | null; skipNote: string | null } {
  if (h.status !== 200)
    return {
      reason: h.error
        ? `api /health unreachable (${h.error}), expected HTTP 200`
        : `api /health HTTP ${h.status}, expected 200`,
      skipNote: null,
    };
  if (!expected)
    return { reason: null, skipNote: 'RAILWAY_GIT_COMMIT_SHA is not set on the acceptance service' };
  if (!h.revision) return { reason: null, skipNote: "the api's /health reports no revision" };
  if (h.revision !== expected)
    return { reason: `api revision ${h.revision}, expected ${expected}`, skipNote: null };
  return { reason: null, skipNote: null };
}

function judgeMigrations(m: MigrationObservation): string | null {
  if (m.upToDate) return null;
  return `migrations pending: latest applied created_at ${m.appliedAt ?? 'none'}, expected ${m.expectedAt} (${m.expectedTag})`;
}

export async function waitForSettled(probes: SettleProbes, opts: SettleOptions): Promise<AcceptanceResult> {
  const intervalMs = opts.intervalMs ?? 10_000;
  const required = opts.required ?? 3;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const print = (line: string) => opts.print(`ACCEPTANCE_INFO settle ${safeDetail(line)}`);
  const deadline = now() + opts.timeoutMs;
  const notes = new Set<string>();
  print(
    `waiting for the api to serve ${opts.revision ?? '(unknown revision)'} with every bundled migration applied: ${required} consecutive probes ${intervalMs / 1000} s apart, up to ${opts.timeoutMs / 1000} s`,
  );
  let streak = 0;
  for (let attempt = 1; ; attempt++) {
    const [health, migrations] = await Promise.all([
      probes
        .health()
        .catch((err): HealthObservation => ({ status: 0, revision: null, error: errorText(err) })),
      probes.migrations().then(
        (m) => ({ m, error: null }),
        (err: unknown) => ({ m: null, error: errorText(err) }),
      ),
    ]);
    const api = judgeHealth(health, opts.revision);
    if (api.skipNote && !notes.has(api.skipNote)) {
      notes.add(api.skipNote);
      print(`revision check skipped: ${api.skipNote}`);
    }
    const reasons = [
      api.reason,
      migrations.m ? judgeMigrations(migrations.m) : `migration state unreadable (${migrations.error})`,
    ].filter((r): r is string => r !== null);
    streak = reasons.length ? 0 : streak + 1;
    print(
      `probe ${attempt}: ${reasons.length ? reasons.join('; ') : `api HTTP 200 revision ${health.revision ?? 'unknown'}, migrations applied through ${migrations.m?.expectedTag ?? 'none'}`} (${streak}/${required} settled)`,
    );
    if (streak >= required)
      return pass(
        'settle',
        `api serves ${opts.revision && health.revision ? health.revision : 'an unchecked revision'} with migrations through ${migrations.m?.expectedTag ?? 'none'} applied, on ${required} consecutive probes`,
      );
    if (now() + intervalMs > deadline)
      return fail(
        'settle',
        `not settled within ${opts.timeoutMs / 1000} s: ${reasons.length ? reasons.join('; ') : `settled on only ${streak} of ${required} consecutive probes`}`,
      );
    await sleep(intervalMs);
  }
}
