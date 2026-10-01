import type { ActivityHooks } from '@oremedia/contracts/agents';
import type { RenderedValidationV1 } from '@oremedia/contracts/article';
import type { ArticleReadbackV1 } from '@oremedia/contracts/destinations';
import type {
  ClientConfig,
  PublishOutcome,
  RemoteMutationOutcome,
  ValidationResult,
} from '@oremedia/contracts/providers';
import type { ChannelVariantForPublishing, PublicationForRelease } from '@oremedia/contracts/publishing';
import type { ReleaseDecision } from '@oremedia/contracts/review';
import type { Tx } from '@oremedia/db';
import type { CapabilityCheck } from '@oremedia/observability';
import { providerRegistry, type PublishMedia } from '@oremedia/providers';

/**
 * Cross-module hooks (same pattern as registerAssetAuthoriser in the creative module: modules never import each
 * other's tables). The composition root wires the content module's `contentService.variants.get`, the review
 * module's `reviewService.evaluateRelease` / `approvals.consume` and the assets module's release-URL minting; until then the defaults
 * are loud so a composition mistake cannot pass silently.
 */

/** Spec 14.1 `variants.getById`: the content module registers `contentService.variants.get`. */
export type VariantSource = (variantId: string, tx?: Tx) => Promise<ChannelVariantForPublishing>;
const unregisteredVariantSource: VariantSource = async () => {
  throw new Error('variant source not registered (composition root must call registerVariantSource)');
};
let variantSource: VariantSource = unregisteredVariantSource;
export const registerVariantSource = (fn: VariantSource): void => {
  variantSource = fn;
};
export const resetVariantSource = (): void => {
  variantSource = unregisteredVariantSource;
};
export const variants = { get: (variantId: string, tx?: Tx) => variantSource(variantId, tx) };

/**
 * Spec 12.4 publications.proposeSchedule: a content revision (tenant-scoped; a foreign id is NOT_FOUND) with its
 * channel variants. The content module registers `contentService.revisions.withVariants`.
 */
export interface RevisionWithVariants {
  id: string;
  brandId: string;
  state: string;
  variants: Array<{ id: string; channelConnectionId: string | null; destinationId: string | null }>;
}
export type RevisionVariantSource = (contentRevisionId: string, tx?: Tx) => Promise<RevisionWithVariants>;
const unregisteredRevisionVariantSource: RevisionVariantSource = async () => {
  throw new Error(
    'revision variant source not registered (composition root must call registerRevisionVariantSource)',
  );
};
let revisionVariantSource: RevisionVariantSource = unregisteredRevisionVariantSource;
export const registerRevisionVariantSource = (fn: RevisionVariantSource): void => {
  revisionVariantSource = fn;
};
export const resetRevisionVariantSource = (): void => {
  revisionVariantSource = unregisteredRevisionVariantSource;
};
export const revisions = {
  withVariants: (contentRevisionId: string, tx?: Tx) => revisionVariantSource(contentRevisionId, tx),
};

/** Spec 13.4 `review.evaluateRelease(pub, at)`: the review module registers `reviewService.evaluateRelease`. */
export type ReleaseEvaluator = (pub: PublicationForRelease, at: Date, tx?: Tx) => Promise<ReleaseDecision>;
const unregisteredReleaseEvaluator: ReleaseEvaluator = async () => {
  throw new Error('release evaluator not registered (composition root must call registerReleaseEvaluator)');
};
let releaseEvaluator: ReleaseEvaluator = unregisteredReleaseEvaluator;
export const registerReleaseEvaluator = (fn: ReleaseEvaluator): void => {
  releaseEvaluator = fn;
};
export const resetReleaseEvaluator = (): void => {
  releaseEvaluator = unregisteredReleaseEvaluator;
};
export const review = {
  evaluateRelease: (pub: PublicationForRelease, at: Date, tx?: Tx) => releaseEvaluator(pub, at, tx),
};

/**
 * Spec 13.1 approval valid → consumed once the approved release is out: the review module registers
 * `reviewService.approvals.consume`. Called in the transaction that marks the publication published, so the same
 * approval cannot authorise a second publication (another occurrence inside the timing tolerance).
 */
/**
 * An approval binds every channel target of the revision (spec 13.2), so it is spent only once every target has
 * published: the consumer receives the channels published under the approval so far (this publication included)
 * and decides; per-target reuse is refused at dispatch by the release evaluator instead.
 */
