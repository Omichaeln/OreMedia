import { randomUUID } from 'node:crypto';
import {
  DestinationConnectCancel,
  DestinationConnectComplete,
  DestinationConnectSelect,
  DestinationConnectStart,
  DestinationDisconnect,
  DestinationGet,
  DestinationList,
  DestinationRegister,
  DestinationSetHealth,
  SourceUseCheck,
  SourceUsePolicyList,
  SourceUsePolicySet,
  sourceUseIssues,
  type DestinationConnectTarget,
  type DestinationSourceV1,
  type DestinationV1,
  type SourceUseCheckResult,
  type SourceUsePolicyV1,
} from '@oremedia/contracts/destinations';
import {
  CapabilityUnsupportedError,
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { MembershipRole } from '@oremedia/contracts/tenancy';
import type { MockBuilders, t } from './mock-api';

/**
 * Brand destinations slice of the UI-only transport (see mock-api.ts): destinations.list/get/register/setHealth/
 * disconnect, destinations.sourceUse.list/set/check and (R2-1) destinations.sources.list and
 * destinations.connect.start/complete/select/cancel with the same paths, DTO shapes, role gates and error
 * envelope as apps/api (packages/modules/destinations). A test double, never a second implementation.
 */
export const PD = {
  destinations: { ga4: 'dst_e2e_ga4', gbp: 'dst_e2e_gbp' },
  policies: { ga4Reports: 'sup_e2e_ga4_reports', gbpReviews: 'sup_e2e_gbp_reviews' },
  /** What a completed grant can read (connect.complete offers both; the person confirms one). */
  targets: [
    { externalId: 'properties/9001', displayName: 'Acme · Acme web (new)' },
    { externalId: 'properties/9002', displayName: 'Acme · Acme app' },
  ] as readonly DestinationConnectTarget[],
} as const;

/** The deployment's sources: GA4 certified and enabled; Search Console registered but not enabled here. */
const SOURCES: readonly DestinationSourceV1[] = [
  {
    kind: 'ga4_property',
    label: 'Google Analytics 4 property',
    vendor: 'Google',
    certified: true,
    enabled: true,
  },
  {
    kind: 'search_console_site',
    label: 'Search Console site',
    vendor: 'Google',
    certified: false,
    enabled: false,
  },
];

/** Spec 5.5 default grants of destination.connect / destination.manage and source_use.manage. */
const CONNECTORS: ReadonlySet<MembershipRole> = new Set(['owner', 'admin', 'publisher']);
const POLICY_MANAGERS: ReadonlySet<MembershipRole> = new Set(['owner', 'admin']);

const now = () => new Date().toISOString();
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

export class DestinationsBackend {
  readonly destinations: DestinationV1[] = [];
  readonly policies: SourceUsePolicyV1[] = [];
  /** connect.start's states (spec 14.7 pattern), consumed once by connect.complete. */
  readonly connectStates = new Map<string, { brandId: string; kind: DestinationV1['kind'] }>();
  /** The flows connect.complete offered (one-shot), keyed by pending id. */
  readonly connectChoices = new Map<
    string,
    { brandId: string; kind: DestinationV1['kind']; targets: DestinationConnectTarget[] }
  >();

  constructor(
    readonly brandId: string,
    readonly role: () => MembershipRole,
    seed = true,
  ) {
    if (!seed) return;
    const at = '2026-09-20T09:00:00.000Z';
    this.destinations.push(
      {
        id: PD.destinations.ga4,
        brandId,
        kind: 'ga4_property',
        externalId: 'properties/424242',
        displayName: 'Acme web',
        ownerUserId: 'usr_e2e',
        grantedScopes: ['analytics.readonly'],
        health: 'healthy',
        healthCheckedAt: '2026-09-30T06:00:00.000Z',
        capabilityVersion: 1,
        status: 'active',
        version: 1,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: PD.destinations.gbp,
        brandId,
        kind: 'gbp_location',
        externalId: 'locations/777',
        displayName: 'Acme Harare',
        ownerUserId: 'usr_e2e',
        grantedScopes: [],
        health: 'unknown',
        healthCheckedAt: null,
        capabilityVersion: 1,
        status: 'active',
        version: 0,
        createdAt: at,
        updatedAt: at,
      },
    );
    this.policies.push(
      {
        id: PD.policies.ga4Reports,
        brandId,
        destinationKind: 'ga4_property',
        dataType: 'ga4.reports',
        allowedUses: ['read'],
        retentionDays: null,
        version: 1,
        reviewedAt: at,
        reviewDueAt: inDays(60),
        reviewedById: 'usr_e2e',
        createdAt: at,
        updatedAt: at,
      },
      {
        id: PD.policies.gbpReviews,
        brandId,
        destinationKind: 'gbp_location',
        dataType: 'gbp.reviews',
        allowedUses: ['read'],
        retentionDays: null,
        version: 2,
        reviewedAt: at,
        reviewDueAt: inDays(30),
        reviewedById: 'usr_e2e',
        createdAt: at,
        updatedAt: at,
      },
    );
  }
}

export interface DestinationsBuilders {
  router: typeof t.router;
  query: MockBuilders['query'];
  mutation: MockBuilders['mutation'];
}

export function destinationsRouters(
  b: DestinationsBackend,
  { router, query, mutation }: DestinationsBuilders,
) {
  const brandOf = (brandId: string) => {
    if (brandId !== b.brandId) throw new NotFoundError('Brand', brandId);
  };
  const destinationOf = (brandId: string, id: string) => {
    const d = b.destinations.find((x) => x.id === id && x.brandId === brandId);
    if (!d) throw new NotFoundError('Destination', id);
    return d;
  };
  const policyOf = (brandId: string, kind: string, dataType: string) =>
    b.policies.find((p) => p.brandId === brandId && p.destinationKind === kind && p.dataType === dataType) ??
    null;
  return router({
    list: query.input(DestinationList).query(({ input }) => {
      brandOf(input.brandId);
      const items = b.destinations
        .filter((d) => d.brandId === input.brandId && (!input.kind || d.kind === input.kind))
        .sort((x, y) => x.kind.localeCompare(y.kind) || x.displayName.localeCompare(y.displayName));
      return { items };
    }),
    get: query.input(DestinationGet).query(({ input }) => destinationOf(input.brandId, input.destinationId)),
    register: mutation.input(DestinationRegister).mutation(({ input }) => {
      brandOf(input.brandId);
      if (!CONNECTORS.has(b.role())) throw new PolicyDeniedError('role_missing');
      const existing = b.destinations.find((d) => d.kind === input.kind && d.externalId === input.externalId);
      if (existing && existing.brandId !== input.brandId)
        throw new ValidationFailedError(
          [{ path: 'externalId', issue: 'remote_identity_registered_to_another_brand' }],
          'This remote identity is already registered to another brand',
        );
      if (existing) throw new ConflictError('Destination', existing.id, existing.version);
      const row: DestinationV1 = {
        id: `dst_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        brandId: input.brandId,
        kind: input.kind,
        externalId: input.externalId,
        displayName: input.displayName,
        ownerUserId: 'usr_e2e',
        grantedScopes: input.grantedScopes,
        health: 'unknown',
        healthCheckedAt: null,
        capabilityVersion: input.capabilityVersion,
        status: 'active',
        version: 0,
        createdAt: now(),
        updatedAt: now(),
      };
      b.destinations.push(row);
      return row;
    }),
    setHealth: mutation.input(DestinationSetHealth).mutation(({ input }) => {
      const d = destinationOf(input.brandId, input.destinationId);
      if (!CONNECTORS.has(b.role())) throw new PolicyDeniedError('role_missing');
      if (d.version !== input.expectedVersion)
        throw new ConflictError('Destination', d.id, input.expectedVersion);
      Object.assign(d, {
        health: input.health,
        healthCheckedAt: now(),
        updatedAt: now(),
        version: d.version + 1,
      });
      return d;
    }),
    sources: router({ list: query.query(() => ({ items: [...SOURCES] })) }),
    connect: router({
      start: mutation.input(DestinationConnectStart).mutation(({ input }) => {
        brandOf(input.brandId);
        if (!CONNECTORS.has(b.role())) throw new PolicyDeniedError('role_missing');
        const source = SOURCES.find((s) => s.kind === input.kind);
        if (!source)
          throw new CapabilityUnsupportedError([{ path: 'kind', issue: `unknown_provider:${input.kind}` }]);
        if (!source.certified)
          throw new CapabilityUnsupportedError([
            { path: 'kind', issue: `provider_not_certified:${input.kind}` },
          ]);
        const state = `st_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
        b.connectStates.set(state, { brandId: input.brandId, kind: input.kind });
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.searchParams.set('state', state);
        url.searchParams.set('redirect_uri', input.redirectUri ?? '');
        url.searchParams.set('access_type', 'offline');
        url.searchParams.set('prompt', 'consent');
        return { state, url: url.toString(), expiresAt: inDays(1) };
      }),
      complete: mutation.input(DestinationConnectComplete).mutation(({ input }) => {
        const pending = b.connectStates.get(input.state);
        b.connectStates.delete(input.state);
        if (!pending)
          throw new ValidationFailedError(
            [{ path: 'state', issue: 'connect_state_invalid_or_expired' }],
            'The connect flow has expired; start again',
          );
        const pendingId = `pdg_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
        const targets = PD.targets.map((t) => ({ ...t }));
        b.connectChoices.set(pendingId, { ...pending, targets });
        return { pendingId, brandId: pending.brandId, kind: pending.kind, targets, expiresAt: inDays(1) };
      }),
      select: mutation.input(DestinationConnectSelect).mutation(({ input }) => {
        const choice = b.connectChoices.get(input.pendingId);
        if (!choice)
          throw new ValidationFailedError(
            [{ path: 'pendingId', issue: 'connect_choice_invalid_or_expired' }],
            'The connect flow has expired; start again',
          );
        const target = choice.targets.find((t) => t.externalId === input.externalId);
        if (!target)
          throw new ValidationFailedError(
            [{ path: 'externalId', issue: 'target_not_offered' }],
            'Choose one of the targets offered',
          );
        const existing = b.destinations.find(
          (d) => d.kind === choice.kind && d.externalId === target.externalId,
        );
        if (existing && existing.brandId !== choice.brandId)
          throw new ValidationFailedError(
            [{ path: 'externalId', issue: 'remote_identity_registered_to_another_brand' }],
            'This remote identity is already registered to another brand',
          );
        if (existing) throw new ConflictError('Destination', existing.id, existing.version);
        b.connectChoices.delete(input.pendingId);
        const row: DestinationV1 = {
          id: `dst_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
          brandId: choice.brandId,
          kind: choice.kind,
          externalId: target.externalId,
          displayName: target.displayName,
          ownerUserId: 'usr_e2e',
          grantedScopes: ['https://www.googleapis.com/auth/analytics.readonly'],
          health: 'healthy',
          healthCheckedAt: now(),
          capabilityVersion: 1,
          status: 'active',
          version: 0,
          createdAt: now(),
          updatedAt: now(),
        };
        b.destinations.push(row);
        return row;
      }),
      cancel: mutation.input(DestinationConnectCancel).mutation(({ input }) => {
        if (!b.connectChoices.delete(input.pendingId))
          throw new ValidationFailedError(
            [{ path: 'pendingId', issue: 'connect_choice_invalid_or_expired' }],
            'The connect flow has expired; start again',
          );
        return { pendingId: input.pendingId, cancelled: true as const };
      }),
    }),
    disconnect: mutation.input(DestinationDisconnect).mutation(({ input }) => {
      const d = destinationOf(input.brandId, input.destinationId);
      if (!CONNECTORS.has(b.role())) throw new PolicyDeniedError('role_missing');
      if (d.status === 'disconnected')
        throw new ValidationFailedError(
          [{ path: 'destinationId', issue: 'already_disconnected' }],
          'This destination is already disconnected',
        );
      if (d.version !== input.expectedVersion)
        throw new ConflictError('Destination', d.id, input.expectedVersion);
      Object.assign(d, { status: 'disconnected', updatedAt: now(), version: d.version + 1 });
      return d;
    }),
    sourceUse: router({
      list: query.input(SourceUsePolicyList).query(({ input }) => {
        brandOf(input.brandId);
        const items = b.policies
          .filter(
            (p) =>
              p.brandId === input.brandId &&
              (!input.destinationKind || p.destinationKind === input.destinationKind),
          )
          .sort(
            (x, y) =>
              x.destinationKind.localeCompare(y.destinationKind) || x.dataType.localeCompare(y.dataType),
          );
        return { items };
      }),
      set: mutation.input(SourceUsePolicySet).mutation(({ input }) => {
        brandOf(input.brandId);
        if (!POLICY_MANAGERS.has(b.role())) throw new PolicyDeniedError('role_missing');
        const allowedUses = [...new Set(input.allowedUses)];
        const issues = sourceUseIssues(input.destinationKind, allowedUses, input.retentionDays);
        if (issues.length) throw new ValidationFailedError(issues);
        const retains = allowedUses.includes('retain');
        if (new Date(input.reviewDueAt).getTime() <= Date.now())
          throw new ValidationFailedError([{ path: 'reviewDueAt', issue: 'not_in_future' }]);
        const values = {
          allowedUses,
          retentionDays: retains ? (input.retentionDays ?? null) : null,
          reviewedAt: now(),
          reviewDueAt: input.reviewDueAt,
          reviewedById: 'usr_e2e',
          updatedAt: now(),
        };
        const existing = policyOf(input.brandId, input.destinationKind, input.dataType);
        if (existing) {
          if (input.expectedVersion !== existing.version)
            throw new ConflictError(
              'SourceUsePolicy',
              existing.id,
              input.expectedVersion ?? existing.version,
            );
          Object.assign(existing, values, { version: existing.version + 1 });
          return existing;
        }
        const row: SourceUsePolicyV1 = {
          id: `sup_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
          brandId: input.brandId,
          destinationKind: input.destinationKind,
          dataType: input.dataType,
          version: 1,
          createdAt: now(),
          ...values,
        };
        b.policies.push(row);
        return row;
      }),
      check: query.input(SourceUseCheck).query(({ input }): SourceUseCheckResult => {
        brandOf(input.brandId);
        const p = policyOf(input.brandId, input.destinationKind, input.dataType);
        if (!p) return { allowed: false, reason: 'no_policy', policy: null };
        if (new Date(p.reviewDueAt).getTime() < Date.now())
          return { allowed: false, reason: 'review_overdue', policy: p };
        if (!p.allowedUses.includes(input.use)) return { allowed: false, reason: 'not_allowed', policy: p };
        return { allowed: true, reason: 'allowed', policy: p };
      }),
    }),
  });
}
