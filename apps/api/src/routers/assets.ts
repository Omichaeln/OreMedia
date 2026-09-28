import {
  AssetApprove,
  AssetGet,
  AssetGrantCreate,
  AssetRetire,
  AssetSearch,
  AssetUsagesList,
  AssetVersionsList,
  BrandFontsList,
  GoogleFontImport,
  MediaSignedUrlRequest,
  UploadIntentComplete,
  UploadIntentCreate,
  UploadIntentGet,
  UsageRightsInput,
} from '@oremedia/contracts/assets';
import { assetService } from '@oremedia/module-assets';
import { idempotent } from '@oremedia/module-operations';
import { router, tenantMutation, tenantQuery, type MutationCtx } from '../trpc';

const mutationCtx = (ctx: MutationCtx) => ({
  idempotency: ctx.idempotency,
  actor: { kind: ctx.tenant.actorRef.kind, id: ctx.tenant.actorRef.id },
});

/** Spec 7.5 assets router (spec 9: ingestion, eligibility search, rights, grants, delivery). */
export const assetsRouter = router({
  uploads: router({
    createIntent: tenantMutation
      .input(UploadIntentCreate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => assetService.createIntent(ctx.tenant.actor, input, tx)),
      ),
    complete: tenantMutation
      .input(UploadIntentComplete)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => assetService.completeUpload(ctx.tenant.actor, input, tx)),
      ),
    get: tenantQuery
      .input(UploadIntentGet)
      .query(({ ctx, input }) => assetService.uploadStatus(ctx.tenant.actor, input)),
  }),
  search: tenantQuery
    .input(AssetSearch)
    .query(({ ctx, input }) => assetService.search(ctx.tenant.actor, input)),
  get: tenantQuery.input(AssetGet).query(({ ctx, input }) => assetService.get(ctx.tenant.actor, input)),
  versions: router({
    list: tenantQuery
      .input(AssetVersionsList)
      .query(({ ctx, input }) => assetService.listVersions(ctx.tenant.actor, input)),
  }),
  rights: router({
    set: tenantMutation
      .input(UsageRightsInput)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => assetService.setRights(ctx.tenant.actor, input, tx)),
      ),
  }),
  approve: tenantMutation
    .input(AssetApprove)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) => assetService.approve(ctx.tenant.actor, input, tx)),
    ),
  retire: tenantMutation
    .input(AssetRetire)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) => assetService.retire(ctx.tenant.actor, input, tx)),
    ),
  usages: router({
    list: tenantQuery
      .input(AssetUsagesList)
      .query(({ ctx, input }) => assetService.listUsages(ctx.tenant.actor, input)),
  }),
  grants: router({
    create: tenantMutation
      .input(AssetGrantCreate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => assetService.createGrant(ctx.tenant.actor, input, tx)),
      ),
  }),
  /** Brand kit typography: the brand's font faces, and a family imported from Google Fonts into them. */
  fonts: router({
    list: tenantQuery
      .input(BrandFontsList)
      .query(({ ctx, input }) => assetService.listFonts(ctx.tenant.actor, input)),
    importGoogle: tenantMutation
      .input(GoogleFontImport)
      // The download runs outside any transaction; only recording the intents is the idempotent command.
      .mutation(({ ctx, input }) =>
        assetService.importGoogleFont(ctx.tenant.actor, input, (command) =>
          idempotent(mutationCtx(ctx), command),
        ),
      ),
  }),
  /** Spec 9.3 media endpoint: re-checks authorisation and returns a 5-minute signed GET. */
  media: router({
    signedUrl: tenantQuery
      .input(MediaSignedUrlRequest)
      .query(({ ctx, input }) => assetService.signedUrl(ctx.tenant.actor, input)),
  }),
});
