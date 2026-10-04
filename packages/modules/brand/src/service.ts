import type { z } from 'zod';
import {
  BrandClassify,
  BrandCompleteSetup,
  BrandCreate,
  BrandSnapshotResolve,
  BrandSystemDocumentV1,
  BrandVersionCreateDraft,
  BrandVersionGet,
  BrandVersionImpact,
  BrandVersionList,
  BrandVersionPublish,
  BrandVersionSubmit,
  BrandVersionUpdate,
  BrandSystemSave,
  BrandProposalDiscard,
  BrandGuidelinesImport,
  BrandVoiceProposal,
  DesignTokenSetV1,
  EvidenceRef,
  FACT_EVIDENCE_SOURCE_KINDS,
  FactApprove,
  FactConflict,
  FactCorrect,
  FactList,
  FactMarkReviewed,
  FactMerge,
  FactPropose,
  FactResolveConflict,
  FactRevoke,
  FactSource,
  FactUpdate,
  FactWithdraw,
  factKindOf,
  type FactCategory,
  type FactConflictInput,
  type FactOrigin,
  type FactState,
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
import type { EvidenceItem } from '@oremedia/contracts/agents';
import type { AssetKind } from '@oremedia/contracts/assets';
import {
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
  type ErrorDetail,
} from '@oremedia/contracts/errors';
import type { Decision, ResolvedActor } from '@oremedia/contracts/policy';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import { requireTenant, runAsPlatform, type Tx } from '@oremedia/db';
import { buildBrandSnapshot } from '@oremedia/domain/brand-snapshot';
import { hashCanonical } from '@oremedia/domain/hash';
import { factDedupeKey, possibleDuplicates } from '@oremedia/domain/facts';
import { newId } from '@oremedia/domain/ids';
import { approvedFactMachine } from '@oremedia/domain/state-machines/approved-fact';
import { brandVersionMachine } from '@oremedia/domain/state-machines/brand-version';
import { IllegalTransitionError, type StateMachine } from '@oremedia/domain/state-machines/machine';
import { policyVersionMachine } from '@oremedia/domain/state-machines/policy-version';
import { accessService, assertTenantCapability, isDemoTenant, policy } from '@oremedia/module-access';
import { budgets, entitlements } from '@oremedia/module-billing';
import { audit, outbox } from '@oremedia/module-operations';
import { providerRegistry } from '@oremedia/providers';
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

/**
 * BSC-1: the channel provider keys guidance may name. Channels are the publishing module's registry (which tests and
 * deployments may replace), so composition wires `providerRegistryInUse().list()`, the registry
 * publishing.channels.limits reads. Until registered, the built-in provider registry answers.
 */
export type ChannelKeySource = () => string[];
const builtinChannelKeys: ChannelKeySource = () => providerRegistry.list().map((p) => p.key);
let channelKeySource: ChannelKeySource = builtinChannelKeys;
export const registerChannelKeySource = (fn: ChannelKeySource): void => {
  channelKeySource = fn;
};
export const resetChannelKeySource = (): void => {
  channelKeySource = builtinChannelKeys;
};
/** The channel keys guidance may name now (BSC-4 suggestions name only these). */
export const knownChannelKeys = (): string[] => channelKeySource();

/**
 * BSC-2: the asset each listed version belongs to, for versions of this brand's live assets (composition wires
 * `assetService.assetsOfVersions`). Versions that are missing, foreign or of another brand are absent. Only a logo rule
 * that pins a version is checked against it; until registered a pinned version is refused, as an asset reference is.
 */
export type BrandAssetVersionSource = (
  brandId: string,
  assetVersionIds: string[],
  tx?: Tx,
) => Promise<Map<string, string>>;
const noBrandVersions: BrandAssetVersionSource = async () => new Map();
let brandAssetVersionSource: BrandAssetVersionSource = noBrandVersions;
export const registerBrandAssetVersionSource = (fn: BrandAssetVersionSource): void => {
  brandAssetVersionSource = fn;
};
export const resetBrandAssetVersionSource = (): void => {
  brandAssetVersionSource = noBrandVersions;
};

/**
 * Spec 8.2 onboarding runs are agent runs, which are the agents module's rows, so it registers the source
 * (composition wires `agentsService.runs.start` / `runs.get`). `get` returns the run's brief as the server wrote it.
 * Unlike the other hooks there is no harmless default (a missing template or asset list is an empty answer; a
 * missing run source is not), so until registered onboarding refuses with not_available_yet and nothing is written.
 */
export interface OnboardingRunSource {
  start(
    actor: ResolvedActor,
    input: { brandId: string; servicePrincipalId: string; brief: Record<string, unknown> },
    tx: Tx,
  ): Promise<{ runId: string; state: string; autonomyMode: string; workflowId: string }>;
  get(
    actor: ResolvedActor,
    runId: string,
    tx: Tx,
  ): Promise<{ brandId: string; taskKind: string; brief: Record<string, unknown> }>;
}
let onboardingRunSource: OnboardingRunSource | null = null;
export const registerOnboardingRunSource = (source: OnboardingRunSource): void => {
  onboardingRunSource = source;
};
export const resetOnboardingRunSource = (): void => {
  onboardingRunSource = null;
};

/**
 * UX-20 (D-13): what publishing a brand version reaches, read before the publish. Requests and approvals are the
 * review module's rows and scheduled publications the publishing module's, so the composition roots register the
 * source (as apps/worker-core composes the same modules for brandChangeImpactWorkflowV1). There is no harmless
 * default: until registered the preview reports `available: false` (the screen refuses to confirm a publish over
 * it) rather than "nothing is affected".
 */
export interface BrandChangeImpactScope {
  /** The reads stop at 200 rows each (as the workflow's do); true when any of them hit that bound. */
  truncated: boolean;
  requests: Array<{ id: string; contentRevisionId: string; dueAt: string | null; assignees: number }>;
  approvals: number;
  publications: Array<{
    publicationId: string;
    contentPackageId: string;
    contentRevisionId: string;
    /** The channel, or null for a publication to a brand destination (R2-3). */
    channelConnectionId: string | null;
    destinationId?: string | null;
    scheduledFor: string;
  }>;
}
export type BrandChangeImpactSource = (brandId: string, tx?: Tx) => Promise<BrandChangeImpactScope>;
let brandChangeImpactSource: BrandChangeImpactSource | null = null;
export const registerBrandChangeImpactSource = (fn: BrandChangeImpactSource): void => {
  brandChangeImpactSource = fn;
};
export const resetBrandChangeImpactSource = (): void => {
  brandChangeImpactSource = null;
};
const onboardingRuns = (): OnboardingRunSource => {
  if (!onboardingRunSource)
    throw new PolicyDeniedError(
      'not_available_yet',
      'Brand onboarding runs are not available in this service',
    );
  return onboardingRunSource;
};

/** The task kind of onboarding runs and the brief keys the brand module writes and later trusts. */
const ONBOARDING_TASK_KIND = 'brand_onboarding';
/** Evidence items are capped at 20000 characters (contracts/agents EvidenceItem.text). */
const EVIDENCE_CHUNK = 20_000;

/**
 * The imported guidelines as untrusted evidence, one item per document, long documents split into chunks. The
 * guidelines are capped at 64 KB and 40 documents, so this always stays under the 50-item brief limit.
 */
export function guidelinesEvidence(document: BrandSystemDocumentV1): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  for (const [i, d] of (document.guidelines?.documents ?? []).entries()) {
    for (let at = 0, part = 0; at < d.content.length; at += EVIDENCE_CHUNK, part++)
      items.push({
        id: `guidelines-${i + 1}-${part + 1}`,
        sourceKind: 'guideline_document',
        ref: `guidelines:${d.path}`,
        text: d.content.slice(at, at + EVIDENCE_CHUNK),
        trust: 'untrusted',
      });
  }
  return items;
}

const HEX_COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * A draft's references must hold together before it is saved: colours are hex with unique keys, a logo rule names a
 * logo of this brand and colour keys the palette defines, pattern examples are assets of this brand, and a type role
 * whose font is new or changed names a font of this brand. Type roles the draft already held are not re-checked, so
 * drafts written before the check (some carry placeholder font ids) still save; rendering authorises every font at
 * the point of effect either way. Every problem is reported at once.
 */
