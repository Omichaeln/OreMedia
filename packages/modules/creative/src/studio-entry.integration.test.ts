import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { emptyBrandSystemDocument, type BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import type { CreativeDocumentV1, Element, Operation } from '@oremedia/contracts/creative';
import {
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { tenants } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { creativeDocuments, creativeRevisions } from '@oremedia/db/schema/creative';
import { auditEvents } from '@oremedia/db/schema/operations';
import { hashCanonical } from '@oremedia/domain/hash';
import { newElementId, newId } from '@oremedia/domain/ids';
import { instantiateStarter, starterByKey, type StarterBrand } from '@oremedia/editor/starters/index';
import {
  brandService,
  registerBrandAssetKindSource,
  resetBrandAssetKindSource,
} from '@oremedia/module-brand';
import { creativeService, registerAssetAuthoriser, resetAssetAuthoriser } from './service';

/**
 * STU-1a against MySQL 8: the creation screen's starts (blank, custom size, built-in starter, approved brand
 * template, duplicate), rename, template retirement, and binding locks for agent batches.
 */
const USER = 'usr_stu1a_test';
const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: USER },
  brandIds: 'all',
  correlationId: 'corr_stu1a',
});
const manager = (tenantId: string, role: 'brand_manager' | 'creator' = 'brand_manager'): ResolvedActor => ({
  kind: 'user',
  id: USER,
  tenantId,
  membershipId: 'mem_stu1a',
  membershipStatus: 'active',
  role,
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});
const agent = (tenantId: string): ResolvedActor => ({
  kind: 'service_principal',
  id: 'sp_stu1a',
  tenantId,
  status: 'active',
  maxAutonomy: 'create',
  grants: [
    { action: 'brand.read', brandIds: 'all' },
    { action: 'creative.read', brandIds: 'all' },
    { action: 'creative.edit', brandIds: 'all' },
  ],
});
const AGENT_OPTS = { autonomyMode: 'create' as const };
const run = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  runInTenant(ctx(tenantId), () => withTransaction(fn));

const brandDocument = (): BrandSystemDocumentV1 => ({
  ...emptyBrandSystemDocument(),
  voice: { ...emptyBrandSystemDocument().voice, summary: 'Plain', tone: ['plain'] },
  tokens: {
    colours: [
      { key: 'ink', value: '#172120', role: 'text' },
      { key: 'paper', value: '#F4F6F3', role: 'background' },
      { key: 'accent', value: '#0F6E63', role: 'accent' },
      { key: 'mist', value: '#D3DAD5', role: 'neutral' },
    ],
    typeRoles: (['display', 'heading', 'body', 'label', 'caption'] as const).map((role, i) => ({
      role,
      fontAssetId: 'ast_font',
      weight: 600,
      minSizePx: [40, 28, 18, 14, 12][i]!,
    })),
    spacingScale: [4, 8, 16],
    radii: [0, 4],
    contrastTarget: 'AA',
  },
  logoRules: [
    {
      assetId: 'ast_logo',
      variant: 'primary',
      allowedBackgroundColourKeys: ['paper'],
      clearSpaceRatio: 0.5,
      minWidthPx: 120,
    },
  ],
});

const starterBrand = (brandVersionId: string): StarterBrand => ({
  brandVersionId,
  colours: brandDocument().tokens.colours,
  typeRoles: brandDocument().tokens.typeRoles.map((t) => ({
    role: t.role,
    fontAssetVersionId: 'av_font',
    weight: t.weight,
    minSizePx: t.minSizePx,
  })),
  logos: [
    {
      variant: 'primary',
      assetVersionId: 'av_logo',
      aspect: 10 / 3,
      minWidthPx: 120,
      allowedBackgroundColourKeys: ['paper'],
    },
  ],
});

