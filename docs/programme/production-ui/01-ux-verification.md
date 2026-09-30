# UX-01 to UX-20 verified against `f51e207`

Source-reviewed 30 September 2026. Line numbers are current at that commit. Each row: verdict, evidence, what
exists to reuse, what is missing, risk. The audit's baseline lines matched in every case.

## UX-01 Studio cannot hand work into review: confirmed

- `studio.tsx:175-181`: the button carries only `disabledReason` and no handler. The working flow is `RequestReview` in `package-detail.tsx:187-275` (`review.requests.create` with `{contentRevisionId, timing}`).
- Reuse: `review.requests.create`, `ReviewRequestCreate` contract, `reviewService.requests.create` (`freezeManifest` at `review/src/service.ts:264`), the `RequestReview` component (lift out of package-detail).
- Missing: the studio is document-scoped; review needs a `contentRevisionId`. `contentService.revisions.listReferencingCreativeDocument` (`content/src/service.ts:860`) exists but is not exposed. Add `content.packages.listForDocument` or a "create package from this document" step.
- Risk: `freezeManifest` throws `no_channel_variants`; unsaved edits are not pinned; the pin must include the document's current revision (UX-02).

## UX-02 Copy-only revisions detach creative on another device: confirmed

- `package-detail.tsx:287,306`, `content-helpers.ts:130-155` (localStorage key `oremedia.package_documents`), contract `creativeDocumentIds.default([])`, `service.ts:732-756` pins only the submitted documents at their current revision.
- `packages.get` (`service.ts:805-821`, `toRevisionDto :387`) returns `creativeRevisionIds` only: no documentId, title or latest flag, and `creative.revisions.get` needs `{documentId, revisionId}`, so the client cannot resolve them.
- Reuse: `creativeRevisionsRepo.getById(id).documentId` (used by `variants.generate :920`), `creativeService.documents.get`, `listReferencingCreativeDocument`.
- Missing: enrich `packages.get` with `creativeDocuments: [{documentId, title, pinnedRevisionId, currentRevisionId, stale}]` (derivable, no migration); revise semantics that distinguish omitted from empty (e.g. `keepExistingPins`); a document picker.
- Risk: revise always re-pins the current revision; it supersedes and stales open review requests.

## UX-03 Reviewers cannot see the rendered creative: confirmed

- `request-detail.tsx:36-100` renders ids, hashes, text and "N rendered file(s)"; the portal reuses it (`review-portal/route.tsx:6,193`). Manifest has `exports[{exportId, contentHash, channelConnectionId}]`.
- No review-scoped delivery: `assets.media.signedUrl` takes `assetVersionId` and asserts `asset.read`; rendered exports are `rendered_exports` rows, not asset versions; `creative.renders.get` returns storage keys only; external reviewers may only `review.decide` on their own request (`domain/src/policy.ts` step 4).
- Reuse: `storage().signDownloadUrl`, `SIGNED_URL_TTL_SEC`, `creativeService.renders.exportsByIds`, the frozen `contentHash` for verification before signing, `useSignedUrl` pattern.
- Missing: `review.requests.media({reviewRequestId})` signing only the manifest's exportIds after a hash check, authorised by `review.decide`/`review.read` bound to that request; a `ManifestMedia` component.
- Risk: keep reviewer scope request-bound; short TTL; the portal is a separate origin, so storage CORS must admit it.

## UX-04 Channel variants have no editing surface: confirmed

- `package-detail.tsx:63-100` read-only; `variants.update` (`routers/content.ts:94`, `service.ts:1004-1051`, contract `ChannelVariantUpdate`) has no web caller.
- Missing: an edit form; an export picker (`exportsRepo.listForRevision` is internal; no procedure lists ready exports for the pinned revisions).
- Risk: `update` does not recompute `validation` (`:1025-1030`), so the "Valid" badge goes stale; edits fire `notifyRevisionChange('variant_changed')`; the state guard blocks edits once in review or approved.

## UX-05 Asset management stops before approval and rights: confirmed

