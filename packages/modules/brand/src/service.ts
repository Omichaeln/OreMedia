import type { z } from 'zod';
import {
  BrandCreate,
  BrandSnapshotResolve,
  BrandSystemDocumentV1,
  BrandVersionCreateDraft,
  BrandVersionGet,
  BrandVersionList,
  BrandVersionPublish,
  BrandVersionSubmit,
  BrandVersionUpdate,
  BrandGuidelinesImport,
  DesignTokenSetV1,
  EvidenceRef,
  FactApprove,
  FactList,
  FactPropose,
  FactRevoke,
  ObjectiveList,
  ObjectiveSet,
  OnboardingStart,
  PolicyDocumentV1,
  PolicyGet,
  PolicyVersionActivate,
  PolicyVersionCreate,
  defaultPolicyDocument,
  emptyBrandSystemDocument,
  type BrandSnapshot,
} from '@oremedia/contracts/brand';
import type { AssetKind } from '@oremedia/contracts/assets';
import {
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
  type ErrorDetail,
} from '@oremedia/contracts/errors';
import type { Decision, ResolvedActor } from '@oremedia/contracts/policy';
import { requireTenant, runAsPlatform, type Tx } from '@oremedia/db';
import { buildBrandSnapshot } from '@oremedia/domain/brand-snapshot';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import { approvedFactMachine } from '@oremedia/domain/state-machines/approved-fact';
import { brandVersionMachine } from '@oremedia/domain/state-machines/brand-version';
import { IllegalTransitionError, type StateMachine } from '@oremedia/domain/state-machines/machine';
import { policyVersionMachine } from '@oremedia/domain/state-machines/policy-version';
import { policy } from '@oremedia/module-access';
import { entitlements } from '@oremedia/module-billing';
import { audit, outbox } from '@oremedia/module-operations';
import {
  ApprovedFactRepository,
  BrandObjectiveRepository,
  BrandRepository,
  BrandVersionRepository,
  BrandGuidelineAuthorRepository,
  DesignTokenRepository,
  PlatformBrandRepository,
  PolicyVersionRepository,
} from './repositories';
import { extractPalette, parseGuidelinesPackage } from './guidelines';

const brandsRepo = new BrandRepository();
const platformBrandsRepo = new PlatformBrandRepository();
const versionsRepo = new BrandVersionRepository();
const guidelineAuthorsRepo = new BrandGuidelineAuthorRepository();
const tokensRepo = new DesignTokenRepository();
const factsRepo = new ApprovedFactRepository();
const objectivesRepo = new BrandObjectiveRepository();
const policiesRepo = new PolicyVersionRepository();

type BrandRow = Awaited<ReturnType<typeof brandsRepo.getById>>;

// ---- cross-module hooks (spec 4.2: the brand module never imports another module's tables or services) ----

/**
 * Spec 8.3 eligible template versions: templates are creative rows, so the creative module registers the source
 * (the composition root wires `creativeService.templates.eligibleVersionIds`). Until then a snapshot lists none.
 */
export type EligibleTemplateSource = (brandId: string, tx?: Tx) => Promise<string[]>;
const noEligibleTemplates: EligibleTemplateSource = async () => [];
let eligibleTemplateSource: EligibleTemplateSource = noEligibleTemplates;
export const registerEligibleTemplateSource = (fn: EligibleTemplateSource): void => {
  eligibleTemplateSource = fn;
};
export const resetEligibleTemplateSource = (): void => {
  eligibleTemplateSource = noEligibleTemplates;
};

/**
 * The kind of each listed asset that belongs to the brand (assets are the assets module's rows, so it registers
 * the source; composition wires `assetService.kindsForBrand`). Ids that are missing, foreign or of another brand
 * are absent from the map. Until registered every reference is absent, so a draft naming assets is refused.
 */
export type BrandAssetKindSource = (
  brandId: string,
  assetIds: string[],
  tx?: Tx,
) => Promise<Map<string, AssetKind>>;
const noBrandAssets: BrandAssetKindSource = async () => new Map();
let brandAssetKindSource: BrandAssetKindSource = noBrandAssets;
export const registerBrandAssetKindSource = (fn: BrandAssetKindSource): void => {
  brandAssetKindSource = fn;
};
export const resetBrandAssetKindSource = (): void => {
  brandAssetKindSource = noBrandAssets;
};

const HEX_COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * A draft's references must hold together before it is saved: colours are hex with unique keys, a logo rule names a
 * logo of this brand and colour keys the palette defines, and pattern examples are assets of this brand. Every
 * problem is reported at once.
 */
