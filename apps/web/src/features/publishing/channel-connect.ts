import type { ErrorDetail } from '@oremedia/contracts/errors';

/**
 * The Release 1 provider keys (spec 14.8, the registry in packages/providers). The API has no provider listing, so
 * the settings screen offers these and the server decides: an uncertified or unknown provider is refused with
 * CAPABILITY_UNSUPPORTED and the screen shows it unavailable with that reason (spec 14.6).
 */
export const RELEASE_1_PROVIDERS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'linkedin_page', label: 'LinkedIn Page' },
  { key: 'instagram_business', label: 'Instagram Business' },
  { key: 'facebook_page', label: 'Facebook Page' },
  { key: 'x', label: 'X' },
];

export const providerLabel = (key: string): string =>
  RELEASE_1_PROVIDERS.find((p) => p.key === key)?.label ?? key;

/** Why a provider cannot be connected, from the server's refusal details; null when the refusal is something else. */
export function unavailableReason(details: readonly ErrorDetail[]): string | null {
  for (const d of details) {
    if (d.issue.startsWith('provider_not_certified:'))
      return 'Not certified for use yet: the platform review for this provider is not complete (spec 14.6).';
    if (d.issue.startsWith('unknown_provider:')) return 'Not available: this provider is not registered.';
  }
  return null;
}

/** The provider redirects back to the settings page with `state` and `code` in the query (spec 14.7 OAuth). */
export function callbackParams(search: string): { state: string; code: string } | null {
  const p = new URLSearchParams(search);
  const state = p.get('state');
  const code = p.get('code');
  return state && code ? { state, code } : null;
}

/** The provider's own error redirect (`error`, `error_description`), shown as text. */
export function callbackError(search: string): string | null {
  const p = new URLSearchParams(search);
  const error = p.get('error');
  if (!error) return null;
  const description = p.get('error_description');
  return description ? `${error}: ${description}` : error;
}

/**
 * Spec 14.7: providers return to one registered callback (Meta and LinkedIn match redirect URIs exactly), not to a
 * brand's own page. The API enforces it where the deployment sets WEB_ORIGIN.
 */
export const CONNECT_CALLBACK_PATH = '/connect/callback';
export const connectRedirectUri = (origin: string): string => `${origin}${CONNECT_CALLBACK_PATH}`;

/** Which brand's settings a connect flow returns to, remembered in this browser under its `state`. */
export interface PendingConnect {
  companyId: string;
  brandId: string;
  expiresAt: string;
}

const pendingKey = (state: string) => `oremedia.connect.${state}`;
type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
const browserStorage = (): KeyValueStore | null => {
  try {
    return localStorage;
  } catch {
    return null; // storage blocked: the callback page then asks the person to start again from the brand
  }
};

/**
 * Remembered in localStorage, not sessionStorage: the provider opens in a new tab (noopener), which shares only the
 * former. The state is not a credential (the server's PKCE verifier stays server-side); the entry is removed on use.
 */
export function rememberConnect(
  state: string,
  pending: PendingConnect,
  storage = browserStorage(),
  now = Date.now(),
): void {
  try {
    // Flows abandoned at the provider leave entries behind: drop the expired ones as a new flow starts.
    const stale: string[] = [];
    for (let i = 0; i < (storage?.length ?? 0); i++) {
      const key = storage?.key(i);
      if (!key?.startsWith(pendingKey(''))) continue;
      const expiresAt = Date.parse(
        (JSON.parse(storage?.getItem(key) ?? '{}') as { expiresAt?: string }).expiresAt ?? '',
      );
      if (!(expiresAt > now)) stale.push(key);
    }
    for (const key of stale) storage?.removeItem(key);
    storage?.setItem(pendingKey(state), JSON.stringify(pending));
  } catch {
    // quota or blocked: the callback page falls back to asking the person to start again
  }
}

/** The pending flow for a returned `state`, removed as it is read; null when unknown here or expired. */
export function recallConnect(
  state: string,
  storage = browserStorage(),
  now = Date.now(),
): PendingConnect | null {
  try {
    const raw = storage?.getItem(pendingKey(state));
    storage?.removeItem(pendingKey(state));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PendingConnect>;
    if (typeof p.companyId !== 'string' || typeof p.brandId !== 'string' || typeof p.expiresAt !== 'string')
      return null;
    return Date.parse(p.expiresAt) > now
      ? { companyId: p.companyId, brandId: p.brandId, expiresAt: p.expiresAt }
      : null;
  } catch {
    return null;
  }
}

/** The provider's own answer (state and code, or its error) carried on to the brand's settings page, nothing else. */
export function returnQuery(search: string): string {
  const from = new URLSearchParams(search);
  const to = new URLSearchParams();
  for (const key of ['state', 'code', 'error', 'error_description']) {
    const value = from.get(key);
    if (value !== null) to.set(key, value);
  }
  return to.toString();
}
