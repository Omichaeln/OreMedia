/**
 * Spec 18 / 19.4: a retained history carries no tenant data, secrets or machine details. The recorder runs every
 * workflow on synthetic ids (tenant `tnt_replay_<n>`, hosts under `.example`), then `sanitiseHistory` replaces the
 * recording machine's identity and drops stack traces (they hold local file paths); `sanitisationProblems` is the
 * check the recorder applies before writing and the replay suite applies to every retained file, payloads decoded.
 */
export const RECORDER_IDENTITY = 'replay-recorder';
export const SYNTHETIC_TENANT = /^tnt_replay_\d+$/;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Identity fields name the worker or client process (`pid@hostname`); stack traces name local paths. */
export function sanitiseHistory<T>(history: T): T {
  const walk = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    const out: { [key: string]: Json } = {};
    for (const [key, v] of Object.entries(value)) {
      if (key === 'identity' && typeof v === 'string') out[key] = v ? RECORDER_IDENTITY : v;
      else if (key === 'stackTrace' && typeof v === 'string') out[key] = '';
      else out[key] = walk(v);
    }
    return out;
  };
  return walk(history as Json) as T;
}

const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8');

/** A Temporal payload in history JSON: base64 metadata and data. json/plain payloads are decoded for the scan. */
function decodedPayload(value: { [key: string]: Json }): Json | undefined {
  const meta = value['metadata'];
  const data = value['data'];
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || typeof data !== 'string') return undefined;
  const encoding = typeof meta['encoding'] === 'string' ? decode(meta['encoding']) : '';
  if (encoding !== 'json/plain') return undefined;
  try {
    return JSON.parse(decode(data)) as Json;
  } catch {
    return undefined;
  }
}

const LOCAL_PATH = /(?:\/home\/|\/Users\/|\/root\/|\/tmp\/|[A-Za-z]:\\)/;
const SECRET_LIKE =
  /(?:-----BEGIN|\bBearer\s+[A-Za-z0-9]|\bsk-[A-Za-z0-9]{8}|\bghp_[A-Za-z0-9]|\bAKIA[0-9A-Z]{12})/;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const URL_HOST = /\bhttps?:\/\/([^/\s"'?#:]+)/g;
const syntheticHost = (host: string) =>
  host.endsWith('.example') || host === 'example.com' || host.endsWith('.example.com');

/** Everything in a history that is not synthetic or not sanitised, as human-readable problems (empty when clean). */
export function sanitisationProblems(history: unknown, extraForbidden: string[] = []): string[] {
  const problems: string[] = [];
  const checkString = (s: string, at: string) => {
    if (LOCAL_PATH.test(s)) problems.push(`${at}: a local file path`);
    if (SECRET_LIKE.test(s)) problems.push(`${at}: a secret-like value`);
    for (const m of s.matchAll(EMAIL))
      if (!syntheticHost((m[1] ?? '').toLowerCase())) problems.push(`${at}: a non-synthetic email address`);
    for (const m of s.matchAll(URL_HOST))
      if (!syntheticHost((m[1] ?? '').toLowerCase())) problems.push(`${at}: a non-synthetic host ${m[1]}`);
    for (const f of extraForbidden) if (f && s.includes(f)) problems.push(`${at}: contains "${f}"`);
  };
  const walk = (value: Json, at: string, inPayload: boolean) => {
    if (typeof value === 'string') return checkString(value, at);
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${at}[${i}]`, inPayload));
    if (!value || typeof value !== 'object') return;
    const payload = inPayload ? undefined : decodedPayload(value);
    if (payload !== undefined) return walk(payload, `${at}<payload>`, true);
    for (const [key, v] of Object.entries(value)) {
      const path = `${at}.${key}`;
      if (!inPayload && key === 'identity' && typeof v === 'string' && v && v !== RECORDER_IDENTITY)
        problems.push(`${path}: identity "${v}" is not ${RECORDER_IDENTITY}`);
      if (!inPayload && key === 'stackTrace' && typeof v === 'string' && v)
        problems.push(`${path}: a stack trace is kept`);
      if (inPayload && key === 'tenantId' && typeof v === 'string' && !SYNTHETIC_TENANT.test(v))
        problems.push(`${path}: tenant "${v}" is not synthetic (tnt_replay_<n>)`);
      walk(v, path, inPayload);
    }
  };
  walk(history as Json, '$', false);
  return problems;
}
