import type {
  ClientConfig,
  DecryptedCredentials,
  ProviderErrorClass,
  RefreshResult,
} from '@oremedia/contracts/providers';
import { classifyByStatus } from '../../base';
import type { ProviderIO } from '../../io';
import { ProviderAuthError, arr, get, str, summarise } from '../../shared';
import type { SourceAdapter, SourceGrant, SourceTarget } from '../../source-contract';
import { googleAuthorizationUrl, googleExchangeCode, googleGet, googleRefresh } from '../google-oauth';
import { searchConsoleSiteCapability } from './capability';

export const SEARCH_CONSOLE_API = 'https://www.googleapis.com/webmasters/v3';
/** A site the person has no verified access to cannot be read; the listing still names it. */
const UNVERIFIED = 'siteUnverifiedUser';

/**
 * Search Console site source adapter (ledger R2-1 part A): Google OAuth with offline access and the sites the
 * grant can read from the Webmasters API's site list. The externalId is the site URL as Search Console names it
 * (`https://acme.example/` or `sc-domain:acme.example`). Read-only.
 */
export class SearchConsoleSiteAdapter implements SourceAdapter {
  readonly key = 'search_console_site' as const;
  readonly capability = searchConsoleSiteCapability;

  async authorizationUrl(input: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
    client: ClientConfig;
  }): Promise<{ url: string }> {
    return { url: googleAuthorizationUrl({ ...input, scopes: this.capability.requiredScopes }) };
  }

  exchangeCode(
    input: { code: string; codeVerifier: string; redirectUri: string; client: ClientConfig },
    io: ProviderIO,
  ): Promise<SourceGrant> {
    return googleExchangeCode(this.key, io, input);
  }

  refresh(credentials: DecryptedCredentials, client: ClientConfig, io: ProviderIO): Promise<RefreshResult> {
    return googleRefresh(credentials, client, io);
  }

  /** Every verified site the grant can read (an unverified entry is listed by Google but readable by nobody). */
  async listTargets(credentials: DecryptedCredentials, _client: ClientConfig, io: ProviderIO) {
    const res = await googleGet(io, `${SEARCH_CONSOLE_API}/sites`, credentials.accessToken);
    if (res.status !== 200) throw new ProviderAuthError(this.key, 'identity_failed', summarise(res));
    const targets: SourceTarget[] = [];
    for (const site of arr(get(res.json, 'siteEntry'))) {
      const siteUrl = str(get(site, 'siteUrl'));
      if (!siteUrl || str(get(site, 'permissionLevel')) === UNVERIFIED) continue;
      targets.push({ externalId: siteUrl, displayName: siteUrl });
    }
    if (targets.length === 0)
      throw new ProviderAuthError(this.key, 'no_eligible_account', 'no verified Search Console site');
    return targets;
  }

  classifyError(input: {
    status?: number;
    body?: string;
    phase: 'before_send' | 'after_send';
    error?: unknown;
  }): ProviderErrorClass {
    return classifyByStatus(input);
  }
}

export const searchConsoleSiteAdapter = new SearchConsoleSiteAdapter();
