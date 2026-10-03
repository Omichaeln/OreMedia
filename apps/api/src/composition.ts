import type { AssetKind } from '@oremedia/contracts/assets';
import { registerBrandChecker, MembershipRepository } from '@oremedia/module-access';
import {
  experimentsService,
  registerExperimentArmLinks,
  registerExperimentListener,
  registerRecommendationResolver,
} from '@oremedia/module-experiments';
import {
  intelligenceService,
  intelligenceToolSource,
  registerExperimentDesigner,
  registerExperimentSource,
  registerMetricsSource,
  registerPublicationVolumeSource,
} from '@oremedia/module-intelligence';
import { assetService, uploadsCapability } from '@oremedia/module-assets';
import { registerUsageCounters } from '@oremedia/module-billing';
import {
  brandService,
  registerBrandAssetKindSource,
  registerBrandAssetVersionSource,
  registerOnboardingRunSource,
  registerBrandChangeImpactSource,
  registerEligibleTemplateSource,
} from '@oremedia/module-brand';
import {
  creativeService,
  registerAssetAuthoriser,
  registerRevisionChangeHook,
} from '@oremedia/module-creative';
import {
  registerAttributeCapturer,
  registerCalendarSource,
  registerChannelResolver,
  registerDestinationResolver,
  registerLinkTracker,
  registerRevisionChangeListener,
  registerVariantValidator,
  contentService,
  contentToolSource,
} from '@oremedia/module-content';
import {
  cmsCapabilities,
  configureSourceActivation,
  destinationArticles,
  destinationService,
  registerFindingWork,
  sourceActivationFromEnv,
  sourceCapabilities,
} from '@oremedia/module-destinations';
import {
  attributeService,
  configureLinkTracking,
  linkService,
  linkTrackingFromEnv,
  metricService,
  registerCommentSink,
  registerMeasurementBrandChecker,
  registerMeasurementPublicationSource,
} from '@oremedia/module-measurement';
import {
  channelService,
  configureCredentialBroker,
  createKmsFromEnv,
  publicationService,
  publishingToolSource,
  registerProviderClients,
  providerClientsFromEnv,
  channelCapabilities,
  configureChannelActivation,
  channelActivationFromEnv,
  registerPublishMediaSource,
  registerRevisionVariantSource,
  registerApprovalConsumer,
  registerReleaseEvaluator,
  registerVariantSource,
  registerPublishingBrandChecker,
  registerDestinationPublisher,
} from '@oremedia/module-publishing';
import {
  registerAssetAuthoriser as registerReleaseAssetAuthoriser,
  registerReleaseCheckers,
  registerReviewImageSigner,
  registerReviewMediaSigner,
  reviewService,
  reviewToolSource,
} from '@oremedia/module-review';
import { registerBrandChecker as registerSkillBrandChecker, skillsService } from '@oremedia/module-skills';
import {
  registerContentToolSource,
  registerIntelligenceToolSource,
  registerPublishingToolSource,
  registerReviewToolSource,
  registerRoutingPolicySource,
  registerSkillResolver,
} from '@oremedia/ai';
import { agentsService, onboardingRunSource } from '@oremedia/module-agents';
import { SEO_FINDING_WORK_TYPE } from '@oremedia/contracts/seo-audit';
import type { CapabilityCheck } from '@oremedia/observability';
import { webOriginCapability } from './web-origin';

