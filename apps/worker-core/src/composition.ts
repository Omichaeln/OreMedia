import {
  registerBrandChecker,
  MembershipRepository,
  ServicePrincipalRepository,
} from '@oremedia/module-access';
import {
  experimentsService,
  registerExperimentListener,
  registerRecommendationResolver,
} from '@oremedia/module-experiments';
import {
  intelligenceService,
  intelligenceToolSource,
  registerAnalystTargetSource,
  registerExperimentDesigner,
  registerExperimentSource,
  registerIntelligenceOutboxRoutes,
  registerMetricsSource,
  registerPublicationVolumeSource,
} from '@oremedia/module-intelligence';
import { IMAGE_CREATIVE_KINDS } from '@oremedia/contracts/assets';
import { runInTenant } from '@oremedia/db';
import { registerOperationsOutboxRoutes, registerRetentionTenantSource } from '@oremedia/module-operations';
import { registerDeletionHandlers, registerRetentionHandlers } from './deletion-handlers';
import {
  cmsCapabilities,
  configureSourceActivation,
  destinationArticles,
  destinationService,
  registerDestinationOutboxRoutes,
  registerFindingWork,
  sourceActivationFromEnv,
  sourceCapabilities,
  sweepDisconnectedDestinationCredentials,
} from '@oremedia/module-destinations';
import { assetService, registerAssetOutboxRoutes, uploadsCapability } from '@oremedia/module-assets';
import { registerUsageCounters } from '@oremedia/module-billing';
import {
  brandService,
  registerBrandAssetKindSource,
  registerChannelKeySource,
  registerBrandAssetVersionSource,
  registerOnboardingRunSource,
  registerBrandChangeImpactSource,
  registerEligibleTemplateSource,
  registerAssistModelGate,
  registerBrandOutboxRoutes,
} from '@oremedia/module-brand';
import {
  configureGenerationPricing,
  creativeService,
  registerAssetAuthoriser,
  registerChannelCapabilitySource,
  registerGenerationAssetSource,
  registerCreativeAssetCatalog,
  registerVideoAiAssetSource,
  registerVideoAiCapabilitySource,
  configureVideoAiPricing,
  registerExportSigner,
  registerCreativeOutboxRoutes,
} from '@oremedia/module-creative';
import {
  agentsService,
  onboardingRunSource,
  durableProviderJobStore,
  registerAgentOutboxRoutes,
} from '@oremedia/module-agents';
import {
  registerBrandChecker as registerSkillBrandChecker,
  registerEvaluationRunner,
  registerSkillOutboxRoutes,
  skillsService,
} from '@oremedia/module-skills';
import {
  brandAssistModelGate,
  createEvaluationRunnerFromEnv,
  createOpenRouterImageGeneratorFromEnv,
  createOpenRouterSpeechGeneratorFromEnv,
  createOpenRouterVideoGeneratorFromEnv,
  createReleaseOneRegistry,
  modelsCapability,
  registerContentToolSource,
  registerImageGenerator,
  registerIntelligenceToolSource,
  registerProviderJobStore,
  registerPublishingToolSource,
  registerReviewToolSource,
  registerRoutingPolicySource,
  registerSkillResolver,
  registerSpeechGenerator,
  registerVideoGenerator,
  IMAGE_COST_MICROS,
  createVideoAiCapabilitySource,
  estimateCostMicros,
  modelConfigFromEnv,
} from '@oremedia/ai';
import {
  contentService,
  contentToolSource,
  registerAttributeCapturer,
  registerCalendarSource,
  registerChannelResolver,
  registerDestinationResolver,
  registerLinkTracker,
  registerVariantValidator,
} from '@oremedia/module-content';
import {
  attributeService,
  configureLinkTracking,
  linkService,
  linkTrackingFromEnv,
  registerMeasurementBrandChecker,
  registerMeasurementPublicationSource,
  registerMeasurementOutboxRoutes,
  metricService,
  registerCommentSink,
} from '@oremedia/module-measurement';
import {
  registerReleaseCheckers,
  registerReviewOutboxRoutes,
  reviewService,
  reviewToolSource,
} from '@oremedia/module-review';
import { registerCommunityOutboxRoutes } from '@oremedia/module-community';
import { SEO_FINDING_WORK_TYPE } from '@oremedia/contracts/seo-audit';
import type { CapabilityCheck } from '@oremedia/observability';
import {
  channelService,
  publicationService,
  publishingToolSource,
  registerProviderClients,
  registerRevisionVariantSource,
  providerClientsFromEnv,
  channelCapabilities,
  configureChannelActivation,
  channelActivationFromEnv,
  registerPublishingOutboxRoutes,
  registerPublishMediaSource,
  registerApprovalConsumer,
  registerReleaseEvaluator,
  registerVariantSource,
  registerWorkflowProbe,
  registerDisconnectedCredentialSweep,
  registerPublishingBrandChecker,
  registerDestinationPublisher,
  type WorkflowProbe,
  providerRegistryInUse,
} from '@oremedia/module-publishing';

