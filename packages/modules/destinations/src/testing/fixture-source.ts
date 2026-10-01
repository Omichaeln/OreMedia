import type { DestinationKind } from '@oremedia/contracts/destinations';
import type {
  ClientConfig,
  DecryptedCredentials,
  ProviderErrorClass,
  RefreshResult,
} from '@oremedia/contracts/providers';
import {
  ProviderAuthError,
  classifyByStatus,
  type ProviderIO,
  type SourceAdapter,
  type SourceCapabilityV1,
  type SourceGrant,
  type SourceTarget,
} from '@oremedia/providers';

/**
 * Test fixture only (never registered in production): an in-memory source whose grant, targets and refresh answer
 * a test scripts per call. `certifiedAt` is set so the registry's certification gate lets tests through. It makes
 * no network call: what the connect flow and the refresh do with a grant is the subject, not the platform.
 */
export const fixtureSourceCapability = (
  kind: DestinationKind,
  over: Partial<SourceCapabilityV1> = {},
): SourceCapabilityV1 => ({
  key: kind,
  version: 1,
  vendor: 'Fixture',
  requiredScopes: ['https://www.googleapis.com/auth/fixture.readonly'],
  latencyHours: 1,
  rateLimits: [],
  certifiedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

export type RefreshBehaviour = { kind: 'refresh' } | { kind: 'revoked' } | { kind: 'transient' };

export class FixtureSourceAdapter implements SourceAdapter {
  readonly key: DestinationKind;
  readonly capability: SourceCapabilityV1;
  /** What the next exchangeCode returns. */
  grant: SourceGrant = {
    credentials: {
      accessToken: 'at_fixture_src',
      refreshToken: 'rt_fixture_src',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
    grantedScopes: ['https://www.googleapis.com/auth/fixture.readonly'],
  };
  /** What listTargets returns; empty means no_eligible_account. */
  targets: SourceTarget[] = [{ externalId: 'properties/1', displayName: 'Fixture property' }];
  refreshBehaviour: RefreshBehaviour = { kind: 'refresh' };
  /** Every refresh call with the credentials it was handed (a test proves the stored grant was opened). */
  readonly refreshCalls: DecryptedCredentials[] = [];
  /** The last code exchanged. */
  lastCode: string | null = null;

  constructor(kind: DestinationKind = 'ga4_property', capability?: SourceCapabilityV1) {
    this.key = kind;
    this.capability = capability ?? fixtureSourceCapability(kind);
  }

  async authorizationUrl(input: { state: string; redirectUri: string; client: ClientConfig }) {
    const u = new URL('https://source.fixture.test/oauth/authorize');
    u.searchParams.set('client_id', input.client.clientId);
    u.searchParams.set('redirect_uri', input.redirectUri);
    u.searchParams.set('state', input.state);
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    return { url: u.toString() };
  }

  async exchangeCode(input: { code: string }, _io: ProviderIO): Promise<SourceGrant> {
    this.lastCode = input.code;
    if (input.code === 'bad') throw new ProviderAuthError(this.key, 'exchange_failed', 'invalid_grant');
    return { ...this.grant, credentials: { ...this.grant.credentials } };
  }

  async refresh(
    credentials: DecryptedCredentials,
    _client: ClientConfig,
    _io: ProviderIO,
  ): Promise<RefreshResult> {
    this.refreshCalls.push({ ...credentials });
    switch (this.refreshBehaviour.kind) {
      case 'revoked':
        return { ok: false, reason: 'reconnect_required' };
      case 'transient':
        return { ok: false, reason: 'transient' };
      case 'refresh': {
        const expiresAt = new Date(Date.now() + 3600_000).toISOString();
        return {
          ok: true,
          credentials: { ...credentials, accessToken: `${credentials.accessToken}_refreshed`, expiresAt },
          tokenExpiresAt: expiresAt,
        };
      }
    }
  }

  async listTargets(): Promise<SourceTarget[]> {
    if (this.targets.length === 0)
      throw new ProviderAuthError(this.key, 'no_eligible_account', 'nothing readable');
    return this.targets.map((t) => ({ ...t }));
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