/** Wires cross-module hooks so modules never import each other's tables. Called by main and by tests. */
export function composeModules(): void {
  registerBrandChecker({
    assertExist: (ids, tx) => brandService.assertExist(ids, tx),
    assertValidGrantBrands: (ids, tx) => brandService.assertValidGrantBrands(ids, tx),
  });
  // Skills validate brand ids the same way (spec 4.2: the skills module never reads the brand tables).
  registerSkillBrandChecker({ assertExist: (ids, tx) => brandService.assertExist(ids, tx) });
  const memberships = new MembershipRepository();
  registerUsageCounters(async (_tenantId, tx) => ({
    brands: await brandService.count(tx),
    seats: await memberships.countActive(tx),
    channels: await channelService.countActive(tx),
  }));
  // Spec 11.4 guardAssets: every asset version an operation introduces is authorised for its purpose.
  registerAssetAuthoriser(async (assetVersionId, ctx, tx) => {
    await assetService.authoriseUse(assetVersionId, ctx.purpose, { brandId: ctx.brandId }, tx);
  });
  // Spec 12.3: the context resolver pins skill versions through the skills module. Spec 19.6: evaluation suites
  // are graded by worker-core (skillEvaluationWorkflowV1), never inside an API transaction.
  registerSkillResolver((input, tx) =>
    skillsService.resolveForRun(input.actor, { brandId: input.brandId, taskKind: input.taskKind }, tx),
  );
  // Spec 12.7: agents.runs.start checks the tenant's stored model-routing policy before a run is created.
  registerRoutingPolicySource((tenantId) => agentsService.routingPolicy.storedFor(tenantId));
  // No durable provider job store here (worker-core registers it for agent runs): an MCP surface call never submits
  // a provider job, since images.generate and the videos tools are outside MCP_TOOLS and costed tools are denied
  // without a run's budget reservation (no_budget_reservation) before they run; a surface call has no agent_runs row
  // for provider_jobs.
  // Spec 11.4 / 13.2: approvals are invalidated eagerly when a creative document or a content revision changes.
  registerRevisionChangeHook((documentId, tx) =>
    reviewService.approvals.invalidateForCreativeRevisionChange(documentId, tx),
  );
  registerRevisionChangeListener((change, tx) => reviewService.onContentRevisionChange(change, tx));
  // Spec 13.4 assets_rights_valid: every asset an export was rendered from is re-authorised at dispatch.
  registerReleaseAssetAuthoriser(async (assetVersionId, ctx, tx) => {
    await assetService.authoriseUse(
      assetVersionId,
      ctx.purpose,
      {
        brandId: ctx.brandId,
        channelConnectionIds: ctx.channelConnectionIds,
        scheduledFor: ctx.scheduledFor,
        ...(ctx.kinds ? { kinds: ctx.kinds as AssetKind[] } : {}),
        ...(ctx.mimes ? { mimes: ctx.mimes } : {}),
      },
      tx,
    );
  });
  // Spec 14.1 / 13.4 / 14.7: the publishing module reads variants and the release decision through hooks; the
  // content and review modules read channels and the checks the publishing module owns the same way. The API
  // process seals credentials but can never open them (WrapOnlyKms, spec 14.7).
  registerPublishingBrandChecker({ assertExist: (ids, tx) => brandService.assertExist(ids, tx) });
  registerVariantSource((variantId, tx) => contentService.variants.read(variantId, tx));
  registerReleaseEvaluator((pub, at, tx) => reviewService.evaluateRelease(pub, at, tx));
  // Spec 13.1: a release approval is spent (valid → consumed) with the publication it authorised.
  registerApprovalConsumer(async (approvalId, publicationId, publishedChannelConnectionIds, tx) => {
    await reviewService.approvals.consume(approvalId, tx, publicationId, publishedChannelConnectionIds);
  });
  // Spec 9.3 / 14.5: the exports a variant publishes, as signed release URLs minted at dispatch. The creative
  // module reads the export rows; the assets module re-verifies the bytes against the pinned hash (spec 3.g4)
  // and mints the URL for the provider's processing window.
  registerPublishMediaSource({
    // STU-2a: a video export carries its duration and frame rate (null on stills) for the capability check.
    describe: async (variant, tx) =>
      (await creativeService.renders.exportsByIds(variant.brandId, variant.exportIds, tx)).map(
        ({ durationMs, fps, ...e }) => ({
          ...e,
          ...(durationMs !== null ? { durationMs } : {}),
          ...(fps !== null ? { fps } : {}),
        }),
      ),
    release: async (variant, { providerProcessingWindowSec }, tx) => {
      const media = [];
      for (const e of await creativeService.renders.exportsByIds(variant.brandId, variant.exportIds, tx))
        media.push(
          await assetService.releaseExport(
            { ...e, brandId: variant.brandId, exportId: e.id },
            providerProcessingWindowSec,
            tx,
          ),
        );
      return media;
    },
  });
  registerReleaseCheckers({
    channelUsable: (channelConnectionId, tx) => channelService.channelUsable(channelConnectionId, tx),
    // R2-3: a destination target stands in for the channel; its write needs the brand's source-use policy (D-17).
    destinationUsable: async (destinationId, tx) =>
      (await destinationArticles.describe(destinationId, tx))?.usable ?? false,
    destinationWriteAllowed: async (destinationId, tx) => {
      const d = await destinationArticles.describe(destinationId, tx);
      return d ? destinationArticles.useAllowed(d.brandId, d.kind, 'write', tx) : false;
    },
    validateVariant: (channelVariantId, tx) => channelService.validateVariant(channelVariantId, tx),
    countForMandateOnDay: (mandateId, at, tx) => publicationService.countForMandateOnDay(mandateId, at, tx),
    publishedElsewhereForApprovalChannel: (approvalId, channelConnectionId, exceptPublicationId, tx) =>
      publicationService.publishedElsewhereForApprovalChannel(
        approvalId,
        channelConnectionId,
        exceptPublicationId,
        tx,
      ),
  });
  registerChannelResolver((channelConnectionId, tx) => channelService.describe(channelConnectionId, tx));
  // R2-3: a website as a variant target (content) and the publisher behind it (publishing); the API registers the
  // publisher for the description, the draft check and the credential-free rendered validation, while a write
  // only ever runs where the broker may open the destination's secret (worker-core).
  registerDestinationResolver((destinationId, tx) => destinationService.describe(destinationId, tx));
  registerDestinationPublisher(destinationArticles);
  registerVariantValidator((variant, tx) => channelService.validateVariantDraft(variant, tx));
  // Spec 13.3: the review inbox and portal show the frozen files; the assets module's storage signs the GETs.
  registerReviewMediaSigner((storageKey) => assetService.signStorageKey(storageKey));
  // RA-09: a frozen article's images (asset versions) are shown the same way, request-bound for a reviewer.
  registerReviewImageSigner((assetVersionId, tx) => assetService.signVersionPreview(assetVersionId, tx));
  registerCalendarSource((brandId, from, to, tx) => publicationService.calendarRange(brandId, from, to, tx));
  registerProviderClients(providerClientsFromEnv());
  // Ledger R2-1: the sources this deployment connects (app credentials present, not disabled).
  configureSourceActivation(sourceActivationFromEnv());
  // RA-01: the channels this deployment connects (not disabled, app credentials present), and the facts behind it.
  configureChannelActivation(channelActivationFromEnv());
  // Spec 15.4 / 16.2: variant links are tracked and creative attributes captured at creation (measurement hooks).
  registerMeasurementBrandChecker({ assertExist: (ids, tx) => brandService.assertExist(ids, tx) });
  // UX-11 / UX-12: every publication of a window (read to the end: the rollups aggregate the whole population).
  registerMeasurementPublicationSource((brandId, from, to, tx) =>
    publicationService.calendarRangeAll(brandId, from, to, tx),
  );
  configureLinkTracking(linkTrackingFromEnv());
  registerLinkTracker((input, tx) => linkService.trackVariantLinks(input, tx));
  // Spec 16.6: a randomised link experiment's arm links at start and its exposures from the redirector's clicks.
  registerExperimentArmLinks({
    create: (input, tx) => linkService.trackExperimentArms(input, tx),
    exposures: (brandId, experimentId, tx) => linkService.experimentExposures(brandId, experimentId, tx),
  });
  registerAttributeCapturer(async (input, tx) => {
    await attributeService.capture(input, tx);
  });
  // Spec 16: the intelligence module reads metrics, experiments and publication volume through hooks; the
  // experiments module reports milestones for the learning record; ingested comments feed the voice library.
  registerMetricsSource(async (actor, query, tx) => {
    const publications = await publicationService.calendarRange(
      query.brandId,
      new Date(query.windowStart),
      new Date(query.windowEnd),
      tx,
    );
    if (publications.length === 0)
      return {
        values: [],
        coverage: {
          subjectsRequested: 0,
          subjectsWithData: 0,
          metricsRequested: query.metricKeys,
          metricsWithData: [],
          metricsUnavailable: query.metricKeys,
          staleValues: 0,
          windowStart: query.windowStart,
          windowEnd: query.windowEnd,
        },
      };
    const result = await metricService.query(
      actor,
      {
        brandId: query.brandId,
        subjectType: 'publication',
        subjectIds: publications.map((p) => p.publicationId).slice(0, 200),
        metricKeys: query.metricKeys,
        windowStart: query.windowStart,
        windowEnd: query.windowEnd,
        grouping: 'metric',
      },
      tx,
    );
    return { values: result.values, coverage: result.coverage };
  });
  registerExperimentDesigner((actor, input, tx, opts) => experimentsService.create(actor, input, tx, opts));
  registerExperimentSource((brandId, tx) => experimentsService.listForBrand(brandId, tx));
  registerPublicationVolumeSource(
    async (brandId, from, to, tx) => (await publicationService.calendarRange(brandId, from, to, tx)).length,
  );
  registerRecommendationResolver((recommendationId, brandId, tx) =>
    intelligenceService.recommendations.belongsToBrand(recommendationId, brandId, tx),
  );
  // RA-11: an SEO finding becomes tracked work as a recommendation (spec 16.4) with the finding's provenance; the
  // destinations module reads the work's title and state back the same way.
  registerFindingWork({
    create: async (actor, input, tx) => {
      const created = await intelligenceService.recommendations.createFromFinding(actor, input, tx);
      return {
        workType: SEO_FINDING_WORK_TYPE,
        workId: created.recommendationId,
        title: created.title,
        state: created.state,
      };
    },
    describe: async (brandId, workIds, tx) =>
      (await intelligenceService.recommendations.describeForBrand(brandId, workIds, tx)).map((r) => ({
        workType: SEO_FINDING_WORK_TYPE,
        workId: r.id,
        title: r.title,
        state: r.state,
      })),
  });
  registerExperimentListener((milestone, tx) =>
    intelligenceService.learning.onExperimentMilestone(milestone, tx),
  );
  registerCommentSink(async (comments, tx) => {
    for (const c of comments)
      await intelligenceService.voice.ingest(
        {
          brandId: c.brandId,
          messageId: c.messageId,
          text: c.text,
          authorHash: c.authorHash,
          remoteCreatedAt: c.remoteCreatedAt,
          ...(c.classification ? { classification: c.classification } : {}),
        },
        tx,
      );
  });
  // Spec 12.4: agent tools reach their modules through the generic registry hooks (as in worker-core, so the
  // cross-tenant harness exercises the same sources); spec 8.3: the brand snapshot lists approved template versions.
  registerIntelligenceToolSource(intelligenceToolSource);
  registerContentToolSource(contentToolSource);
  registerReviewToolSource(reviewToolSource);
  registerPublishingToolSource(publishingToolSource);
  registerRevisionVariantSource((contentRevisionId, tx) =>
    contentService.revisions.withVariants(contentRevisionId, tx),
  );
  registerEligibleTemplateSource((brandId, tx) => creativeService.templates.eligibleVersionIds(brandId, tx));
  registerBrandAssetKindSource((brandId, assetIds, tx) => assetService.kindsForBrand(brandId, assetIds, tx));
  registerBrandAssetVersionSource((brandId, ids, tx) => assetService.assetsOfVersions(brandId, ids, tx));
  // Spec 8.2: brand onboarding starts an agent run; its proposal tool reads the run's brief through the same source.
  registerOnboardingRunSource(onboardingRunSource);
  // UX-20 (D-13): what publishing a brand version reaches, from the review and publishing modules.
  registerBrandChangeImpactSource(async (brandId, tx) => {
    const scope = await reviewService.approvals.brandChangeScope(brandId, tx);
    const publications = await publicationService.scheduledForBrand(brandId, tx);
    return { ...scope, truncated: scope.truncated || publications.length >= 200, publications };
  });
  if (process.env['KMS_LOCAL_MASTER_SECRET'])
    configureCredentialBroker({ kms: createKmsFromEnv({ decrypt: false }) });
}

/**
 * What the startup configuration report checks for the api (docs/runbooks/deploy-railway.md, "Configuration
 * report"): the web origin, uploads (it signs upload and download URLs), every provider's app credentials (it
 * connects channels) and every source's (it connects destinations).
 */
export const apiCapabilities = (env: NodeJS.ProcessEnv = process.env): CapabilityCheck[] => [
  webOriginCapability,
  uploadsCapability,
  ...channelCapabilities(env),
  ...sourceCapabilities(env),
  ...cmsCapabilities(env),
];
