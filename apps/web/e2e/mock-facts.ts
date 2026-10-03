import { randomUUID } from 'node:crypto';
import {
  FACT_EVIDENCE_SOURCE_KINDS,
  FactApprove,
  FactCorrect,
  FactList,
  FactMarkReviewed,
  FactMerge,
  FactPropose,
  FactResolveConflict,
  FactRevoke,
  FactUpdate,
  FactWithdraw,
  factKindOf,
  type FactCategory,
  type FactConflict,
  type FactKind,
  type FactOrigin,
  type FactSource,
  type FactState,
} from '@oremedia/contracts/brand';
import {
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { MembershipRole } from '@oremedia/contracts/tenancy';
import type { MockBuilders, t } from './mock-api';

/**
 * BSC-3 facts slice of the UI-only transport (see mock-api.ts): brand.facts.* with the same paths, DTO shape and
 * error envelope as apps/api (packages/modules/brand facts). `seed()` adds, relative to "now", with one fact in every state
 * the workspace shows (in effect, expiring, review due, an unsourced AI suggestion, a conflict, possible
 * duplicates, superseded). A test double, never a second implementation.
 */
export const PF = {
  website: 'fact_website',
  offer: 'fact_offer',
  reviewDue: 'fact_review_due',
  suggestion: 'fact_suggestion',
  conflicting: 'fact_conflicting',
  dupA: 'fact_dup_a',
  dupB: 'fact_dup_b',
  superseded: 'fact_superseded',
  userId: 'usr_e2e',
  userName: 'E2E Owner',
} as const;

/** Spec 5.5 default grants of brand.edit_standards (the decisions are a person's). */
const DECIDERS: ReadonlySet<MembershipRole> = new Set(['owner', 'admin', 'brand_manager']);
const DAY = 86_400_000;
const LIVE: ReadonlySet<FactState> = new Set(['proposed', 'approved']);

export interface MockFact {
  id: string;
  brandId: string;
  kind: FactKind;
  category: FactCategory;
  scope: string | null;
  origin: FactOrigin;
  statement: string;
  sources: FactSource[];
  validFrom: string | null;
  validUntil: string | null;
  state: FactState;
  proposedByKind: 'user' | 'agent';
  proposedById: string;
  approvedByUserId: string | null;
  revokedByUserId: string | null;
  revokeReason: string | null;
  reviewDueAt: string | null;
  reviewedAt: string | null;
  reviewedByUserId: string | null;
  supersededByFactId: string | null;
  supersedesFactId: string | null;
  conflicts: FactConflict[];
  createdAt: string;
  updatedAt: string;
  version: number;
}

const normalise = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const words = (s: string) => new Set(normalise(s).split(' ').filter(Boolean));
const similar = (a: string, b: string) => {
  const wa = words(a);
  const wb = words(b);
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / Math.max(1, wa.size + wb.size - shared);
};

export class FactsBackend {
  readonly facts: MockFact[] = [];

  constructor(
    readonly brandId: string,
    private readonly role: () => MembershipRole,
  ) {}

  /**
   * The workspace fixtures (facts.e2e.test.ts). Not seeded by default, so the other suites keep a brand without
   * facts (Needs you and the navigation counts stay as they expect).
   */
  seed(): void {
    const brandId = this.brandId;
    const now = Date.now();
    const iso = (offsetDays: number) => new Date(now + offsetDays * DAY).toISOString();
    const base = (
      id: string,
      statement: string,
      category: FactCategory,
      over: Partial<MockFact> = {},
    ): MockFact => ({
      id,
      brandId,
      kind: factKindOf(category),
      category,
      scope: null,
      origin: 'user',
      statement,
      sources: [],
      validFrom: null,
      validUntil: null,
      state: 'approved',
      proposedByKind: 'user',
      proposedById: PF.userId,
      approvedByUserId: PF.userId,
      revokedByUserId: null,
      revokeReason: null,
      reviewDueAt: iso(200),
      reviewedAt: iso(-30),
      reviewedByUserId: PF.userId,
      supersededByFactId: null,
      supersedesFactId: null,
      conflicts: [],
      createdAt: iso(-30),
      updatedAt: iso(-30),
      version: 1,
      ...over,
    });
    this.facts.push(
      base(PF.website, 'Founded in Harare in 1998', 'company', {
        origin: 'extracted',
        sources: [
          {
            kind: 'url',
            ref: 'https://example.test/about',
            title: 'About us',
            excerpt: 'We opened our first studio in Harare in 1998.',
          },
        ],
      }),
      base(PF.offer, 'Winter sale: 20% off all prints', 'offer', {
        sources: [{ kind: 'asset', ref: 'ast_e2e', title: 'Winter sale poster' }],
        validUntil: iso(10),
      }),
      base(PF.reviewDue, 'Our studio is open seven days a week', 'location', {
        sources: [{ kind: 'other', ref: 'Confirmed by the studio manager' }],
        reviewDueAt: iso(-2),
      }),
      base(PF.suggestion, 'Customers love our fast turnaround', 'differentiator', {
        origin: 'suggested',
        state: 'proposed',
        proposedByKind: 'agent',
        proposedById: 'sp_e2e',
        approvedByUserId: null,
        reviewDueAt: null,
        reviewedAt: null,
        reviewedByUserId: null,
        version: 0,
      }),
      base(PF.conflicting, 'Head office is in Bulawayo', 'location', {
        state: 'proposed',
        approvedByUserId: null,
        reviewedAt: null,
        reviewedByUserId: null,
        reviewDueAt: null,
        sources: [{ kind: 'url', ref: 'https://example.test/contact' }],
        conflicts: [
          {
            id: 'c1',
            factId: PF.website,
            note: 'The about page names Harare',
            raisedAt: iso(-1),
            status: 'open',
          },
        ],
        version: 0,
      }),
      base(PF.dupA, 'Free delivery on orders over $50', 'offer', {
        sources: [{ kind: 'url', ref: 'https://example.test/delivery' }],
      }),
      base(PF.dupB, 'Free delivery on all orders over $50', 'offer', {
        state: 'proposed',
        approvedByUserId: null,
        reviewedAt: null,
        reviewedByUserId: null,
        reviewDueAt: null,
        version: 0,
      }),
      base(PF.superseded, 'Founded in 1999', 'company', {
        state: 'superseded',
        supersededByFactId: PF.website,
        version: 2,
      }),
    );
  }

  get(brandId: string, id: string): MockFact {
    if (brandId !== this.brandId) throw new NotFoundError('Brand', brandId);
    const f = this.facts.find((x) => x.id === id);
    if (!f) throw new NotFoundError('ApprovedFact', id);
    return f;
  }

  assertDecider(): void {
    if (!DECIDERS.has(this.role())) throw new PolicyDeniedError('role_missing');
  }

  write(f: MockFact, expectedVersion: number, patch: Partial<MockFact>): void {
    if (f.version !== expectedVersion) throw new ConflictError('ApprovedFact', f.id, expectedVersion);
    Object.assign(f, patch, { version: f.version + 1, updatedAt: new Date().toISOString() });
  }

  supersede(f: MockFact, by: string): void {
    if (!LIVE.has(f.state)) throw new ValidationFailedError([{ path: 'factId', issue: 'not_live' }]);
    Object.assign(f, { state: 'superseded', supersededByFactId: by, version: f.version + 1 });
  }

  dto(f: MockFact) {
    const now = Date.now();
    const live = this.facts.filter((x) => LIVE.has(x.state) && x.id !== f.id);
    const effective =
      f.state === 'approved' &&
      (!f.validFrom || new Date(f.validFrom).getTime() <= now) &&
      (!f.validUntil || new Date(f.validUntil).getTime() > now);
    const name = (id: string | null) => (id === PF.userId ? PF.userName : null);
    return {
      ...f,
      evidence: f.sources.map(({ title: _t, excerpt: _e, ...ref }) => ref),
      proposedByName: f.proposedByKind === 'user' ? name(f.proposedById) : null,
      approvedByName: name(f.approvedByUserId),
      revokedByName: name(f.revokedByUserId),
      reviewedByName: name(f.reviewedByUserId),
      conflicts: f.conflicts.map((c) => ({
        ...c,
        factStatement: c.factId ? (this.facts.find((x) => x.id === c.factId)?.statement ?? null) : null,
      })),
      possibleDuplicates: LIVE.has(f.state)
        ? live
            .filter((x) => similar(x.statement, f.statement) >= 0.75 && x.supersedesFactId !== f.id)
            .map((x) => ({ id: x.id, statement: x.statement }))
        : [],
      effective,
      expired: f.validUntil !== null && new Date(f.validUntil).getTime() <= now,
      reviewDue: f.state === 'approved' && f.reviewDueAt !== null && new Date(f.reviewDueAt).getTime() <= now,
    };
  }
}

export interface FactsBuilders {
  router: typeof t.router;
  query: MockBuilders['query'];
  mutation: MockBuilders['mutation'];
}

export function factsRouter(b: FactsBackend, { router, query, mutation }: FactsBuilders) {
  const now = () => new Date().toISOString();
  const reviewer = (note: string | undefined): FactSource[] =>
    note ? [{ kind: 'reviewer', ref: PF.userId, note, capturedAt: now() }] : [];
  return router({
    list: query.input(FactList).query(({ input }) => {
      if (input.brandId !== b.brandId) throw new NotFoundError('Brand', input.brandId);
      const t0 = Date.now();
      const ms = (v: string | null) => (v ? new Date(v).getTime() : null);
      const search = input.search ? normalise(input.search) : null;
      const items = b.facts
        .map((f) => b.dto(f))
        .filter(
          (f) =>
            (!input.state || f.state === input.state) &&
            (!input.category || f.category === input.category) &&
            (!input.origin || f.origin === input.origin) &&
            (!input.effective || f.effective) &&
            (!input.reviewDue || f.reviewDue) &&
            (!input.expiringWithinDays ||
              (f.state === 'approved' &&
                (ms(f.validUntil) ?? 0) > t0 &&
                (ms(f.validUntil) ?? 0) <= t0 + input.expiringWithinDays * DAY)) &&
            (!input.hasConflicts || f.conflicts.some((c) => c.status === 'open')) &&
            (!input.possibleDuplicates || f.possibleDuplicates.length > 0) &&
            (!input.ids || input.ids.includes(f.id)) &&
            (!search || normalise(`${f.statement} ${f.scope ?? ''}`).includes(search)),
        )
        .sort((x, y) => (x.id < y.id ? 1 : -1));
      return { items, nextCursor: null };
    }),
    propose: mutation.input(FactPropose).mutation(({ input }) => {
      if (input.brandId !== b.brandId) throw new NotFoundError('Brand', input.brandId);
      const existing = b.facts.find(
        (f) => LIVE.has(f.state) && normalise(f.statement) === normalise(input.statement),
      );
      if (existing) return { factId: existing.id, version: existing.version, duplicate: true };
      const category = input.category ?? input.kind ?? 'claim';
      const id = `fact_${randomUUID().slice(0, 8)}`;
      b.facts.push({
        id,
        brandId: b.brandId,
        kind: factKindOf(category),
        category,
        scope: input.scope ?? null,
        origin: input.origin ?? 'user',
        statement: input.statement,
        sources: input.sources ?? input.evidence ?? [],
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
        state: 'proposed',
        proposedByKind: 'user',
        proposedById: PF.userId,
        approvedByUserId: null,
        revokedByUserId: null,
        revokeReason: null,
        reviewDueAt: input.reviewDueAt ?? null,
        reviewedAt: null,
        reviewedByUserId: null,
        supersededByFactId: null,
        supersedesFactId: null,
        conflicts: [],
        createdAt: now(),
        updatedAt: now(),
        version: 0,
      });
      return { factId: id, version: 0, duplicate: false };
    }),
    update: mutation.input(FactUpdate).mutation(({ input }) => {
      const f = b.get(input.brandId, input.factId);
      if (f.state !== 'proposed')
        throw new ValidationFailedError([{ path: 'factId', issue: 'not_proposed' }]);
      b.write(f, input.expectedVersion, {
        ...(input.statement ? { statement: input.statement } : {}),
        ...(input.category ? { category: input.category, kind: factKindOf(input.category) } : {}),
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
        ...(input.sources ? { sources: input.sources } : {}),
        ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
        ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
        ...(input.reviewDueAt !== undefined ? { reviewDueAt: input.reviewDueAt } : {}),
      });
      return { factId: f.id, version: f.version };
    }),
    approve: mutation.input(FactApprove).mutation(({ input }) => {
      b.assertDecider();
      const f = b.get(input.brandId, input.factId);
      if (f.state !== 'proposed')
        throw new ValidationFailedError([{ path: 'factId', issue: 'illegal_transition' }]);
      const sourced = f.sources.some((s) => FACT_EVIDENCE_SOURCE_KINDS.includes(s.kind));
      if ((f.origin === 'suggested' || f.origin === 'inferred') && !sourced && !input.reviewerNote)
        throw new ValidationFailedError(
          [{ path: 'reviewerNote', issue: 'reviewer_note_required' }],
          'This fact has no source: say why it holds before approving it',
        );
      b.write(f, input.expectedVersion, {
        state: 'approved',
        approvedByUserId: PF.userId,
        reviewedAt: now(),
        reviewedByUserId: PF.userId,
        reviewDueAt: input.reviewDueAt ?? f.reviewDueAt ?? new Date(Date.now() + 365 * DAY).toISOString(),
        sources: [...f.sources, ...reviewer(input.reviewerNote)],
      });
      const superseded: string[] = [];
      const corrected = f.supersedesFactId ? b.facts.find((x) => x.id === f.supersedesFactId) : undefined;
      if (corrected && LIVE.has(corrected.state)) {
        b.supersede(corrected, f.id);
        superseded.push(corrected.id);
      }
      return { factId: f.id, state: f.state, version: f.version, supersededFactIds: superseded };
    }),
    revoke: mutation.input(FactRevoke).mutation(({ input }) => {
      b.assertDecider();
      const f = b.get(input.brandId, input.factId);
      if (!LIVE.has(f.state))
        throw new ValidationFailedError([{ path: 'factId', issue: 'illegal_transition' }]);
      b.write(f, input.expectedVersion, {
        state: 'revoked',
        revokedByUserId: PF.userId,
        revokeReason: input.reason ?? null,
      });
      return { factId: f.id, state: f.state, version: f.version };
    }),
    withdraw: mutation.input(FactWithdraw).mutation(({ input }) => {
      b.assertDecider();
      const f = b.get(input.brandId, input.factId);
      if (!LIVE.has(f.state))
        throw new ValidationFailedError([{ path: 'factId', issue: 'illegal_transition' }]);
      b.write(f, input.expectedVersion, {
        state: 'revoked',
        revokedByUserId: PF.userId,
        revokeReason: input.reason,
      });
      return { factId: f.id, state: f.state, version: f.version };
    }),
    correct: mutation.input(FactCorrect).mutation(({ input }) => {
      const f = b.get(input.brandId, input.factId);
      if (f.state !== 'approved')
        throw new ValidationFailedError([{ path: 'factId', issue: 'not_approved' }]);
      if (f.version !== input.expectedVersion)
        throw new ConflictError('ApprovedFact', f.id, input.expectedVersion);
      if (b.facts.some((x) => x.supersedesFactId === f.id && x.state === 'proposed'))
        throw new ValidationFailedError(
          [{ path: 'factId', issue: 'correction_pending' }],
          'A correction of this fact is already waiting for approval',
        );
      const id = `fact_${randomUUID().slice(0, 8)}`;
      const category = input.category ?? f.category;
      b.facts.push({
        ...f,
        id,
        category,
        kind: factKindOf(category),
        statement: input.statement,
        scope: input.scope === undefined ? f.scope : input.scope,
        sources: input.sources ?? f.sources.filter((s) => s.kind !== 'reviewer'),
        validFrom: input.validFrom === undefined ? f.validFrom : input.validFrom,
        validUntil: input.validUntil === undefined ? f.validUntil : input.validUntil,
        reviewDueAt: input.reviewDueAt ?? null,
        state: 'proposed',
        origin: 'user',
        approvedByUserId: null,
        reviewedAt: null,
        reviewedByUserId: null,
        supersedesFactId: f.id,
        conflicts: [],
        createdAt: now(),
        updatedAt: now(),
        version: 0,
      });
      return { factId: id, version: 0, supersedesFactId: f.id };
    }),
    merge: mutation.input(FactMerge).mutation(({ input }) => {
      b.assertDecider();
      const keep = b.get(input.brandId, input.keep.factId);
      const others = input.merge.map((m) => ({
        fact: b.get(input.brandId, m.factId),
        expected: m.expectedVersion,
      }));
      for (const { fact, expected } of [{ fact: keep, expected: input.keep.expectedVersion }, ...others]) {
        if (!LIVE.has(fact.state)) throw new ValidationFailedError([{ path: 'merge', issue: 'not_live' }]);
        if (fact.version !== expected) throw new ConflictError('ApprovedFact', fact.id, expected);
      }
      const seen = new Set<string>();
      const sources = [keep, ...others.map((o) => o.fact)]
        .flatMap((f) => f.sources)
        .filter((s) => {
          const key = `${s.kind}|${s.ref}|${s.note ?? ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      b.write(keep, input.keep.expectedVersion, { sources });
      for (const { fact } of others) b.supersede(fact, keep.id);
      return { factId: keep.id, version: keep.version, supersededFactIds: others.map((o) => o.fact.id) };
    }),
    markReviewed: mutation.input(FactMarkReviewed).mutation(({ input }) => {
      b.assertDecider();
      const f = b.get(input.brandId, input.factId);
      if (f.state !== 'approved')
        throw new ValidationFailedError([{ path: 'factId', issue: 'not_approved' }]);
      const next = input.nextReviewDueAt ?? new Date(Date.now() + 365 * DAY).toISOString();
      b.write(f, input.expectedVersion, {
        reviewedAt: now(),
        reviewedByUserId: PF.userId,
        reviewDueAt: next,
        sources: [...f.sources, ...reviewer(input.note)],
      });
      return { factId: f.id, version: f.version, reviewDueAt: next };
    }),
    resolveConflict: mutation.input(FactResolveConflict).mutation(({ input }) => {
      b.assertDecider();
      const f = b.get(input.brandId, input.factId);
      const c = f.conflicts.find((x) => x.id === input.conflictId);
      if (!c) throw new ValidationFailedError([{ path: 'conflictId', issue: 'unknown_conflict' }]);
      if (c.status === 'resolved')
        throw new ValidationFailedError([{ path: 'conflictId', issue: 'already_resolved' }]);
      if (input.outcome === 'annotated' && !input.note)
        throw new ValidationFailedError([{ path: 'note', issue: 'required' }], 'Say why both stand');
      const other = c.factId ? b.facts.find((x) => x.id === c.factId && LIVE.has(x.state)) : undefined;
      if (input.outcome === 'kept_other' && !other)
        throw new ValidationFailedError([{ path: 'outcome', issue: 'no_live_conflicting_fact' }]);
      b.write(f, input.expectedVersion, {
        conflicts: f.conflicts.map((x) =>
          x.id === c.id
            ? {
                ...x,
                status: 'resolved' as const,
                resolution: {
                  outcome: input.outcome,
                  ...(input.note ? { note: input.note } : {}),
                  byUserId: PF.userId,
                  at: now(),
                },
              }
            : x,
        ),
      });
      if (input.outcome === 'kept_other' && other) b.supersede(f, other.id);
      if (input.outcome === 'kept_this' && other) b.supersede(other, f.id);
      return { factId: f.id, state: f.state, version: f.version };
    }),
  });
}