export type ApprovalConsumer = (
  approvalId: string,
  publicationId: string,
  /** The targets published so far: channel connection ids and (R2-3) destination ids, as the binding names them. */
  publishedTargetIds: string[],
  tx: Tx,
) => Promise<void>;
const unregisteredApprovalConsumer: ApprovalConsumer = async () => {
  throw new Error('approval consumer not registered (composition root must call registerApprovalConsumer)');
};
let approvalConsumer: ApprovalConsumer = unregisteredApprovalConsumer;
export const registerApprovalConsumer = (fn: ApprovalConsumer): void => {
  approvalConsumer = fn;
};
export const resetApprovalConsumer = (): void => {
  approvalConsumer = unregisteredApprovalConsumer;
};
export const approvals = {
  consume: (approvalId: string, publicationId: string, publishedChannelConnectionIds: string[], tx: Tx) =>
    approvalConsumer(approvalId, publicationId, publishedChannelConnectionIds, tx),
};

/**
 * Spec 9.3 / 14.5 PublishMedia: the exports a variant references, as the adapter needs them. `describe` serves the
 * capability check (spec 13.4 capability_valid, the schedule pre-check): dimensions, mime and bytes, nothing
 * minted. `release` serves publishOnce immediately before send: signed release URLs covering the provider's
 * processing window, the bytes re-verified against the pinned hash (spec 3.g4). Registered by the composition
 * root from the creative (export rows) and assets (release URLs) modules. A variant without exports needs no media
 * and never calls the hook. A ReleaseIntegrityError from `release` holds the publication with reason
 * export_hash_mismatch (runtime.publishOnce).
 */
export interface PublishMediaOptions {
  /** The provider's processing window (capability.media.publicUrlFetch): how long the signed URL must stay valid. */
  providerProcessingWindowSec: number;
}
export type PublishMediaDescription = Omit<PublishMedia, 'url' | 'altText'>;
export interface PublishMediaSource {
  describe(variant: ChannelVariantForPublishing, tx?: Tx): Promise<PublishMediaDescription[]>;
  release(variant: ChannelVariantForPublishing, opts: PublishMediaOptions, tx?: Tx): Promise<PublishMedia[]>;
}
const unregisteredMediaSource: PublishMediaSource = {
  describe: async () => {
    throw new Error(
      'publish media source not registered (composition root must call registerPublishMediaSource)',
    );
  },
  release: async () => {
    throw new Error(
      'publish media source not registered (composition root must call registerPublishMediaSource)',
    );
  },
};
let mediaSource: PublishMediaSource = unregisteredMediaSource;
export const registerPublishMediaSource = (source: PublishMediaSource): void => {
  mediaSource = source;
};
export const resetPublishMediaSource = (): void => {
  mediaSource = unregisteredMediaSource;
};
export const publishMedia = {
  describeForVariant: (variant: ChannelVariantForPublishing, tx?: Tx): Promise<PublishMediaDescription[]> =>
    variant.exportIds.length === 0 ? Promise.resolve([]) : mediaSource.describe(variant, tx),
  forVariant: (
    variant: ChannelVariantForPublishing,
    opts: PublishMediaOptions,
    tx?: Tx,
  ): Promise<PublishMedia[]> =>
    variant.exportIds.length === 0 ? Promise.resolve([]) : mediaSource.release(variant, opts, tx),
};

/**
 * Per-provider app credentials (Appendix A: PROVIDER_<KEY>_CLIENT_ID_REF / _SECRET_REF). Registered by the
 * composition root; tests register a fixture.
 */
export type ProviderClientSource = (providerKey: string) => ClientConfig;
const unregisteredClients: ProviderClientSource = (providerKey) => {
  throw new Error(
    `provider client configuration not registered for ${providerKey} (registerProviderClients)`,
  );
};
let providerClients: ProviderClientSource = unregisteredClients;
export const registerProviderClients = (fn: ProviderClientSource): void => {
  providerClients = fn;
};
export const providerClientFor = (providerKey: string): ClientConfig => providerClients(providerKey);

