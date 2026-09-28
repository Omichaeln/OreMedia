import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing for the password sign-in method (the second login method next to Google). scrypt from node:crypto,
 * no dependency. A stored hash is self-describing, `scrypt$<log2 N>$<r>$<p>$<salt b64>$<key b64>`, so the parameters
 * can be raised later: a hash made with weaker parameters still verifies and is replaced on the next successful
 * sign-in (needsRehash). The password is NFC-normalised first, so the same characters typed on any keyboard match.
 */
export interface ScryptParams {
  logN: number;
  r: number;
  p: number;
}

/** 2^17 × 8 × 1: 128 MiB and a few hundred milliseconds per hash (the OWASP scrypt recommendation). */
export const CURRENT_SCRYPT_PARAMS: ScryptParams = { logN: 17, r: 8, p: 1 };
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const PREFIX = 'scrypt';
/** Bounds a stored string may carry: a corrupted or hostile value can neither exhaust memory nor verify cheaply. */
const LIMITS = { logN: [10, 18], r: [1, 16], p: [1, 16] } as const;

/**
 * scrypt needs 128 × N × r bytes (128 MiB at the current parameters); each hash runs in the libuv pool with that much
 * memory. PASSWORD_HASH_CONCURRENCY hashes run at a time (default 4, so about 512 MiB at most); up to
 * MAX_WAITING more wait their turn, and beyond that the request is refused as busy rather than queued without bound.
 * A finished hash hands its slot straight to the next waiter, so the count never exceeds the limit.
 */
const concurrency = (): number => {
  const n = Number(process.env['PASSWORD_HASH_CONCURRENCY'] ?? 4);
  return Number.isInteger(n) && n >= 1 && n <= 32 ? n : 4;
};
const MAX_CONCURRENT = concurrency();
const MAX_WAITING = 64;
let running = 0;
const waiting: Array<() => void> = [];

/** Too many password hashes are already running or waiting; the caller answers 503 with Retry-After. */
export class PasswordHashingBusyError extends Error {
  readonly retryAfterMs = 1000;
  constructor() {
    super('password hashing is busy');
    this.name = 'PasswordHashingBusyError';
  }
}

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running < MAX_CONCURRENT) running++;
  else if (waiting.length >= MAX_WAITING) throw new PasswordHashingBusyError();
  else await new Promise<void>((resolve) => waiting.push(resolve)); // the slot is handed over, running unchanged
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

const derive = (password: string, salt: Buffer, params: ScryptParams, keyLength: number): Promise<Buffer> => {
  const N = 2 ** params.logN;
  const options: ScryptOptions = { N, r: params.r, p: params.p, maxmem: 256 * N * params.r };
  return withSlot(
    () =>
      new Promise<Buffer>((resolve, reject) =>
        scrypt(password.normalize('NFC'), salt, keyLength, options, (err, key) =>
          err ? reject(err) : resolve(key),
        ),
      ),
  );
};

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}

const within = (value: number, [min, max]: readonly [number, number]) =>
  Number.isInteger(value) && value >= min && value <= max;

/** The parts of a stored hash, or null when it is not one this module wrote (such a value never verifies). */
export function parsePasswordHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;
  const [logN, r, p] = parts.slice(1, 4).map((v) => (/^\d{1,3}$/.test(v as string) ? Number(v) : NaN)) as [
    number,
    number,
    number,
  ];
  if (!within(logN, LIMITS.logN) || !within(r, LIMITS.r) || !within(p, LIMITS.p)) return null;
  const salt = Buffer.from(parts[4] as string, 'base64');
  const key = Buffer.from(parts[5] as string, 'base64');
  if (salt.length < SALT_BYTES || key.length < 16 || key.length > 64) return null;
  return { params: { logN, r, p }, salt, key };
}

export async function hashPassword(
  password: string,
  params: ScryptParams = CURRENT_SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params, KEY_BYTES);
  return [PREFIX, params.logN, params.r, params.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/**
 * A fixed hash to verify against when there is no stored one (unknown email, or a user without a password), so the
 * answer takes as long as a real check and does not reveal whether the account exists. Made once per process, with
 * the current parameters.
 */
let dummy: Promise<string> | null = null;
const dummyHash = () => (dummy ??= hashPassword(randomBytes(32).toString('base64url')));

/**
 * Constant-time check of a password against a stored hash. `stored` null (or unparseable) still costs one scrypt
 * against the dummy hash and returns false.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parsed = stored ? parsePasswordHash(stored) : null;
  const target = parsed ?? (parsePasswordHash(await dummyHash()) as ParsedHash);
  const key = await derive(password, target.salt, target.params, target.key.length);
  return timingSafeEqual(key, target.key) && parsed !== null;
}

/** True when a stored hash was made with weaker parameters than the current ones (rehash on the next sign-in). */
export function needsRehash(stored: string, current: ScryptParams = CURRENT_SCRYPT_PARAMS): boolean {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return true;
  const { logN, r, p } = parsed.params;
  return logN < current.logN || r < current.r || p < current.p || parsed.key.length < KEY_BYTES;
}