- Library calls eligible search only (`use-assets.ts:11-19` → `findEligibleAssets`, `assets/src/service.ts:442-470`); ineligible by typed id (`assets/route.tsx:128-146`); inspector has no mutations; `use-upload.ts:28-70` ends at `queued` and never polls; `rights.set` used only by brand-kit `LogoPreview` (`brand-kit-editor.tsx:1074`).
- Reuse: `assets.uploads.get` (`{state, assetId, rejectionReason}`), `approve`, `retire`, `rights.set`, `versions.list`, `usages.list`, `grants.create`, `get`.
- Missing: a brand asset listing including pending, ineligible and retired with reasons (new procedure); `refetchInterval` polling in `useAssetUpload` until terminal; inspector actions.
- Risk: `useAssetUpload` is shared with the brand kit (`brand-kit-editor.tsx:540`); uploads land pending and invisible.

## UX-06 Scheduling needs IDs and misreads the time zone: confirmed

- `schedule-form.tsx:31-100`: free-text `cv_` id + "Load variant", free-text approval/mandate id. `localInputToIso`/`isoToLocalInput` (`publication-state.ts:383-395`) use `new Date(value)` in the viewer zone; the brand `timeZone` is used only for `dayKey`. The same helpers set the review planned time (`package-detail.tsx:195,239`), so the frozen timing is also viewer-zone.
- Reuse: `review.requests.get`/`inbox.list` return `approvals`; `review.approvals.get`; `review.mandates.list`; `packages.get` variants; manifest `timing.at` for prefill; `publications.schedule`.
- Missing: a zone-aware converter (no date-fns-tz/Temporal in the web app; the `Intl` API suffices); valid approvals by revision/package (`approvalsRepo.listForRevision` is internal); a schedule entry point on `PackageDetail`.
- Risk: the release policy holds publications scheduled outside the frozen timing; a zone skew between the two forms holds legitimate schedules.

## UX-07 Studio agent conversation not connected: confirmed

- `studio.tsx:346-379`: `ProposalPanel` or empty state plus a dev-only `simulateProposal`; `use-studio.ts:299-330` builds a hard-coded batch for `creative.operations.propose`.
- Reuse: `operations.propose` (`OperationsPropose = OperationsApply + previewRender`), `ProposalPanel`, `agents.runs.start/steps/approveProposal`, builtin skills `social-layout` and `channel-adaptation`.
- Missing: `propose` takes an op batch, not language, so a send control needs an agent run with a document-scoped task kind and a way to surface the run's proposal step into studio state; no creative propose tool exists (tools live in content, intelligence, publishing, review); an implicit principal (UX-08).
- Risk: proposals must bind to `headRevisionId` (stale detection exists in `proposal-panel.tsx:41`).

## UX-08 Agent setup is an API form: confirmed

- `start-run-form.tsx:34-92`: task kind default, raw JSON brief, free-text `sp_` id; `intelligence-workspace.tsx:~260`, `recommendation-card.tsx:~88`; `RunStart` requires `servicePrincipalId`.
- No listing of principals: `access.servicePrincipals` has `create`/`revoke` only; `ServicePrincipalRepository.list` exists unexposed. `skills.list` exists but `toSkillDto` omits `taskKinds` and `inputSchema` (they live in the manifest, e.g. `builtin/campaign-planning/manifest.json`).
- Missing: `access.servicePrincipals.list` (active, with grants and max autonomy, filtered to what the caller may start); skills read exposing task kinds and input schema for the active version; a schema-driven brief form.
- Risk: listing principals exposes grant structure, so gate on an access/admin action; pre-filter by the action the task kind needs to avoid run-time `grant_missing`.

## UX-09 Campaign planning materialises no plan: confirmed

- `service.ts:629-647` `briefs.accept` transitions and audits only; `brief-detail.tsx:209-230`; `campaigns-screen.tsx:~218-240`.
- No plan-item concept persisted (`plan:'pln'` and `plans` are billing). Closest: builtin `campaign-planning` skill, task kind `campaign_planning`, output `calendar: [{date, channelKey, theme, formatKey, factIds}]`, consumed by nothing.
- Reuse: `agents.runs.start` with `campaign_planning`; content tools `createBrief`/`draftCopy`; `contentService.packages.create`; `content.calendar.range`; `content.plan` policy action.
- Missing: migration `plan_items` (brief_id, date, channel_connection_id, theme, format_key, fact_ids, state, content_package_id, version); repository and contracts; persistence of the skill's calendar output; idempotent materialisation on accept; `content.planItems.*`; a plan grid and "Plan with agent".
- Risk: the skill emits `channelKey`, not a connection id; accept side effects need idempotency.

## UX-10 Channel examples exceed the certified baseline: confirmed

