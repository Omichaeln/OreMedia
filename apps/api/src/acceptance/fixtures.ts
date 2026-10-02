import { randomBytes, randomUUID } from 'node:crypto';
import { defaultPolicyDocument, emptyBrandSystemDocument } from '@oremedia/contracts/brand';
import { NotFoundError } from '@oremedia/contracts/errors';
import type { Action, ResolvedActor } from '@oremedia/contracts/policy';
import type { MembershipRole } from '@oremedia/contracts/tenancy';
import { runAsPlatform, runInTenant, withTransaction, type Tx } from '@oremedia/db';
import {
  accessService,
  resolveTenantContext,
  UserDirectory,
  type AuthOrigin,
  type ResolvedTenant,
} from '@oremedia/module-access';
import { brandService } from '@oremedia/module-brand';
import { channelService } from '@oremedia/module-publishing';
import { providerRegistry } from '@oremedia/providers';
import { fail, pass, type AcceptanceResult } from '../../../../tooling/scripts/acceptance/report';

/**
 * The staging acceptance fixtures (docs/runbooks/staging-acceptance.md): two throwaway companies, each with a
 * member per role the product has, one brand with published standards and an active release policy, and an agent
 * principal, provisioned through the application services (never a table write) so every row is one the product
 * itself would have made. Re-runnable: whatever exists is reused, and only what is missing is created. Each run
 * gives every synthetic member a fresh random password through the password setup path (an owner issues the link,
 * the person redeems it), held in this process's memory only; nothing is written to a log or a report.
 *
 * Each company has an extra owner, the "operator": the account the bootstrap creates (bootstrapOwner, as the
 * deploy runbook's first-owner step does) and the only one that can issue the other owner's setup link (an owner's
 * link needs an owner, never oneself). The operator has no password and no session: it acts in-process only.
 */
export const FIXTURE_TENANTS = [
  { label: 'A', name: 'Acceptance A', slug: 'acceptance-a' },
  { label: 'B', name: 'Acceptance B', slug: 'acceptance-b' },
] as const;
export type FixtureTenantSpec = (typeof FIXTURE_TENANTS)[number];

export const FIXTURE_ROLES = [
  'owner',
  'admin',
  'brand_manager',
  'publisher',
  'reviewer',
  'creator',
] as const satisfies readonly MembershipRole[];
export type FixtureRole = (typeof FIXTURE_ROLES)[number];

export const FIXTURE_BRAND_NAME = 'Acceptance brand';
export const FIXTURE_AGENT_NAME = 'Acceptance agent';

/** What the fixture agent may do: enough for a copywriting run and a layout proposal, nothing external. */
const AGENT_GRANTS = (
  [
    'brand.read',
    'asset.read',
    'creative.read',
    'creative.edit',
    'content.plan',
    'content.edit',
    'skill.read',
    'insight.read',
  ] satisfies Action[]
).map((action) => ({ action, brandIds: 'all' as const }));

export interface FixtureMember {
  role: FixtureRole;
  email: string;
  /** Generated at run time; in memory only. */
  password: string;
  membershipId: string;
  userId: string;
}

export interface FixtureTenant {
  label: string;
  name: string;
  slug: string;
  tenantId: string;
  operatorEmail: string;
  operatorUserId: string;
  members: Record<FixtureRole, FixtureMember>;
  brandId: string;
  brandName: string;
  publishedVersionId: string;
  policyVersionId: string;
  servicePrincipalId: string;
  /** Usable channel connections of the fixture brand (only ever a certified provider; see `providerAvailability`). */
  channelConnectionIds: string[];
  /** The address an external reviewer link is issued to in the review journey. */
  externalReviewerEmail: string;
}

export interface FixtureOptions {
  emailDomain: string;
  /** The deployed web origin (where setup links point; the links are redeemed in-process and never printed). */
  webOrigin: string;
  correlationId?: string;
}

export const fixtureEmail = (slug: string, who: string, domain: string): string => `${slug}-${who}@${domain}`;

/** 32 characters of randomness, base64url: well above the 12-character policy, never containing an address. */
export const generatePassword = (): string => randomBytes(24).toString('base64url');

const directory = new UserDirectory();

const authOrigin = (correlationId: string): AuthOrigin => ({
  correlationId,
  ipHash: null,
  userAgentHash: null,
});

