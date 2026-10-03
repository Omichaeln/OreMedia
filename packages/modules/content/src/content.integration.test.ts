import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  defaultPolicyDocument,
  emptyBrandSystemDocument,
  type BrandSystemDocumentV1,
} from '@oremedia/contracts/brand';
import type { CreativeDocumentV1 } from '@oremedia/contracts/creative';
import {
  CapabilityUnsupportedError,
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { ResolvedActor, ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { tenants } from '@oremedia/db/schema/access';
import { assetVersions, assets, usageRights } from '@oremedia/db/schema/assets';
import { brands } from '@oremedia/db/schema/brand';
import {
  briefs,
  channelVariants,
  contentPackages,
  contentRevisions,
  planItems,
} from '@oremedia/db/schema/content';
import { brandDestinations } from '@oremedia/db/schema/destinations';
import {
  ARTICLE_BODY_MAX_CHARS,
  ARTICLE_TEXT_MAX_CHARS,
  CHANNEL_VARIANT_TEXT_MAX_CHARS,
  type ArticleDocumentV1,
} from '@oremedia/contracts/content';
import { articlePlainText } from '@oremedia/contracts/article';
import { auditEvents, outboxEvents } from '@oremedia/db/schema/operations';
import { hashCanonical, hashText } from '@oremedia/domain/hash';
import { newElementId, newId } from '@oremedia/domain/ids';
import { brandService, registerBrandAssetKindSource } from '@oremedia/module-brand';
import { creativeService, registerAssetAuthoriser } from '@oremedia/module-creative';
import {
  contentService,
  hashesForVariant,
  registerCalendarSource,
  registerChannelResolver,
  registerDestinationResolver,
  registerRevisionChangeListener,
  registerVariantValidator,
  resetDestinationResolver,
  resetVariantValidator,
  resetChannelResolver,
  type RevisionChange,
} from './service';
import { contentToolSource } from './tools';

const USER = 'usr_content_test';
const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: USER },
  brandIds: 'all',
  correlationId: 'corr_content',
});
const manager = (tenantId: string): ResolvedActor => ({
  kind: 'user',
  id: USER,
  tenantId,
  membershipId: 'mem_content_test',
  membershipStatus: 'active',
  role: 'brand_manager',
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});
const run = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  runInTenant(ctx(tenantId), () => withTransaction(fn));

const brandDocument = (): BrandSystemDocumentV1 => ({
  ...emptyBrandSystemDocument(),
  tokens: {
    colours: [
      { key: 'ink', value: '#172120', role: 'text' },
      { key: 'paper', value: '#F4F6F3', role: 'background' },
    ],
    typeRoles: [
      { role: 'display', fontAssetId: 'ast_font', weight: 600, minSizePx: 40 },
      { role: 'heading', fontAssetId: 'ast_font', weight: 600, minSizePx: 28 },
      { role: 'body', fontAssetId: 'ast_font', weight: 400, minSizePx: 18 },
      { role: 'label', fontAssetId: 'ast_font', weight: 500, minSizePx: 14 },
      { role: 'caption', fontAssetId: 'ast_font', weight: 400, minSizePx: 12 },
    ],
    spacingScale: [4, 8, 16],
    radii: [0, 4],
    contrastTarget: 'AA',
  },
});
const studioDocument = (brandVersionId: string): CreativeDocumentV1 => ({
  schemaVersion: 1,
  brandVersionId,
  pages: [
    {
      id: 'page_1',
      name: 'Feed',
      formatKey: 'square_1080',
      width: 1080,
      height: 1080,
      layoutConstraints: [],
      elements: [
        {
          id: newElementId(),
          name: 'Headline',
          type: 'text',
          locked: false,
          visible: true,
          opacity: 1,
          protected: false,
          transform: { x: 80, y: 80, width: 920, height: 120, rotation: 0 },
          text: 'Headline',
          style: {
            typeRole: 'display',
            fontAssetVersionId: 'av_font',
            weight: 600,
            sizePx: 64,
            lineHeight: 1.2,
            tracking: 0,
            colourToken: 'ink',
            align: 'left',
            overflow: 'error',
          },
          factRefs: [],
        },
      ],
    },
  ],
  variants: [],
});
const exportFor = (tenantId: string, brandVersionId: string, hashChar: string) => ({
  pageId: 'page_1',
  formatKey: 'square_1080',
  mime: 'image/png',
  width: 1080,
  height: 1080,
  bytes: 1234,
  storageKey: `renders/${tenantId}/${hashChar}.png`,
  contentHash: hashChar.repeat(64),
  rendererVersion: 'renderer-test',
  manifest: {
    rendererVersion: 'renderer-test',
    fonts: [],
    assets: [],
    brandVersionId,
    revisionContentHash: 'd'.repeat(64),
  },
  validation: { ok: true, findings: [] },
});
const copy = (text: string, factRefs: string[] = []) => ({
  schemaVersion: 1 as const,
  master: { text, factRefs },
});