async function assertDocumentReferences(
  brandId: string,
  document: BrandSystemDocumentV1,
  tx: Tx,
): Promise<void> {
  const issues: ErrorDetail[] = [];
  const keys = new Set<string>();
  document.tokens.colours.forEach((c, i) => {
    if (!HEX_COLOUR.test(c.value))
      issues.push({ path: `tokens.colours.${i}.value`, issue: 'not_a_hex_colour' });
    if (!c.key.trim()) issues.push({ path: `tokens.colours.${i}.key`, issue: 'empty' });
    if (keys.has(c.key)) issues.push({ path: `tokens.colours.${i}.key`, issue: 'duplicate_key' });
    keys.add(c.key);
  });
  const logoIds = document.logoRules.map((r) => r.assetId);
  const exampleIds = document.patterns.flatMap((p) => p.exampleAssetIds);
  const ids = [...new Set([...logoIds, ...exampleIds])];
  const kinds = ids.length ? await brandAssetKindSource(brandId, ids, tx) : new Map<string, AssetKind>();
  document.logoRules.forEach((r, i) => {
    if (kinds.get(r.assetId) !== 'logo')
      issues.push({ path: `logoRules.${i}.assetId`, issue: 'not_a_logo_of_this_brand' });
    r.allowedBackgroundColourKeys.forEach((k, j) => {
      if (!keys.has(k))
        issues.push({ path: `logoRules.${i}.allowedBackgroundColourKeys.${j}`, issue: 'unknown_colour_key' });
    });
  });
  document.patterns.forEach((p, i) =>
    p.exampleAssetIds.forEach((id, j) => {
      if (!kinds.has(id))
        issues.push({ path: `patterns.${i}.exampleAssetIds.${j}`, issue: 'not_an_asset_of_this_brand' });
    }),
  );
  if (issues.length) throw new ValidationFailedError(issues, 'The brand system draft has invalid references');
}

/** The guidelines' identity for change detection: absent guidelines are ''. */
const guidelinesKey = (d: BrandSystemDocumentV1): string => (d.guidelines ? hashCanonical(d.guidelines) : '');

async function recordGuidelineAuthor(
  actor: ResolvedActor,
  brandId: string,
  versionId: string,
  packageHash: string | null,
  tx: Tx,
): Promise<void> {
  if (actor.kind !== 'user' && actor.kind !== 'service_principal')
    throw new PolicyDeniedError(
      'actor_kind_not_allowed',
      'Only people and agents may change brand guidelines',
    );
  await guidelineAuthorsRepo.record(
    { id: versionId, brandId, authorKind: actor.kind, authorId: actor.id, packageHash },
    tx,
  );
}

/**
 * Separation of duties for guidelines (the owner's decision, 25 September 2026): a version whose guidelines differ
 * from the published ones, other than by removing them, is published only by someone other than whoever last
 * imported or edited them, because agents follow that text. Unknown authorship is refused (fail closed).
 */
async function assertGuidelinesApprover(
  actor: ResolvedActor,
  versionId: string,
  document: BrandSystemDocumentV1,
  published: BrandSystemDocumentV1 | null,
  tx: Tx,
): Promise<void> {
  if (!document.guidelines) return;
  if (published && guidelinesKey(published) === guidelinesKey(document)) return;
  const author = await guidelineAuthorsRepo.findById(versionId, tx);
  if (!author)
    throw new PolicyDeniedError(
      'distinct_approver_required',
      'These guidelines have no recorded author; re-import them so a second person can approve',
    );
  if (author.authorKind === actor.kind && author.authorId === actor.id)
    throw new PolicyDeniedError(
      'distinct_approver_required',
      'New brand guidelines must be published by someone other than the person who imported or last edited them',
    );
}

/** Adds the colours read from guidelines that the palette does not already hold (by value); keys stay unique. */
function mergePalette(
  palette: BrandSystemDocumentV1['tokens']['colours'],
  extracted: BrandSystemDocumentV1['tokens']['colours'],
): BrandSystemDocumentV1['tokens']['colours'] {
  const values = new Set(palette.map((c) => c.value.toUpperCase()));
  const keys = new Set(palette.map((c) => c.key));
  const added = [];
  for (const c of extracted) {
    if (values.has(c.value.toUpperCase())) continue;
    let key = c.key;
    for (let n = 2; keys.has(key); n++) key = `${c.key}-${n}`;
    keys.add(key);
    values.add(c.value.toUpperCase());
    added.push({ ...c, key });
  }
  return [...palette, ...added];
}

const actorRef = (actor: ResolvedActor) => ({ kind: actor.kind, id: actor.id });
const brandResource = (b: BrandRow) => ({ type: 'brand', tenantId: b.tenantId, brandId: b.id, id: b.id });

/**
 * Spec 5.5: agents hold brand.edit_standards / brand.publish_version with the propose_only obligation. They may
 * draft and propose; approving a fact, publishing a version or activating a policy is a person's decision.
 */
function assertMayDecide(decision: Decision): void {
  if (decision.obligations?.some((o) => o.type === 'propose_only'))
    throw new PolicyDeniedError('propose_only', 'Agents may only propose; a brand manager must decide');
}