/** The tenant context and actor a request by this user on this company would get (the same resolution as HTTP). */
const actorFor = (userId: string, tenantId: string, correlationId: string): Promise<ResolvedTenant> =>
  resolveTenantContext(
    { kind: 'user', userId, sessionId: `acceptance-${correlationId}`, selectedTenantId: tenantId },
    tenantId,
    correlationId,
  );

/** Runs a command the way the router does: tenant context + one transaction. */
const command = <T>(as: ResolvedTenant, fn: (actor: ResolvedActor, tx: Tx) => Promise<T>): Promise<T> =>
  runInTenant(as.context, () => withTransaction((tx) => fn(as.actor, tx)));

const read = <T>(as: ResolvedTenant, fn: (actor: ResolvedActor) => Promise<T>): Promise<T> =>
  runInTenant(as.context, () => fn(as.actor));

/** Certified providers the staging api deploys: the only ones a fixture channel could ever be connected on. */
export function providerAvailability(disabled: ReadonlySet<string>): {
  usable: string[];
  uncertified: string[];
  disabled: string[];
} {
  const listed = providerRegistry.list();
  return {
    usable: listed.filter((p) => p.certified && !disabled.has(p.key)).map((p) => p.key),
    uncertified: listed.filter((p) => !p.certified).map((p) => p.key),
    disabled: listed.filter((p) => disabled.has(p.key)).map((p) => p.key),
  };
}

interface ExistingTenant {
  tenantId: string;
  operatorUserId: string;
}

/** The company by slug with its operator, or null when it does not exist yet; a slug taken by another company fails. */
async function findTenant(spec: FixtureTenantSpec, operatorEmail: string, correlationId: string) {
  return runAsPlatform('acceptance', correlationId, async (): Promise<ExistingTenant | null> => {
    const tenant = await directory.tenantBySlug(spec.slug);
    if (!tenant) return null;
    if (tenant.status !== 'active') throw new Error(`company ${spec.slug} exists but is ${tenant.status}`);
    const operator = await directory.findByEmail(operatorEmail);
    if (!operator)
      throw new Error(
        `company ${spec.slug} exists without its operator account: not provisioned by this job`,
      );
    return { tenantId: tenant.id, operatorUserId: operator.id };
  });
}

async function ensureTenant(
  spec: FixtureTenantSpec,
  opts: Required<FixtureOptions>,
): Promise<ExistingTenant> {
  const operatorEmail = fixtureEmail(spec.slug, 'operator', opts.emailDomain);
  const existing = await findTenant(spec, operatorEmail, opts.correlationId);
  if (existing) return existing;
  const created = await accessService.bootstrapOwner(
    { email: operatorEmail, name: `${spec.name} operator`, tenant: { name: spec.name, slug: spec.slug } },
    opts.correlationId,
  );
  return { tenantId: created.tenantId, operatorUserId: created.userId };
}

/** The member for each role: invited by the operator when missing (allBrands, so every role reaches the brand). */
async function ensureMembers(
  spec: FixtureTenantSpec,
  operator: ResolvedTenant,
  opts: Required<FixtureOptions>,
): Promise<Array<Omit<FixtureMember, 'password'>>> {
  const wanted = FIXTURE_ROLES.map((role) => ({
    role,
    email: fixtureEmail(spec.slug, role, opts.emailDomain),
  }));
  let listed = (await read(operator, (a) => accessService.listMembers(a))).items;
  for (const { role, email } of wanted) {
    const found = listed.find((m) => m.email?.toLowerCase() === email);
    if (found && found.role !== role) throw new Error(`${email} is a ${found.role}, expected ${role}`);
    if (found?.status === 'disabled')
      throw new Error(`${email} is a disabled member; re-enable or remove it first`);
    if (!found)
      await command(operator, (a, tx) => accessService.inviteMember(a, { email, role, allBrands: true }, tx));
  }
  listed = (await read(operator, (a) => accessService.listMembers(a))).items;
  return wanted.map(({ role, email }) => {
    const m = listed.find((x) => x.email?.toLowerCase() === email);
    if (!m) throw new Error(`${email} was not listed after the invitation`);
    return { role, email, membershipId: m.membershipId, userId: m.userId };
  });
}

/**
 * A fresh password for one member through the product's own path: the operator (an owner) issues a one-time setup
 * link for the membership, and the link is redeemed here with the generated password. The redemption also signs the
 * person in; that session is ended at once, so the only sessions a fixture holds are the ones the HTTP sign-in makes.
 */