export async function assertDocumentReferences(
  brandId: string,
  document: BrandSystemDocumentV1,
  previous: BrandSystemDocumentV1 | null,
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
  const held = new Map(previous?.tokens.typeRoles.map((r) => [r.role, r.fontAssetId]) ?? []);
  const changedRoles = document.tokens.typeRoles
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => held.get(r.role) !== r.fontAssetId);
  const fontIds = changedRoles.map(({ r }) => r.fontAssetId);
  const ids = [...new Set([...logoIds, ...exampleIds, ...fontIds])];
  const kinds = ids.length ? await brandAssetKindSource(brandId, ids, tx) : new Map<string, AssetKind>();
  const pinned = document.logoRules.flatMap((r) => (r.assetVersionId ? [r.assetVersionId] : []));
  const versionAssets = pinned.length
    ? await brandAssetVersionSource(brandId, [...new Set(pinned)], tx)
    : new Map<string, string>();
  const variants = new Set<string>();
  // A variant named twice is refused only when the save introduces it: stored documents may already hold one.
  const heldTwice = new Set(
    (previous?.logoRules ?? []).map((r) => r.variant).filter((v, i, all) => all.indexOf(v) !== i),
  );
  document.logoRules.forEach((r, i) => {
    if (kinds.get(r.assetId) !== 'logo')
      issues.push({ path: `logoRules.${i}.assetId`, issue: 'not_a_logo_of_this_brand' });
    if (variants.has(r.variant) && !heldTwice.has(r.variant))
      issues.push({ path: `logoRules.${i}.variant`, issue: 'duplicate_variant' });
    variants.add(r.variant);
    if (r.assetVersionId && versionAssets.get(r.assetVersionId) !== r.assetId)
      issues.push({ path: `logoRules.${i}.assetVersionId`, issue: 'not_a_version_of_this_logo' });
    r.usage?.donts.forEach((d, j) => {
      if (!d.trim()) issues.push({ path: `logoRules.${i}.usage.donts.${j}`, issue: 'empty' });
    });
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
  for (const { r, i } of changedRoles)
    if (kinds.get(r.fontAssetId) !== 'font')
      issues.push({ path: `tokens.typeRoles.${i}.fontAssetId`, issue: 'not_a_font_of_this_brand' });
  issues.push(...(await guidanceIssues(brandId, document, previous, tx)));
  if (issues.length) throw new ValidationFailedError(issues, 'The brand system draft has invalid references');
}

/** Every channel key a document refers to: channel guidance, copy templates and examples. */
const channelKeysOf = (d: BrandSystemDocumentV1): Set<string> =>
  new Set([
    ...d.channelGuidance.map((c) => c.providerKey),
    ...(d.copyTemplates ?? []).flatMap((t) => t.channelKeys),
    ...d.voice.examples.flatMap((e) => (e.channelKey ? [e.channelKey] : [])),
  ]);

/** The keys a list holds more than once. */
function repeated<T>(items: readonly T[], key: (t: T) => string): Set<string> {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const item of items) (seen.has(key(item)) ? out : seen).add(key(item));
  return out;
}

/**
 * Reports every repeat of a key in a list (after its first use), except keys the applied document already held more
 * than once: a document saved before the check still saves.
 */
function duplicates<T>(
  items: readonly T[],
  previous: readonly T[],
  key: (t: T) => string,
  path: (i: number) => string,
): ErrorDetail[] {
  const held = repeated(previous, key);
  const seen = new Set<string>();
  return items.flatMap((item, i) => {
    const k = key(item);
    if (seen.has(k) && !held.has(k)) return [{ path: path(i), issue: 'duplicate_key' }];
    seen.add(k);
    return [];
  });
}

/**
 * BSC-1 guidance references: channel keys name known channel providers, one guidance entry per channel; copy
 * template keys, messaging pillar keys and vocabulary terms (case-insensitively) are unique; a pillar's proof facts
 * are facts of this brand, and a fact a pillar newly cites is in effect (approved, within its validity window). As with type roles, what the applied document
 * already held (channel keys, repeated keys, cited facts) is not re-checked, so an older save still saves (a held fact
 * that was since revoked stays cited until a person removes it; snapshots and prompts use approved facts only).
 */
async function guidanceIssues(
  brandId: string,
  document: BrandSystemDocumentV1,
  previous: BrandSystemDocumentV1 | null,
  tx: Tx,
): Promise<ErrorDetail[]> {
  const issues: ErrorDetail[] = [];
  const known = new Set(channelKeySource());
  const held = previous ? channelKeysOf(previous) : new Set<string>();
  const unknown = (key: string) => !known.has(key) && !held.has(key);
  document.channelGuidance.forEach((c, i) => {
    if (unknown(c.providerKey))
      issues.push({ path: `channelGuidance.${i}.providerKey`, issue: 'unknown_channel' });
  });
  issues.push(
    ...duplicates(
      document.channelGuidance,
      previous?.channelGuidance ?? [],
      (c) => c.providerKey,
      (i) => `channelGuidance.${i}.providerKey`,
    ),
  );
  (document.copyTemplates ?? []).forEach((t, i) =>
    t.channelKeys.forEach((k, j) => {
      if (unknown(k)) issues.push({ path: `copyTemplates.${i}.channelKeys.${j}`, issue: 'unknown_channel' });
    }),
  );
  issues.push(
    ...duplicates(
      document.copyTemplates ?? [],
      previous?.copyTemplates ?? [],
      (t) => t.key,
      (i) => `copyTemplates.${i}.key`,
    ),
  );
  document.voice.examples.forEach((e, i) => {
    if (e.channelKey && unknown(e.channelKey))
      issues.push({ path: `voice.examples.${i}.channelKey`, issue: 'unknown_channel' });
  });
  issues.push(
    ...duplicates(
      document.vocabulary ?? [],
      previous?.vocabulary ?? [],
      (v) => v.term.trim().toLocaleLowerCase(),
      (i) => `vocabulary.${i}.term`,
    ),
  );
  const pillars = document.messaging?.pillars ?? [];
  issues.push(
    ...duplicates(
      pillars,
      previous?.messaging?.pillars ?? [],
      (p) => p.key,
      (i) => `messaging.pillars.${i}.key`,
    ),
  );
  const pillarKeys = new Set(pillars.map((p) => p.key));
  (document.messaging?.keyMessages ?? []).forEach((m, i) => {
    if (m.pillarKey !== undefined && !pillarKeys.has(m.pillarKey))
      issues.push({ path: `messaging.keyMessages.${i}.pillarKey`, issue: 'unknown_pillar' });
  });
  const cited = new Set(previous?.messaging?.pillars.flatMap((p) => p.proofFactIds) ?? []);
  const factIds = [...new Set(pillars.flatMap((p) => p.proofFactIds))].filter((id) => !cited.has(id));
  const states = factIds.length
    ? await factsRepo.statesOf(brandId, factIds, tx)
    : new Map<string, FactState>();
  // Spec 8.3 as the snapshot applies it: approved, its validity window open now (a superseded fact is not).
  const effective = new Set(
    (await factsRepo.listEffectiveByIds(brandId, factIds, new Date(), tx)).map((f) => f.id),
  );
  pillars.forEach((p, i) =>
    p.proofFactIds.forEach((id, j) => {
      const path = `messaging.pillars.${i}.proofFactIds.${j}`;
      // A fact the applied document already cites is not re-checked (it may since have been revoked or superseded;
      // snapshots and prompts cite effective facts only).
      if (cited.has(id) || effective.has(id)) return;
      issues.push({
        path,
        issue: states.get(id) === undefined ? 'not_a_fact_of_this_brand' : 'fact_not_in_effect',
      });
    }),
  );
  return issues;
}

type Voice = BrandSystemDocumentV1['voice'];
type WithProvenance = { provenance?: { origin: string } };
const SUGGESTED = { origin: 'suggested' as const };

/**
 * Merges a proposed list into the current one by `key`: an item a person entered (provenance `user`) is kept as it
 * is; an item the proposal matches keeps its extra fields (needs, rationale, channel...) and takes the proposal's
 * values, becoming `suggested` when they differ; an item the proposal adds is `suggested`. Items the proposal leaves
 * out are dropped unless a person entered them.
 */
function mergeProposed<T extends WithProvenance, P extends object>(
  current: readonly T[],
  proposed: readonly P[],
  key: (item: T | P) => string,
): T[] {
  const byKey = new Map(current.map((c) => [key(c), c]));
  const out: T[] = [];
  const used = new Set<string>();
  for (const p of proposed) {
    const k = key(p);
    if (used.has(k)) continue;
    used.add(k);
    const existing = byKey.get(k);
    if (existing?.provenance?.origin === 'user') {
      out.push(existing);
      continue;
    }
    const merged = { ...existing, ...p } as unknown as T;
    const changed = !existing || hashCanonical({ ...existing, ...p }) !== hashCanonical(existing);
    out.push({ ...merged, provenance: changed ? SUGGESTED : (existing.provenance ?? SUGGESTED) } as T);
  }
  for (const c of current)
    if (c.provenance?.origin === 'user' && !used.has(key(c))) {
      used.add(key(c));
      out.push(c);
    }
  return out;
}

/**
 * An onboarding proposal covers the original voice fields. Guidance a person added (personality, rules) is kept;
 * audiences (by key) and examples (by text) are merged so their extra fields survive and a person's items are
 * never overwritten; plain lists (tone, terms, phrases, locales) are replaced as before.
 */