- `registry.ts:56-60` registers linkedin_page, instagram_business, facebook_page, x; all `certifiedAt: null`. `ProviderRegistry.get()` throws `provider_not_certified`; `adapterFor` (`publishing/src/providers.ts:46`) reaches it from `channels.connect.start`; `common.ts:71-72` returns false; the worker starts publish queues only for certified providers (`publishing-worker.ts:128`, currently none); ingest seeds metric definitions only for certified providers.
- Risk: `registry().capability(key)` does not check certification (`publications.ts:232,677`, `runtime.ts:394`, `measurement/common.ts:30,50`), so capability reads succeed for uncertified providers. With all four uncertified, no tenant can connect a channel, and no publish or ingest worker runs. Certification is a date literal per `capability.ts` after the runbook's evidence.

## UX-11 Portfolio lacks the cross-brand view: confirmed

- `portfolio/route.tsx:13-95`: per-company sections summing `brand.summary` (overdue, needing a person, upcoming). No cross-brand route. `access.listCompanies` is session-scoped; `brand.summary` is per tenant.
- Missing: a per-brand performance summary procedure (`MetricsQuery` takes one `brandId`, ≤ 200 subjects, ≤ 50 keys, and needs publication ids first); a route.
- Risk: companies are tenants, so N tenant-scoped requests, never one cross-tenant query; per brand the client needs calendar + definitions + metrics, so a server rollup is the realistic design; `insight.read` per brand drops restricted brands silently.

## UX-12 Performance narrower than the design: confirmed

- `performance-screen.tsx`: period, channel filter, 8 comparable groups + engagement rate, coverage, posts by metric, by channel; `daily-trend.tsx` compares at normalised post age against the previous equal period (`:41,72,171`).
- Existing: measurement `quality.get`, `links.list`, `attributes.get/correct`, `attributeService` with `copyFeatures`/`layoutFeatures`; intelligence workspace, recommendations, playbook, voice, anomalies; web `features/intelligence/*`.
- Missing: brand-wide attribute-vs-outcome aggregate; quality and links on the screen; a "kept cycle item → brief" contract (recommendations.accept already fans out to `content.briefs.create`).
- Risk: the 200-subject budget is shared between this period and the previous one in `daily-trend.tsx:27`; `content.calendar.range` has no pagination.

## UX-13 Documents and older packages not discoverable: confirmed

- `home/route.tsx:159,172-190` (open by id; localStorage recents); `creative.documents` has `create`/`get` only; `use-content.ts:46-53` uses `calendar.range` with a stale comment, while `content.packages.list` exists (`routers/content.ts:76`, `service.ts:797-802`, cursor-paged).
- Missing: `DocumentList` contract, `creativeService.documents.list`, repository `list` (copy `CreativeRevisionRepository.list` id-desc cursor), router entry. Index `uq(tenant, brand, id)` suffices for id ordering; ordering by `updatedAt` needs a migration.

## UX-14 Pagination stops at page one: partially confirmed

- Hooks take one page and ignore `nextCursor`: `use-content.ts:15,24`, `use-review.ts:14`, `use-experiments.ts:14`, `use-document.ts:22,27`, `use-community.ts:14`, `use-assets.ts:16,30`, `use-brand.ts:41,55,63`, `use-intelligence.ts:33,40`, `use-settings.ts:10,46`, `use-publishing.ts:98`, router prefetches.
- Exceptions: `useRevisionPublications` walks up to 25 pages; history and skills show a truncation notice; performance slices to 200/50 and says so.
- Cursors exist on: content campaigns/briefs/packages, creative revisions/comments/templates, review inbox/mandates, experiments, community conversations, publications, intelligence lists, brand versions/facts/objectives, assets search/versions/usages, links, runs.steps, skills, audit. None on: brand.list, listCompanies, members.list, channels.list, definitions.list, voice.clusters, and `content.calendar.range` (unbounded).
- Missing: a shared load-more/infinite list component in `packages/ui`; `useInfiniteQuery` adoption; query-key alignment with router prefetch and `pathFilter` invalidation.

## UX-15 Conflict resolution cannot keep the user's edit: confirmed