/**
 * Wires cross-module hooks so modules never import each other's tables (same shape as apps/api/src/composition.ts),
 * plus the outbox routes that map events to workflow starts. Called by main and by tests.
 */
export function composeModules(opts: { workflowProbe?: WorkflowProbe } = {}): void {
  registerBrandChecker({
    assertExist: (ids, tx) => brandService.assertExist(ids, tx),
    assertValidGrantBrands: (ids, tx) => brandService.assertValidGrantBrands(ids, tx),
  });
  const memberships = new MembershipRepository();
  registerUsageCounters(async (_tenantId, tx) => ({
    brands: await brandService.count(tx),
    seats: await memberships.countActive(tx),
    channels: await channelService.countActive(tx),
  }));
  registerAssetAuthoriser(async (assetVersionId, ctx, tx) => {
    await assetService.authoriseUse(
      assetVersionId,
      ctx.purpose,
      { brandId: ctx.brandId, ...(ctx.kinds ? { kinds: ctx.kinds } : {}) },
      tx,
    );
  });
  // STU-2b: video documents read their sources' kind, duration, size and derivatives through the assets module.
  registerCreativeAssetCatalog({
    mediaInfo: (ids, tx) => assetService.mediaSummaries(ids, tx),
    currentVersionIds: (ids, tx) => assetService.currentVersionIds(ids, tx),
    waveforms: (ids, tx) => assetService.waveforms(ids, tx),
  });
  // STU-3: storyboards read the eligible, person-supplied assets; gaps say whether generated media could close them;
  // the job's estimate is one model call at the configured price list.
  registerVideoAiAssetSource((brandId, tx) => assetService.storyboardCandidates(brandId, tx));
  registerVideoAiCapabilitySource(createVideoAiCapabilitySource());
  const videoAiModel = modelConfigFromEnv();
  configureVideoAiPricing({
    modelCallMicros: estimateCostMicros(videoAiModel, {
      inputTokens: 12_000,
      outputTokens: videoAiModel.maxOutputTokens,
    }),
  });
  registerExportSigner((storageKey) => assetService.signStorageKey(storageKey));
  registerAssetOutboxRoutes();
  registerCreativeOutboxRoutes();
  registerSkillOutboxRoutes();
  // Spec 12: agent runs start and are signalled through the outbox; the context resolver pins skills (spec 12.3).
  registerSkillBrandChecker({ assertExist: (ids, tx) => brandService.assertExist(ids, tx) });
  registerAgentOutboxRoutes();
  // BSC-4: brand.assist_requested / brand.assist_cancel_requested → brandAssistWorkflowV1 (and its relay) on `agents`;
  // the assist runtime reads the deployment's model and the tenant's routing policy through the gate.
  registerBrandOutboxRoutes();
  registerAssistModelGate(brandAssistModelGate());
  // Spec 12.2 / 12.7: provider job ids survive a worker restart; the tenant's stored routing policy gates every call.
  // Only here: agent runs (the only callers with a run row for fk_provider_job_run) dispatch tools in this process.
  // The API's surface path (MCP, spec 7.6 / 12.4) never reaches a provider job: the only tool that submits one,
  // images.generate, is outside MCP_TOOLS (denied tool_not_allowed) and costed, and a surface call has no budget
  // reservation (denied no_budget_reservation before the tool runs). So the API keeps the in-memory default.
  registerProviderJobStore(durableProviderJobStore());
  registerRoutingPolicySource((tenantId) => agentsService.routingPolicy.storedFor(tenantId));
  registerSkillResolver((input, tx) =>
    skillsService.resolveForRun(input.actor, { brandId: input.brandId, taskKind: input.taskKind }, tx),
  );
  // Spec 19.6: sandbox evaluations run here, not in the API (adapters come from the environment on first use).
  registerEvaluationRunner(createEvaluationRunnerFromEnv(createReleaseOneRegistry()));
  // Spec 14: publications start and are signalled through the outbox on task queue `core`; the runtime reads
  // variants and the release decision through hooks (the worker's KMS may decrypt: publishing-worker.ts).
  registerPublishingOutboxRoutes();
  // R2-3: destination.registered with a secret to verify → destinationVerifyWorkflowV1 on task queue `core`.
  registerDestinationOutboxRoutes();
  // Spec 8.2: brand.version_published / brand.fact_revoked → brandChangeImpactWorkflowV1 on task queue `core`.
  registerReviewOutboxRoutes();
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
  registerCalendarSource((brandId, from, to, tx) => publicationService.calendarRange(brandId, from, to, tx));
  registerProviderClients(providerClientsFromEnv());
  // Ledger R2-1: the sources this deployment refreshes (app credentials present, not disabled).
  configureSourceActivation(sourceActivationFromEnv());
  // RA-01: the channels this deployment connects (not disabled, app credentials present), and the facts behind it.
  configureChannelActivation(channelActivationFromEnv());
  registerWorkflowProbe(opts.workflowProbe ?? null);
  // RA-01: the publication sweeper's shred floor covers disconnected destinations too (destinations runtime).
  registerDisconnectedCredentialSweep(sweepDisconnectedDestinationCredentials);
  // Spec 15: measurement.collection_due starts the collection on worker-ingest's queues; variant links and
  // creative attributes are captured here too because agents run content commands in this process.
  registerMeasurementOutboxRoutes();
  registerMeasurementBrandChecker({ assertExist: (ids, tx) => brandService.assertExist(ids, tx) });
  // UX-11 / UX-12: every publication of a window (read to the end: the rollups aggregate the whole population).
  registerMeasurementPublicationSource((brandId, from, to, tx) =>
    publicationService.calendarRangeAll(brandId, from, to, tx),
  );
  // Comment inbox: community.reply_requested starts communityReplyWorkflowV1 on `core`.
  registerCommunityOutboxRoutes();
  configureLinkTracking(linkTrackingFromEnv());
  registerLinkTracker((input, tx) => linkService.trackVariantLinks(input, tx));
  registerAttributeCapturer(async (input, tx) => {
    await attributeService.capture(input, tx);
  });
  // Spec 16: intelligence.analysis_due → brandAnalystWorkflowV1 on `core`; the analyst's tools reach the module
  // through the generic registry hook; metrics, experiments and publication volume arrive through hooks; the
  // experiments module reports milestones for the learning record; ingested comments feed the voice library.
  registerIntelligenceOutboxRoutes();
  registerIntelligenceToolSource(intelligenceToolSource);
  // Spec 12.4: content.createBrief / content.draftCopy, review.request and publications.proposeSchedule reach their
  // modules through the same generic registry hooks; spec 8.3: the brand snapshot lists approved template versions.
  registerContentToolSource(contentToolSource);
  registerReviewToolSource(reviewToolSource);
  registerPublishingToolSource(publishingToolSource);
  // ADR-11: images.generate reaches OpenRouter when IMAGE_GEN_PROVIDER=openrouter; its output enters asset ingest.
  const imageGenerator = createOpenRouterImageGeneratorFromEnv();
  if (imageGenerator) registerImageGenerator(imageGenerator);
  // videos.generate likewise with VIDEO_GEN_PROVIDER=openrouter, and only for tenants with creative.video_generation.
  const videoGenerator = createOpenRouterVideoGeneratorFromEnv();
  if (videoGenerator) registerVideoGenerator(videoGenerator);
  // speech.generate likewise with SPEECH_GEN_PROVIDER=openrouter, and only for tenants with creative.audio_generation.
  const speechGenerator = createOpenRouterSpeechGeneratorFromEnv();
  if (speechGenerator) registerSpeechGenerator(speechGenerator);
  registerRevisionVariantSource((contentRevisionId, tx) =>
    contentService.revisions.withVariants(contentRevisionId, tx),
  );
  registerEligibleTemplateSource((brandId, tx) => creativeService.templates.eligibleVersionIds(brandId, tx));
  // STU-1b: generation reads the eligible assets, the channel capability register in use and its price list.
  registerGenerationAssetSource(async (brandId, tx) =>
    (
      await assetService.findEligibleAssets(
        // STU-2b: `creative` also covers video and audio; generation fills image areas with stills only.
        { brandId, purpose: 'creative', channelConnectionIds: [], kinds: [...IMAGE_CREATIVE_KINDS] },
        { limit: 200 },
        tx,
      )
    ).items.map((a) => ({
      assetId: a.assetId,
      assetVersionId: a.assetVersionId,
      kind: a.kind,
      altText: a.altText,
      semanticRole: a.semanticRole,
    })),
  );
  registerChannelCapabilitySource(() =>
    providerRegistryInUse()
      .list()
      .map((p) => p.capability),
  );
  const generationModel = modelConfigFromEnv();
  configureGenerationPricing({
    modelCallMicros: estimateCostMicros(generationModel, {
      inputTokens: 12_000,
      outputTokens: generationModel.maxOutputTokens,
    }),
    imageMicros: IMAGE_COST_MICROS,
  });
  registerBrandAssetKindSource((brandId, assetIds, tx) => assetService.kindsForBrand(brandId, assetIds, tx));
  // BSC-1: guidance names the channels of the registry publishing uses (the one channels.limits reads).
  registerChannelKeySource(() =>
    providerRegistryInUse()
      .list()
      .map((p) => p.key),
  );
  registerBrandAssetVersionSource((brandId, ids, tx) => assetService.assetsOfVersions(brandId, ids, tx));
  // Spec 8.2: brand onboarding starts an agent run; its proposal tool reads the run's brief through the same source.
  registerOnboardingRunSource(onboardingRunSource);
  // UX-20 (D-13): what publishing a brand version reaches, from the review and publishing modules.
  registerBrandChangeImpactSource(async (brandId, tx) => {
    const scope = await reviewService.approvals.brandChangeScope(brandId, tx);
    const publications = await publicationService.scheduledForBrand(brandId, tx);
    return { ...scope, truncated: scope.truncated || publications.length >= 200, publications };
  });
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
  // Spec 17.5: operations.deletion_requested → deletionRequestWorkflowV1 on `core`; each module's rows, objects and
  // credentials are removed by the handlers registered here; the daily retention sweep visits every tenant with an
  // active brand and applies the TTL handlers.
  registerOperationsOutboxRoutes();
  registerDeletionHandlers();
  registerRetentionHandlers();
  registerRetentionTenantSource(async (correlationId) =>
    (await brandService.listActiveAcrossTenants('retention-sweep', correlationId)).map((r) => r.tenantId),
  );
  // Spec 16.3 weekly sweep / 16.8 monthly comparison: every active brand whose tenant has an active agent
  // principal granted agent.start_run and insight.manage (the analyst principal); brands without one are skipped.
  const principals = new ServicePrincipalRepository();
  registerAnalystTargetSource(async (correlationId) => {
    const refs = await brandService.listActiveAcrossTenants('brand-analyst-sweep', correlationId);
    const targets = [];
    const byTenant = new Map<string, string | null>();
    for (const ref of refs) {
      if (!byTenant.has(ref.tenantId)) {
        const found = await runInTenant(
          {
            tenantId: ref.tenantId,
            actor: { kind: 'service_principal', id: 'brand-analyst-sweep' },
            brandIds: 'all',
            correlationId,
          },
          async () =>
            (await principals.list()).find(
              (p) =>
                p.kind === 'agent' &&
                p.status === 'active' &&
                p.grants.some((g) => g.action === 'agent.start_run') &&
                p.grants.some((g) => g.action === 'insight.manage'),
            ) ?? null,
        );
        byTenant.set(ref.tenantId, found?.id ?? null);
      }
      const servicePrincipalId = byTenant.get(ref.tenantId);
      if (servicePrincipalId)
        targets.push({ tenantId: ref.tenantId, brandId: ref.brandId, servicePrincipalId });
    }
    return targets;
  });
}

/**
 * What the startup configuration report checks for worker-core (docs/runbooks/deploy-railway.md, "Configuration
 * report"): uploads (publishing copies media to release keys, deletion removes objects), every provider's app
 * credentials (publishing and token refresh), every source's (the daily destination refresh) and the models
 * (agents, generators).
 */
export const workerCoreCapabilities = (env: NodeJS.ProcessEnv = process.env): CapabilityCheck[] => [
  uploadsCapability,
  ...channelCapabilities(env),
  ...sourceCapabilities(env),
  ...cmsCapabilities(env),
  modelsCapability,
];