describe('content module (spec 6.3 content tables, 7.5 content router) against MySQL 8', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandA2 = newId('brand');
  const brandB = newId('brand');
  const channelA = newId('channelConnection');
  const channelA2 = newId('channelConnection');
  const channelOfBrandA2 = newId('channelConnection');
  const A = manager(tenantA);
  const B = manager(tenantB);
  let brandVersionA = '';
  let policyVersionA = '';
  let docId = '';
  let docRevision = '';
  let readyExportId = '';
  let campaignId = '';
  let briefId = '';
  let packageId = '';
  let revisionId = '';
  let variantId = '';
  let packageB = '';
  let revisionB = '';
  let variantB = '';
  const changes: RevisionChange[] = [];

  const eventsOf = (tenantId: string, type: string) =>
    tdb.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.tenantId, tenantId), eq(outboxEvents.eventType, type)));
  const auditOf = (tenantId: string, action: string) =>
    tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, action)));
  const revisionRow = async (id: string) =>
    (await tdb.db.select().from(contentRevisions).where(eq(contentRevisions.id, id)))[0]!;
  const packageRow = async (id: string) =>
    (await tdb.db.select().from(contentPackages).where(eq(contentPackages.id, id)))[0]!;

  async function publishBrand(tenantId: string, brandId: string) {
    const actor = manager(tenantId);
    const draft = await run(tenantId, (tx) => brandService.versions.createDraft(actor, { brandId }, tx));
    await run(tenantId, (tx) =>
      brandService.versions.update(
        actor,
        { brandId, versionId: draft.versionId, expectedVersion: 0, document: brandDocument() },
        tx,
      ),
    );
    await run(tenantId, (tx) =>
      brandService.versions.submitForReview(
        actor,
        { brandId, versionId: draft.versionId, expectedVersion: 1 },
        tx,
      ),
    );
    await run(tenantId, (tx) =>
      brandService.versions.publish(actor, { brandId, versionId: draft.versionId, expectedVersion: 2 }, tx),
    );
    return draft.versionId;
  }
  async function activatePolicy(tenantId: string, brandId: string) {
    const actor = manager(tenantId);
    const pv = await run(tenantId, (tx) =>
      brandService.policy.createVersion(actor, { brandId, document: defaultPolicyDocument() }, tx),
    );
    await run(tenantId, (tx) =>
      brandService.policy.activate(
        actor,
        { brandId, policyVersionId: pv.policyVersionId, expectedVersion: 0 },
        tx,
      ),
    );
    return pv.policyVersionId;
  }

  beforeAll(async () => {
    // The brand documents here name the placeholder font ast_font; a draft's type roles must name fonts of the
    // brand, so the brand module is told it is one (no asset rows are seeded in this suite).
    registerBrandAssetKindSource(
      async (_brandId, ids) =>
        new Map(ids.filter((id) => id === 'ast_font').map((id) => [id, 'font' as const])),
    );
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'content-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'content-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandA2, tenantId: tenantA, name: 'A2', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    registerAssetAuthoriser(async () => undefined);
    registerRevisionChangeListener(async (change) => {
      changes.push(change);
    });
    brandVersionA = await publishBrand(tenantA, brandA);
    const brandVersionB = await publishBrand(tenantB, brandB);
    // A creative document with one ready export and one pending job (whose formats never become exports).
    const created = await run(tenantA, (tx) =>
      creativeService.documents.create(
        A,
        { brandId: brandA, title: 'Offer visual', document: studioDocument(brandVersionA) },
        tx,
      ),
    );
    docId = created.documentId;
    docRevision = created.revisionId;
    const job = await run(tenantA, (tx) =>
      creativeService.renders.request(
        A,
        { documentId: docId, revisionId: docRevision, formatKeys: ['square_1080'] },
        tx,
      ),
    );
    await run(tenantA, (tx) => creativeService.renders.markRendering({ renderJobId: job.renderJobId }, tx));
    const ready = await run(tenantA, (tx) =>
      creativeService.renders.markReady(
        { renderJobId: job.renderJobId, exports: [exportFor(tenantA, brandVersionA, 'a')] },
        tx,
      ),
    );
    readyExportId = ready.exportIds[0]!;
    await run(tenantA, (tx) =>
      creativeService.renders.request(
        A,
        { documentId: docId, revisionId: docRevision, formatKeys: ['ig_feed_4x5'] },
        tx,
      ),
    ); // stays pending: no export rows
    // Tenant B rows for the foreign-id checks.
    await activatePolicy(tenantB, brandB);
    registerChannelResolver(async (id) =>
      id === channelA || id === channelA2
        ? { brandId: brandA, providerKey: 'fixture_provider', capabilityVersion: 3 }
        : id === channelOfBrandA2
          ? { brandId: brandA2, providerKey: 'fixture_provider', capabilityVersion: 3 }
          : id === 'cc_b'
            ? { brandId: brandB, providerKey: 'fixture_provider', capabilityVersion: 3 }
            : null,
    );
    const pkgB = await run(tenantB, (tx) =>
      contentService.packages.create(
        B,
        { brandId: brandB, title: 'B', copy: copy('B caption'), creativeDocumentIds: [] },
        tx,
      ),
    );
    packageB = pkgB.contentPackageId;
    revisionB = pkgB.contentRevisionId;
    variantB = (
      await run(tenantB, (tx) =>
        contentService.variants.generate(
          B,
          { contentRevisionId: revisionB, channelConnectionIds: ['cc_b'] },
          tx,
        ),
      )
    ).created[0]!;
    void brandVersionB;
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  describe('campaigns and briefs (content.plan)', () => {
    it('creates, lists and gets campaigns; the end date cannot precede the start', async () => {
      await expect(
        run(tenantA, (tx) =>
          contentService.campaigns.create(
            A,
            {
              brandId: brandA,
              name: 'June',
              startsAt: '2026-06-30T00:00:00.000Z',
              endsAt: '2026-06-01T00:00:00.000Z',
            },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      const res = await run(tenantA, (tx) =>
        contentService.campaigns.create(
          A,
          {
            brandId: brandA,
            name: 'June',
            startsAt: '2026-06-01T00:00:00.000Z',
            endsAt: '2026-06-30T00:00:00.000Z',
          },
          tx,
        ),
      );
      campaignId = res.campaignId;
      expect(res).toMatchObject({ state: 'draft', version: 0 });
      const list = await run(tenantA, () =>
        contentService.campaigns.list(A, { brandId: brandA, page: { limit: 10 } }),
      );
      expect(list.items.map((c) => c.id)).toEqual([campaignId]);
      expect((await run(tenantA, () => contentService.campaigns.get(A, { campaignId }))).name).toBe('June');
      expect((await auditOf(tenantA, 'content.campaign.create')).length).toBe(1);
    });

    it('creates a brief on the campaign and accepts it through the machine, once', async () => {
      const res = await run(tenantA, (tx) =>
        contentService.briefs.create(
          A,
          {
            brandId: brandA,
            campaignId,
            audience: 'Repeat buyers',
            message: 'June offer',
            offerFactIds: [],
            channelConnectionIds: [],
            constraints: [],
          },
          tx,
        ),
      );
      briefId = res.briefId;
      const accepted = await run(tenantA, (tx) =>
        contentService.briefs.accept(A, { briefId, expectedVersion: 0 }, tx),
      );
      expect(accepted).toMatchObject({ state: 'accepted', version: 1 });
      await expect(
        run(tenantA, (tx) => contentService.briefs.accept(A, { briefId, expectedVersion: 1 }, tx)),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      const list = await run(tenantA, () =>
        contentService.briefs.list(A, { brandId: brandA, campaignId, page: { limit: 10 } }),
      );
      expect(list.items.map((b) => b.state)).toEqual(['accepted']);
      // A campaign of another brand cannot host the brief.
      await expect(
        run(tenantA, (tx) =>
          contentService.briefs.create(
            A,
            {
              brandId: brandA2,
              campaignId,
              audience: 'x',
              message: 'x',
              offerFactIds: [],
              channelConnectionIds: [],
              constraints: [],
            },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('a new brief offers only facts in effect: a revoked, an expired or a proposed offer fact is refused', async () => {
      const offer = async (statement: string, validUntil?: string) => {
        const p = await run(tenantA, (tx) =>
          brandService.facts.propose(
            A,
            {
              brandId: brandA,
              category: 'offer',
              statement,
              sources: [{ kind: 'url', ref: 'https://example.test/offers' }],
              ...(validUntil ? { validUntil } : {}),
            },
            tx,
          ),
        );
        return p.factId;
      };
      const approve = (factId: string) =>
        run(tenantA, (tx) =>
          brandService.facts.approve(A, { brandId: brandA, factId, expectedVersion: 0 }, tx),
        );
      const revoked = await offer('Brief test: revoked offer');
      await approve(revoked);
      await run(tenantA, (tx) =>
        brandService.facts.withdraw(
          A,
          { brandId: brandA, factId: revoked, expectedVersion: 1, reason: 'Ended early' },
          tx,
        ),
      );
      const expired = await offer('Brief test: expired offer', new Date(Date.now() + 1500).toISOString());
      await approve(expired);
      const proposed = await offer('Brief test: proposed offer');
      const live = await offer('Brief test: live offer');
      await approve(live);
      await new Promise((r) => setTimeout(r, 1600)); // the expired offer's window ends
      const brief = (offerFactIds: string[]) =>
        run(tenantA, (tx) =>
          contentService.briefs.create(
            A,
            {
              brandId: brandA,
              audience: 'Repeat buyers',
              message: 'Offers',
              offerFactIds,
              channelConnectionIds: [],
              constraints: [],
            },
            tx,
          ),
        );
      for (const factId of [revoked, expired, proposed])
        await expect(brief([live, factId])).rejects.toMatchObject({
          code: 'VALIDATION_FAILED',
          details: [{ path: 'offerFactIds.1', issue: 'fact_not_effective' }],
        });
      expect((await brief([live])).state).toBe('draft');
    });
  });

  describe('packages and content revisions (content.edit, spec 13.1 machine)', () => {
    it('needs an active release policy and effective facts; then revision 1 pins the brand version, policy and creative revisions', async () => {
      await expect(
        run(tenantA, (tx) =>
          contentService.packages.create(
            A,
            { brandId: brandA, title: 'Offer', copy: copy('x'), creativeDocumentIds: [] },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ details: [{ issue: 'brand_has_no_active_policy' }] });
      policyVersionA = await activatePolicy(tenantA, brandA);
      await expect(
        run(tenantA, (tx) =>
          contentService.packages.create(
            A,
            { brandId: brandA, title: 'Offer', copy: copy('x', ['fact_nope']), creativeDocumentIds: [] },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ details: [{ path: 'copy.master.factRefs.0', issue: 'fact_not_effective' }] });
      const res = await run(tenantA, (tx) =>
        contentService.packages.create(
          A,
          {
            brandId: brandA,
            briefId,
            title: 'Offer',
            copy: copy('Twenty percent off in June'),
            creativeDocumentIds: [docId],
          },
          tx,
        ),
      );
      packageId = res.contentPackageId;
      revisionId = res.contentRevisionId;
      expect(res).toMatchObject({
        number: 1,
        brandVersionId: brandVersionA,
        policyVersionId: policyVersionA,
        state: 'draft',
        version: 1,
      });
      const rev = await revisionRow(revisionId);
      expect(rev).toMatchObject({
        number: 1,
        state: 'draft',
        creativeRevisionIds: [docRevision],
        brandVersionId: brandVersionA,
      });
      expect(rev.contentHash).toBe(
        hashCanonical({
          copy: copy('Twenty percent off in June'),
          creativeRevisionIds: [docRevision],
          factRefs: [],
          brandVersionId: brandVersionA,
          policyVersionId: policyVersionA,
        }),
      );
      expect((await packageRow(packageId)).currentRevisionId).toBe(revisionId);
      expect((await run(tenantA, () => contentService.briefs.get(A, { briefId }))).state).toBe('in_progress');
      expect((await eventsOf(tenantA, 'content.revision_created')).map((e) => e.payload)).toContainEqual(
        expect.objectContaining({ contentPackageId: packageId, contentRevisionId: revisionId, number: 1 }),
      );
      // A document of another brand cannot be pinned.
      const brandVersionA2 = await publishBrand(tenantA, brandA2);
      const other = await run(tenantA, (tx) =>
        creativeService.documents.create(
          A,
          { brandId: brandA2, title: 'Other', document: studioDocument(brandVersionA2) },
          tx,
        ),
      );
      await expect(
        run(tenantA, (tx) =>
          contentService.packages.create(
            A,
            { brandId: brandA, title: 'Mixed', copy: copy('x'), creativeDocumentIds: [other.documentId] },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ details: [{ issue: 'document_not_in_brand' }] });
    });

    it("generates variants from the master copy with the pinned revision's READY exports and their hashes, once per channel", async () => {
      resetChannelResolver();
      await expect(
        run(tenantA, (tx) =>
          contentService.variants.generate(
            A,
            { contentRevisionId: revisionId, channelConnectionIds: [channelA] },
            tx,
          ),
        ),
      ).rejects.toThrow(/channel resolver not registered/);
      registerChannelResolver(async (id) =>
        id === channelA || id === channelA2
          ? { brandId: brandA, providerKey: 'fixture_provider', capabilityVersion: 3 }
          : id === channelOfBrandA2
            ? { brandId: brandA2, providerKey: 'fixture_provider', capabilityVersion: 3 }
            : null,
      );
      await expect(
        run(tenantA, (tx) =>
          contentService.variants.generate(
            A,
            { contentRevisionId: revisionId, channelConnectionIds: [channelOfBrandA2] },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) =>
          contentService.variants.generate(
            A,
            { contentRevisionId: revisionId, channelConnectionIds: ['cc_unknown'] },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      changes.length = 0;
      const res = await run(tenantA, (tx) =>
        contentService.variants.generate(
          A,
          { contentRevisionId: revisionId, channelConnectionIds: [channelA, channelA] },
          tx,
        ),
      );
      expect(res.created).toHaveLength(1);
      variantId = res.created[0]!;
      expect(res.variants[0]).toMatchObject({
        id: variantId,
        tenantId: tenantA,
        brandId: brandA,
        contentPackageId: packageId,
        contentRevisionId: revisionId,
        channelConnectionId: channelA,
        text: 'Twenty percent off in June',
        altTexts: ['Offer visual'],
        settings: {},
        exportIds: [readyExportId],
        exportHashes: ['a'.repeat(64)],
        capabilityVersion: 3,
        version: 0,
      });
      expect(changes).toEqual([
        {
          contentRevisionId: revisionId,
          contentPackageId: packageId,
          brandId: brandA,
          reason: 'variant_changed',
        },
      ]);
      // Generating again returns the existing target and creates nothing.
      const again = await run(tenantA, (tx) =>
        contentService.variants.generate(
          A,
          { contentRevisionId: revisionId, channelConnectionIds: [channelA] },
          tx,
        ),
      );
      expect(again.created).toEqual([]);
      expect(again.variants.map((v) => v.id)).toEqual([variantId]);
      expect(
        (await tdb.db.select().from(channelVariants).where(eq(channelVariants.contentRevisionId, revisionId)))
          .length,
      ).toBe(1);
      const got = await run(tenantA, () => contentService.variants.get(A, { variantId }));
      expect(hashesForVariant(got)).toEqual({
        textHash: hashText('Twenty percent off in June'),
        altTextHashes: [hashText('Offer visual')],
        settingsHash: hashCanonical({}),
        exportHashes: ['a'.repeat(64)],
      });
    });

    it('updates a variant with an optimistic version; only exports of the pinned revisions can be selected', async () => {
      await expect(
        run(tenantA, (tx) =>
          contentService.variants.update(
            A,
            {
              channelVariantId: variantId,
              expectedVersion: 0,
              text: 'x',
              altTexts: [],
              settings: {},
              exportIds: ['exp_nope'],
            },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ details: [{ path: 'exportIds.0', issue: 'export_not_found' }] });
      const updated = await run(tenantA, (tx) =>
        contentService.variants.update(
          A,
          {
            channelVariantId: variantId,
            expectedVersion: 0,
            text: 'Twenty percent off in June ✨',
            altTexts: ['Offer'],
            settings: { firstComment: 'Shop now' },
            exportIds: [readyExportId],
          },
          tx,
        ),
      );
      expect(updated).toMatchObject({
        text: 'Twenty percent off in June ✨',
        altTexts: ['Offer'],
        settings: { firstComment: 'Shop now' },
        validation: { ok: true, issues: [] }, // no validator registered: nothing is flagged
        version: 1,
      });
      // Spec 13.4: the registered capability check runs on the edited variant and its findings are stored with it.
      registerVariantValidator(async (v) => ({
        ok: v.text.length <= 20,
        issues: v.text.length <= 20 ? [] : [{ path: 'text', issue: 'text_too_long' }],
      }));
      const flagged = await run(tenantA, (tx) =>
        contentService.variants.update(
          A,
          {
            channelVariantId: variantId,
            expectedVersion: 1,
            text: 'Twenty percent off in June, this week only',
            altTexts: ['Offer'],
            settings: {},
            exportIds: [readyExportId],
          },
          tx,
        ),
      );
      expect(flagged.validation).toEqual({ ok: false, issues: [{ path: 'text', issue: 'text_too_long' }] });
      expect((await run(tenantA, () => contentService.variants.get(A, { variantId }))).validation).toEqual(
        flagged.validation,
      );
      const shortened = await run(tenantA, (tx) =>
        contentService.variants.update(
          A,
          {
            channelVariantId: variantId,
            expectedVersion: 2,
            text: 'Twenty percent off',
            altTexts: ['Offer'],
            settings: { firstComment: 'Shop now' },
            exportIds: [readyExportId],
          },
          tx,
        ),
      );
      expect(shortened.validation).toEqual({ ok: true, issues: [] });
      // A channel the validator cannot resolve is a finding on the variant, not a refused edit.
      registerVariantValidator(async () => {
        throw new NotFoundError('ChannelConnection', channelA);
      });
      const unresolved = await run(tenantA, (tx) =>
        contentService.variants.update(
          A,
          {
            channelVariantId: variantId,
            expectedVersion: 3,
            text: 'Twenty percent off',
            altTexts: ['Offer'],
            settings: {},
            exportIds: [readyExportId],
          },
          tx,
        ),
      );
      expect(unresolved.validation).toEqual({
        ok: false,
        issues: [{ path: 'channelConnectionId', issue: 'channel_unavailable' }],
      });
      // So is a provider the registry refuses (unknown or not certified): its details are the findings.
      registerVariantValidator(async () => {
        throw new CapabilityUnsupportedError([{ path: 'providerKey', issue: 'provider_not_certified:x' }]);
      });
      const uncertified = await run(tenantA, (tx) =>
        contentService.variants.update(
          A,
          {
            channelVariantId: variantId,
            expectedVersion: 4,
            text: 'Twenty percent off',
            altTexts: ['Offer'],
            settings: {},
            exportIds: [readyExportId],
          },
          tx,
        ),
      );
      expect(uncertified.validation).toEqual({
        ok: false,
        issues: [{ path: 'providerKey', issue: 'provider_not_certified:x' }],
      });
      resetVariantValidator();
      await expect(
        run(tenantA, (tx) =>
          contentService.variants.update(
            A,
            {
              channelVariantId: variantId,
              expectedVersion: 0,
              text: 'x',
              altTexts: [],
              settings: {},
              exportIds: [],
            },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
      expect((await auditOf(tenantA, 'content.variant.update')).length).toBe(5);
    });

    it('moves the revision only through the machine and guards variant edits by revision state (spec 5.5 step 5)', async () => {
      const moved = await run(tenantA, (tx) =>
        contentService.revisions.transition(revisionId, 'request_review', tx),
      );
      expect(moved).toMatchObject({ fromState: 'draft', toState: 'in_review' });
      expect((await packageRow(packageId)).state).toBe('in_review');
      await expect(
        run(tenantA, (tx) =>
          contentService.variants.update(
            A,
            {
              channelVariantId: variantId,
              expectedVersion: 1,
              text: 'x',
              altTexts: [],
              settings: {},
              exportIds: [],
            },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ reason: 'resource_state' });
      await expect(
        run(tenantA, (tx) =>
          contentService.variants.generate(
            A,
            { contentRevisionId: revisionId, channelConnectionIds: [channelA2] },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      await expect(
        run(tenantA, (tx) => contentService.revisions.transition(revisionId, 'reopen', tx)),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      expect(
        (await run(tenantA, (tx) => contentService.revisions.transition(revisionId, 'request_changes', tx)))
          .toState,
      ).toBe('changes_requested');
      expect((await packageRow(packageId)).state).toBe('draft');
      expect(
        (await run(tenantA, (tx) => contentService.revisions.transition(revisionId, 'request_review', tx)))
          .toState,
      ).toBe('in_review');
      expect(
        (await run(tenantA, (tx) => contentService.revisions.transition(revisionId, 'approve', tx))).toState,
      ).toBe('approved');
      expect((await packageRow(packageId)).state).toBe('approved');
      expect((await auditOf(tenantA, 'content.revision.transition')).length).toBe(4);
    });

    it('revising an approved package inserts revision 2 as a draft and supersedes revision 1; the old revision is never edited', async () => {
      const pkg = await run(tenantA, () => contentService.packages.get(A, { contentPackageId: packageId }));
      expect(pkg.revision.id).toBe(revisionId);
      expect(pkg.variants.map((v) => v.id)).toEqual([variantId]);
      changes.length = 0;
      const res = await run(tenantA, (tx) =>
        contentService.packages.revise(
          A,
          {
            contentPackageId: packageId,
            expectedVersion: pkg.version,
            copy: copy('Twenty-five percent off in June'),
            creativeDocumentIds: [docId],
            summary: 'better offer',
          },
          tx,
        ),
      );
      expect(res).toMatchObject({
        number: 2,
        supersededRevisionId: revisionId,
        state: 'draft',
        version: pkg.version + 1,
      });
      expect((await revisionRow(revisionId)).state).toBe('superseded');
      expect((await revisionRow(revisionId)).copy).toEqual(copy('Twenty percent off in June'));
      expect((await packageRow(packageId)).currentRevisionId).toBe(res.contentRevisionId);
      expect(changes).toEqual([
        {
          contentRevisionId: revisionId,
          contentPackageId: packageId,
          brandId: brandA,
          reason: 'package_revised',
        },
      ]);
      // A superseded revision is terminal: no machine event moves it, and its variants cannot be touched.
      await expect(
        run(tenantA, (tx) => contentService.revisions.transition(revisionId, 'request_review', tx)),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      // A stale package version is a CONFLICT.
      await expect(
        run(tenantA, (tx) =>
          contentService.packages.revise(
            A,
            {
              contentPackageId: packageId,
              expectedVersion: pkg.version,
              copy: copy('x'),
              creativeDocumentIds: [],
            },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
      const history = (
        await run(tenantA, () => contentService.packages.get(A, { contentPackageId: packageId }))
      ).revisions;
      expect(history.map((r) => [r.number, r.state])).toEqual([
        [2, 'draft'],
        [1, 'superseded'],
      ]);
      expect((await run(tenantA, () => contentService.revisions.get(A, { revisionId }))).state).toBe(
        'superseded',
      );
    });

    it('get names the creative documents behind the pins; revising without creativeDocumentIds keeps them, [] removes them', async () => {
      const pkg = await run(tenantA, () => contentService.packages.get(A, { contentPackageId: packageId }));
      expect(pkg.creativeDocuments).toEqual([
        expect.objectContaining({
          documentId: docId,
          pinnedRevisionId: docRevision,
          currentRevisionId: docRevision,
          stale: false,
          // The pinned revision's ready exports, what a variant may select (the pending job contributes none).
          exports: [
            {
              exportId: readyExportId,
              pageId: 'page_1',
              formatKey: 'square_1080',
              mime: 'image/png',
              width: 1080,
              height: 1080,
            },
          ],
        }),
      ]);
      expect(pkg.creativeDocuments[0]?.title).toEqual(expect.any(String));
      // Copy-only revise from a client that knows nothing about documents: the creative stays pinned.
      const kept = await run(tenantA, (tx) =>
        contentService.packages.revise(
          A,
          { contentPackageId: packageId, expectedVersion: pkg.version, copy: copy('Kept creative') },
          tx,
        ),
      );
      expect((await revisionRow(kept.contentRevisionId)).creativeRevisionIds).toEqual([docRevision]);
      // An explicit empty selection removes every creative.
      const removed = await run(tenantA, (tx) =>
        contentService.packages.revise(
          A,
          {
            contentPackageId: packageId,
            expectedVersion: kept.version,
            copy: copy('No creative'),
            creativeDocumentIds: [],
          },
          tx,
        ),
      );
      expect((await revisionRow(removed.contentRevisionId)).creativeRevisionIds).toEqual([]);
      expect(
        (await run(tenantA, () => contentService.packages.get(A, { contentPackageId: packageId })))
          .creativeDocuments,
      ).toEqual([]);
      // Put the document back for the tests that follow.
      const restored = await run(tenantA, (tx) =>
        contentService.packages.revise(
          A,
          {
            contentPackageId: packageId,
            expectedVersion: removed.version,
            copy: copy('Twenty-five percent off in June'),
            creativeDocumentIds: [docId],
          },
          tx,
        ),
      );
      expect((await revisionRow(restored.contentRevisionId)).creativeRevisionIds).toEqual([docRevision]);
    });

    it('lists the revisions that pin a creative document (for the creative-change approval hook)', async () => {
      const pkg = await run(tenantA, () => contentService.packages.get(A, { contentPackageId: packageId }));
      await run(tenantA, (tx) => contentService.revisions.transition(pkg.revision.id, 'request_review', tx));
      const refs = await run(tenantA, () => contentService.revisions.listReferencingCreativeDocument(docId));
      expect(refs.map((r) => r.id)).toEqual([pkg.revision.id]);
    });

    it('lists the live packages whose current revision pins a document, with the pin and variant count; a foreign document is NOT_FOUND', async () => {
      const pkg = await run(tenantA, () => contentService.packages.get(A, { contentPackageId: packageId }));
      const res = await run(tenantA, () => contentService.packages.listForDocument(A, { documentId: docId }));
      const mine = res.items.find((i) => i.package.id === packageId);
      expect(mine).toMatchObject({
        revision: { id: pkg.revision.id, state: pkg.revision.state },
        pinnedRevisionId: docRevision,
        stale: false,
        variantCount: pkg.variants.length,
      });
      // Only the current revision counts: the superseded revisions that also pinned the document are not listed.
      expect(res.items.filter((i) => i.package.id === packageId)).toHaveLength(1);
      await expect(
        run(tenantB, () => contentService.packages.listForDocument(B, { documentId: docId })),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('lists the packages of a brand newest first with cursor paging; a foreign brand is NOT_FOUND', async () => {
      const first = await run(tenantA, () =>
        contentService.packages.list(A, { brandId: brandA, page: { limit: 1 } }),
      );
      expect(first.items).toHaveLength(1);
      expect(first.items[0]).toMatchObject({ brandId: brandA });
      const all = await run(tenantA, () =>
        contentService.packages.list(A, { brandId: brandA, page: { limit: 200 } }),
      );
      expect(all.items.map((p) => p.id)).toContain(packageId);
      expect(all.items.map((p) => p.id)).toEqual([...all.items.map((p) => p.id)].sort().reverse());
      if (first.nextCursor) {
        const second = await run(tenantA, () =>
          contentService.packages.list(A, {
            brandId: brandA,
            page: { limit: 1, cursor: first.nextCursor ?? undefined },
          }),
        );
        expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
      }
      await expect(
        run(tenantA, () => contentService.packages.list(A, { brandId: brandB, page: { limit: 10 } })),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('calendar.range', () => {
    it('returns campaigns overlapping the range, packages touched in it and publications from the registered source', async () => {
      const range = { brandId: brandA, from: '2026-01-01T00:00:00.000Z', to: '2030-01-01T00:00:00.000Z' };
      const empty = await run(tenantA, () => contentService.calendar.range(A, range));
      expect(empty.campaigns.map((c) => c.id)).toEqual([campaignId]);
      expect(empty.packages.map((p) => p.id)).toContain(packageId);
      expect(empty.publications).toEqual([]);
      registerCalendarSource(async (brandId) => [
        {
          publicationId: 'pub_1',
          contentPackageId: packageId,
          contentRevisionId: revisionId,
          channelVariantId: variantId,
          channelConnectionId: channelA,
          destinationId: null,
          scheduledFor: '2026-06-01T09:00:00.000Z',
          state: `scheduled:${brandId}`,
          remoteStatus: null,
          remoteVerification: null,
        },
      ]);
      const filled = await run(tenantA, () => contentService.calendar.range(A, range));
      expect(filled.publications).toEqual([
        expect.objectContaining({ publicationId: 'pub_1', state: `scheduled:${brandA}` }),
      ]);
      expect(
        (
          await run(tenantA, () =>
            contentService.calendar.range(A, {
              ...range,
              from: '2027-01-01T00:00:00.000Z',
              to: '2027-02-01T00:00:00.000Z',
            }),
          )
        ).campaigns,
      ).toEqual([]);
      await expect(
        run(tenantA, () => contentService.calendar.range(A, { ...range, to: '2020-01-01T00:00:00.000Z' })),
      ).rejects.toBeInstanceOf(ValidationFailedError);
    });
  });

  describe('plan items (UX-09): proposed by a run or a person, edited, dropped, materialised on acceptance', () => {
    const planner = (tenantId: string): ResolvedActorServicePrincipal => ({
      kind: 'service_principal',
      id: 'sp_planner',
      tenantId,
      status: 'active',
      maxAutonomy: 'create',
      grants: [
        { action: 'brand.read', brandIds: 'all' },
        { action: 'content.plan', brandIds: 'all' },
      ],
    });
    const runAsPlanner = <T>(fn: (tx: Tx) => Promise<T>) =>
      runInTenant({ ...ctx(tenantA), actor: { kind: 'service_principal', id: 'sp_planner' } }, () =>
        withTransaction(fn),
      );
    const item = (over: Record<string, unknown> = {}) => ({
      date: '2026-11-02',
      channelKey: 'fixture_provider',
      theme: 'Launch week',
      formatKey: 'post',
      factIds: [],
      ...over,
    });
    let planBriefId = '';
    let ids: string[] = [];

    it('a run proposes the calendar against its brief: channels resolve from the brief when unambiguous, another brand’s brief is NOT_FOUND', async () => {
      const created = await run(tenantA, (tx) =>
        contentService.briefs.create(
          A,
          {
            brandId: brandA,
            campaignId,
            audience: 'Renovators',
            message: 'Autumn lamps',
            offerFactIds: [],
            channelConnectionIds: [channelA],
            constraints: [],
          },
          tx,
        ),
      );
      planBriefId = created.briefId;
      // A run for brand A cannot plan against brand A2's brief, whatever the principal's grants.
      const otherBrief = await run(tenantA, (tx) =>
        contentService.briefs.create(
          A,
          {
            brandId: brandA2,
            audience: 'x',
            message: 'x',
            offerFactIds: [],
            channelConnectionIds: [],
            constraints: [],
          },
          tx,
        ),
      );
      await expect(
        runAsPlanner((tx) =>
          contentToolSource.proposePlan(
            planner(tenantA),
            {
              brandId: brandA,
              runId: 'run_plan',
              autonomyMode: 'create',
              briefId: otherBrief.briefId,
              items: [item()],
            },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        runAsPlanner((tx) =>
          contentToolSource.proposePlan(
            planner(tenantA),
            {
              brandId: brandA,
              runId: 'run_plan',
              autonomyMode: 'create',
              briefId: planBriefId,
              items: [item({ channelConnectionId: channelOfBrandA2 })],
            },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      // A fact the brand does not own (or that does not exist) is refused at proposal, as briefs.create refuses it.
      await expect(
        runAsPlanner((tx) =>
          contentToolSource.proposePlan(
            planner(tenantA),
            {
              brandId: brandA,
              runId: 'run_plan',
              autonomyMode: 'create',
              briefId: planBriefId,
              items: [item({ factIds: ['fct_nope'] })],
            },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      const proposed = await runAsPlanner((tx) =>
        contentToolSource.proposePlan(
          planner(tenantA),
          {
            brandId: brandA,
            runId: 'run_plan',
            autonomyMode: 'create',
            briefId: planBriefId,
            items: [
              item(),
              item({
                date: '2026-11-04',
                channelKey: 'unknown_provider',
                theme: 'Follow-up',
                formatKey: 'story',
              }),
              item({ date: '2026-11-06', channelKey: channelA, theme: 'Reminder' }),
            ],
          },
          tx,
        ),
      );
      ids = proposed.planItemIds;
      expect(ids).toHaveLength(3);
      const list = await run(tenantA, () => contentService.planItems.list(A, { briefId: planBriefId }));
      expect(
        list.items.map((i) => [i.date, i.channelConnectionId, i.state, i.createdByKind, i.agentRunId]),
      ).toEqual([
        ['2026-11-02', channelA, 'proposed', 'agent', 'run_plan'],
        ['2026-11-04', null, 'proposed', 'agent', 'run_plan'],
        ['2026-11-06', channelA, 'proposed', 'agent', 'run_plan'],
      ]);
      // Another tenant's manager cannot see the brief's plan.
      await expect(
        run(tenantB, () => contentService.planItems.list(B, { briefId: planBriefId })),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('a person edits an item (the version guards it), assigns a channel of the brand only, drops and restores', async () => {
      const [first, second] = ids as [string, string, string];
      const edited = await run(tenantA, (tx) =>
        contentService.planItems.update(
          A,
          {
            planItemId: second,
            expectedVersion: 0,
            theme: 'Follow-up: the lamp range',
            channelConnectionId: channelA2,
          },
          tx,
        ),
      );
      expect(edited).toMatchObject({
        theme: 'Follow-up: the lamp range',
        channelConnectionId: channelA2,
        version: 1,
      });
      await expect(
        run(tenantA, (tx) =>
          contentService.planItems.update(A, { planItemId: second, expectedVersion: 0, theme: 'stale' }, tx),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        run(tenantA, (tx) =>
          contentService.planItems.update(
            A,
            { planItemId: second, expectedVersion: 1, channelConnectionId: channelOfBrandA2 },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      const dropped = await run(tenantA, (tx) =>
        contentService.planItems.drop(A, { planItemId: first, expectedVersion: 0 }, tx),
      );
      expect(dropped.state).toBe('dropped');
      await expect(
        run(tenantA, (tx) => contentService.planItems.drop(A, { planItemId: first, expectedVersion: 1 }, tx)),
      ).rejects.toMatchObject({ details: [{ issue: 'plan_item_is_dropped' }] });
      const restored = await run(tenantA, (tx) =>
        contentService.planItems.restore(A, { planItemId: first, expectedVersion: 1 }, tx),
      );
      expect(restored.state).toBe('proposed');
      await run(tenantA, (tx) =>
        contentService.planItems.drop(A, { planItemId: first, expectedVersion: 2 }, tx),
      );
      // A foreign manager can move nothing.
      await expect(
        run(tenantB, (tx) =>
          contentService.planItems.drop(B, { planItemId: second, expectedVersion: 1 }, tx),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('accepting the brief materialises every proposed item as a draft package once; a retry creates no second package; an ineffective fact names its item', async () => {
      const [, second, third] = ids as [string, string, string];
      // A fact of the brand that is proposed, not approved: it exists (so the item may cite it) but is not effective.
      const pending = await run(tenantA, (tx) =>
        brandService.facts.propose(
          A,
          {
            brandId: brandA,
            kind: 'claim',
            statement: 'Pending claim',
            evidence: [{ kind: 'other', ref: 't' }],
          },
          tx,
        ),
      );
      await run(tenantA, (tx) =>
        contentService.planItems.update(
          A,
          { planItemId: third, expectedVersion: 0, factIds: [pending.factId] },
          tx,
        ),
      );
      await expect(
        run(tenantA, (tx) =>
          contentService.briefs.accept(A, { briefId: planBriefId, expectedVersion: 0 }, tx),
        ),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: [{ path: `planItems.${third}.copy.master.factRefs.0`, issue: 'fact_not_effective' }],
      });
      // The failed transaction left nothing behind: the brief is still a draft with no package.
      const packagesBefore = await tdb.db
        .select()
        .from(contentPackages)
        .where(and(eq(contentPackages.tenantId, tenantA), eq(contentPackages.briefId, planBriefId)));
      expect(packagesBefore).toHaveLength(0);
      await run(tenantA, (tx) =>
        contentService.planItems.update(A, { planItemId: third, expectedVersion: 1, factIds: [] }, tx),
      );
      const accepted = await run(tenantA, (tx) =>
        contentService.briefs.accept(A, { briefId: planBriefId, expectedVersion: 0 }, tx),
      );
      expect(accepted.materialised.map((m) => m.planItemId)).toEqual([second, third]);
      expect(accepted.state).toBe('in_progress'); // the first package moved the accepted brief on
      const rows = await tdb.db
        .select()
        .from(planItems)
        .where(and(eq(planItems.tenantId, tenantA), eq(planItems.briefId, planBriefId)))
        .orderBy(planItems.date);
      expect(rows.map((r) => [r.state, r.contentPackageId !== null])).toEqual([
        ['dropped', false],
        ['materialised', true],
        ['materialised', true],
      ]);
      const pkg = await packageRow(rows[1]!.contentPackageId!);
      expect(pkg).toMatchObject({
        briefId: planBriefId,
        title: '2026-11-04 · Follow-up: the lamp range',
        state: 'draft',
      });
      const rev = await revisionRow(pkg.currentRevisionId!);
      expect(rev.copy.master.text).toBe('Follow-up: the lamp range');
      // A retried acceptance (stale version, or the brief already moved) creates nothing more.
      await expect(
        run(tenantA, (tx) =>
          contentService.briefs.accept(A, { briefId: planBriefId, expectedVersion: 0 }, tx),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const packagesAfter = await tdb.db
        .select()
        .from(contentPackages)
        .where(and(eq(contentPackages.tenantId, tenantA), eq(contentPackages.briefId, planBriefId)));
      expect(packagesAfter).toHaveLength(2);
      // Once the brief has moved, nothing on its plan moves either (the materialised item is its package now).
      await expect(
        run(tenantA, (tx) =>
          contentService.planItems.update(A, { planItemId: second, expectedVersion: 2, theme: 'late' }, tx),
        ),
      ).rejects.toMatchObject({ details: [{ path: 'briefId', issue: 'brief is in_progress' }] });
      await expect(
        run(tenantA, (tx) =>
          contentService.planItems.propose(A, { briefId: planBriefId, items: [item()] }, tx),
        ),
      ).rejects.toMatchObject({ details: [{ path: 'briefId', issue: 'brief is in_progress' }] });
      // Nor can a dropped item be restored (or edited) once the brief has moved: nothing would materialise it.
      const droppedRow = rows[0]!;
      await expect(
        run(tenantA, (tx) =>
          contentService.planItems.restore(
            A,
            { planItemId: droppedRow.id, expectedVersion: droppedRow.version },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ details: [{ path: 'briefId', issue: 'brief is in_progress' }] });
      await expect(
        run(tenantA, (tx) =>
          contentService.planItems.update(
            A,
            { planItemId: droppedRow.id, expectedVersion: droppedRow.version, theme: 'late' },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ details: [{ path: 'briefId', issue: 'brief is in_progress' }] });
      expect((await auditOf(tenantA, 'content.plan_item.propose')).length).toBeGreaterThan(0);
    });
  });

  describe('website article packages at the text cap (RA-03): one cap, create → generate → mode change → persistence', () => {
    const destinationId = newId('destination');
    /** A body exactly at ARTICLE_BODY_MAX_CHARS over its blocks, with the title and the excerpt at their caps. */
    const maxArticle: ArticleDocumentV1 = {
      kind: 'article',
      title: 't'.repeat(200),
      slug: 'why-ore-and-tar-last',
      excerpt: 'e'.repeat(1000),
      blocks: Array.from({ length: 5 }, (_, i) => ({
        type: 'paragraph' as const,
        text: `${i}`.padEnd(10_000, 'x'),
      })),
      categories: ['Guides'],
      tags: ['ore'],
    };
    const text = articlePlainText(maxArticle);

    beforeAll(async () => {
      await tdb.db.insert(brandDestinations).values({
        id: destinationId,
        tenantId: tenantA,
        brandId: brandA,
        kind: 'cms_site',
        externalId: 'https://blog.acme.example',
        displayName: 'blog.acme.example',
        ownerUserId: USER,
        grantedScopes: ['articles:write', 'articles:publish'],
        health: 'healthy',
        capabilityVersion: 1,
      });
      registerDestinationResolver(async (id) =>
        id === destinationId
          ? {
              brandId: brandA,
              kind: 'cms_site',
              capabilityVersion: 1,
              writable: true,
              displayName: 'blog.acme.example',
              externalId: 'https://blog.acme.example',
              grantedScopes: ['articles:write'],
            }
          : null,
      );
    });
    afterAll(() => {
      resetDestinationResolver();
    });

    it('a body over the cap fails at the initial input; one exactly at it is accepted', async () => {
      await expect(
        run(tenantA, (tx) =>
          contentService.packages.create(
            A,
            {
              brandId: brandA,
              title: 'Too long',
              copy: {
                ...copy('Caption'),
                article: {
                  ...maxArticle,
                  blocks: [...maxArticle.blocks, { type: 'paragraph', text: 'x' }],
                },
              },
            },
            tx,
          ),
        ),
      ).rejects.toThrow(`body_too_long:${ARTICLE_BODY_MAX_CHARS + 1}>${ARTICLE_BODY_MAX_CHARS}`);
      expect(text.length).toBeGreaterThan(CHANNEL_VARIANT_TEXT_MAX_CHARS);
      expect(text.length).toBeLessThanOrEqual(ARTICLE_TEXT_MAX_CHARS);
    });

    it("RA-08: an article's images must be asset versions this brand may use; an unknown or ineligible one is refused by name, an eligible one is kept and sent with the variant", async () => {
      const assetId = newId('asset');
      const versionId = newId('assetVersion');
      const seed = async (state: 'approved' | 'retired') => {
        await tdb.db.insert(assets).values({
          id: assetId,
          tenantId: tenantA,
          brandId: brandA,
          kind: 'photo',
          name: 'weighbridge',
          currentVersionId: versionId,
          state,
          rightsState: 'recorded',
        });
        await tdb.db.insert(assetVersions).values({
          id: versionId,
          tenantId: tenantA,
          brandId: brandA,
          assetId,
          number: 1,
          storageKey: `assets/${tenantA}/${brandA}/${assetId}/${versionId}/original`,
          contentHash: hashText('png'),
          mime: 'image/png',
          bytes: 3,
          provenance: { kind: 'upload', uploadedByUserId: USER, originalFilename: 'w.png' },
        });
        await tdb.db.insert(usageRights).values({
          id: newId('usageRights'),
          tenantId: tenantA,
          brandId: brandA,
          assetId,
          owner: 'owner',
          permittedChannels: 'all',
          territories: 'all',
          expiresAt: null,
          releases: [],
          restrictions: [],
        });
      };
      const rich = (assetVersionId: string): ArticleDocumentV1 => ({
        kind: 'article',
        v: 2,
        title: 'How ore is weighed',
        slug: 'how-ore-is-weighed',
        excerpt: 'Scales.',
        featuredImage: { assetVersionId, alt: 'A weighbridge' },
        blocks: [
          { type: 'paragraph', text: 'Every load is weighed twice.' },
          { type: 'image', assetVersionId, alt: 'The weighbridge' },
          {
            type: 'faq',
            question: 'What is tare?',
            answer: 'The empty weight.',
            answerBlocks: [{ type: 'paragraph', text: 'The empty weight.' }],
          },
        ],
        categories: [],
        tags: [],
      });
      await expect(
        run(tenantA, (tx) =>
          contentService.packages.create(
            A,
            { brandId: brandA, title: 'Images', copy: { ...copy('Scales.'), article: rich('av_missing') } },
            tx,
          ),
        ),
      ).rejects.toMatchObject({
        details: [
          { path: 'copy.article.images.0', issue: 'asset_not_found' },
          { path: 'copy.article.images.1', issue: 'asset_not_found' },
        ],
      });
      await seed('retired');
      await expect(
        run(tenantA, (tx) =>
          contentService.packages.create(
            A,
            { brandId: brandA, title: 'Images', copy: { ...copy('Scales.'), article: rich(versionId) } },
            tx,
          ),
        ),
      ).rejects.toMatchObject({
        details: [
          { path: 'copy.article.images.0', issue: expect.stringMatching(/^asset_ineligible:/) },
          { path: 'copy.article.images.1', issue: expect.stringMatching(/^asset_ineligible:/) },
        ],
      });
      await tdb.db.update(assets).set({ state: 'approved' }).where(eq(assets.id, assetId));
      // Images of an image kind only: a video is refused. (BSC-2: an SVG is accepted; it is sent as its PNG.)
      await tdb.db.update(assetVersions).set({ mime: 'video/mp4' }).where(eq(assetVersions.id, versionId));
      await expect(
        run(tenantA, (tx) =>
          contentService.packages.create(
            A,
            { brandId: brandA, title: 'Images', copy: { ...copy('Scales.'), article: rich(versionId) } },
            tx,
          ),
        ),
      ).rejects.toMatchObject({
        details: [
          { path: 'copy.article.images.0', issue: 'asset_ineligible:mime_not_allowed' },
          expect.anything(),
        ],
      });
      await tdb.db.update(assetVersions).set({ mime: 'image/png' }).where(eq(assetVersions.id, versionId));
      await tdb.db.update(assets).set({ kind: 'video' }).where(eq(assets.id, assetId));
      await expect(
        run(tenantA, (tx) =>
          contentService.packages.create(
            A,
            { brandId: brandA, title: 'Images', copy: { ...copy('Scales.'), article: rich(versionId) } },
            tx,
          ),
        ),
      ).rejects.toMatchObject({
        details: [
          { path: 'copy.article.images.0', issue: 'asset_ineligible:kind_not_allowed' },
          expect.anything(),
        ],
      });
      await tdb.db.update(assets).set({ kind: 'photo' }).where(eq(assets.id, assetId));
      const pkg = await run(tenantA, (tx) =>
        contentService.packages.create(
          A,
          { brandId: brandA, title: 'Images', copy: { ...copy('Scales.'), article: rich(versionId) } },
          tx,
        ),
      );
      const generated = await run(tenantA, (tx) =>
        contentService.variants.generate(
          A,
          { contentRevisionId: pkg.contentRevisionId, destinationIds: [destinationId] },
          tx,
        ),
      );
      const website = generated.variants[0]!;
      expect(website.article).toEqual(rich(versionId));
      expect(website.article?.featuredImage).toEqual({ assetVersionId: versionId, alt: 'A weighbridge' });
      expect(website.text).toBe(articlePlainText(rich(versionId)));
      // Revising keeps the check: the same document with a foreign version is refused.
      await expect(
        run(tenantA, (tx) =>
          contentService.packages.revise(
            A,
            {
              contentPackageId: pkg.contentPackageId,
              expectedVersion: pkg.version,
              copy: { ...copy('Scales.'), article: rich('av_other') },
            },
            tx,
          ),
        ),
      ).rejects.toMatchObject({
        details: [{ path: 'copy.article.images.0', issue: 'asset_not_found' }, expect.anything()],
      });
    });

    it('the article at the cap is created, its website variant carries the whole text, survives a mode change and is persisted whole', async () => {
      const pkg = await run(tenantA, (tx) =>
        contentService.packages.create(
          A,
          { brandId: brandA, title: 'At the cap', copy: { ...copy('Caption'), article: maxArticle } },
          tx,
        ),
      );
      const generated = await run(tenantA, (tx) =>
        contentService.variants.generate(
          A,
          {
            contentRevisionId: pkg.contentRevisionId,
            channelConnectionIds: [channelA],
            destinationIds: [destinationId],
          },
          tx,
        ),
      );
      const website = generated.variants.find((v) => v.destinationId === destinationId)!;
      const channel = generated.variants.find((v) => v.channelConnectionId === channelA)!;
      expect(website.text).toBe(text);
      expect(website.article).toEqual(maxArticle);
      expect(channel.text).toBe(maxArticle.excerpt); // the caption is the excerpt, under the social cap
      // The website editor re-sends the variant's text when the publish mode changes: the article cap applies.
      const switched = await run(tenantA, (tx) =>
        contentService.variants.update(
          A,
          {
            channelVariantId: website.id,
            expectedVersion: website.version,
            text: website.text,
            altTexts: [],
            settings: { publishMode: 'publish' },
            exportIds: [],
          },
          tx,
        ),
      );
      expect(switched).toMatchObject({ settings: { publishMode: 'publish' }, version: website.version + 1 });
      expect(switched.text).toBe(text);
      // A channel caption stays under the social cap once the variant's target is known.
      await expect(
        run(tenantA, (tx) =>
          contentService.variants.update(
            A,
            {
              channelVariantId: channel.id,
              expectedVersion: channel.version,
              text,
              altTexts: [],
              settings: {},
              exportIds: [],
            },
            tx,
          ),
        ),
      ).rejects.toMatchObject({
        details: [{ path: 'text', issue: `text_too_long:${text.length}>${CHANNEL_VARIANT_TEXT_MAX_CHARS}` }],
      });
      // Persisted whole (MEDIUMTEXT, migration 0020), as the variant reads back.
      const stored = (
        await tdb.db.select().from(channelVariants).where(eq(channelVariants.id, website.id))
      )[0]!;
      expect(stored.text).toHaveLength(text.length);
      expect(stored.text).toBe(text);
      const read = await run(tenantA, () => contentService.variants.get(A, { variantId: website.id }));
      expect(read.text).toBe(text);
      expect(read.settings).toEqual({ publishMode: 'publish' });
    });
  });

  describe('tenant isolation (spec 5.3)', () => {
    it('foreign ids are NOT_FOUND and nothing is written in the foreign tenant', async () => {
      const before = JSON.stringify(
        await tdb.db.select().from(contentRevisions).where(eq(contentRevisions.tenantId, tenantB)),
      );
      await expect(
        run(tenantA, () => contentService.packages.get(A, { contentPackageId: packageB })),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) =>
          contentService.packages.revise(
            A,
            { contentPackageId: packageB, expectedVersion: 1, copy: copy('x'), creativeDocumentIds: [] },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, () => contentService.revisions.get(A, { revisionId: revisionB })),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(run(tenantA, () => contentService.revisions.read(revisionB))).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(
        run(tenantA, (tx) =>
          contentService.variants.generate(
            A,
            { contentRevisionId: revisionB, channelConnectionIds: [channelA] },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) =>
          contentService.variants.update(
            A,
            {
              channelVariantId: variantB,
              expectedVersion: 0,
              text: 'x',
              altTexts: [],
              settings: {},
              exportIds: [],
            },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, () => contentService.variants.get(A, { variantId: variantB })),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) => contentService.revisions.transition(revisionB, 'request_review', tx)),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, () => contentService.campaigns.list(A, { brandId: brandB, page: { limit: 5 } })),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(
        JSON.stringify(
          await tdb.db.select().from(contentRevisions).where(eq(contentRevisions.tenantId, tenantB)),
        ),
      ).toBe(before);
      expect(
        (await tdb.db.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantB))).every(
          (a) => a.actorId !== USER || a.tenantId === tenantB,
        ),
      ).toBe(true);
    });
  });

  describe('agent tool source (spec 12.4 content.createBrief / content.draftCopy)', () => {
    const RUN = 'run_content_tools';
    const agent = (tenantId: string): ResolvedActorServicePrincipal => ({
      kind: 'service_principal',
      id: 'sp_content_tools',
      tenantId,
      status: 'active',
      maxAutonomy: 'create',
      grants: [
        { action: 'brand.read', brandIds: 'all' },
        { action: 'content.plan', brandIds: 'all' },
        { action: 'content.edit', brandIds: 'all' },
      ],
    });
    const runAsAgent = <T>(fn: (tx: Tx) => Promise<T>) =>
      runInTenant({ ...ctx(tenantA), actor: { kind: 'service_principal', id: 'sp_content_tools' } }, () =>
        withTransaction(fn),
      );
    const briefInput = (over: Record<string, unknown> = {}) => ({
      brandId: brandA,
      runId: RUN,
      autonomyMode: 'create' as const,
      audience: 'Repeat buyers',
      message: 'Autumn restock',
      offerFactIds: [],
      channelConnectionIds: [channelA],
      constraints: ['no discounts'],
      ...over,
    });
    let agentBriefId = '';

    it('createBrief records the agent and its run; the run mode is enforced and channels must be the brand’s', async () => {
      await expect(
        runAsAgent((tx) =>
          contentToolSource.createBrief(agent(tenantA), briefInput({ autonomyMode: 'assist' }), tx),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', reason: 'autonomy_insufficient' });
      for (const channel of [channelOfBrandA2, 'cc_unknown', 'cc_b'])
        await expect(
          runAsAgent((tx) =>
            contentToolSource.createBrief(
              agent(tenantA),
              briefInput({ channelConnectionIds: [channel] }),
              tx,
            ),
          ),
        ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        runAsAgent((tx) =>
          contentToolSource.createBrief(agent(tenantA), briefInput({ brandId: brandB }), tx),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      const created = await runAsAgent((tx) =>
        contentToolSource.createBrief(agent(tenantA), briefInput({ campaignId }), tx),
      );
      agentBriefId = created.briefId;
      const row = (await tdb.db.select().from(briefs).where(eq(briefs.id, agentBriefId)))[0]!;
      expect(row).toMatchObject({
        tenantId: tenantA,
        brandId: brandA,
        campaignId,
        state: 'draft',
        createdByKind: 'agent',
        createdById: 'sp_content_tools',
        agentRunId: RUN,
        channelConnectionIds: [channelA],
        constraints: ['no discounts'],
      });
      expect(
        (await auditOf(tenantA, 'content.brief.create')).some((a) => a.actorId === 'sp_content_tools'),
      ).toBe(true);
    });

    it('draftCopy turns each variant into a draft package under the brief, authored by the agent run', async () => {
      const drafted = await runAsAgent((tx) =>
        contentToolSource.draftCopy(
          agent(tenantA),
          {
            brandId: brandA,
            runId: RUN,
            autonomyMode: 'create',
            briefId: agentBriefId,
            variants: [
              { text: 'Restocked for autumn\nCome see', factIds: [], rationale: 'plain' },
              { text: 'Autumn is back in stock', factIds: [], rationale: 'short' },
            ],
          },
          tx,
        ),
      );
      expect(drafted.drafts).toHaveLength(2);
      for (const [i, d] of drafted.drafts.entries()) {
        const rev = await revisionRow(d.contentRevisionId);
        expect(rev).toMatchObject({
          packageId: d.contentPackageId,
          number: 1,
          state: 'draft',
          authorKind: 'agent',
          authorId: 'sp_content_tools',
          agentRunId: RUN,
          contentHash: d.contentHash,
          policyVersionId: policyVersionA,
        });
        expect(rev.copy).toMatchObject({ master: { factRefs: [] }, rationale: i === 0 ? 'plain' : 'short' });
        expect(await packageRow(d.contentPackageId)).toMatchObject({
          briefId: agentBriefId,
          state: 'draft',
          title: `${i === 0 ? 'Restocked for autumn' : 'Autumn is back in stock'} (variant ${i + 1})`,
        });
      }
      // a cited fact must be effective; another brand's brief is NOT_FOUND; nothing is written either way
      const before = (
        await tdb.db.select().from(contentPackages).where(eq(contentPackages.tenantId, tenantA))
      ).length;
      await expect(
        runAsAgent((tx) =>
          contentToolSource.draftCopy(
            agent(tenantA),
            {
              brandId: brandA,
              runId: RUN,
              autonomyMode: 'create',
              briefId: agentBriefId,
              variants: [{ text: 'x', factIds: ['fct_not_effective'], rationale: 'r' }],
            },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      await expect(
        runAsAgent((tx) =>
          contentToolSource.draftCopy(
            agent(tenantA),
            {
              brandId: brandA2,
              runId: RUN,
              autonomyMode: 'create',
              briefId: agentBriefId,
              variants: [{ text: 'x', factIds: [], rationale: 'r' }],
            },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(
        (await tdb.db.select().from(contentPackages).where(eq(contentPackages.tenantId, tenantA))).length,
      ).toBe(before);
    });

    it('withVariants reads a revision with its variants for the publishing module; a foreign id is NOT_FOUND', async () => {
      const read = await run(tenantA, (tx) => contentService.revisions.withVariants(revisionId, tx));
      expect(read).toMatchObject({ id: revisionId, brandId: brandA });
      expect(read.variants.map((v) => v.id)).toContain(variantId);
      await expect(
        run(tenantA, (tx) => contentService.revisions.withVariants(revisionB, tx)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
