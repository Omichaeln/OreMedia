import type { Db } from '@oremedia/db';
import type { SeededTenant } from './seed';
import { ACCESS_INPUTS, ACCESS_OWN_TENANT_INPUTS } from './inputs/access';
import { ACCESS_SEED } from './inputs/access-seed';
import { BRAND_INPUTS, BRAND_OWN_TENANT_INPUTS } from './inputs/brand';
import { BRAND_SEED } from './inputs/brand-seed';
import { OPERATIONS_INPUTS, OPERATIONS_OWN_TENANT_INPUTS } from './inputs/operations';
import { OPERATIONS_SEED } from './inputs/operations-seed';
import { ASSETS_INPUTS, ASSETS_SEED } from './inputs/assets';
import { CREATIVE_INPUTS } from './inputs/creative';
import { CREATIVE_SEED } from './inputs/creative-seed';
import { SKILLS_INPUTS } from './inputs/skills';
import { SKILLS_SEED } from './inputs/skills-seed';
import { AGENTS_INPUTS, AGENTS_OWN_TENANT_INPUTS } from './inputs/agents';
import { AGENTS_SEED } from './inputs/agents-seed';
import { CONTENT_INPUTS } from './inputs/content';
import { CONTENT_SEED } from './inputs/content-seed';
import { REVIEW_INPUTS } from './inputs/review';
import { REVIEW_SEED } from './inputs/review-seed';
import { PUBLISHING_INPUTS } from './inputs/publishing';
import { PUBLISHING_SEED } from './inputs/publishing-seed';
import { INTELLIGENCE_INPUTS } from './inputs/intelligence';
import { INTELLIGENCE_SEED } from './inputs/intelligence-seed';
import { EXPERIMENTS_INPUTS } from './inputs/experiments';
import { EXPERIMENTS_SEED } from './inputs/experiments-seed';
import { MEASUREMENT_INPUTS, MEASUREMENT_OWN_TENANT_INPUTS } from './inputs/measurement';
import { MEASUREMENT_SEED } from './inputs/measurement-seed';
import { COMMUNITY_INPUTS } from './inputs/community';
import { COMMUNITY_SEED } from './inputs/community-seed';
import { DESTINATIONS_INPUTS, DESTINATIONS_OWN_TENANT_INPUTS } from './inputs/destinations';
import { DESTINATIONS_SEED } from './inputs/destinations-seed';
import { OVERVIEW_INPUTS } from './inputs/overview';
import { REPORTS_INPUTS } from './inputs/reports';
import { REPORTS_SEED } from './inputs/reports-seed';
export { MCP_CROSS_TENANT_INPUTS, type McpCrossTenantFixture } from './inputs/mcp';

/**
 * Spec 19.3: every procedure needs a fixture that points every ID field at the *foreign* tenant. A procedure
 * without an entry fails CI. `null` means the procedure takes no resource ids (documented per entry, and called as
 * the caller's own tenant through OWN_TENANT_INPUTS).
 * `expectEmpty` marks list/filter queries whose correct outcome is "no data" rather than an error.
 * `expectCode` is the exact error code for foreign ids: NOT_FOUND by default (spec 5.3: existence is never leaked);
 * FORBIDDEN only where the id is not secret (a tenant id the caller is simply not a member of).
 * Each module keeps its fixtures in `inputs/<module>.ts` so parallel work never edits the same file.
 */
export interface CrossTenantFixture {
  buildInput: ((foreign: SeededTenant['ids']) => unknown) | null;
  reason?: string;
  expectEmpty?: boolean;
  expectCode?: 'NOT_FOUND' | 'FORBIDDEN';
}

/**
 * Ledger G14: a procedure whose fixture is `buildInput: null` takes no foreign reference (no id and no brand in its
 * input), so the harness has no foreign id to try. It is called as the caller's own tenant with `input` instead and
 * must answer only that tenant's data: no id of the other tenant anywhere in the answer, every `tenantId` in it the
 * caller's, and nothing of the other tenant changed. `why` says what the input holds and why no foreign reference
 * fits in it; the call succeeds unless `expectError` names the refusal the input is built to meet.
 */
export interface OwnTenantFixture {
  why: string;
  input: () => unknown;
  /** The refusal the caller's own tenant gets: VALIDATION_FAILED for a bad own input, FORBIDDEN for an operator-only procedure. */
  expectError?: 'VALIDATION_FAILED' | 'FORBIDDEN';
}

/** A module may seed extra rows per tenant and return the ids a foreign caller might try to use. */
export type SeedExtension = (
  db: Db,
  tenant: { tenantId: string; brandIds: [string, string]; ownerUserId: string },
) => Promise<Record<string, string>>;

export const CROSS_TENANT_INPUTS: Record<string, CrossTenantFixture> = {
  ...ACCESS_INPUTS,
  ...BRAND_INPUTS,
  ...OPERATIONS_INPUTS,
  ...ASSETS_INPUTS,
  ...CREATIVE_INPUTS,
  ...SKILLS_INPUTS,
  ...AGENTS_INPUTS,
  ...CONTENT_INPUTS,
  ...REVIEW_INPUTS,
  ...PUBLISHING_INPUTS,
  ...MEASUREMENT_INPUTS,
  ...COMMUNITY_INPUTS,
  ...DESTINATIONS_INPUTS,
  ...OVERVIEW_INPUTS,
  ...REPORTS_INPUTS,
  ...INTELLIGENCE_INPUTS,
  ...EXPERIMENTS_INPUTS,
};
/** One entry per procedure with `buildInput: null` (the harness fails on a missing or a stale entry). */
export const OWN_TENANT_INPUTS: Record<string, OwnTenantFixture> = {
  ...ACCESS_OWN_TENANT_INPUTS,
  ...BRAND_OWN_TENANT_INPUTS,
  ...OPERATIONS_OWN_TENANT_INPUTS,
  ...AGENTS_OWN_TENANT_INPUTS,
  ...MEASUREMENT_OWN_TENANT_INPUTS,
  ...DESTINATIONS_OWN_TENANT_INPUTS,
};
export const SEED_EXTENSIONS: SeedExtension[] = [
  ACCESS_SEED,
  ASSETS_SEED,
  BRAND_SEED,
  CREATIVE_SEED,
  OPERATIONS_SEED,
  SKILLS_SEED,
  AGENTS_SEED,
  CONTENT_SEED,
  REVIEW_SEED,
  PUBLISHING_SEED,
  MEASUREMENT_SEED,
  COMMUNITY_SEED,
  DESTINATIONS_SEED,
  INTELLIGENCE_SEED,
  EXPERIMENTS_SEED,
  REPORTS_SEED,
].filter((s): s is SeedExtension => s !== null);
