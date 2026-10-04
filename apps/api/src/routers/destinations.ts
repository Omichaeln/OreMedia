import {
  DestinationConnectCancel,
  DestinationConnectComplete,
  DestinationConnectSelect,
  DestinationConnectStart,
  DestinationConnectWithSecret,
  DestinationDisconnect,
  DestinationGet,
  DestinationList,
  DestinationRegister,
  DestinationReportOpportunities,
  DestinationReportRows,
  DestinationReportSummary,
  DestinationSetArticleSelector,
  DestinationSetHealth,
  SourceUseCheck,
  SourceUsePolicyList,
  SourceUsePolicySet,
} from '@oremedia/contracts/destinations';
import {
  SeoAuditCreateWork,
  SeoAuditFindings,
  SeoAuditPagesList,
  SeoAuditRun,
  SeoAuditRunsList,
  SeoAuditSummary,
} from '@oremedia/contracts/seo-audit';
import {
  destinationReportService,
  destinationService,
  seoAuditService,
  sourceUsePolicyService,
} from '@oremedia/module-destinations';
import { idempotent } from '@oremedia/module-operations';
import { router, tenantMutation, tenantQuery, type MutationCtx } from '../trpc';

const mutationCtx = (ctx: MutationCtx) => ({
  idempotency: ctx.idempotency,
  actor: { kind: ctx.tenant.actorRef.kind, id: ctx.tenant.actorRef.id },
});

/**
 * Brand destinations (R2-0): the non-social places a brand reads from or writes to, registered, health-checked and
 * disconnected by the people who hold destination.connect / destination.manage; and the source-use policy (D-17)
 * per destination kind and data type, set by an admin (source_use.manage) and asked before any ingestion or write.
 * R2-1: the connect flow that attaches a Google grant (start / complete / select / cancel, as the channel flow) and
 * the sources this deployment can connect; part B: the read model over the stored GA4 and Search Console reports
 * (summary, drill-down rows, opportunities), a restricted view under the brand's source-use policy (brand.read).
 * R2-4: the technical SEO audit of a website destination (summary, runs, pages, findings with suggested tasks under
 * the brand's `cms.audit` policy) and the on-demand `run` (seo_audit.run; once per destination per day).
 * RA-11: `audit.createWork` turns one or many findings into tracked work (a recommendation with the finding's
 * provenance; insight.manage; idempotent per finding), and the findings carry their status and work.
 */
export const destinationsRouter = router({
  list: tenantQuery
    .input(DestinationList)
    .query(({ ctx, input }) => destinationService.list(ctx.tenant.actor, input)),
  get: tenantQuery
    .input(DestinationGet)
    .query(({ ctx, input }) => destinationService.get(ctx.tenant.actor, input)),
  register: tenantMutation
    .input(DestinationRegister)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) => destinationService.register(ctx.tenant.actor, input, tx)),
    ),
  setHealth: tenantMutation
    .input(DestinationSetHealth)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) => destinationService.setHealth(ctx.tenant.actor, input, tx)),
    ),
  /** PR-04: a website's article-region selector for rendered-article verification (destination.manage). */
  setArticleSelector: tenantMutation
    .input(DestinationSetArticleSelector)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) =>
        destinationService.setArticleSelector(ctx.tenant.actor, input, tx),
      ),
    ),
  disconnect: tenantMutation
    .input(DestinationDisconnect)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) => destinationService.disconnect(ctx.tenant.actor, input, tx)),
    ),
  sources: router({
    list: tenantQuery.query(() => destinationService.sources.list()),
  }),
  connect: router({
    start: tenantMutation
      .input(DestinationConnectStart)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => destinationService.connect.start(ctx.tenant.actor, input, tx)),
      ),
    complete: tenantMutation
      .input(DestinationConnectComplete)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          destinationService.connect.complete(ctx.tenant.actor, input, tx),
        ),
      ),
    select: tenantMutation
      .input(DestinationConnectSelect)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => destinationService.connect.select(ctx.tenant.actor, input, tx)),
      ),
    cancel: tenantMutation
      .input(DestinationConnectCancel)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => destinationService.connect.cancel(ctx.tenant.actor, input, tx)),
      ),
    /** R2-3: a website connected with its integration identity and secret, sealed here and verified by the worker. */
    withSecret: tenantMutation
      .input(DestinationConnectWithSecret)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          destinationService.connect.withSecret(ctx.tenant.actor, input, tx),
        ),
      ),
  }),
  reports: router({
    summary: tenantQuery
      .input(DestinationReportSummary)
      .query(({ ctx, input }) => destinationReportService.summary(ctx.tenant.actor, input)),
    rows: tenantQuery
      .input(DestinationReportRows)
      .query(({ ctx, input }) => destinationReportService.rows(ctx.tenant.actor, input)),
    opportunities: tenantQuery
      .input(DestinationReportOpportunities)
      .query(({ ctx, input }) => destinationReportService.opportunities(ctx.tenant.actor, input)),
  }),
  audit: router({
    summary: tenantQuery
      .input(SeoAuditSummary)
      .query(({ ctx, input }) => seoAuditService.summary(ctx.tenant.actor, input)),
    runs: router({
      list: tenantQuery
        .input(SeoAuditRunsList)
        .query(({ ctx, input }) => seoAuditService.runs.list(ctx.tenant.actor, input)),
    }),
    pages: router({
      list: tenantQuery
        .input(SeoAuditPagesList)
        .query(({ ctx, input }) => seoAuditService.pages.list(ctx.tenant.actor, input)),
    }),
    findings: tenantQuery
      .input(SeoAuditFindings)
      .query(({ ctx, input }) => seoAuditService.findings(ctx.tenant.actor, input)),
    run: tenantMutation
      .input(SeoAuditRun)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => seoAuditService.run(ctx.tenant.actor, input, tx)),
      ),
    createWork: tenantMutation
      .input(SeoAuditCreateWork)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => seoAuditService.createWork(ctx.tenant.actor, input, tx)),
      ),
  }),
  sourceUse: router({
    list: tenantQuery
      .input(SourceUsePolicyList)
      .query(({ ctx, input }) => sourceUsePolicyService.list(ctx.tenant.actor, input)),
    set: tenantMutation
      .input(SourceUsePolicySet)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => sourceUsePolicyService.set(ctx.tenant.actor, input, tx)),
      ),
    check: tenantQuery
      .input(SourceUseCheck)
      .query(({ ctx, input }) => sourceUsePolicyService.check(ctx.tenant.actor, input)),
  }),
});