/** Appendix A names: PROVIDER_<KEY_UPPER>_CLIENT_ID_REF and PROVIDER_<KEY_UPPER>_SECRET_REF. */
export const providerClientSettings = (providerKey: string): { clientId: string; clientSecret: string } => {
  const upper = providerKey.toUpperCase();
  return { clientId: `PROVIDER_${upper}_CLIENT_ID_REF`, clientSecret: `PROVIDER_${upper}_SECRET_REF` };
};

export const providerClientsFromEnv =
  (env: NodeJS.ProcessEnv = process.env): ProviderClientSource =>
  (providerKey) => {
    const names = providerClientSettings(providerKey);
    const clientId = env[names.clientId];
    const clientSecret = env[names.clientSecret];
    if (!clientId || !clientSecret)
      throw new Error(`${names.clientId} and ${names.clientSecret} are required`);
    return { clientId, clientSecret };
  };

/**
 * Production may intentionally deploy only a subset of registered adapters while platform review is pending.
 * The default is fail-closed: every registered provider remains required unless its key is explicitly listed here.
 */
const disabledChannelKeys = (env: NodeJS.ProcessEnv): ReadonlySet<string> =>
  new Set(
    (env['OREMEDIA_DISABLED_CHANNELS'] ?? '')
      .split(',')
      .map((key) => key.trim().toLowerCase())
      .filter(Boolean),
  );

/**
 * Configuration report capabilities `channel:<providerKey>`, one per registered provider: the app credentials
 * providerClientsFromEnv reads. Every process that connects channels, refreshes their tokens or pulls from them
 * (api, worker-core, worker-ingest) needs both names, or that provider's work fails there.
 */
export const channelCapabilities = (env: NodeJS.ProcessEnv = process.env): CapabilityCheck[] => {
  const disabled = disabledChannelKeys(env);
  return providerRegistry
    .list()
    .filter(({ key }) => !disabled.has(key))
    .map(({ key }) => ({
      capability: `channel:${key}`,
      missing: (checkEnv) => Object.values(providerClientSettings(key)).filter((name) => !checkEnv[name]),
    }));
};

/** Brand ids named in inputs are verified through the brand module (spec 4.2), as the skills module does. */
export interface BrandChecker {
  assertExist(brandIds: string[], tx?: Tx): Promise<void>;
}
let brandChecker: BrandChecker = {
  assertExist: async () => {
    throw new Error('brand checker not registered (composition root must call registerBrandChecker)');
  },
};
export const registerBrandChecker = (c: BrandChecker): void => {
  brandChecker = c;
};
export const assertBrandExists = (brandId: string, tx?: Tx): Promise<void> =>
  brandChecker.assertExist([brandId], tx);

/**
 * The sweeper asks whether a workflow is running before it re-emits a start or declares worker loss; a process
 * that holds a Temporal client (worker-core) registers the probe. Absent, the sweeper assumes nothing is running
 * and lets the outbox start's USE_EXISTING policy absorb the duplicate.
 */
export interface WorkflowProbe {
  isRunning(workflowId: string): Promise<boolean>;
}
let workflowProbe: WorkflowProbe = { isRunning: async () => false };
export const registerWorkflowProbe = (probe: WorkflowProbe | null): void => {
  workflowProbe = probe ?? { isRunning: async () => false };
};
export const workflowRunning = (workflowId: string): Promise<boolean> => workflowProbe.isRunning(workflowId);

/**
 * Ledger R2-3: a publication whose target is a write-capable brand destination (a website) is carried out by the
 * destinations module behind this hook, as a channel's is by its provider adapter: generic code here knows a
 * target kind and an outcome, never a CMS. The composition root registers `destinationArticles` from the
 * destinations module; the API registers it too (describe, capability and the draft check run there), while only
 * the worker's broker can open the destination's secret for a write.
 */
