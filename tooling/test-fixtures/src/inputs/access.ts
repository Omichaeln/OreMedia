import { randomUUID } from 'node:crypto';
import type { CrossTenantFixture, OwnTenantFixture } from '../cross-tenant-inputs';

export const ACCESS_INPUTS: Record<string, CrossTenantFixture> = {
  'access.me': { buildInput: null, reason: 'no resource ids; tenant comes from the verified membership' },
  'access.session': { buildInput: null, reason: "the caller's own user; takes no ids" },
  'access.listCompanies': { buildInput: null, reason: "projection over the caller's own memberships" },
  'access.switchCompany': {
    buildInput: (f) => ({ tenantId: f['tenantId'] }),
    reason: 'tenant ids are not secret; a non-member is told so',
    expectCode: 'FORBIDDEN',
  },
  'access.members.list': {
    buildInput: null,
    reason: "no input; lists the caller's own tenant's memberships (tenant from the verified membership)",
  },
  'access.members.invite': {
    buildInput: null,
    reason: "takes an email, no resource ids; the membership is created in the caller's tenant",
  },
  'access.members.setRole': {
    buildInput: (f) => ({ membershipId: f['membershipId'], expectedVersion: 0, role: 'admin' }),
  },
  'access.members.issuePasswordSetup': { buildInput: (f) => ({ membershipId: f['membershipId'] }) },
  'access.account.signInMethods': { buildInput: null, reason: "the caller's own user; takes no ids" },
  'access.account.setPassword': {
    buildInput: null,
    reason: "the caller's own password; takes no ids (and no tenant)",
  },
  'access.account.removePassword': {
    buildInput: null,
    reason: "the caller's own password; takes no ids (and no tenant)",
  },
  'access.brandGrants.set': {
    buildInput: (f) => ({ membershipId: f['membershipId'], brandId: f['brandId'], roles: [] }),
  },
  'access.servicePrincipals.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'access.servicePrincipals.create': {
    buildInput: (f) => ({
      kind: 'agent',
      name: 'x',
      grants: [{ action: 'brand.read', brandIds: [f['brandId']] }],
      maxAutonomy: 'create',
    }),
  },
  'access.servicePrincipals.revoke': {
    buildInput: (f) => ({ servicePrincipalId: f['servicePrincipalId'], expectedVersion: 0 }),
  },
  'access.apiClients.create': {
    buildInput: (f) => ({ servicePrincipalId: f['servicePrincipalId'], scopes: ['brands:read'] }),
  },
  'access.apiClients.rotate': { buildInput: (f) => ({ apiClientId: f['apiClientId'] }) },
  'access.supportSessions.escalate': {
    buildInput: (f) => ({
      supportSessionId: f['supportSessionId'],
      reason: 'escalate a foreign support session',
    }),
  },
};

/**
 * Ledger G14: the access.* procedures above whose fixture is `buildInput: null` take no foreign reference, so there is
 * no foreign id to try. Each is called as the caller's own tenant instead (OwnTenantFixture), and must answer only
 * that tenant's data and leave the other tenant unchanged. A block of its own, apart from the fixtures above.
 */
export const ACCESS_OWN_TENANT_INPUTS: Record<string, OwnTenantFixture> = {
  'access.me': {
    why: 'takes no input: the tenant and the actor come from the verified membership, never from the request',
    input: () => undefined,
  },
  'access.session': {
    why: 'takes no input: answers the signed-in person of the session itself (a user, not a tenant resource)',
    input: () => undefined,
  },
  'access.listCompanies': {
    why: "takes no input: a projection over the signed-in person's own memberships",
    input: () => undefined,
  },
  'access.members.list': {
    why: "takes no input: lists the memberships of the caller's verified tenant",
    input: () => undefined,
  },
  'access.members.invite': {
    why: "takes an email, a role and allBrands (no id, no brand): the membership is created in the caller's tenant",
    input: () => ({ email: `own-tenant-${randomUUID()}@example.test`, role: 'creator', allBrands: false }),
  },
  'access.account.signInMethods': {
    why: "takes no input: the signed-in person's own sign-in methods (a person's, not a tenant's)",
    input: () => undefined,
  },
  'access.account.setPassword': {
    why: "takes the signed-in person's own current and new password: no id and no tenant",
    input: () => ({ newPassword: `own tenant passphrase ${randomUUID()}` }),
  },
  'access.account.removePassword': {
    why: "takes the signed-in person's own current password: no id and no tenant",
    // The seeded owner signs in with Google only, so the password is refused (nobody locks themselves out).
    input: () => ({ currentPassword: `not the password ${randomUUID()}` }),
    expectError: 'VALIDATION_FAILED',
  },
};