/** Spec 13.1: state is written only by transition(); an illegal move is rejected as a validation failure. */
function transition<S extends string, E extends string>(
  machine: StateMachine<S, E>,
  from: S,
  event: E,
  path: string,
): S {
  try {
    return machine.transition(from, event);
  } catch (err) {
    if (err instanceof IllegalTransitionError)
      throw new ValidationFailedError(
        [{ path, issue: err.message }],
        'This change is not allowed in the current state',
      );
    throw err;
  }
}

/** Brand-owned rows are loaded through the scoped repository and bound to the brand in the input: a foreign or mismatched id is NOT_FOUND. */
async function loadVersion(brandId: string, versionId: string, tx?: Tx) {
  const v = await versionsRepo.getById(versionId, tx);
  if (v.brandId !== brandId) throw new NotFoundError('BrandVersion', versionId);
  return v;
}
async function loadFact(brandId: string, factId: string, tx?: Tx) {
  const f = await factsRepo.getById(factId, tx);
  if (f.brandId !== brandId) throw new NotFoundError('ApprovedFact', factId);
  return f;
}
async function loadPolicyVersion(brandId: string, policyVersionId: string, tx?: Tx) {
  const p = await policiesRepo.getById(policyVersionId, tx);
  if (p.brandId !== brandId) throw new NotFoundError('PolicyVersion', policyVersionId);
  return p;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** JSON documents are validated on read as well as on write (spec 6.1). */
const toVersionDto = (v: Awaited<ReturnType<typeof loadVersion>>) => ({
  id: v.id,
  brandId: v.brandId,
  number: v.number,
  state: v.state,
  document: BrandSystemDocumentV1.parse(v.document),
  contentHash: v.contentHash,
  publishedAt: iso(v.publishedAt),
  publishedByUserId: v.publishedByUserId,
  createdAt: v.createdAt.toISOString(),
  updatedAt: v.updatedAt.toISOString(),
  version: v.version,
});
const toVersionSummary = (v: Awaited<ReturnType<typeof loadVersion>>) => {
  const { document: _document, ...summary } = toVersionDto(v);
  return summary;
};
const toFactDto = (f: Awaited<ReturnType<typeof loadFact>>) => ({
  id: f.id,
  brandId: f.brandId,
  kind: f.kind,
  statement: f.statement,
  evidence: EvidenceRef.array().parse(f.evidence),
  validFrom: iso(f.validFrom),
  validUntil: iso(f.validUntil),
  state: f.state,
  proposedByKind: f.proposedByKind,
  proposedById: f.proposedById,
  approvedByUserId: f.approvedByUserId,
  revokedByUserId: f.revokedByUserId,
  createdAt: f.createdAt.toISOString(),
  updatedAt: f.updatedAt.toISOString(),
  version: f.version,
});
const toObjectiveDto = (o: Awaited<ReturnType<typeof objectivesRepo.getById>>) => ({
  id: o.id,
  brandId: o.brandId,
  name: o.name,
  primaryMetricKey: o.primaryMetricKey,
  guardrailMetricKeys: o.guardrailMetricKeys,
  engagementQualityWeights: o.engagementQualityWeights ?? null,
  activeFrom: o.activeFrom.toISOString(),
  activeUntil: iso(o.activeUntil),
  createdAt: o.createdAt.toISOString(),
  version: o.version,
});
const toPolicyDto = (p: Awaited<ReturnType<typeof loadPolicyVersion>>) => ({
  id: p.id,
  brandId: p.brandId,
  number: p.number,
  state: p.state,
  document: PolicyDocumentV1.parse(p.document),
  createdByUserId: p.createdByUserId,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
  version: p.version,
});

/** Spec 6.3 design_tokens: the token set of a published version, derived from document.tokens. */
const tokenSetFrom = (d: BrandSystemDocumentV1): DesignTokenSetV1 =>
  DesignTokenSetV1.parse({
    schemaVersion: 1,
    colour: Object.fromEntries(d.tokens.colours.map((c) => [c.key, c.value])),
    typeRoles: Object.fromEntries(
      d.tokens.typeRoles.map((t) => [
        t.role,
        { fontAssetId: t.fontAssetId, weight: t.weight, minSizePx: t.minSizePx },
      ]),
    ),
    spacing: d.tokens.spacingScale,
    radius: d.tokens.radii,
  });

export const brandService = {
  async create(actor: ResolvedActor, input: z.infer<typeof BrandCreate>, tx: Tx) {
    const parsed = BrandCreate.parse(input);
    const { tenantId } = requireTenant();
    await policy.assert(actor, 'brand.edit_standards', { type: 'tenant', tenantId, id: tenantId }, {}, tx);
    await entitlements.assert(tenantId, 'brands', tx);
    const id = newId('brand');
    await brandsRepo.create(
      {
        id,
        name: parsed.name,
        timezone: parsed.timezone,
        defaultLocale: parsed.defaultLocale,
        status: 'setup',
      },
      tx,
    );
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'brand.create',
      { type: 'brand', id },
      'allowed',
      tx,
      { brandId: id },
    );
    return { brandId: id };
  },

  async list(actor: ResolvedActor, tx?: Tx) {
    const rows = await brandsRepo.listVisible(tx);
    return rows.map((b) => ({
      id: b.id,
      name: b.name,
      timezone: b.timezone,
      defaultLocale: b.defaultLocale,
      status: b.status,
      publishedVersionId: b.publishedVersionId,
      version: b.version,
    }));
  },

  /** Any brand id from a client is loaded through the scoped repository first; a foreign id is NOT_FOUND. */
  async get(actor: ResolvedActor, brandId: string, tx?: Tx) {
    const b = await brandsRepo.getById(brandId, tx);
    await policy.assert(actor, 'brand.read', brandResource(b), {}, tx);
    return {
      id: b.id,
      name: b.name,
      timezone: b.timezone,
      defaultLocale: b.defaultLocale,
      status: b.status,
      publishedVersionId: b.publishedVersionId,
      activePolicyVersionId: b.activePolicyVersionId,
      version: b.version,
    };
  },

  /** Spec 8.2 lifecycle: draft → in_review → published → retired; exactly one published version per brand. */
  versions: {
    /** A new draft starts from the published document, or from the empty document when nothing is published yet. */
    async createDraft(actor: ResolvedActor, input: z.infer<typeof BrandVersionCreateDraft>, tx: Tx) {
      const parsed = BrandVersionCreateDraft.parse(input);
      const brand = await brandsRepo.lock(parsed.brandId, tx);
      await policy.assert(actor, 'brand.edit_standards', brandResource(brand), {}, tx);
      const published = await versionsRepo.findPublished(brand.id, tx);
      const document = published
        ? BrandSystemDocumentV1.parse(published.document)
        : emptyBrandSystemDocument();
      const id = newId('brandVersion');
      const number = await versionsRepo.nextNumber(brand.id, tx);
      await versionsRepo.create(
        { id, brandId: brand.id, number, state: 'draft', document, contentHash: hashCanonical(document) },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'brand.version.create_draft',
        { type: 'brand_version', id },
        'allowed',
        tx,
        { brandId: brand.id },
      );
      return { versionId: id, number, version: 0 };
    },

    /** Optimistic concurrency on expectedVersion; the policy denies edits to published or retired versions. */
    async update(actor: ResolvedActor, input: z.infer<typeof BrandVersionUpdate>, tx: Tx) {
      const parsed = BrandVersionUpdate.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      const v = await loadVersion(brand.id, parsed.versionId, tx);
      await policy.assert(
        actor,
        'brand.edit_standards',
        { type: 'brand_version', tenantId: brand.tenantId, brandId: brand.id, id: v.id, state: v.state },
        {},
        tx,
      );
      const document = BrandSystemDocumentV1.parse(parsed.document);
      await assertDocumentReferences(brand.id, document, tx);
      const contentHash = hashCanonical(document);
      await versionsRepo.update(v.id, parsed.expectedVersion, { document, contentHash }, tx);
      if (guidelinesKey(BrandSystemDocumentV1.parse(v.document)) !== guidelinesKey(document))
        await recordGuidelineAuthor(actor, brand.id, v.id, null, tx);
      await audit.record(
        actorRef(actor),
        'brand.version.update',
        { type: 'brand_version', id: v.id },
        'allowed',
        tx,
        { brandId: brand.id, expectedVersion: parsed.expectedVersion },
      );
      return { versionId: v.id, version: parsed.expectedVersion + 1, contentHash };
    },

    async submitForReview(actor: ResolvedActor, input: z.infer<typeof BrandVersionSubmit>, tx: Tx) {
      const parsed = BrandVersionSubmit.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      const v = await loadVersion(brand.id, parsed.versionId, tx);
      await policy.assert(
        actor,
        'brand.edit_standards',
        { type: 'brand_version', tenantId: brand.tenantId, brandId: brand.id, id: v.id, state: v.state },
        {},
        tx,
      );
      const toState = transition(brandVersionMachine, v.state, 'submit', 'versionId');
      await versionsRepo.update(v.id, parsed.expectedVersion, { state: toState }, tx);
      await audit.record(
        actorRef(actor),
        'brand.version.submit_for_review',
        { type: 'brand_version', id: v.id },
        'allowed',
        tx,
        { brandId: brand.id, fromState: v.state, toState },
      );
      return { versionId: v.id, state: toState, version: parsed.expectedVersion + 1 };
    },

    /**
     * Publishing retires the previously published version in the same transaction, points the brand at the new
     * version, writes its design tokens and emits brand.version_published (with the publishing actor, so the
     * consumer re-establishes tenant context as it: spec 5.2). It never mutates approved work: the impact workflow
     * that consumes the event (brandChangeImpactWorkflowV1) invalidates approvals and re-evaluates scheduled
     * publications (spec 8.2).
     */
    async publish(actor: ResolvedActor, input: z.infer<typeof BrandVersionPublish>, tx: Tx) {
      const parsed = BrandVersionPublish.parse(input);
      const brand = await brandsRepo.lock(parsed.brandId, tx);
      const v = await loadVersion(brand.id, parsed.versionId, tx);
      const decision = await policy.assert(
        actor,
        'brand.publish_version',
        { type: 'brand_version', tenantId: brand.tenantId, brandId: brand.id, id: v.id, state: v.state },
        {},
        tx,
      );
      assertMayDecide(decision);
      const toState = transition(brandVersionMachine, v.state, 'publish', 'versionId');
      const document = BrandSystemDocumentV1.parse(v.document);
      const previous = await versionsRepo.findPublished(brand.id, tx);
      await assertGuidelinesApprover(
        actor,
        v.id,
        document,
        previous ? BrandSystemDocumentV1.parse(previous.document) : null,
        tx,
      );
      if (previous && previous.id !== v.id)
        await versionsRepo.update(
          previous.id,
          previous.version,
          { state: transition(brandVersionMachine, previous.state, 'retire', 'versionId') },
          tx,
        );
      await versionsRepo.update(
        v.id,
        parsed.expectedVersion,
        {
          state: toState,
          publishedAt: new Date(),
          publishedByUserId: actor.kind === 'user' ? actor.id : null,
        },
        tx,
      );
      await brandsRepo.update(brand.id, brand.version, { publishedVersionId: v.id }, tx);
      await tokensRepo.create(
        {
          id: newId('designTokenSet'),
          brandId: brand.id,
          brandVersionId: v.id,
          tokenSet: tokenSetFrom(document),
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'brand.version.publish',
        { type: 'brand_version', id: v.id },
        'allowed',
        tx,
        { brandId: brand.id, fromState: v.state, toState },
      );
      await outbox.add(
        'brand.version_published',
        { type: 'brand_version', id: v.id, version: parsed.expectedVersion + 1 },
        {
          brandVersionId: v.id,
          number: v.number,
          contentHash: v.contentHash,
          previousVersionId: previous && previous.id !== v.id ? previous.id : null,
          actorKind: actor.kind,
          actorId: actor.id,
        },
        tx,
        { brandId: brand.id },
      );
      return { versionId: v.id, number: v.number, state: toState, version: parsed.expectedVersion + 1 };
    },

    async list(actor: ResolvedActor, input: z.infer<typeof BrandVersionList>, tx?: Tx) {
      const parsed = BrandVersionList.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      await policy.assert(actor, 'brand.read', brandResource(brand), {}, tx);
      const page = await versionsRepo.list(brand.id, parsed.page, tx);
      return { items: page.items.map(toVersionSummary), nextCursor: page.nextCursor };
    },

    async get(actor: ResolvedActor, input: z.infer<typeof BrandVersionGet>, tx?: Tx) {
      const parsed = BrandVersionGet.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      await policy.assert(actor, 'brand.read', brandResource(brand), {}, tx);
      return toVersionDto(await loadVersion(brand.id, parsed.versionId, tx));
    },
  },

  /** Spec 8.2: facts land as proposed (by a person or an agent); a brand manager approves; revocation is evented. */
  facts: {
    async propose(actor: ResolvedActor, input: z.infer<typeof FactPropose>, tx: Tx) {
      const parsed = FactPropose.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      await policy.assert(actor, 'brand.edit_standards', brandResource(brand), {}, tx);
      const validFrom = parsed.validFrom ? new Date(parsed.validFrom) : null;
      const validUntil = parsed.validUntil ? new Date(parsed.validUntil) : null;
      if (validFrom && validUntil && validUntil.getTime() <= validFrom.getTime())
        throw new ValidationFailedError([{ path: 'validUntil', issue: 'must be after validFrom' }]);
      const id = newId('approvedFact');
      await factsRepo.create(
        {
          id,
          brandId: brand.id,
          kind: parsed.kind,
          statement: parsed.statement,
          evidence: parsed.evidence,
          validFrom,
          validUntil,
          state: 'proposed',
          proposedByKind: actor.kind === 'service_principal' ? 'agent' : 'user',
          proposedById: actor.id,
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'brand.fact.propose',
        { type: 'approved_fact', id },
        'allowed',
        tx,
        { brandId: brand.id },
      );
      return { factId: id, version: 0 };
    },

    async approve(actor: ResolvedActor, input: z.infer<typeof FactApprove>, tx: Tx) {
      const parsed = FactApprove.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      const fact = await loadFact(brand.id, parsed.factId, tx);
      const decision = await policy.assert(
        actor,
        'brand.edit_standards',
        { type: 'approved_fact', tenantId: brand.tenantId, brandId: brand.id, id: fact.id },
        {},
        tx,
      );
      assertMayDecide(decision);
      const toState = transition(approvedFactMachine, fact.state, 'approve', 'factId');
      await factsRepo.update(
        fact.id,
        parsed.expectedVersion,
        { state: toState, approvedByUserId: actor.kind === 'user' ? actor.id : null },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'brand.fact.approve',
        { type: 'approved_fact', id: fact.id },
        'allowed',
        tx,
        { brandId: brand.id, fromState: fact.state, toState },
      );
      return { factId: fact.id, state: toState, version: parsed.expectedVersion + 1 };
    },

    /**
     * Event contract `brand.fact_revoked` (schema 1), aggregate approved_fact: data { factId, kind, previousState,
     * reason, actorKind, actorId }, brandId in the payload. Consumer (brandChangeImpactWorkflowV1, started by the
     * review module's outbox route): for every *scheduled* publication whose content references factId, apply the
     * brand's active policy — holdOnDependencyRevocation true (spec 8.2 default) moves it to `held` with the failed
     * checks as reasons; false only flags it (publication.needs_attention). `previousState` lets the consumer
     * ignore withdrawn proposals, which no content can reference.
     */
    async revoke(actor: ResolvedActor, input: z.infer<typeof FactRevoke>, tx: Tx) {
      const parsed = FactRevoke.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      const fact = await loadFact(brand.id, parsed.factId, tx);
      const decision = await policy.assert(
        actor,
        'brand.edit_standards',
        { type: 'approved_fact', tenantId: brand.tenantId, brandId: brand.id, id: fact.id },
        {},
        tx,
      );
      assertMayDecide(decision);
      const toState = transition(approvedFactMachine, fact.state, 'revoke', 'factId');
      await factsRepo.update(
        fact.id,
        parsed.expectedVersion,
        { state: toState, revokedByUserId: actor.kind === 'user' ? actor.id : null },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'brand.fact.revoke',
        { type: 'approved_fact', id: fact.id },
        'allowed',
        tx,
        { brandId: brand.id, fromState: fact.state, toState, reason: parsed.reason ?? null },
      );
      await outbox.add(
        'brand.fact_revoked',
        { type: 'approved_fact', id: fact.id, version: parsed.expectedVersion + 1 },
        {
          factId: fact.id,
          kind: fact.kind,
          previousState: fact.state,
          reason: parsed.reason ?? null,
          actorKind: actor.kind,
          actorId: actor.id,
        },
        tx,
        { brandId: brand.id },
      );
      return { factId: fact.id, state: toState, version: parsed.expectedVersion + 1 };
    },

    async list(actor: ResolvedActor, input: z.infer<typeof FactList>, tx?: Tx) {
      const parsed = FactList.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      await policy.assert(actor, 'brand.read', brandResource(brand), {}, tx);
      const page = await factsRepo.list(brand.id, parsed.state, parsed.page, tx);
      return { items: page.items.map(toFactDto), nextCursor: page.nextCursor };
    },
  },

  objectives: {
    /** Creates the objective and closes every still-open one at the new activeFrom (one active objective at a time). */
    async set(actor: ResolvedActor, input: z.infer<typeof ObjectiveSet>, tx: Tx) {
      const parsed = ObjectiveSet.parse(input);
      const brand = await brandsRepo.lock(parsed.brandId, tx);
      await policy.assert(actor, 'brand.edit_standards', brandResource(brand), {}, tx);
      const activeFrom = new Date(parsed.activeFrom);
      const activeUntil = parsed.activeUntil ? new Date(parsed.activeUntil) : null;
      if (activeUntil && activeUntil.getTime() <= activeFrom.getTime())
        throw new ValidationFailedError([{ path: 'activeUntil', issue: 'must be after activeFrom' }]);
      const closedObjectiveIds: string[] = [];
      for (const open of await objectivesRepo.listOpenAt(brand.id, activeFrom, tx)) {
        const closeAt = new Date(Math.max(open.activeFrom.getTime(), activeFrom.getTime()));
        await objectivesRepo.update(open.id, open.version, { activeUntil: closeAt }, tx);
        closedObjectiveIds.push(open.id);
      }
      const id = newId('brandObjective');
      await objectivesRepo.create(
        {
          id,
          brandId: brand.id,
          name: parsed.name,
          primaryMetricKey: parsed.primaryMetricKey,
          guardrailMetricKeys: parsed.guardrailMetricKeys,
          engagementQualityWeights: parsed.engagementQualityWeights ?? null,
          activeFrom,
          activeUntil,
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'brand.objective.set',
        { type: 'brand_objective', id },
        'allowed',
        tx,
        { brandId: brand.id, count: closedObjectiveIds.length },
      );
      return { objectiveId: id, closedObjectiveIds, version: 0 };
    },

    async list(actor: ResolvedActor, input: z.infer<typeof ObjectiveList>, tx?: Tx) {
      const parsed = ObjectiveList.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      await policy.assert(actor, 'brand.read', brandResource(brand), {}, tx);
      const page = await objectivesRepo.list(brand.id, parsed.activeOnly, new Date(), parsed.page, tx);
      return { items: page.items.map(toObjectiveDto), nextCursor: page.nextCursor };
    },
  },

  /** Spec 6.3 policy_versions: draft → active → retired; exactly one active per brand. */
  policy: {
    async createVersion(actor: ResolvedActor, input: z.infer<typeof PolicyVersionCreate>, tx: Tx) {
      const parsed = PolicyVersionCreate.parse(input);
      const brand = await brandsRepo.lock(parsed.brandId, tx);
      await policy.assert(actor, 'brand.edit_standards', brandResource(brand), {}, tx);
      if (actor.kind !== 'user')
        throw new PolicyDeniedError('agent_never', 'Only a person can author a release policy');
      const document = PolicyDocumentV1.parse(parsed.document);
      const id = newId('policyVersion');
      const number = await policiesRepo.nextNumber(brand.id, tx);
      await policiesRepo.create(
        { id, brandId: brand.id, number, document, state: 'draft', createdByUserId: actor.id },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'brand.policy.create_version',
        { type: 'policy_version', id },
        'allowed',
        tx,
        { brandId: brand.id },
      );
      return { policyVersionId: id, number, version: 0 };
    },

    /** Activation retires the previously active policy version in the same transaction and points the brand at the new one. */
    async activate(actor: ResolvedActor, input: z.infer<typeof PolicyVersionActivate>, tx: Tx) {
      const parsed = PolicyVersionActivate.parse(input);
      const brand = await brandsRepo.lock(parsed.brandId, tx);
      const pv = await loadPolicyVersion(brand.id, parsed.policyVersionId, tx);
      const decision = await policy.assert(
        actor,
        'brand.publish_version',
        { type: 'policy_version', tenantId: brand.tenantId, brandId: brand.id, id: pv.id, state: pv.state },
        {},
        tx,
      );
      assertMayDecide(decision);
      const toState = transition(policyVersionMachine, pv.state, 'activate', 'policyVersionId');
      const previous = await policiesRepo.findActive(brand.id, tx);
      if (previous && previous.id !== pv.id)
        await policiesRepo.update(
          previous.id,
          previous.version,
          { state: transition(policyVersionMachine, previous.state, 'retire', 'policyVersionId') },
          tx,
        );
      await policiesRepo.update(pv.id, parsed.expectedVersion, { state: toState }, tx);
      await brandsRepo.update(brand.id, brand.version, { activePolicyVersionId: pv.id }, tx);
      await audit.record(
        actorRef(actor),
        'brand.policy.activate',
        { type: 'policy_version', id: pv.id },
        'allowed',
        tx,
        { brandId: brand.id, fromState: pv.state, toState },
      );
      return { policyVersionId: pv.id, state: toState, version: parsed.expectedVersion + 1 };
    },

    /** The active policy version, or a specific one by id. NOT_FOUND when nothing has been activated yet. */
    async get(actor: ResolvedActor, input: z.infer<typeof PolicyGet>, tx?: Tx) {
      const parsed = PolicyGet.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      await policy.assert(actor, 'brand.read', brandResource(brand), {}, tx);
      if (parsed.policyVersionId)
        return toPolicyDto(await loadPolicyVersion(brand.id, parsed.policyVersionId, tx));
      const active = await policiesRepo.findActive(brand.id, tx);
      if (!active) throw new NotFoundError('PolicyVersion', 'active');
      return toPolicyDto(active);
    },
  },

  /**
   * Spec 8.3: the immutable, hashed bundle every agent run and every revision records. Defaults to the published
   * version; `versionId` resolves a specific version (e.g. a draft for preview). Facts and objectives are those
   * effective now, so approving, revoking or expiring a fact changes the hash; approving a template version does too.
   */
  async resolveBrandSnapshot(
    actor: ResolvedActor,
    input: z.infer<typeof BrandSnapshotResolve>,
    tx?: Tx,
  ): Promise<BrandSnapshot> {
    const parsed = BrandSnapshotResolve.parse(input);
    const brand = await brandsRepo.getById(parsed.brandId, tx);
    await policy.assert(actor, 'brand.read', brandResource(brand), {}, tx);
    const version = parsed.versionId
      ? await loadVersion(brand.id, parsed.versionId, tx)
      : await versionsRepo.findPublished(brand.id, tx);
    if (!version) throw new NotFoundError('PublishedBrandVersion', brand.id);
    const now = new Date();
    const facts = await factsRepo.listEffective(brand.id, now, tx);
    const objectives = await objectivesRepo.listActive(brand.id, now, tx);
    const active = await policiesRepo.findActive(brand.id, tx);
    return buildBrandSnapshot({
      brandId: brand.id,
      brandVersionId: version.id,
      brandVersionNumber: version.number,
      document: BrandSystemDocumentV1.parse(version.document),
      facts: facts.map((f) => ({
        id: f.id,
        kind: f.kind,
        statement: f.statement,
        validFrom: iso(f.validFrom),
        validUntil: iso(f.validUntil),
      })),
      objectives: objectives.map((o) => ({
        id: o.id,
        name: o.name,
        primaryMetricKey: o.primaryMetricKey,
        guardrailMetricKeys: o.guardrailMetricKeys,
      })),
      policyVersionId: active?.id ?? null,
      policy: active ? PolicyDocumentV1.parse(active.document) : defaultPolicyDocument(),
      // Approved template versions of the brand, supplied by the creative module through the registered source.
      eligibleTemplateVersionIds: await eligibleTemplateSource(brand.id, tx),
      timezone: brand.timezone,
      defaultLocale: brand.defaultLocale,
    });
  },

  guidelines: {
    /**
     * Imports a brand skill (Agent Skills package) as a new draft version: the draft starts from the published
     * document, carries the package's text as its guidelines, and adds the colours its tables state. People only;
     * the importer cannot publish the draft (assertGuidelinesApprover). Skipped files are reported, never stored.
     */
    async import(actor: ResolvedActor, input: z.infer<typeof BrandGuidelinesImport>, tx: Tx) {
      const parsed = BrandGuidelinesImport.parse(input);
      const brand = await brandsRepo.lock(parsed.brandId, tx);
      const decision = await policy.assert(actor, 'brand.edit_standards', brandResource(brand), {}, tx);
      assertMayDecide(decision);
      const { guidelines, skipped } = parseGuidelinesPackage(parsed.files);
      const extracted = extractPalette(guidelines.documents);
      const published = await versionsRepo.findPublished(brand.id, tx);
      const base = published ? BrandSystemDocumentV1.parse(published.document) : emptyBrandSystemDocument();
      const colours = mergePalette(base.tokens.colours, extracted);
      const document = BrandSystemDocumentV1.parse({
        ...base,
        tokens: { ...base.tokens, colours },
        guidelines,
      });
      const id = newId('brandVersion');
      const number = await versionsRepo.nextNumber(brand.id, tx);
      await versionsRepo.create(
        { id, brandId: brand.id, number, state: 'draft', document, contentHash: hashCanonical(document) },
        tx,
      );
      await recordGuidelineAuthor(actor, brand.id, id, guidelines.source.packageHash, tx);
      await audit.record(
        actorRef(actor),
        'brand.guidelines.import',
        { type: 'brand_version', id },
        'allowed',
        tx,
        { brandId: brand.id, count: guidelines.documents.length },
      );
      return {
        versionId: id,
        number,
        version: 0,
        source: guidelines.source,
        documents: guidelines.documents.map((d) => d.path),
        coloursAdded: colours.length - base.tokens.colours.length,
        skipped,
      };
    },
  },

  /**
   * Spec 8.2: onboarding is an agent skill run that proposes a draft version and proposed facts from guidelines,
   * website captures and logos (Phase 4 agent runtime). Until then this is a deliberate stub: it validates the
   * input and refuses with a clear reason. It never fakes a proposal and never writes.
   */
  async startOnboarding(
    _actor: ResolvedActor,
    input: z.infer<typeof OnboardingStart>,
    _tx: Tx,
  ): Promise<never> {
    OnboardingStart.parse(input);
    throw new PolicyDeniedError(
      'not_available_yet',
      'Brand onboarding runs as an agent skill and is not available yet',
    );
  },

  /**
   * Spec 16.3 / 16.8 sweeps: the active brands of every tenant as references (no content), under a declared
   * platform job. Callers establish each tenant's context before touching anything else.
   */
  listActiveAcrossTenants(job: string, correlationId: string, tx?: Tx) {
    return runAsPlatform(job, correlationId, () => platformBrandsRepo.listActiveRefs(tx));
  },

  /** Validates that every id exists in the current tenant; throws NOT_FOUND for the first that does not. */
  async assertExist(brandIds: string[], tx?: Tx): Promise<void> {
    const missing = await brandsRepo.missing(brandIds, tx);
    if (missing[0]) throw new NotFoundError('Brand', missing[0]);
  },

  async assertValidGrantBrands(brandIds: string[], tx?: Tx): Promise<void> {
    const missing = await brandsRepo.missing(brandIds, tx);
    if (missing.length)
      throw new ValidationFailedError(
        missing.map((m) => ({ path: 'grants.brandIds', issue: `unknown brand ${m}` })),
      );
  },

  count: (tx?: Tx) => brandsRepo.countAll(tx),
};