async function setPassword(
  operator: ResolvedTenant,
  member: Omit<FixtureMember, 'password'>,
  opts: Required<FixtureOptions>,
): Promise<string> {
  const password = generatePassword();
  const link = await command(operator, (a, tx) =>
    accessService.issuePasswordSetup(a, { membershipId: member.membershipId }, opts.webOrigin, tx),
  );
  const token = new URL(link.url).hash.replace(/^#token=/, '');
  const redeemed = await accessService.redeemPasswordSetup(
    { token, password },
    { allowedDomains: null },
    authOrigin(opts.correlationId),
  );
  if (!redeemed.ok) throw new Error(`password setup for the ${member.role} was refused: ${redeemed.reason}`);
  await accessService.signOut(
    { userId: redeemed.userId, sessionId: redeemed.sessionId },
    authOrigin(opts.correlationId),
  );
  return password;
}

/** The fixture brand, out of setup, with published standards (the first version, submitted and published) and an active policy. */
async function ensureBrand(owner: ResolvedTenant) {
  const listed = await read(owner, (a) => brandService.list(a));
  let brandId = listed.find((b) => b.name === FIXTURE_BRAND_NAME)?.id;
  if (!brandId)
    brandId = (
      await command(owner, (a, tx) =>
        brandService.create(
          a,
          { name: FIXTURE_BRAND_NAME, timezone: 'UTC', defaultLocale: 'en', classification: 'client' },
          tx,
        ),
      )
    ).brandId;
  const id = brandId;
  let brand = await read(owner, (a) => brandService.get(a, id));
  if (!brand.publishedVersionId) {
    const empty = emptyBrandSystemDocument();
    const document = {
      ...empty,
      voice: { ...empty.voice, summary: 'Plain, specific and warm', tone: ['plain', 'warm'] },
      tokens: {
        ...empty.tokens,
        colours: [
          { key: 'ink', value: '#172120', role: 'text' as const },
          { key: 'paper', value: '#F4F6F3', role: 'background' as const },
        ],
        spacingScale: [4, 8, 16, 24],
        radii: [0, 4],
      },
    };
    const draft = await command(owner, (a, tx) => brandService.versions.createDraft(a, { brandId: id }, tx));
    const updated = await command(owner, (a, tx) =>
      brandService.versions.update(
        a,
        { brandId: id, versionId: draft.versionId, expectedVersion: draft.version, document },
        tx,
      ),
    );
    const submitted = await command(owner, (a, tx) =>
      brandService.versions.submitForReview(
        a,
        { brandId: id, versionId: draft.versionId, expectedVersion: updated.version },
        tx,
      ),
    );
    await command(owner, (a, tx) =>
      brandService.versions.publish(
        a,
        { brandId: id, versionId: draft.versionId, expectedVersion: submitted.version },
        tx,
      ),
    );
    brand = await read(owner, (a) => brandService.get(a, id));
  }
  let policyVersionId: string;
  try {
    policyVersionId = (await read(owner, (a) => brandService.policy.get(a, { brandId: id }))).id;
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    const created = await command(owner, (a, tx) =>
      brandService.policy.createVersion(a, { brandId: id, document: defaultPolicyDocument() }, tx),
    );
    await command(owner, (a, tx) =>
      brandService.policy.activate(
        a,
        { brandId: id, policyVersionId: created.policyVersionId, expectedVersion: created.version },
        tx,
      ),
    );
    policyVersionId = created.policyVersionId;
  }
  if (!brand.publishedVersionId) throw new Error('the brand has no published version after publishing');
  // R1-D: with its standards published the brand leaves setup (the checklist's Finish); the home then shows work.
  // Read again: activating the policy bumped the brand's version.
  brand = await read(owner, (a) => brandService.get(a, id));
  if (brand.status === 'setup')
    await command(owner, (a, tx) =>
      brandService.completeSetup(a, { brandId: id, expectedVersion: brand.version }, tx),
    );
  return { brandId: id, publishedVersionId: brand.publishedVersionId, policyVersionId };
}

/** The agent principal runs are started under (UX-08: picked by name), created when the brand lists none by that name. */
async function ensureAgent(owner: ResolvedTenant, brandId: string): Promise<string> {
  const listed = await read(owner, (a) =>
    accessService.listServicePrincipals(a, { brandId, page: { limit: 50 } }),
  );
  const found = listed.items.find((sp) => sp.name === FIXTURE_AGENT_NAME);
  if (found) return found.id;
  const created = await command(owner, (a, tx) =>
    accessService.createServicePrincipal(
      a,
      { kind: 'agent', name: FIXTURE_AGENT_NAME, grants: AGENT_GRANTS, maxAutonomy: 'create' },
      tx,
    ),
  );
  return created.servicePrincipalId;
}

export async function provisionTenant(
  spec: FixtureTenantSpec,
  options: FixtureOptions,
): Promise<FixtureTenant> {
  const opts = { correlationId: `acceptance-${randomUUID()}`, ...options };
  const { tenantId, operatorUserId } = await ensureTenant(spec, opts);
  const operator = await actorFor(operatorUserId, tenantId, opts.correlationId);
  const members = await ensureMembers(spec, operator, opts);
  const withPasswords: FixtureMember[] = [];
  for (const m of members) withPasswords.push({ ...m, password: await setPassword(operator, m, opts) });
  const ownerMember = withPasswords.find((m) => m.role === 'owner');
  if (!ownerMember) throw new Error('no owner among the fixture members');
  const owner = await actorFor(ownerMember.userId, tenantId, opts.correlationId);
  const brand = await ensureBrand(owner);
  const servicePrincipalId = await ensureAgent(owner, brand.brandId);
  const channels = await read(owner, (a) => channelService.list(a, { brandId: brand.brandId }));
  return {
    label: spec.label,
    name: spec.name,
    slug: spec.slug,
    tenantId,
    operatorEmail: fixtureEmail(spec.slug, 'operator', opts.emailDomain),
    operatorUserId,
    members: Object.fromEntries(withPasswords.map((m) => [m.role, m])) as Record<FixtureRole, FixtureMember>,
    brandId: brand.brandId,
    brandName: FIXTURE_BRAND_NAME,
    publishedVersionId: brand.publishedVersionId,
    policyVersionId: brand.policyVersionId,
    servicePrincipalId,
    channelConnectionIds: channels.filter((c) => c.usable).map((c) => c.id),
    externalReviewerEmail: fixtureEmail(spec.slug, 'external-reviewer', opts.emailDomain),
  };
}

export async function provisionFixtures(options: FixtureOptions): Promise<FixtureTenant[]> {
  const out: FixtureTenant[] = [];
  for (const spec of FIXTURE_TENANTS) out.push(await provisionTenant(spec, options));
  return out;
}

/**
 * `--teardown`: the companies stay (the product removes a company only through the deletion-request runbook), but
 * nobody can use the fixtures afterwards: every synthetic member's password is replaced through the same setup
 * path with one this process discards, and every session of every fixture account (the operator's included) is
 * revoked. The next run provisions fresh credentials over the same rows.
 */
export async function teardownFixtures(options: FixtureOptions): Promise<AcceptanceResult[]> {
  const opts = { correlationId: `acceptance-teardown-${randomUUID()}`, ...options };
  const results: AcceptanceResult[] = [];
  for (const spec of FIXTURE_TENANTS) {
    const name = `teardown:${spec.slug}`;
    try {
      const operatorEmail = fixtureEmail(spec.slug, 'operator', opts.emailDomain);
      const existing = await findTenant(spec, operatorEmail, opts.correlationId);
      if (!existing) {
        results.push(pass(name, 'no such company'));
        continue;
      }
      const operator = await actorFor(existing.operatorUserId, existing.tenantId, opts.correlationId);
      const listed = (await read(operator, (a) => accessService.listMembers(a))).items;
      const synthetic = FIXTURE_ROLES.flatMap((role) => {
        const email = fixtureEmail(spec.slug, role, opts.emailDomain);
        const m = listed.find((x) => x.email?.toLowerCase() === email);
        return m && m.status !== 'disabled'
          ? [{ role, email, membershipId: m.membershipId, userId: m.userId }]
          : [];
      });
      for (const m of synthetic) await setPassword(operator, m, opts);
      await runAsPlatform('acceptance', opts.correlationId, async () => {
        for (const userId of [...synthetic.map((m) => m.userId), existing.operatorUserId])
          await directory.revokeSessionsForUser(userId);
      });
      results.push(
        pass(name, `${synthetic.length} member passwords rotated and discarded, sessions revoked`),
      );
    } catch (err) {
      results.push(fail(name, err instanceof Error ? err.message : String(err)));
    }
  }
  return results;
}
