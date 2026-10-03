/**
 * Shared workflow helpers for failures (deterministic; no Node APIs). New workflow versions import from here; files
 * already deployed keep their own copies (deployed workflow files are immutable).
 */

/** Walks the failure chain (ActivityFailure → ApplicationFailure) for a failure type or error name. */
export function isFailureOfType(err: unknown, type: string): boolean {
  let current: unknown = err;
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    const e = current as { type?: string; name?: string; cause?: unknown };
    if (e.type === type || e.name === type) return true;
    current = e.cause;
  }
  return false;
}