export interface DestinationTargetDescription {
  id: string;
  brandId: string;
  kind: string;
  displayName: string;
  capabilityVersion: number;
  /** Active, with a credential, not unreachable, and with a certified, enabled adapter (spec 13.4 channel_active). */
  usable: boolean;
  /** The remote actions the kind's adapter offers on a live article. */
  actions: { edit: boolean; delete: boolean; unpublish: boolean };
}
export interface DestinationPublishInput {
  tenantId: string;
  destinationId: string;
  publicationId: string;
  attemptId: string;
  idempotencyKey: string;
  variant: ChannelVariantForPublishing;
}
/** A publish outcome with, when the write went through, the read-back and the rendered validation as evidence. */
export type DestinationPublishResult = PublishOutcome & {
  readback?: ArticleReadbackV1;
  validation?: RenderedValidationV1;
};
export interface DestinationEditInput {
  tenantId: string;
  destinationId: string;
  remoteId: string;
  /** The remote hash the product last read back; a remote that moved since is a conflict, never overwritten. */
  expectedHash: string | null;
  html: string;
  idempotencyKey: string;
}
export type DestinationMutationResult = RemoteMutationOutcome & { readback?: ArticleReadbackV1 };
export interface DestinationValidateInput {
  tenantId: string;
  destinationId: string;
  url: string;
  title: string;
  firstParagraph: string;
  draft: boolean;
}
export interface DestinationPublisher {
  /** A description, never the row; null for a foreign or unknown id (spec 4.2). */
  describe(destinationId: string, tx?: Tx): Promise<DestinationTargetDescription | null>;
  /** Spec 13.4 for a destination variant: what it will publish passes the kind's rules (an article is present…). */
  validateVariant(variant: ChannelVariantForPublishing, tx?: Tx): Promise<ValidationResult>;
  /** D-17 default deny: whether the brand's source-use policy allows the use of the kind's data type now. */
  useAllowed(brandId: string, kind: string, use: 'read' | 'write', tx?: Tx): Promise<boolean>;
  publish(
    input: DestinationPublishInput,
    hooks?: ActivityHooks,
    beforeSend?: () => Promise<void>,
  ): Promise<DestinationPublishResult>;
  edit(input: DestinationEditInput, hooks?: ActivityHooks): Promise<DestinationMutationResult>;
  unpublish(
    input: { tenantId: string; destinationId: string; remoteId: string },
    hooks?: ActivityHooks,
  ): Promise<DestinationMutationResult>;
  delete(
    input: { tenantId: string; destinationId: string; remoteId: string },
    hooks?: ActivityHooks,
  ): Promise<RemoteMutationOutcome>;
  /** Fetches the rendered page (no credential) and records what it showed; never throws for a page that fails. */
  validateRendered(input: DestinationValidateInput, hooks?: ActivityHooks): Promise<RenderedValidationV1>;
}
const unregisteredDestinationPublisher: DestinationPublisher = {
  describe: async () => {
    throw new Error(
      'destination publisher not registered (composition root must call registerDestinationPublisher)',
    );
  },
  validateVariant: async () => {
    throw new Error(
      'destination publisher not registered (composition root must call registerDestinationPublisher)',
    );
  },
  useAllowed: async () => {
    throw new Error(
      'destination publisher not registered (composition root must call registerDestinationPublisher)',
    );
  },
  publish: async () => {
    throw new Error(
      'destination publisher not registered (composition root must call registerDestinationPublisher)',
    );
  },
  edit: async () => {
    throw new Error(
      'destination publisher not registered (composition root must call registerDestinationPublisher)',
    );
  },
  unpublish: async () => {
    throw new Error(
      'destination publisher not registered (composition root must call registerDestinationPublisher)',
    );
  },
  delete: async () => {
    throw new Error(
      'destination publisher not registered (composition root must call registerDestinationPublisher)',
    );
  },
  validateRendered: async () => {
    throw new Error(
      'destination publisher not registered (composition root must call registerDestinationPublisher)',
    );
  },
};
let destinationPublisher: DestinationPublisher = unregisteredDestinationPublisher;
export const registerDestinationPublisher = (p: DestinationPublisher): void => {
  destinationPublisher = p;
};
export const resetDestinationPublisher = (): void => {
  destinationPublisher = unregisteredDestinationPublisher;
};
export const destinations: DestinationPublisher = {
  describe: (id, tx) => destinationPublisher.describe(id, tx),
  validateVariant: (variant, tx) => destinationPublisher.validateVariant(variant, tx),
  useAllowed: (brandId, kind, use, tx) => destinationPublisher.useAllowed(brandId, kind, use, tx),
  publish: (input, hooks, beforeSend) => destinationPublisher.publish(input, hooks, beforeSend),
  edit: (input, hooks) => destinationPublisher.edit(input, hooks),
  unpublish: (input, hooks) => destinationPublisher.unpublish(input, hooks),
  delete: (input, hooks) => destinationPublisher.delete(input, hooks),
  validateRendered: (input, hooks) => destinationPublisher.validateRendered(input, hooks),
};
