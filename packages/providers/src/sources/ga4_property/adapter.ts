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
import { ga4PropertyCapability } from './capability';

export const GA4_ADMIN_API = 'https://analyticsadmin.googleapis.com/v1beta';
/** accountSummaries pages: 200 per request (the API's maximum), at most 10 pages per listing. */
const SUMMARY_PAGE_SIZE = 200;
const SUMMARY_MAX_PAGES = 10;

/**
 * GA4 property source adapter (ledger R2-1 part A): Google OAuth with offline access, the properties the person
 * can read from the Analytics Admin API's account summaries (`properties/<id>`, the externalId form the Data API
 * reports of part B are keyed by). Read-only: it writes nothing anywhere.
 */
export class Ga4PropertyAdapter implements SourceAdapter {
  readonly key = 'ga4_property' as const;
  readonly capability = ga4PropertyCapability;

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

  /** Every property of every account the grant can see, account by account as the summaries list them. */
  async listTargets(credentials: DecryptedCredentials, _client: ClientConfig, io: ProviderIO) {
    const targets: SourceTarget[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < SUMMARY_MAX_PAGES; page++) {
      const u = new URL(`${GA4_ADMIN_API}/accountSummaries`);
      u.searchParams.set('pageSize', String(SUMMARY_PAGE_SIZE));
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const res = await googleGet(io, u.toString(), credentials.accessToken);
      if (res.status !== 200) throw new ProviderAuthError(this.key, 'identity_failed', summarise(res));
      for (const account of arr(get(res.json, 'accountSummaries'))) {
        const accountName = str(get(account, 'displayName'));
        for (const property of arr(get(account, 'propertySummaries'))) {
          const externalId = str(get(property, 'property'));
          if (!externalId) continue;
          const name = str(get(property, 'displayName')) ?? externalId;
          targets.push({ externalId, displayName: accountName ? `${accountName} · ${name}` : name });
        }
      }
      pageToken = str(get(res.json, 'nextPageToken'));
      if (!pageToken) break;
    }
    if (targets.length === 0)
      throw new ProviderAuthError(
        this.key,
        'no_eligible_account',
        'no GA4 property readable with this grant',
      );
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

export const ga4PropertyAdapter = new Ga4PropertyAdapter();
