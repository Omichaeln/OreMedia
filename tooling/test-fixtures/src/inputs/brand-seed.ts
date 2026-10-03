import { sql } from 'drizzle-orm';
import { defaultPolicyDocument, emptyBrandSystemDocument } from '@oremedia/contracts/brand';
import { approvedFacts, brandObjectives, brandVersions, policyVersions } from '@oremedia/db/schema/brand';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import type { SeedExtension } from '../cross-tenant-inputs';

/** Brand-owned rows per tenant (on brand 1) so a foreign caller has version, fact, objective and policy ids to try. */
export const BRAND_SEED: SeedExtension = async (db, { tenantId, brandIds, ownerUserId }) => {
  const brandId = brandIds[0];
  const brandVersionId = newId('brandVersion');
  const factId = newId('approvedFact');
  const factId2 = newId('approvedFact');
  const objectiveId = newId('brandObjective');
  const policyVersionId = newId('policyVersion');
  const document = emptyBrandSystemDocument();
  await db.insert(brandVersions).values({
    id: brandVersionId,
    tenantId,
    brandId,
    number: 1,
    state: 'draft',
    document,
    contentHash: hashCanonical(document),
  });
  // sql``, not insert(approvedFacts).values(): the roll-forward suites seed databases at heads before 0023 (BSC-3),
  // which lack the facts workspace columns (seed.ts LATER_COLUMNS); these columns exist at every head.
  const seededAt = new Date();
  const evidence = JSON.stringify([{ kind: 'other', ref: 'seed' }]);
  for (const [id, statement] of [
    [factId, 'Seeded claim'],
    [factId2, 'Seeded second claim'],
  ] as const)
    await db.execute(
      sql`insert into ${approvedFacts} (id, tenant_id, brand_id, kind, statement, evidence, state, proposed_by_kind, proposed_by_id, created_at, updated_at, version) values (${id}, ${tenantId}, ${brandId}, 'claim', ${statement}, ${evidence}, 'proposed', 'user', ${ownerUserId}, ${seededAt}, ${seededAt}, 0)`,
    );
  await db.insert(brandObjectives).values({
    id: objectiveId,
    tenantId,
    brandId,
    name: 'Seeded objective',
    primaryMetricKey: 'qualified_enquiries',
    guardrailMetricKeys: [],
    activeFrom: new Date(),
  });
  await db.insert(policyVersions).values({
    id: policyVersionId,
    tenantId,
    brandId,
    number: 1,
    document: defaultPolicyDocument(),
    state: 'draft',
    createdByUserId: ownerUserId,
  });
  return { brandVersionId, factId, factId2, objectiveId, policyVersionId };
};