- `save-indicator.tsx:59-117`: discard-all or keep-server only; `use-studio.ts:381-382`; reducer `dropConflicting` (`studio-reducer.ts:99`); `history-panel.tsx` lists only.
- Rebase engine `packages/editor/src/rebase.ts`: `rebaseBatch` returns ok or `RebaseConflict[{elementId, localOp, remoteOp}]`; detection only. Server throws `StaleRevisionError`. Also exported: `invertBatch`, `applyBatch`, `reduce`, `changedElementIds`. `diffDocuments`/`ElementDiff` (`studio/diff.ts`) already power proposal and canvas diffs.
- Missing: `conflict:keep-mine` (re-apply local ops on the head snapshot, submit with `baseRevision = head`; handle `OperationError` for deleted targets); a compare panel. No server change.
- Risk: keep-mine overwrites a collaborator's intent, so it needs wording and audit; `applyTemplate` page conflicts make "mine" wipe their page.

## UX-16 Budgets missing from the surface: confirmed

- `settings-screen.tsx:14-23,94-96`; `billing/src/budgets.ts:134-243` (`reserveSpend`, `consume`, `settle`, `release`, `setLimit`); no billing router. Effective month limit is `min(row, entitlement)` (`:152`); rows are created lazily (`ensure`), tenant-month row uses `brandId ''`, defaults `DEFAULT_BRAND_DAY_MICROS` (placeholder under D-08).
- Missing: `budgets.read` (limits, committed, ledger breakdown), optional `setLimit` exposure, contracts, `billingRouter`, a Budgets tab gated by `billing.manage`.

## UX-17 Skill administration lacks the lifecycle: confirmed

- `settings-screen.tsx:45-91` list only; `skills` router exposes `get` (versions, bindings, evaluations), `versions.create/evaluate/publish`, `bindings.set`, `import`, `export`; no web callers. `brand-skill-import.tsx` uses `brand.guidelines.import`, a different pipeline.
- Missing: detail drawer, import/export, evaluate/publish/bind actions with role gating and pending states. No server work.

## UX-18 Studio tablet pinch point: confirmed

- `studio.tsx:229-232`: `md:grid-cols-[16rem_minmax(0,1fr)_22rem]`; no collapse state, no lg/xl breakpoints; `app.css` has nothing studio-specific. At 768 px the canvas is about 150 px wide.
- Missing: collapse state (persisted), lg/xl breakpoints, a toggle; canvas fit depends on container width.

## UX-19 Deployment brand: confirmed as described (no defect)

- `lib/deployment-brand.tsx`: `loadDeploymentBrand()` before render in `main.tsx:20` and `review-portal.tsx:10`; fetches `/deployment-brand/brand.json` (no-cache, JSON content-type required); validates name ≤ 80, logo file names, Google Fonts URL; awaits `theme.css`; races a 1500 ms timeout; any failure yields `NEUTRAL_BRAND`. Served by `Caddyfile:27-44`; packs copied by `Dockerfile.web:22`. Tokens: neutral `packages/ui/src/tokens.css`, mapped by `apps/web/src/styles/tokens.css` (`@theme inline`), overridden by `deployment-brands/ore-and-tar/theme.css` (`:root:root`). E2E `deployment-brand.e2e.test.ts`.
- Risks: a timed-out stylesheet applying after first render (colour flash); CSP must admit the font host (it does, verified in production); `--font-sans` specificity.

## UX-20 Brand publication impact: confirmed, with a hidden coupling

- `brandService.versions.publish` (`brand/src/service.ts:636-705`) → `brand.version_published` → `brandChangeImpactWorkflowV1`: `invalidateForBrandChange` invalidates every valid approval and stales open requests, then `reevaluateScheduledForBrand` holds where release fails. UI text matches (`system/route.tsx:424-428`).
- Coupling: the approval binding hash includes the current `brandVersionId` (`evaluate-release.ts:228-246`, checked at dispatch `:372`), and `requests.create` rejects `brand_version_outdated`. A "keep approvals" policy therefore also needs a new binding version (v2) that excludes or relaxes `brandVersionId`.
- Where a switch lives: `PolicyDocumentV1.holdOnDependencyRevocation` is the precedent (`contracts/brand.ts:170`; read in `evaluate-release.ts:450-456`, branched in `publications.applyFactRevocation`). Add e.g. `onBrandVersionPublished: 'invalidate_and_hold' | 'flag'` without defaulting (snapshot hashes; see the `generation` precedent at `brand.ts:172-176`), branch in the two activities, edit in the existing release-policy UI. Workflow immutability: new branching lives in activities or `brandChangeImpactWorkflowV2`.
