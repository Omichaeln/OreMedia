import { hashCanonical } from '@oremedia/domain/hash';

/**
 * Input fields that carry a credential: a destination's application password (`secret`), an OAuth authorisation
 * `code`, a password or a token. The request hash is stored unsalted in idempotency_keys, where a low-entropy secret
 * could be recovered offline, so these are left out of it. A retry under the same Idempotency-Key that changes only
 * such a field is then treated as the same request, as for any field the hash does not cover.
 */
export const SECRET_INPUT_FIELDS: ReadonlySet<string> = new Set([
  'secret',
  'code',
  'password',
  'currentPassword',
  'newPassword',
  'token',
]);

const withoutSecrets = (input: unknown): unknown =>
  input && typeof input === 'object' && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input).filter(([k]) => !SECRET_INPUT_FIELDS.has(k)))
    : input;

/**
 * Spec 7.1: the idempotency request hash covers the procedure path and the raw input, canonically, without the
 * credential fields above.
 */
export const hashRequest = (path: string, rawInput: unknown): string =>
  hashCanonical({ path, input: withoutSecrets(rawInput ?? null) });