async function publishBrand(tenantId: string, brandId: string, document: BrandSystemDocumentV1) {
  const actor = manager(tenantId);
  const draft = await run(tenantId, (tx) => brandService.versions.createDraft(actor, { brandId }, tx));
  await run(tenantId, (tx) =>
    brandService.versions.update(
      actor,
      { brandId, versionId: draft.versionId, expectedVersion: 0, document },
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

const textEl = (id: string, name: string, y: number, locked = false): Element => ({
  id,
  name,
  type: 'text',
  locked,
  visible: true,
  opacity: 1,
  protected: false,
  semanticRole: 'headline',
  transform: { x: 80, y, width: 920, height: 120, rotation: 0 },
  text: name,
  style: {
    typeRole: 'display',
    fontAssetVersionId: 'av_font',
    weight: 600,
    sizePx: 64,
    lineHeight: 1.2,
    tracking: 0,
    colourToken: 'ink',
    align: 'left',
    overflow: 'shrink_to_fit',
  },
  factRefs: [],
});

describe('STU-1a studio entry and locks against MySQL 8', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandB = newId('brand');
  const A = manager(tenantA);
  let versionA = '';
  let versionB = '';
  let foreignTemplate = { templateId: '', templateVersionId: '' };
  const authorised: string[] = [];

  const auditOf = (tenantId: string, action: string) =>
    tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, action)));
  const revisionsOf = (documentId: string) =>
    tdb.db.select().from(creativeRevisions).where(eq(creativeRevisions.documentId, documentId));

  beforeAll(async () => {
    tdb = await createTestDatabase();
    registerBrandAssetKindSource(
      async (_brandId, ids) =>
        new Map(ids.map((id) => [id, id === 'ast_font' ? ('font' as const) : ('logo' as const)])),
    );
    registerAssetAuthoriser(async (assetVersionId) => {
      authorised.push(assetVersionId);
    });
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'stu1a-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'stu1a-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    versionA = await publishBrand(tenantA, brandA, brandDocument());
    versionB = await publishBrand(tenantB, brandB, brandDocument());
    // Tenant B's approved template: the foreign-id checks start from it.
    const tB = await run(tenantB, (tx) =>
      creativeService.templates.create(manager(tenantB), { brandId: brandB, name: 'B' }, tx),
    );
    const vB = await run(tenantB, (tx) =>
      creativeService.templates.createVersion(
        manager(tenantB),
        {
          templateId: tB.templateId,
          document: instantiateStarter(starterByKey('grid-two-column')!, starterBrand(versionB)).document,
        },
        tx,
      ),
    );
    await run(tenantB, (tx) =>
      creativeService.templates.approve(
        manager(tenantB),
        { templateId: tB.templateId, templateVersionId: vB.templateVersionId, expectedVersion: 0 },
        tx,
      ),
    );
    foreignTemplate = { templateId: tB.templateId, templateVersionId: vB.templateVersionId };
  });
  afterAll(async () => {
    resetBrandAssetKindSource();
    resetAssetAuthoriser();
    await tdb?.drop();
  });

  describe('starting points', () => {
    it('a built-in starter: the instantiated document becomes revision 1 with its content type; the audit names the starter', async () => {
      const { document } = instantiateStarter(starterByKey('carousel-3-steps')!, starterBrand(versionA));
      authorised.length = 0;
      const created = await run(tenantA, (tx) =>
        creativeService.documents.create(
          A,
          {
            brandId: brandA,
            title: 'Three-step guide – 3 Oct',
            document,
            contentType: 'carousel',
            source: { kind: 'starter', starterKey: 'carousel-3-steps' },
          },
          tx,
        ),
      );
      expect(created.findings.filter((f) => f.severity === 'blocking')).toEqual([]);
      const got = await run(tenantA, () =>
        creativeService.documents.get(A, { documentId: created.documentId }),
      );
      if (got.revision.kind !== 'graphic') throw new Error('expected graphic'); // STU-2b: the DTO is per kind
      expect(got.revision.snapshot.contentType).toBe('carousel');
      expect(got.revision.snapshot.pages).toHaveLength(3);
      expect(authorised).toEqual(expect.arrayContaining(['av_font', 'av_logo']));
      const [event] = (await auditOf(tenantA, 'creative.document.create')).filter(
        (e) => e.resourceId === created.documentId,
      );
      expect(event?.metadata).toMatchObject({
        sourceType: 'starter',
        sourceId: 'carousel-3-steps',
        contentType: 'carousel',
      });
    });

    it('an unknown starter, a starter without a document and a page that does not match its format are refused', async () => {
      const { document } = instantiateStarter(starterByKey('post-bold-headline')!, starterBrand(versionA));
      const create = (input: Parameters<typeof creativeService.documents.create>[1]) =>
        run(tenantA, (tx) => creativeService.documents.create(A, input, tx));
      await expect(
        create({ brandId: brandA, title: 'x', document, source: { kind: 'starter', starterKey: 'nope' } }),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      await expect(
        create({
          brandId: brandA,
          title: 'x',
          source: { kind: 'starter', starterKey: 'post-bold-headline' },
        }),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      const wrongSize = { ...document, pages: [{ ...document.pages[0]!, width: 1000 }] };
      await expect(
        create({ brandId: brandA, title: 'x', document: wrongSize, source: { kind: 'blank' } }),
      ).rejects.toBeInstanceOf(ValidationFailedError);
    });

    it('a custom size within the render limits is a format of its own; out of range is refused', async () => {
      const page = (w: number, h: number) => ({
        id: 'page_1',
        name: 'Page 1',
        formatKey: `custom_${w}x${h}`,
        width: w,
        height: h,
        elements: [],
        layoutConstraints: [],
      });
      const doc = (w: number, h: number): CreativeDocumentV1 => ({
        schemaVersion: 1,
        brandVersionId: 'x',
        pages: [page(w, h)],
        variants: [],
      });
      const created = await run(tenantA, (tx) =>
        creativeService.documents.create(
          A,
          {
            brandId: brandA,
            title: 'Event banner',
            document: doc(1500, 500),
            contentType: 'custom',
            source: { kind: 'custom' },
          },
          tx,
        ),
      );
      const render = await run(tenantA, (tx) =>
        creativeService.renders.request(
          A,
          { documentId: created.documentId, revisionId: created.revisionId, formatKeys: ['custom_1500x500'] },
          tx,
        ),
      );
      expect(render.state).toBe('pending');
      for (const [w, h] of [
        [5000, 500],
        [4000, 400],
        [40, 40],
      ] as const)
        await expect(
          run(tenantA, (tx) =>
            creativeService.documents.create(
              A,
              { brandId: brandA, title: 'x', document: doc(w, h), source: { kind: 'custom' } },
              tx,
            ),
          ),
        ).rejects.toBeInstanceOf(ValidationFailedError);
    });

    it('an approved brand template: the server starts from the version document; drafts and foreign templates are refused', async () => {
      const t = await run(tenantA, (tx) =>
        creativeService.templates.create(A, { brandId: brandA, name: 'Promo' }, tx),
      );
      const { document } = instantiateStarter(starterByKey('post-photo-feature')!, starterBrand(versionA));
      const v = await run(tenantA, (tx) =>
        creativeService.templates.createVersion(
          A,
          { templateId: t.templateId, document, formats: ['square_1080'] },
          tx,
        ),
      );
      const fromTemplate = (templateId: string, templateVersionId: string) =>
        run(tenantA, (tx) =>
          creativeService.documents.create(
            A,
            {
              brandId: brandA,
              title: 'From template',
              contentType: 'social_post',
              source: { kind: 'template', templateId, templateVersionId },
            },
            tx,
          ),
        );
      await expect(fromTemplate(t.templateId, v.templateVersionId)).rejects.toBeInstanceOf(
        ValidationFailedError,
      );
      await run(tenantA, (tx) =>
        creativeService.templates.approve(
          A,
          { templateId: t.templateId, templateVersionId: v.templateVersionId, expectedVersion: 0 },
          tx,
        ),
      );
      const created = await fromTemplate(t.templateId, v.templateVersionId);
      const got = await run(tenantA, () =>
        creativeService.documents.get(A, { documentId: created.documentId }),
      );
      if (got.revision.kind !== 'graphic') throw new Error('expected graphic');
      expect(got.revision.snapshot.templateVersionId).toBe(v.templateVersionId);
      expect(got.revision.snapshot.contentType).toBe('social_post');
      expect(hashCanonical(got.revision.snapshot.pages)).toBe(hashCanonical(document.pages));
      await expect(
        fromTemplate(foreignTemplate.templateId, foreignTemplate.templateVersionId),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) =>
          creativeService.documents.create(
            A,
            {
              brandId: brandA,
              title: 'x',
              document,
              source: {
                kind: 'template',
                ...{ templateId: t.templateId, templateVersionId: v.templateVersionId },
              },
            },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
    });

    it('duplicate copies the current revision as revision 1 (same snapshot and hash) with provenance in the audit', async () => {
      const { document } = instantiateStarter(starterByKey('post-bold-headline')!, starterBrand(versionA));
      const source = await run(tenantA, (tx) =>
        creativeService.documents.create(
          A,
          {
            brandId: brandA,
            title: 'Original',
            document,
            source: { kind: 'starter', starterKey: 'post-bold-headline' },
          },
          tx,
        ),
      );
      const headline = document.pages[0]!.elements.find((e) => e.semanticRole === 'headline')!;
      const edited = await run(tenantA, (tx) =>
        creativeService.operations.apply(
          A,
          {
            documentId: source.documentId,
            baseRevisionId: source.revisionId,
            operations: [{ op: 'setText', pageId: 'page_1', elementId: headline.id, text: 'Spring offer' }],
            summary: 'edit',
            origin: 'user',
          },
          tx,
        ),
      );
      const copy = await run(tenantA, (tx) =>
        creativeService.documents.duplicate(A, { documentId: source.documentId }, tx),
      );
      const got = await run(tenantA, () => creativeService.documents.get(A, { documentId: copy.documentId }));
      expect(got.title).toBe('Original (copy)');
      expect(got.revision.number).toBe(1);
      expect(got.revision.contentHash).toBe(edited.revision.contentHash);
      expect(await revisionsOf(copy.documentId)).toHaveLength(1);
      const [event] = (await auditOf(tenantA, 'creative.document.duplicate')).filter(
        (e) => e.resourceId === copy.documentId,
      );
      expect(event?.metadata).toMatchObject({
        sourceType: 'creative_document',
        sourceId: source.documentId,
        sourceRevisionId: edited.revision.id,
        sourceBrandVersionId: versionA,
      });
      expect(got.revision.snapshot.brandVersionId).toBe(versionA); // the published version, as create pins it
      const named = await run(tenantA, (tx) =>
        creativeService.documents.duplicate(A, { documentId: source.documentId, title: 'Named copy' }, tx),
      );
      expect(
        (await tdb.db.select().from(creativeDocuments).where(eq(creativeDocuments.id, named.documentId)))[0]
          ?.title,
      ).toBe('Named copy');
    });

    it('rename changes the title only and is audited; blank titles are refused', async () => {
      const created = await run(tenantA, (tx) =>
        creativeService.documents.create(A, { brandId: brandA, title: 'Draft' }, tx),
      );
      const renamed = await run(tenantA, (tx) =>
        creativeService.documents.rename(
          A,
          { documentId: created.documentId, title: '  Spring offer – 3 Oct  ' },
          tx,
        ),
      );
      expect(renamed.title).toBe('Spring offer – 3 Oct');
      const got = await run(tenantA, () =>
        creativeService.documents.get(A, { documentId: created.documentId }),
      );
      expect(got.title).toBe('Spring offer – 3 Oct');
      expect(got.revision.id).toBe(created.revisionId);
      expect(
        (await auditOf(tenantA, 'creative.document.rename')).some((e) => e.resourceId === created.documentId),
      ).toBe(true);
      await expect(
        run(tenantA, (tx) =>
          creativeService.documents.rename(A, { documentId: created.documentId, title: '   ' }, tx),
        ),
      ).rejects.toThrow();
    });

    it('foreign documents cannot be duplicated or renamed; foreign templates cannot be retired', async () => {
      const foreign = await run(tenantB, (tx) =>
        creativeService.documents.create(manager(tenantB), { brandId: brandB, title: 'B' }, tx),
      );
      await expect(
        run(tenantA, (tx) => creativeService.documents.duplicate(A, { documentId: foreign.documentId }, tx)),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) =>
          creativeService.documents.rename(A, { documentId: foreign.documentId, title: 'x' }, tx),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) =>
          creativeService.templates.retire(A, { ...foreignTemplate, expectedVersion: 1 }, tx),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('archive and unarchive (G12)', () => {
    const listIds = async (archived?: boolean) =>
      (
        await run(tenantA, () =>
          creativeService.documents.list(A, {
            brandId: brandA,
            ...(archived === undefined ? {} : { archived }),
            page: { limit: 200 },
          }),
        )
      ).items.map((d) => d.id);

    it('an archived document leaves the default index, is listed with the filter, still opens, and comes back', async () => {
      const created = await run(tenantA, (tx) =>
        creativeService.documents.create(A, { brandId: brandA, title: 'Old flyer' }, tx),
      );
      expect(await listIds()).toContain(created.documentId);
      const archived = await run(tenantA, (tx) =>
        creativeService.documents.archive(A, { documentId: created.documentId, expectedVersion: 1 }, tx),
      );
      expect(archived).toMatchObject({ documentId: created.documentId, version: 2 });
      expect(archived.archivedAt).not.toBeNull();
      expect(await listIds()).not.toContain(created.documentId);
      expect(await listIds(false)).not.toContain(created.documentId);
      expect(await listIds(true)).toEqual(expect.arrayContaining([created.documentId]));
      const got = await run(tenantA, () =>
        creativeService.documents.get(A, { documentId: created.documentId }),
      );
      expect(got.archivedAt).toBe(archived.archivedAt);
      expect(got.revision.id).toBe(created.revisionId); // revisions are untouched
      expect(
        (await auditOf(tenantA, 'creative.document.archive')).some(
          (e) => e.resourceId === created.documentId,
        ),
      ).toBe(true);
      // Archiving again answers the stored state and writes nothing.
      const again = await run(tenantA, (tx) =>
        creativeService.documents.archive(A, { documentId: created.documentId, expectedVersion: 2 }, tx),
      );
      expect(again).toEqual(archived);
      const restored = await run(tenantA, (tx) =>
        creativeService.documents.unarchive(A, { documentId: created.documentId, expectedVersion: 2 }, tx),
      );
      expect(restored).toEqual({ documentId: created.documentId, archivedAt: null, version: 3 });
      expect(await listIds()).toContain(created.documentId);
      expect(await listIds(true)).not.toContain(created.documentId);
      expect(
        (await auditOf(tenantA, 'creative.document.unarchive')).some(
          (e) => e.resourceId === created.documentId,
        ),
      ).toBe(true);
    });

    it('is version-checked and needs creative.edit; a foreign document is NOT_FOUND', async () => {
      const created = await run(tenantA, (tx) =>
        creativeService.documents.create(A, { brandId: brandA, title: 'Guarded' }, tx),
      );
      await expect(
        run(tenantA, (tx) =>
          creativeService.documents.archive(A, { documentId: created.documentId, expectedVersion: 0 }, tx),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
      const reviewer = { ...manager(tenantA), role: 'reviewer' } as ResolvedActor;
      await expect(
        run(tenantA, (tx) =>
          creativeService.documents.archive(
            reviewer,
            { documentId: created.documentId, expectedVersion: 1 },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      const foreign = await run(tenantB, (tx) =>
        creativeService.documents.create(manager(tenantB), { brandId: brandB, title: 'B' }, tx),
      );
      await expect(
        run(tenantA, (tx) =>
          creativeService.documents.archive(A, { documentId: foreign.documentId, expectedVersion: 1 }, tx),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) =>
          creativeService.documents.unarchive(A, { documentId: foreign.documentId, expectedVersion: 1 }, tx),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await listIds()).toContain(created.documentId);
    });
  });

  describe('templates with their current version (gallery read)', () => {
    it('lists active templates with their approved current version document; drafts are left out', async () => {
      const draft = await run(tenantA, (tx) =>
        creativeService.templates.create(A, { brandId: brandA, name: 'Draft only' }, tx),
      );
      const list = await run(tenantA, () =>
        creativeService.templates.listCurrent(A, { brandId: brandA, page: { limit: 50 } }),
      );
      expect(list.items.length).toBeGreaterThan(0);
      for (const t of list.items) {
        expect(t.state).toBe('active');
        expect(t.currentVersion).toMatchObject({ id: t.currentVersionId, state: 'approved' });
        expect(t.currentVersion.document.pages.length).toBeGreaterThan(0);
      }
      expect(list.items.some((t) => t.id === draft.templateId)).toBe(false);
      await expect(
        run(tenantA, () =>
          creativeService.templates.listCurrent(A, { brandId: brandB, page: { limit: 50 } }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('template retirement', () => {
    it('retiring the current version falls back to the newest other approved one; retiring the template retires all', async () => {
      const t = await run(tenantA, (tx) =>
        creativeService.templates.create(A, { brandId: brandA, name: 'Two versions' }, tx),
      );
      const doc = instantiateStarter(starterByKey('grid-two-column')!, starterBrand(versionA)).document;
      const v1 = await run(tenantA, (tx) =>
        creativeService.templates.createVersion(A, { templateId: t.templateId, document: doc }, tx),
      );
      const v2 = await run(tenantA, (tx) =>
        creativeService.templates.createVersion(A, { templateId: t.templateId, document: doc }, tx),
      );
      await run(tenantA, (tx) =>
        creativeService.templates.approve(
          A,
          { templateId: t.templateId, templateVersionId: v1.templateVersionId, expectedVersion: 0 },
          tx,
        ),
      );
      await run(tenantA, (tx) =>
        creativeService.templates.approve(
          A,
          { templateId: t.templateId, templateVersionId: v2.templateVersionId, expectedVersion: 1 },
          tx,
        ),
      );
      await expect(
        run(tenantA, (tx) =>
          creativeService.templates.retire(
            agent(tenantA),
            { templateId: t.templateId, templateVersionId: v2.templateVersionId, expectedVersion: 2 },
            tx,
            AGENT_OPTS,
          ),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      const retired = await run(tenantA, (tx) =>
        creativeService.templates.retire(
          A,
          { templateId: t.templateId, templateVersionId: v2.templateVersionId, expectedVersion: 2 },
          tx,
        ),
      );
      expect(retired).toMatchObject({
        templateState: 'active',
        currentVersionId: v1.templateVersionId,
        version: 3,
      });
      expect(await run(tenantA, () => creativeService.templates.eligibleVersionIds(brandA))).not.toContain(
        v2.templateVersionId,
      );
      const all = await run(tenantA, (tx) =>
        creativeService.templates.retire(A, { templateId: t.templateId, expectedVersion: 3 }, tx),
      );
      expect(all.templateState).toBe('retired');
      const got = await run(tenantA, () => creativeService.templates.get(A, { templateId: t.templateId }));
      expect(got.versions.map((v) => v.state)).toEqual(['retired', 'retired']);
      expect((await auditOf(tenantA, 'creative.template.retire')).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('locks are binding (architecture principle 2)', () => {
    const lockedId = newElementId();
    const freeId = newElementId();
    let documentId = '';
    let head = '';

    beforeAll(async () => {
      const document: CreativeDocumentV1 = {
        schemaVersion: 1,
        brandVersionId: versionA,
        pages: [
          {
            id: 'page_1',
            name: 'Page 1',
            formatKey: 'square_1080',
            width: 1080,
            height: 1080,
            layoutConstraints: [],
            elements: [textEl(lockedId, 'Locked headline', 80, true), textEl(freeId, 'Free text', 400)],
          },
        ],
        variants: [],
      };
      const created = await run(tenantA, (tx) =>
        creativeService.documents.create(A, { brandId: brandA, title: 'Locks', document }, tx),
      );
      documentId = created.documentId;
      head = created.revisionId;
    });

    const agentApply = (operations: Operation[]) =>
      run(tenantA, (tx) =>
        creativeService.operations.apply(
          agent(tenantA),
          { documentId, baseRevisionId: head, operations, summary: 'agent edit', origin: 'agent' },
          tx,
          AGENT_OPTS,
        ),
      );

    it('an agent operation on a locked element is refused with element_locked and nothing is written', async () => {
      for (const op of [
        { op: 'setText', pageId: 'page_1', elementId: lockedId, text: 'Changed' },
        { op: 'setStyle', pageId: 'page_1', elementId: lockedId, patch: { sizePx: 70 } },
        { op: 'removeElement', pageId: 'page_1', elementId: lockedId },
        { op: 'setRotation', pageId: 'page_1', elementId: lockedId, rotation: 4 },
        { op: 'setLock', pageId: 'page_1', elementId: lockedId, locked: false },
      ] as Operation[]) {
        const err = await agentApply([op]).catch((e: unknown) => e);
        expect(err, op.op).toBeInstanceOf(PolicyDeniedError);
        expect((err as PolicyDeniedError).reason).toBe('element_locked');
      }
      expect(await revisionsOf(documentId)).toHaveLength(1);
      // The same agent may edit the unlocked element; a person may edit the locked element's text.
      const ok = await agentApply([
        { op: 'setText', pageId: 'page_1', elementId: freeId, text: 'Agent text' },
      ]);
      head = ok.revision.id;
      const person = await run(tenantA, (tx) =>
        creativeService.operations.apply(
          A,
          {
            documentId,
            baseRevisionId: head,
            operations: [{ op: 'setText', pageId: 'page_1', elementId: lockedId, text: 'Person text' }],
            summary: 'person edit',
            origin: 'user',
          },
          tx,
        ),
      );
      head = person.revision.id;
    });

    it('a person cannot move a locked element; a locked page refuses agents entirely, propose included', async () => {
      await expect(
        run(tenantA, (tx) =>
          creativeService.operations.apply(
            A,
            {
              documentId,
              baseRevisionId: head,
              operations: [{ op: 'moveElement', pageId: 'page_1', elementId: lockedId, x: 0, y: 0 }],
              summary: 'move',
              origin: 'user',
            },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      const locked = await run(tenantA, (tx) =>
        creativeService.operations.apply(
          A,
          {
            documentId,
            baseRevisionId: head,
            operations: [{ op: 'setPageLock', pageId: 'page_1', locked: true }],
            summary: 'lock page',
            origin: 'user',
          },
          tx,
        ),
      );
      head = locked.revision.id;
      const err = await agentApply([{ op: 'setText', pageId: 'page_1', elementId: freeId, text: 'x' }]).catch(
        (e: unknown) => e,
      );
      expect((err as PolicyDeniedError).reason).toBe('page_locked');
      const proposed = await run(tenantA, (tx) =>
        creativeService.operations
          .propose(
            agent(tenantA),
            {
              documentId,
              baseRevisionId: head,
              operations: [{ op: 'setText', pageId: 'page_1', elementId: freeId, text: 'x' }],
              summary: 'p',
              origin: 'agent',
            },
            tx,
            AGENT_OPTS,
          )
          .catch((e: unknown) => e),
      );
      expect((proposed as PolicyDeniedError).reason).toBe('page_locked');
    });

    it('a person cannot remove a locked element; an agent cannot remove a page holding a protected logo', async () => {
      const err = await run(tenantA, (tx) =>
        creativeService.operations.apply(
          A,
          {
            documentId,
            baseRevisionId: head,
            operations: [{ op: 'removeElement', pageId: 'page_1', elementId: lockedId }],
            summary: 'rm',
            origin: 'user',
          },
          tx,
        ),
      ).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ issue: 'element_locked' }] });
      const { document } = instantiateStarter(starterByKey('carousel-3-steps')!, starterBrand(versionA));
      const withLogo = await run(tenantA, (tx) =>
        creativeService.documents.create(A, { brandId: brandA, title: 'Logo pages', document }, tx),
      );
      const denied = await run(tenantA, (tx) =>
        creativeService.operations.apply(
          agent(tenantA),
          {
            documentId: withLogo.documentId,
            baseRevisionId: withLogo.revisionId,
            operations: [{ op: 'removePage', pageId: 'page_2' }],
            summary: 'rm page',
            origin: 'agent',
          },
          tx,
          AGENT_OPTS,
        ),
      ).catch((e: unknown) => e);
      expect((denied as PolicyDeniedError).reason).toBe('protected_element');
    });

    it('page operations commit for a person and undo through their inverses', async () => {
      const { revision } = await run(tenantA, () => creativeService.documents.get(A, { documentId }));
      if (revision.kind !== 'graphic') throw new Error('expected graphic');
      const ids = revision.snapshot.pages[0]!.elements.map((e) => e.id);
      const elementIdMap = Object.fromEntries(ids.map((id) => [id, newElementId()]));
      const res = await run(tenantA, (tx) =>
        creativeService.operations.apply(
          A,
          {
            documentId,
            baseRevisionId: head,
            operations: [
              { op: 'duplicatePage', pageId: 'page_1', newPageId: 'page_2', elementIdMap },
              { op: 'reorderPage', pageId: 'page_2', toIndex: 0 },
            ],
            summary: 'pages',
            origin: 'user',
          },
          tx,
        ),
      );
      expect(res.revision.snapshot.pages.map((p) => [p.id, p.locked ?? false])).toEqual([
        ['page_2', false],
        ['page_1', true],
      ]);
      head = res.revision.id;
      const removed = await run(tenantA, (tx) =>
        creativeService.operations.apply(
          A,
          {
            documentId,
            baseRevisionId: head,
            operations: [{ op: 'removePage', pageId: 'page_2' }],
            summary: 'remove',
            origin: 'user',
          },
          tx,
        ),
      );
      expect(removed.revision.snapshot.pages.map((p) => p.id)).toEqual(['page_1']);
    });
  });
});