export function mergeProposedVoice(current: Voice, proposal: BrandVoiceProposal): Voice {
  return {
    ...current,
    ...proposal,
    audiences: mergeProposed(current.audiences, proposal.audiences, (a) => a.key),
    examples: mergeProposed(current.examples, proposal.examples, (e) => e.text),
  };
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

export const actorRef = (actor: ResolvedActor) => ({ kind: actor.kind, id: actor.id });
export const brandResource = (b: BrandRow) => ({
  type: 'brand',
  tenantId: b.tenantId,
  brandId: b.id,
  id: b.id,
});

/**
 * Spec 5.5: agents hold brand.edit_standards / brand.publish_version with the propose_only obligation. They may
 * draft and propose; approving a fact, publishing a version or activating a policy is a person's decision.
 */
export function assertMayDecide(decision: Decision): void {
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

/** A snapshot of a brand with nothing published: the empty document, never a draft. */
const UNPUBLISHED_VERSION_ID = 'unpublished';

/** The hashed snapshot of one version of the brand, with the facts, objectives and policy effective now. */
async function snapshotOf(
  brand: BrandRow,
  version: { id: string; number: number; document: unknown },
  tx?: Tx,
): Promise<BrandSnapshot> {
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
}

/** Brand-owned rows are loaded through the scoped repository and bound to the brand in the input: a foreign or mismatched id is NOT_FOUND. */
/**
 * Makes `v` the brand's applied version: retires the previously published one in the same transaction, points the
 * brand at `v`, writes its design tokens and emits brand.version_published (with the acting principal, so the
 * consumer re-establishes tenant context as it: spec 5.2). It never mutates approved work: the impact workflow
 * that consumes the event (brandChangeImpactWorkflowV1) invalidates approvals and re-evaluates scheduled
 * publications (spec 8.2). The caller has locked the brand and checked brand.publish_version.
 */
async function applyVersion(
  actor: ResolvedActor,
  brand: BrandRow,
  v: Awaited<ReturnType<typeof loadVersion>>,
  expectedVersion: number,
  tx: Tx,
) {
  const toState = transition(brandVersionMachine, v.state, 'publish', 'versionId');
  const document = BrandSystemDocumentV1.parse(v.document);
  const previous = await versionsRepo.findPublished(brand.id, tx);
  if (previous && previous.id !== v.id)
    await versionsRepo.update(
      previous.id,
      previous.version,
      { state: transition(brandVersionMachine, previous.state, 'retire', 'versionId') },
      tx,
    );
  await versionsRepo.update(
    v.id,
    expectedVersion,
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
    { type: 'brand_version', id: v.id, version: expectedVersion + 1 },
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
  return { versionId: v.id, number: v.number, state: toState, version: expectedVersion + 1 };
}

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
type FactRow = Awaited<ReturnType<typeof loadFact>>;

/** Facts that still apply or may apply: the ones a merge, a correction or a conflict decision can act on. */
const LIVE_FACT_STATES: ReadonlyArray<FactState> = ['proposed', 'approved'];
/** Without a date of its own, an approved or reviewed fact is next due for review a year later. */
const DEFAULT_FACT_REVIEW_DAYS = 365;
const DAY_MS = 86_400_000;

const dateOrNull = (v: string | null | undefined): Date | null => (v ? new Date(v) : null);
const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

function assertValidity(validFrom: Date | null, validUntil: Date | null): void {
  if (validFrom && validUntil && validUntil.getTime() <= validFrom.getTime())
    throw new ValidationFailedError([{ path: 'validUntil', issue: 'must be after validFrom' }]);
}

/** Rows written before 0023 (or by the previous release mid-deploy) read as the category of the same name as kind. */
const factCategory = (f: FactRow): FactCategory => f.category ?? f.kind;
const factOrigin = (f: FactRow): FactOrigin =>
  f.origin ?? (f.proposedByKind === 'agent' ? 'suggested' : 'user');
const factSources = (f: FactRow): FactSource[] => FactSource.array().parse(f.sources ?? f.evidence);
/** The evidence column keeps the plain references (titles and excerpts live in sources only). */
const evidenceOf = (sources: readonly FactSource[]): EvidenceRef[] =>
  sources.map(({ title: _title, excerpt: _excerpt, ...ref }) => ref);
const hasEvidenceSource = (sources: readonly FactSource[]) =>
  sources.some((s) => FACT_EVIDENCE_SOURCE_KINDS.includes(s.kind));
const isEffective = (f: FactRow, at: Date) =>
  f.state === 'approved' &&
  (f.validFrom === null || f.validFrom <= at) &&
  (f.validUntil === null || f.validUntil > at);

/** A person's fact is `user` unless they say otherwise; an agent never claims `user` (it is then `suggested`). */
function originFor(actor: ResolvedActor, requested: FactOrigin | undefined): FactOrigin {
  if (actor.kind === 'user') return requested ?? 'user';
  return requested && requested !== 'user' ? requested : 'suggested';
}

function withReviewerNote(
  sources: FactSource[],
  actor: ResolvedActor,
  note: string | undefined,
  at: Date,
): FactSource[] {
  return note
    ? [...sources, { kind: 'reviewer', ref: actor.id, note, capturedAt: at.toISOString() }]
    : sources;
}

const factResource = (brand: BrandRow, fact: FactRow) => ({
  type: 'approved_fact',
  tenantId: brand.tenantId,
  brandId: brand.id,
  id: fact.id,
});

/**
 * The live fact of the brand with this dedupe key: by the stored key, or, for a fact stored before 0023 whose key
 * the daily sweep has not filled yet, by computing its key here (so existing facts are duplicates from day one).
 */
async function findLiveDuplicate(brandId: string, dedupeKey: string, tx: Tx) {
  const keyed = await factsRepo.findLiveByDedupeKey(brandId, dedupeKey, tx);
  if (keyed) return keyed;
  const unkeyed = await factsRepo.listLiveUnkeyed(brandId, tx);
  return unkeyed.find((f) => factDedupeKey(f.statement) === dedupeKey) ?? null;
}

/** Another live fact of the brand with the same normalised statement is a duplicate (typed for the workspace). */
async function assertNotDuplicate(brandId: string, dedupeKey: string, except: string[], tx: Tx) {
  const existing = await findLiveDuplicate(brandId, dedupeKey, tx);
  if (existing && !except.includes(existing.id))
    throw new ValidationFailedError(
      [{ path: 'statement', issue: 'duplicate_fact' }],
      `The brand already has this fact: "${existing.statement.slice(0, 200)}"`,
    );
}

/** Conflicts named when a fact is proposed; a conflicting fact must be the brand's (another is NOT_FOUND). */
async function conflictsOf(
  brandId: string,
  inputs: readonly FactConflictInput[],
  at: Date,
  tx: Tx,
): Promise<FactConflict[]> {
  const out: FactConflict[] = [];
  for (const [i, c] of inputs.entries()) {
    if (!c.factId && !c.source && !c.note)
      throw new ValidationFailedError([{ path: `conflicts.${i}`, issue: 'empty_conflict' }]);
    if (c.factId) await loadFact(brandId, c.factId, tx);
    out.push({ ...c, id: `c${i + 1}`, raisedAt: at.toISOString(), status: 'open' });
  }
  return out;
}

/**
 * A fact that stopped applying (revoked, withdrawn or superseded while approved) announces it the way a revocation
 * always has (`brand.fact_revoked`, schema 1; `cause` and `supersededByFactId` are additive), so the impact
 * workflow holds or flags the scheduled work citing it.
 */
async function emitFactRevoked(
  actor: ResolvedActor,
  brand: BrandRow,
  fact: FactRow,
  version: number,
  extra: { reason: string | null; cause: string; supersededByFactId?: string },
  tx: Tx,
) {
  await outbox.add(
    'brand.fact_revoked',
    { type: 'approved_fact', id: fact.id, version },
    {
      factId: fact.id,
      kind: fact.kind,
      previousState: fact.state,
      reason: extra.reason,
      cause: extra.cause,
      ...(extra.supersededByFactId ? { supersededByFactId: extra.supersededByFactId } : {}),
      actorKind: actor.kind,
      actorId: actor.id,
    },
    tx,
    { brandId: brand.id },
  );
}

/** proposed | approved → superseded by `byFactId`; an approved fact's dependants are held through the event. */
async function supersedeFact(
  actor: ResolvedActor,
  brand: BrandRow,
  fact: FactRow,
  expectedVersion: number,
  byFactId: string,
  cause: 'corrected' | 'merged' | 'conflict',
  tx: Tx,
): Promise<FactState> {
  const toState = transition(approvedFactMachine, fact.state, 'supersede', 'factId');
  await factsRepo.update(fact.id, expectedVersion, { state: toState, supersededByFactId: byFactId }, tx);
  await audit.record(
    actorRef(actor),
    'brand.fact.supersede',
    { type: 'approved_fact', id: fact.id },
    'allowed',
    tx,
    { brandId: brand.id, fromState: fact.state, toState, supersededByFactId: byFactId, cause },
  );
  if (fact.state === 'approved')
    await emitFactRevoked(
      actor,
      brand,
      fact,
      expectedVersion + 1,
      { reason: null, cause, supersededByFactId: byFactId },
      tx,
    );
  return toState;
}

async function revokeFact(
  actor: ResolvedActor,
  input: { brandId: string; factId: string; expectedVersion: number; reason?: string },
  cause: 'revoked' | 'withdrawn',
  tx: Tx,
) {
  const brand = await brandsRepo.getById(input.brandId, tx);
  const fact = await loadFact(brand.id, input.factId, tx);
  const decision = await policy.assert(actor, 'brand.edit_standards', factResource(brand, fact), {}, tx);
  assertMayDecide(decision);
  const toState = transition(approvedFactMachine, fact.state, 'revoke', 'factId');
  const reason = input.reason ?? null;
  await factsRepo.update(
    fact.id,
    input.expectedVersion,
    { state: toState, revokedByUserId: actor.kind === 'user' ? actor.id : null, revokeReason: reason },
    tx,
  );
  await audit.record(
    actorRef(actor),
    cause === 'withdrawn' ? 'brand.fact.withdraw' : 'brand.fact.revoke',
    { type: 'approved_fact', id: fact.id },
    'allowed',
    tx,
    { brandId: brand.id, fromState: fact.state, toState, reason },
  );
  await emitFactRevoked(actor, brand, fact, input.expectedVersion + 1, { reason, cause }, tx);
  return { factId: fact.id, state: toState, version: input.expectedVersion + 1 };
}

const toFactDto = (
  f: FactRow,
  ctx: {
    at: Date;
    names: ReadonlyMap<string, string>;
    statements: ReadonlyMap<string, string>;
    duplicates: ReadonlyMap<string, readonly string[]>;
  },
) => {
  const name = (id: string | null) => (id ? (ctx.names.get(id) ?? null) : null);
  return {
    id: f.id,
    brandId: f.brandId,
    kind: f.kind,
    category: factCategory(f),
    scope: f.scope,
    origin: factOrigin(f),
    statement: f.statement,
    evidence: EvidenceRef.array().parse(f.evidence),
    sources: factSources(f),
    validFrom: iso(f.validFrom),
    validUntil: iso(f.validUntil),
    state: f.state,
    proposedByKind: f.proposedByKind,
    proposedById: f.proposedById,
    proposedByName: f.proposedByKind === 'user' ? name(f.proposedById) : null,
    approvedByUserId: f.approvedByUserId,
    approvedByName: name(f.approvedByUserId),
    revokedByUserId: f.revokedByUserId,
    revokedByName: name(f.revokedByUserId),
    revokeReason: f.revokeReason,
    reviewDueAt: iso(f.reviewDueAt),
    reviewedAt: iso(f.reviewedAt),
    reviewedByUserId: f.reviewedByUserId,
    reviewedByName: name(f.reviewedByUserId),
    supersededByFactId: f.supersededByFactId,
    supersedesFactId: f.supersedesFactId,
    conflicts: FactConflict.array()
      .parse(f.conflicts ?? [])
      .map((c) => ({ ...c, factStatement: c.factId ? (ctx.statements.get(c.factId) ?? null) : null })),
    possibleDuplicates: (ctx.duplicates.get(f.id) ?? []).map((id) => ({
      id,
      statement: ctx.statements.get(id) ?? '',
    })),
    /** Approved and inside its validity window now: what generation and release checks use. */
    effective: isEffective(f, ctx.at),
    expired: f.validUntil !== null && f.validUntil <= ctx.at,
    reviewDue: f.state === 'approved' && f.reviewDueAt !== null && f.reviewDueAt <= ctx.at,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
    version: f.version,
  };
};
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
    // Creating a brand is a person's decision: an agent or API key holding brand.edit_standards may only propose.
    assertMayDecide(
      await policy.assert(actor, 'brand.edit_standards', { type: 'tenant', tenantId, id: tenantId }, {}, tx),
    );
    await entitlements.assert(tenantId, 'brands', tx);
    const id = newId('brand');
    await brandsRepo.create(
      {
        id,
        name: parsed.name,
        timezone: parsed.timezone,
        defaultLocale: parsed.defaultLocale,
        status: 'setup',
        classification: parsed.classification,
      },
      tx,
    );
    // Demo workspace (architecture §4.6): every brand of a demo starts with a zero daily spend limit, beside the
    // company's zero monthly limit set when the demo was created.
    if (await isDemoTenant(tx)) await budgets.setLimit(id, 'day', 0, tx);
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
      classification: b.classification,
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
      classification: b.classification,
      publishedVersionId: b.publishedVersionId,
      activePolicyVersionId: b.activePolicyVersionId,
      version: b.version,
    };
  },

  /**
   * D-11: a client brand needs a distinct approver by default; an internal brand does not. Reclassifying can switch
   * separation of duties off, so it takes the authority that activates a release policy (which can switch it off too):
   * owners, admins and brand managers, never an agent.
   */
  async classify(actor: ResolvedActor, input: z.infer<typeof BrandClassify>, tx: Tx) {
    const parsed = BrandClassify.parse(input);
    const brand = await brandsRepo.lock(parsed.brandId, tx);
    const decision = await policy.assert(actor, 'brand.publish_version', brandResource(brand), {}, tx);
    assertMayDecide(decision);
    // Already that type: nothing changes, so nothing is written or audited.
    if (brand.classification === parsed.classification)
      return { brandId: brand.id, classification: brand.classification, version: brand.version };
    await brandsRepo.update(brand.id, parsed.expectedVersion, { classification: parsed.classification }, tx);
    await audit.record(actorRef(actor), 'brand.classify', { type: 'brand', id: brand.id }, 'allowed', tx, {
      brandId: brand.id,
      from: brand.classification,
      to: parsed.classification,
    });
    return { brandId: brand.id, classification: parsed.classification, version: parsed.expectedVersion + 1 };
  },

  /**
   * R1-D: the brand's setup is complete once its standards are published; connections, assets and a first package
   * are optional steps the home screen offers, never gates (missing integrations do not block creation). Brand
   * managers and above (brand.edit_standards); a brand already active changes nothing.
   */
  async completeSetup(actor: ResolvedActor, input: z.infer<typeof BrandCompleteSetup>, tx: Tx) {
    const parsed = BrandCompleteSetup.parse(input);
    const brand = await brandsRepo.lock(parsed.brandId, tx);
    const decision = await policy.assert(actor, 'brand.edit_standards', brandResource(brand), {}, tx);
    assertMayDecide(decision); // an agent may only propose standards; it never finishes a brand's setup
    if (brand.status === 'active') return { brandId: brand.id, status: brand.status, version: brand.version };
    if (brand.status === 'archived')
      throw new ValidationFailedError([
        { path: 'brandId', issue: 'an archived brand cannot complete setup' },
      ]);
    if (!brand.publishedVersionId)
      throw new ValidationFailedError([
        { path: 'brandId', issue: 'publish the brand standards before completing setup' },
      ]);
    await brandsRepo.update(brand.id, parsed.expectedVersion, { status: 'active' }, tx);
    await audit.record(
      actorRef(actor),
      'brand.setup.complete',
      { type: 'brand', id: brand.id },
      'allowed',
      tx,
      {
        brandId: brand.id,
        from: brand.status,
        to: 'active',
      },
    );
    return { brandId: brand.id, status: 'active' as const, version: parsed.expectedVersion + 1 };
  },

  /**
   * D-11: whether a review decision on this brand needs an approver other than the author. The active release policy
   * decides when there is one; without one, client brands do and internal brands do not.
   */
  async distinctApproverRequired(brandId: string, tx?: Tx): Promise<boolean> {
    const brand = await brandsRepo.getById(brandId, tx);
    const active = await policiesRepo.findActive(brand.id, tx);
    return active
      ? PolicyDocumentV1.parse(active.document).requireDistinctApprover
      : brand.classification === 'client';
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
      await assertDocumentReferences(brand.id, document, BrandSystemDocumentV1.parse(v.document), tx);
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
      return applyVersion(actor, brand, v, parsed.expectedVersion, tx);
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

    /**
     * UX-20 (D-13): the open review requests, valid approvals and scheduled publications that publishing a version
     * of this brand reaches now, with the policy that decides what happens to them. `effective` is what the
     * workflow does today: `invalidate_and_hold` whatever is stored, until approval binding v2 enables `flag`.
     * brand.read on the brand; a foreign brand is NOT_FOUND.
     */
    async impact(actor: ResolvedActor, input: z.infer<typeof BrandVersionImpact>, tx?: Tx) {
      const parsed = BrandVersionImpact.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      await policy.assert(actor, 'brand.read', brandResource(brand), {}, tx);
      const active = await policiesRepo.findActive(brand.id, tx);
      const configured = active
        ? (PolicyDocumentV1.parse(active.document).onBrandVersionPublished ?? null)
        : null;
      const scope = brandChangeImpactSource ? await brandChangeImpactSource(brand.id, tx) : null;
      return {
        brandId: brand.id,
        available: scope !== null,
        truncated: scope?.truncated ?? false,
        policy: { configured, effective: 'invalidate_and_hold' as const },
        requests: scope?.requests ?? [],
        approvals: scope?.approvals ?? 0,
        publications: scope?.publications ?? [],
        computedAt: new Date().toISOString(),
      };
    },
  },

  /**
   * D-22: one brand system per brand, edited and saved by a person; a save applies at once. Each save is recorded
   * internally as an immutable version (approvals, reviews and agent runs keep pointing at what they were checked
   * against), but no one creates, chooses or publishes versions: imports and agents land proposals that a person
   * applies (save) or discards.
   */
  system: {
    async save(actor: ResolvedActor, input: z.infer<typeof BrandSystemSave>, tx: Tx) {
      const parsed = BrandSystemSave.parse(input);
      const brand = await brandsRepo.lock(parsed.brandId, tx);
      await policy.assert(actor, 'brand.edit_standards', brandResource(brand), {}, tx);
      assertMayDecide(await policy.assert(actor, 'brand.publish_version', brandResource(brand), {}, tx));
      if ((brand.publishedVersionId ?? null) !== parsed.basedOnVersionId)
        throw new ConflictError('BrandSystem', brand.id, brand.version);
      const published = await versionsRepo.findPublished(brand.id, tx);
      const previous = published ? BrandSystemDocumentV1.parse(published.document) : null;
      const document = BrandSystemDocumentV1.parse(parsed.document);
      await assertDocumentReferences(brand.id, document, previous, tx);
      const proposal = parsed.proposal ? await loadVersion(brand.id, parsed.proposal.versionId, tx) : null;
      if (proposal && proposal.state !== 'draft' && proposal.state !== 'in_review')
        throw new ValidationFailedError(
          [{ path: 'proposal.versionId', issue: 'proposal_closed' }],
          'This proposal was already applied or discarded',
        );
      const contentHash = hashCanonical(document);
      // Saving what is already applied changes nothing: no new version, and no approval is invalidated.
      const unchanged = published !== null && published.contentHash === contentHash;
      let applied: { versionId: string; number: number } | null = null;
      if (!unchanged) {
        const id = newId('brandVersion');
        const number = await versionsRepo.nextNumber(brand.id, tx);
        await versionsRepo.create(
          { id, brandId: brand.id, number, state: 'draft', document, contentHash },
          tx,
        );
        await versionsRepo.update(
          id,
          0,
          { state: transition(brandVersionMachine, 'draft', 'submit', 'versionId') },
          tx,
        );
        if (guidelinesKey(previous ?? emptyBrandSystemDocument()) !== guidelinesKey(document))
          await recordGuidelineAuthor(actor, brand.id, id, null, tx);
        const result = await applyVersion(actor, brand, await loadVersion(brand.id, id, tx), 1, tx);
        applied = { versionId: result.versionId, number: result.number };
      }
      if (proposal && parsed.proposal)
        await versionsRepo.update(
          proposal.id,
          parsed.proposal.expectedVersion,
          { state: transition(brandVersionMachine, proposal.state, 'retire', 'versionId') },
          tx,
        );
      await audit.record(
        actorRef(actor),
        'brand.system.save',
        { type: 'brand', id: brand.id },
        'allowed',
        tx,
        {
          brandId: brand.id,
          ...(applied ? { versionId: applied.versionId } : {}),
          ...(proposal ? { proposalVersionId: proposal.id } : {}),
          changed: !unchanged,
        },
      );
      return {
        brandId: brand.id,
        changed: !unchanged,
        versionId: applied?.versionId ?? published?.id ?? null,
        contentHash,
      };
    },

    /** D-22: a proposal is dismissed by retiring it; nothing applied changes. */
    async discardProposal(actor: ResolvedActor, input: z.infer<typeof BrandProposalDiscard>, tx: Tx) {
      const parsed = BrandProposalDiscard.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      const v = await loadVersion(brand.id, parsed.versionId, tx);
      // Retiring a person's proposal is a decision: agents and API keys may only propose.
      assertMayDecide(
        await policy.assert(
          actor,
          'brand.edit_standards',
          { type: 'brand_version', tenantId: brand.tenantId, brandId: brand.id, id: v.id, state: v.state },
          {},
          tx,
        ),
      );
      const toState = transition(brandVersionMachine, v.state, 'retire', 'versionId');
      await versionsRepo.update(v.id, parsed.expectedVersion, { state: toState }, tx);
      await audit.record(
        actorRef(actor),
        'brand.system.discard_proposal',
        { type: 'brand_version', id: v.id },
        'allowed',
        tx,
        { brandId: brand.id, fromState: v.state, toState },
      );
      return { versionId: v.id, state: toState, version: parsed.expectedVersion + 1 };
    },
  },

  /**
   * Spec 8.2 / BSC-3: facts land as proposed (by a person or an agent, with category, scope, origin and sources); a
   * person approves, corrects, merges, resolves conflicts, marks them reviewed and withdraws them. Every decision is
   * a person's (agents propose only, assertMayDecide). A fact that stops applying (revoked, withdrawn, superseded)
   * emits brand.fact_revoked so the impact workflow holds the scheduled work citing it; expiry is the daily sweep's.
   */
  facts: {
    /**
     * The same normalised statement already live in the brand (proposed or approved) is not proposed twice: the
     * existing fact is returned with `duplicate: true` and nothing is written.
     */
    async propose(actor: ResolvedActor, input: z.input<typeof FactPropose>, tx: Tx) {
      const parsed = FactPropose.parse(input);
      const brand = await brandsRepo.lock(parsed.brandId, tx);
      await policy.assert(actor, 'brand.edit_standards', brandResource(brand), {}, tx);
      const category = parsed.category ?? parsed.kind;
      if (!category)
        throw new ValidationFailedError([{ path: 'category', issue: 'required' }], 'Choose a category');
      const validFrom = dateOrNull(parsed.validFrom);
      const validUntil = dateOrNull(parsed.validUntil);
      assertValidity(validFrom, validUntil);
      const dedupeKey = factDedupeKey(parsed.statement);
      const existing = await findLiveDuplicate(brand.id, dedupeKey, tx);
      if (existing) return { factId: existing.id, version: existing.version, duplicate: true };
      const conflicts = await conflictsOf(brand.id, parsed.conflicts ?? [], new Date(), tx);
      const sources: FactSource[] = parsed.sources ?? parsed.evidence ?? [];
      const id = newId('approvedFact');
      await factsRepo.create(
        {
          id,
          brandId: brand.id,
          kind: parsed.category ? factKindOf(parsed.category) : (parsed.kind ?? 'claim'),
          category,
          scope: parsed.scope?.trim() || null,
          origin: originFor(actor, parsed.origin),
          statement: parsed.statement,
          evidence: evidenceOf(sources),
          sources,
          validFrom,
          validUntil,
          reviewDueAt: dateOrNull(parsed.reviewDueAt),
          conflicts: conflicts.length ? conflicts : null,
          dedupeKey,
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
        { brandId: brand.id, category },
      );
      return { factId: id, version: 0, duplicate: false };
    },

    /** Edit a proposed fact. An agent edits only its own proposals; a person any proposal of the brand. */
    async update(actor: ResolvedActor, input: z.input<typeof FactUpdate>, tx: Tx) {
      const parsed = FactUpdate.parse(input);
      const brand = await brandsRepo.lock(parsed.brandId, tx);
      const fact = await loadFact(brand.id, parsed.factId, tx);
      await policy.assert(actor, 'brand.edit_standards', factResource(brand, fact), {}, tx);
      if (fact.state !== 'proposed')
        throw new ValidationFailedError(
          [{ path: 'factId', issue: 'not_proposed' }],
          'Only a proposed fact can be edited; correct an approved fact instead',
        );
      if (actor.kind !== 'user' && !(fact.proposedByKind === 'agent' && fact.proposedById === actor.id))
        throw new PolicyDeniedError('propose_only', 'Agents may only edit their own proposals');
      const validFrom = parsed.validFrom === undefined ? fact.validFrom : dateOrNull(parsed.validFrom);
      const validUntil = parsed.validUntil === undefined ? fact.validUntil : dateOrNull(parsed.validUntil);
      assertValidity(validFrom, validUntil);
      const statement = parsed.statement ?? fact.statement;
      const dedupeKey = factDedupeKey(statement);
      await assertNotDuplicate(brand.id, dedupeKey, [fact.id], tx);
      const sources = parsed.sources ?? factSources(fact);
      const category = parsed.category ?? factCategory(fact);
      await factsRepo.update(
        fact.id,
        parsed.expectedVersion,
        {
          statement,
          dedupeKey,
          category,
          kind: factKindOf(category),
          scope: parsed.scope === undefined ? fact.scope : parsed.scope?.trim() || null,
          sources,
          evidence: evidenceOf(sources),
          validFrom,
          validUntil,
          reviewDueAt: parsed.reviewDueAt === undefined ? fact.reviewDueAt : dateOrNull(parsed.reviewDueAt),
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'brand.fact.update',
        { type: 'approved_fact', id: fact.id },
        'allowed',
        tx,
        { brandId: brand.id },
      );
      return { factId: fact.id, version: parsed.expectedVersion + 1 };
    },

    /**
     * A suggested or inferred fact without a source is approved only with a reviewer note, kept as a reviewer source
     * (BSC-3: AI cannot promote an assumption). Approval is a review: the next review falls due a year later unless
     * the fact or the input names a date. Approving a correction supersedes the fact it corrects.
     */
    async approve(actor: ResolvedActor, input: z.input<typeof FactApprove>, tx: Tx) {
      const parsed = FactApprove.parse(input);
      const brand = await brandsRepo.lock(parsed.brandId, tx);
      const fact = await loadFact(brand.id, parsed.factId, tx);
      const decision = await policy.assert(actor, 'brand.edit_standards', factResource(brand, fact), {}, tx);
      assertMayDecide(decision);
      const toState = transition(approvedFactMachine, fact.state, 'approve', 'factId');
      // A correction replaces a fact that still applies; one whose original was withdrawn or merged meanwhile is
      // refused (propose it as a new fact instead), so approving it never silently stands alone.
      const corrected = fact.supersedesFactId ? await factsRepo.findById(fact.supersedesFactId, tx) : null;
      if (
        fact.supersedesFactId &&
        !(corrected && corrected.brandId === brand.id && LIVE_FACT_STATES.includes(corrected.state))
      )
        throw new ValidationFailedError(
          [{ path: 'factId', issue: 'corrects_not_live' }],
          'The fact this corrects no longer applies; propose the statement as a new fact instead',
        );
      const origin = factOrigin(fact);
      const sources = factSources(fact);
      if (
        (origin === 'suggested' || origin === 'inferred') &&
        !hasEvidenceSource(sources) &&
        !parsed.reviewerNote
      )
        throw new ValidationFailedError(
          [{ path: 'reviewerNote', issue: 'reviewer_note_required' }],
          'This fact has no source: say why it holds before approving it',
        );
      const now = new Date();
      const nextSources = withReviewerNote(sources, actor, parsed.reviewerNote, now);
      await factsRepo.update(
        fact.id,
        parsed.expectedVersion,
        {
          state: toState,
          approvedByUserId: actor.kind === 'user' ? actor.id : null,
          reviewedAt: now,
          reviewedByUserId: actor.kind === 'user' ? actor.id : null,
          reviewDueAt: parsed.reviewDueAt
            ? new Date(parsed.reviewDueAt)
            : (fact.reviewDueAt ?? new Date(now.getTime() + DEFAULT_FACT_REVIEW_DAYS * DAY_MS)),
          reviewFlaggedAt: null,
          sources: nextSources,
          evidence: evidenceOf(nextSources),
          dedupeKey: fact.dedupeKey ?? factDedupeKey(fact.statement),
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'brand.fact.approve',
        { type: 'approved_fact', id: fact.id },
        'allowed',
        tx,
        {
          brandId: brand.id,
          fromState: fact.state,
          toState,
          reviewerNote: parsed.reviewerNote !== undefined,
        },
      );
      const supersededFactIds: string[] = [];
      if (corrected) {
        await supersedeFact(actor, brand, corrected, corrected.version, fact.id, 'corrected', tx);
        supersededFactIds.push(corrected.id);
      }
      return { factId: fact.id, state: toState, version: parsed.expectedVersion + 1, supersededFactIds };
    },

    /**
     * Event contract `brand.fact_revoked` (schema 1), aggregate approved_fact: data { factId, kind, previousState,
     * reason, actorKind, actorId, cause }, brandId in the payload; `cause` (BSC-3, additive) is revoked, withdrawn,
     * corrected, merged or conflict. Consumer (brandChangeImpactWorkflowV1, started by the review module's outbox
     * route): for every *scheduled* publication whose content references factId, apply the brand's active policy —
     * holdOnDependencyRevocation true (spec 8.2 default) moves it to `held` with the failed checks as reasons; false
     * only flags it (publication.needs_attention). `previousState` lets the consumer ignore withdrawn proposals,
     * which no content can reference.
     */
    async revoke(actor: ResolvedActor, input: z.input<typeof FactRevoke>, tx: Tx) {
      const parsed = FactRevoke.parse(input);
      return revokeFact(actor, parsed, 'revoked', tx);
    },

    /** BSC-3: revoke with a required reason (kept on the fact and shown in the workspace). */
    async withdraw(actor: ResolvedActor, input: z.input<typeof FactWithdraw>, tx: Tx) {
      const parsed = FactWithdraw.parse(input);
      return revokeFact(actor, parsed, 'withdrawn', tx);
    },

    /**
     * Correct an approved fact: a new proposed fact that supersedes it once approved. Agents may propose a
     * correction; one correction is open per fact at a time. Omitted fields are copied from the approved fact.
     */
    async correct(actor: ResolvedActor, input: z.input<typeof FactCorrect>, tx: Tx) {
      const parsed = FactCorrect.parse(input);
      const brand = await brandsRepo.lock(parsed.brandId, tx);
      const fact = await loadFact(brand.id, parsed.factId, tx);
      await policy.assert(actor, 'brand.edit_standards', factResource(brand, fact), {}, tx);
      if (fact.state !== 'approved')
        throw new ValidationFailedError(
          [{ path: 'factId', issue: 'not_approved' }],
          'Only an approved fact can be corrected; edit a proposed fact instead',
        );
      if (fact.version !== parsed.expectedVersion)
        throw new ConflictError('ApprovedFact', fact.id, parsed.expectedVersion);
      if ((await factsRepo.listOpenCorrections(brand.id, fact.id, tx)).length)
        throw new ValidationFailedError(
          [{ path: 'factId', issue: 'correction_pending' }],
          'A correction of this fact is already waiting for approval',
        );
      const validFrom = parsed.validFrom === undefined ? fact.validFrom : dateOrNull(parsed.validFrom);
      const validUntil = parsed.validUntil === undefined ? fact.validUntil : dateOrNull(parsed.validUntil);
      assertValidity(validFrom, validUntil);
      const dedupeKey = factDedupeKey(parsed.statement);
      await assertNotDuplicate(brand.id, dedupeKey, [fact.id], tx);
      const category = parsed.category ?? factCategory(fact);
      const sources = parsed.sources ?? factSources(fact).filter((s) => s.kind !== 'reviewer');
      const id = newId('approvedFact');
      await factsRepo.create(
        {
          id,
          brandId: brand.id,
          kind: factKindOf(category),
          category,
          scope: parsed.scope === undefined ? fact.scope : parsed.scope?.trim() || null,
          origin: originFor(actor, undefined),
          statement: parsed.statement,
          evidence: evidenceOf(sources),
          sources,
          validFrom,
          validUntil,
          reviewDueAt: parsed.reviewDueAt === undefined ? null : dateOrNull(parsed.reviewDueAt),
          dedupeKey,
          supersedesFactId: fact.id,
          state: 'proposed',
          proposedByKind: actor.kind === 'service_principal' ? 'agent' : 'user',
          proposedById: actor.id,
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'brand.fact.correct',
        { type: 'approved_fact', id },
        'allowed',
        tx,
        { brandId: brand.id, correctsFactId: fact.id },
      );
      return { factId: id, version: 0, supersedesFactId: fact.id };
    },

    /** Keep one live fact; the others become superseded by it and their sources (deduplicated) join it. */
    async merge(actor: ResolvedActor, input: z.input<typeof FactMerge>, tx: Tx) {
      const parsed = FactMerge.parse(input);
      const brand = await brandsRepo.lock(parsed.brandId, tx);
      const ids = [parsed.keep.factId, ...parsed.merge.map((m) => m.factId)];
      if (new Set(ids).size !== ids.length)
        throw new ValidationFailedError([{ path: 'merge', issue: 'duplicate_fact_ids' }]);
      const keep = await loadFact(brand.id, parsed.keep.factId, tx);
      const others: Array<{ fact: FactRow; expectedVersion: number }> = [];
      for (const m of parsed.merge)
        others.push({ fact: await loadFact(brand.id, m.factId, tx), expectedVersion: m.expectedVersion });
      const decision = await policy.assert(actor, 'brand.edit_standards', factResource(brand, keep), {}, tx);
      assertMayDecide(decision);
      const all = [{ fact: keep, expectedVersion: parsed.keep.expectedVersion }, ...others];
      for (const [i, { fact }] of all.entries())
        if (!LIVE_FACT_STATES.includes(fact.state))
          throw new ValidationFailedError(
            [{ path: i === 0 ? 'keep.factId' : `merge.${i - 1}.factId`, issue: 'not_live' }],
            'Only proposed or approved facts can be merged',
          );
      for (const { fact, expectedVersion } of all)
        if (fact.version !== expectedVersion)
          throw new ConflictError('ApprovedFact', fact.id, expectedVersion);
      // An approved fact is never superseded by one nobody approved (it would stop applying with nothing in its place).
      if (keep.state !== 'approved' && others.some(({ fact }) => fact.state === 'approved'))
        throw new ValidationFailedError(
          [{ path: 'keep.factId', issue: 'keep_not_approved' }],
          'Keep an approved fact when an approved fact is merged into it',
        );
      const seen = new Set<string>();
      const sources: FactSource[] = [];
      for (const s of all.flatMap(({ fact }) => factSources(fact))) {
        const key = `${s.kind}\u0000${s.ref}\u0000${s.note ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        sources.push(s);
      }
      await factsRepo.update(
        keep.id,
        parsed.keep.expectedVersion,
        { sources, evidence: evidenceOf(sources) },
        tx,
      );
      for (const { fact, expectedVersion } of others)
        await supersedeFact(actor, brand, fact, expectedVersion, keep.id, 'merged', tx);
      await audit.record(
        actorRef(actor),
        'brand.fact.merge',
        { type: 'approved_fact', id: keep.id },
        'allowed',
        tx,
        { brandId: brand.id, mergedFactIds: others.map(({ fact }) => fact.id) },
      );
      return {
        factId: keep.id,
        version: parsed.keep.expectedVersion + 1,
        supersededFactIds: others.map(({ fact }) => fact.id),
      };
    },

    /** A person confirms an approved fact still holds; the next review is due at the given date or in a year. */
    async markReviewed(actor: ResolvedActor, input: z.input<typeof FactMarkReviewed>, tx: Tx) {
      const parsed = FactMarkReviewed.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      const fact = await loadFact(brand.id, parsed.factId, tx);
      const decision = await policy.assert(actor, 'brand.edit_standards', factResource(brand, fact), {}, tx);
      assertMayDecide(decision);
      if (fact.state !== 'approved')
        throw new ValidationFailedError(
          [{ path: 'factId', issue: 'not_approved' }],
          'Only an approved fact is reviewed',
        );
      const now = new Date();
      const next = parsed.nextReviewDueAt
        ? new Date(parsed.nextReviewDueAt)
        : new Date(now.getTime() + DEFAULT_FACT_REVIEW_DAYS * DAY_MS);
      if (next.getTime() <= now.getTime())
        throw new ValidationFailedError([{ path: 'nextReviewDueAt', issue: 'must be in the future' }]);
      const sources = withReviewerNote(factSources(fact), actor, parsed.note, now);
      await factsRepo.update(
        fact.id,
        parsed.expectedVersion,
        {
          reviewedAt: now,
          reviewedByUserId: actor.id,
          reviewDueAt: next,
          reviewFlaggedAt: null,
          sources,
          evidence: evidenceOf(sources),
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'brand.fact.mark_reviewed',
        { type: 'approved_fact', id: fact.id },
        'allowed',
        tx,
        { brandId: brand.id, nextReviewDueAt: next.toISOString() },
      );
      return { factId: fact.id, version: parsed.expectedVersion + 1, reviewDueAt: next.toISOString() };
    },

    /**
     * Decide a recorded conflict. kept_this: the fact stands and a conflicting live fact of the brand is superseded
     * by it; kept_other: this fact is superseded by the conflicting fact; annotated: both stand, with the note.
     */
    async resolveConflict(actor: ResolvedActor, input: z.input<typeof FactResolveConflict>, tx: Tx) {
      const parsed = FactResolveConflict.parse(input);
      const brand = await brandsRepo.lock(parsed.brandId, tx);
      const fact = await loadFact(brand.id, parsed.factId, tx);
      const decision = await policy.assert(actor, 'brand.edit_standards', factResource(brand, fact), {}, tx);
      assertMayDecide(decision);
      if (!LIVE_FACT_STATES.includes(fact.state))
        throw new ValidationFailedError([{ path: 'factId', issue: 'not_live' }]);
      const conflicts = FactConflict.array().parse(fact.conflicts ?? []);
      const conflict = conflicts.find((c) => c.id === parsed.conflictId);
      if (!conflict) throw new ValidationFailedError([{ path: 'conflictId', issue: 'unknown_conflict' }]);
      if (conflict.status === 'resolved')
        throw new ValidationFailedError([{ path: 'conflictId', issue: 'already_resolved' }]);
      if (parsed.outcome === 'annotated' && !parsed.note)
        throw new ValidationFailedError([{ path: 'note', issue: 'required' }], 'Say why both stand');
      const other = conflict.factId ? await factsRepo.findById(conflict.factId, tx) : null;
      const otherLive = other && other.brandId === brand.id && LIVE_FACT_STATES.includes(other.state);
      if (parsed.outcome === 'kept_other' && !otherLive)
        throw new ValidationFailedError(
          [{ path: 'outcome', issue: 'no_live_conflicting_fact' }],
          'The conflicting source is not a fact of the brand; keep this fact or annotate the conflict',
        );
      // As for merge: an approved fact is superseded only by an approved one.
      const kept = parsed.outcome === 'kept_other' ? other : fact;
      const dropped = parsed.outcome === 'kept_other' ? fact : otherLive ? other : null;
      if (parsed.outcome !== 'annotated' && dropped?.state === 'approved' && kept?.state !== 'approved')
        throw new ValidationFailedError(
          [{ path: 'outcome', issue: 'kept_fact_not_approved' }],
          'The fact you keep must be approved, because the other one is: approve it first or annotate the conflict',
        );
      const now = new Date();
      const resolved = conflicts.map((c) =>
        c.id === conflict.id
          ? {
              ...c,
              status: 'resolved' as const,
              resolution: {
                outcome: parsed.outcome,
                ...(parsed.note ? { note: parsed.note } : {}),
                byUserId: actor.id,
                at: now.toISOString(),
              },
            }
          : c,
      );
      await factsRepo.update(fact.id, parsed.expectedVersion, { conflicts: resolved }, tx);
      let version = parsed.expectedVersion + 1;
      let state = fact.state;
      if (parsed.outcome === 'kept_other' && other) {
        state = await supersedeFact(actor, brand, { ...fact, version }, version, other.id, 'conflict', tx);
        version += 1;
      }
      if (parsed.outcome === 'kept_this' && other && otherLive)
        await supersedeFact(actor, brand, other, other.version, fact.id, 'conflict', tx);
      await audit.record(
        actorRef(actor),
        'brand.fact.resolve_conflict',
        { type: 'approved_fact', id: fact.id },
        'allowed',
        tx,
        { brandId: brand.id, conflictId: conflict.id, outcome: parsed.outcome },
      );
      return { factId: fact.id, state, version };
    },

    /**
     * The workspace listing with its filters. Each fact carries what the workspace shows: category and origin (also
     * for rows written before BSC-3), sources, review and validity status, the names of the people who approved and
     * reviewed it, its conflicts with the conflicting fact's statement, and the live facts it may duplicate.
     */
    async list(actor: ResolvedActor, input: z.input<typeof FactList>, tx?: Tx) {
      const parsed = FactList.parse(input);
      const brand = await brandsRepo.getById(parsed.brandId, tx);
      await policy.assert(actor, 'brand.read', brandResource(brand), {}, tx);
      const at = new Date();
      const live = await factsRepo.listLiveStatements(brand.id, tx);
      const statements = new Map(live.map((f) => [f.id, f.statement]));
      const corrections = new Set(
        live.flatMap((f) => (f.supersedesFactId ? [pairKey(f.id, f.supersedesFactId)] : [])),
      );
      const duplicates = new Map(
        [...possibleDuplicates(live)].flatMap(([id, others]) => {
          const kept = others.filter((o) => !corrections.has(pairKey(id, o)));
          return kept.length ? [[id, kept] as const] : [];
        }),
      );
      const { page, ids, ...filters } = parsed;
      const duplicateIds = parsed.possibleDuplicates ? [...duplicates.keys()] : undefined;
      const only = ids && duplicateIds ? ids.filter((id) => duplicates.has(id)) : (ids ?? duplicateIds);
      const rows = await factsRepo.list(
        brand.id,
        { ...filters, at, ...(only ? { ids: only } : {}) },
        page,
        tx,
      );
      const people = rows.items.flatMap((f) =>
        [
          f.approvedByUserId,
          f.reviewedByUserId,
          f.revokedByUserId,
          f.proposedByKind === 'user' ? f.proposedById : null,
        ].filter((x): x is string => x !== null),
      );
      const names = await accessService.memberNames(people, tx);
      const conflictIds = rows.items.flatMap((f) =>
        FactConflict.array()
          .parse(f.conflicts ?? [])
          .flatMap((c) => (c.factId && !statements.has(c.factId) ? [c.factId] : [])),
      );
      for (const f of await factsRepo.listByIds(brand.id, [...new Set(conflictIds)], tx))
        statements.set(f.id, f.statement);
      return {
        items: rows.items.map((f) => toFactDto(f, { at, names, statements, duplicates })),
        nextCursor: rows.nextCursor,
      };
    },

    /**
     * BSC-3 daily sweep for one brand (the caller is the sweep runtime in the brand's tenant, as the platform job):
     * marks each approved fact whose validity ended exactly once, audits it and emits the informational
     * `brand.fact_expired` (data { factId, kind, previousState, validUntil, cause: 'expired', actorKind, actorId },
     * brandId in the payload; no route), and returns those ids so the runtime holds the scheduled work citing them
     * in the same transaction. Flags approved facts past their review date once and keys facts stored before
     * duplicate detection. The markers make a re-run a no-op.
     */
    async sweep(brandId: string, at: Date, tx: Tx) {
      const { actor } = requireTenant();
      await brandsRepo.getById(brandId, tx); // a foreign or unknown brand is NOT_FOUND
      const result = { expired: 0, reviewDue: 0, keyed: 0, expiredFactIds: [] as string[] };
      for (const f of await factsRepo.listSweepDue(brandId, at, tx)) {
        const approved = f.state === 'approved';
        const expiring =
          approved && f.validUntil !== null && f.validUntil <= at && f.expiryNotifiedAt === null;
        const due = approved && f.reviewDueAt !== null && f.reviewDueAt <= at && f.reviewFlaggedAt === null;
        await factsRepo.update(
          f.id,
          f.version,
          {
            ...(expiring ? { expiryNotifiedAt: at } : {}),
            ...(due ? { reviewFlaggedAt: at } : {}),
            ...(f.dedupeKey === null ? { dedupeKey: factDedupeKey(f.statement) } : {}),
          },
          tx,
        );
        if (f.dedupeKey === null) result.keyed += 1;
        if (due) {
          result.reviewDue += 1;
          await audit.record(
            actor,
            'brand.fact.review_due',
            { type: 'approved_fact', id: f.id },
            'allowed',
            tx,
            {
              brandId,
              reviewDueAt: f.reviewDueAt?.toISOString() ?? null,
            },
          );
        }
        if (!expiring) continue;
        result.expired += 1;
        await audit.record(actor, 'brand.fact.expire', { type: 'approved_fact', id: f.id }, 'allowed', tx, {
          brandId,
          validUntil: f.validUntil?.toISOString() ?? null,
        });
        result.expiredFactIds.push(f.id);
        await outbox.add(
          'brand.fact_expired',
          { type: 'approved_fact', id: f.id, version: f.version + 1 },
          {
            factId: f.id,
            kind: f.kind,
            previousState: f.state,
            validUntil: f.validUntil?.toISOString() ?? null,
            cause: 'expired',
            actorKind: actor.kind,
            actorId: actor.id,
          },
          tx,
          { brandId },
        );
      }
      return result;
    },
  },

  objectives: {
    /** Creates the objective and closes every still-open one at the new activeFrom (one active objective at a time). */
    async set(actor: ResolvedActor, input: z.infer<typeof ObjectiveSet>, tx: Tx) {
      const parsed = ObjectiveSet.parse(input);
      const brand = await brandsRepo.lock(parsed.brandId, tx);
      // The active objective feeds every agent snapshot: setting it is a person's decision.
      assertMayDecide(await policy.assert(actor, 'brand.edit_standards', brandResource(brand), {}, tx));
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
      const document = PolicyDocumentV1.parse({
        ...parsed.document,
        requireDistinctApprover: parsed.document.requireDistinctApprover ?? brand.classification === 'client',
      });
      // D-13: `flag` keeps approvals across a brand version, which needs approval binding v2; not enabled yet.
      if (document.onBrandVersionPublished === 'flag')
        throw new ValidationFailedError([
          {
            path: 'document.onBrandVersionPublished',
            issue:
              'flag is designed but not enabled: approvals are bound to the published brand version (D-13)',
          },
        ]);
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
    return snapshotOf(brand, version, tx);
  },

  /**
   * The approved baseline an onboarding run starts from: the published snapshot, or, for a brand with nothing
   * published yet, the empty document as version 0 (`unpublished`). Never a draft: drafts are not approved
   * constraints, and what the run reads from a draft reaches it as untrusted evidence.
   */
  async resolveBaselineSnapshot(
    actor: ResolvedActor,
    input: { brandId: string },
    tx?: Tx,
  ): Promise<BrandSnapshot> {
    const brand = await brandsRepo.getById(input.brandId, tx);
    await policy.assert(actor, 'brand.read', brandResource(brand), {}, tx);
    const published = await versionsRepo.findPublished(brand.id, tx);
    return snapshotOf(
      brand,
      published ?? { id: UNPUBLISHED_VERSION_ID, number: 0, document: emptyBrandSystemDocument() },
      tx,
    );
  },

  guidelines: {
    /**
     * Imports a brand skill (Agent Skills package) as a new draft version: the draft starts from the published
     * document, carries the package's text as its guidelines, and adds the colours its tables state. People only;
     * the importer is recorded as the guidelines' author (brand_guideline_authors) and may publish the draft
     * themselves (the owner's decision, 2 October 2026). Skipped files are reported, never stored.
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
   * Spec 8.2: onboarding starts a brand_onboarding agent run over the guidelines imported into a draft. The run
   * reads them as untrusted evidence and proposes the draft's voice and vocabulary (brand.proposeVoice); it never
   * publishes. The brief records the target draft and the voice it started from, so the proposal lands only on that
   * draft and only while nobody has edited its voice since. Website captures are not available yet and are refused.
   */
  async startOnboarding(actor: ResolvedActor, input: z.infer<typeof OnboardingStart>, tx: Tx) {
    const parsed = OnboardingStart.parse(input);
    await assertTenantCapability('agent_run', tx); // an onboarding run calls a model
    if (parsed.websiteUrls.length)
      throw new ValidationFailedError([
        {
          path: 'websiteUrls',
          issue: 'website captures are not available yet; import the guidelines instead',
        },
      ]);
    const brand = await brandsRepo.getById(parsed.brandId, tx);
    const v = await loadVersion(brand.id, parsed.versionId, tx);
    await policy.assert(
      actor,
      'brand.edit_standards',
      { type: 'brand_version', tenantId: brand.tenantId, brandId: brand.id, id: v.id, state: v.state },
      {},
      tx,
    );
    if (v.state !== 'draft')
      throw new ValidationFailedError([
        { path: 'versionId', issue: 'onboarding proposes into a draft only' },
      ]);
    const document = BrandSystemDocumentV1.parse(v.document);
    const evidence = guidelinesEvidence(document);
    if (!evidence.length)
      throw new ValidationFailedError([
        { path: 'versionId', issue: 'the draft has no imported guidelines to read' },
      ]);
    const started = await onboardingRuns().start(
      actor,
      {
        brandId: brand.id,
        servicePrincipalId: parsed.servicePrincipalId,
        brief: {
          brandVersionId: v.id,
          baseVoiceHash: hashCanonical(document.voice),
          sourceAssetIds: parsed.sourceAssetIds,
          websiteUrls: [],
          ...(parsed.notes ? { notes: parsed.notes } : {}),
          evidence,
        },
      },
      tx,
    );
    await audit.record(
      actorRef(actor),
      'brand.onboarding.start',
      { type: 'brand_version', id: v.id },
      'allowed',
      tx,
      { brandId: brand.id, runId: started.runId, count: evidence.length },
    );
    return { ...started, versionId: v.id };
  },

  /**
   * The onboarding run's proposal (tool brand.proposeVoice): replaces the voice of the draft named in the run's
   * brief, as the run's principal, through the same policy as any draft edit. Refused when the run is not an
   * onboarding run of this brand, when the draft left `draft`, or when its voice changed since the run started
   * (a person's edit is never overwritten). Publishing stays a person's decision (propose_only). `autonomyMode` is
   * the run's mode, as for every agent write.
   */
  async proposeVoice(
    actor: ResolvedActor,
    input: { brandId: string; runId: string; voice: BrandVoiceProposal },
    tx: Tx,
    opts: { autonomyMode?: AutonomyMode } = {},
  ) {
    const voice = BrandVoiceProposal.parse(input.voice);
    const run = await onboardingRuns().get(actor, input.runId, tx);
    if (run.brandId !== input.brandId || run.taskKind !== ONBOARDING_TASK_KIND)
      throw new PolicyDeniedError('not_an_onboarding_run', 'Only a brand onboarding run proposes a voice');
    const versionId = typeof run.brief['brandVersionId'] === 'string' ? run.brief['brandVersionId'] : null;
    const baseVoiceHash = typeof run.brief['baseVoiceHash'] === 'string' ? run.brief['baseVoiceHash'] : null;
    if (!versionId || !baseVoiceHash)
      throw new PolicyDeniedError('not_an_onboarding_run', 'The run names no draft to propose into');
    const brand = await brandsRepo.getById(input.brandId, tx);
    const v = await loadVersion(brand.id, versionId, tx);
    await policy.assert(
      actor,
      'brand.edit_standards',
      { type: 'brand_version', tenantId: brand.tenantId, brandId: brand.id, id: v.id, state: v.state },
      opts,
      tx,
    );
    if (v.state !== 'draft')
      throw new ValidationFailedError([{ path: 'voice', issue: 'the draft is no longer a draft' }]);
    const current = BrandSystemDocumentV1.parse(v.document);
    // A person changed the voice after the run started: their edit wins (CONFLICT, like any stale edit).
    if (hashCanonical(current.voice) !== baseVoiceHash)
      throw new ConflictError('BrandVersion', v.id, v.version);
    const document = BrandSystemDocumentV1.parse({
      ...current,
      voice: mergeProposedVoice(current.voice, voice),
    });
    const contentHash = hashCanonical(document);
    await versionsRepo.update(v.id, v.version, { document, contentHash }, tx);
    await audit.record(
      actorRef(actor),
      'brand.version.propose_voice',
      { type: 'brand_version', id: v.id },
      'allowed',
      tx,
      {
        brandId: brand.id,
        runId: input.runId,
        count: voice.preferredTerms.length + voice.prohibitedPhrases.length,
      },
    );
    return { versionId: v.id, version: v.version + 1, contentHash };
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
