import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createServer } from '@oremedia/api';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { memberships, users } from '@oremedia/db/schema/access';
import { newId } from '@oremedia/domain/ids';
import { CookieJar, FakeOidcProvider, runGoogleSignIn, seedTwoTenants, type SeededTenant } from './src';

/**
 * Spec 19.3 / 18 for D-03 Google sign-in. The harness in cross-tenant.cross-tenant.test.ts enumerates tRPC
 * procedures, the REST route table and MCP tools; the /auth Express routes are not in any of those registries and
 * need no foreign-id fixtures because they are pre-tenant: they take no tenant or resource id, create or end a
 * session for the signed-in person only, and every later request is authorised per tenant by the policy layer.
 * This file asserts the property that matters: signing in never grants access to a company without an active
 * membership, and a sign-in writes nothing into another tenant.
 */
describe('cross-tenant: Google sign-in grants no access beyond active memberships', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  let provider: FakeOidcProvider;
  let http: Server;
  let api = '';

  const trpcGet = async (path: string, jar: CookieJar, tenantId?: string, input?: unknown) => {
    const q = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
    const res = await fetch(`${api}/trpc/${path}${q}`, {
      headers: { cookie: jar.header(), ...(tenantId ? { 'x-oremedia-tenant': tenantId } : {}) },
    });
    return {
      status: res.status,
      body: (await res.json()) as {
        result?: { data?: { json?: unknown } };
        error?: { json?: { data?: { envelope?: { code: string; details?: unknown } } } };
      },
    };
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ({ tenantA, tenantB } = await seedTwoTenants(tdb.db));
    provider = await FakeOidcProvider.start();
    http = createHttpServer();
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    api = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    http.on(
      'request',
      createServer({
        auth: {
          issuerUrl: new URL(provider.issuer),
          clientId: provider.clientId,
          clientSecret: provider.clientSecret,
          redirectUri: new URL(`${api}/auth/google/callback`),
          allowedDomains: null,
          secureCookies: false,
          allowInsecureIssuer: true,
        },
      }),
    );
  });
  afterAll(async () => {
    await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
    await provider?.close();
    await tdb?.drop();
  });

  it("tenant A's owner signs in with Google and still reaches only tenant A", async () => {
    const owner = (await tdb.db.select().from(users).where(eq(users.id, tenantA.ownerUserId)))[0];
    // Tenant B holds an invitation for this same person, but addressed to another email: it is not accepted.
    const pendingInB = newId('membership');
    await tdb.db.insert(memberships).values({
      id: pendingInB,
      tenantId: tenantB.tenantId,
      userId: tenantA.ownerUserId,
      role: 'owner',
      status: 'invited',
      allBrands: true,
      invitedEmail: `alias-${randomUUID().slice(0, 6)}@example.test`,
    });
    const before = await tenantB.snapshot();

    provider.reset({
      sub: `google-a-owner-${randomUUID()}`,
      email: owner?.email,
      email_verified: true,
      hd: 'example.test',
    });
    const jar = new CookieJar();
    const run = await runGoogleSignIn(api, jar);
    expect(run.location).toBe('/portfolio');

    const companies = await trpcGet('access.listCompanies', jar);
    expect(companies.status).toBe(200);
    expect((companies.body.result?.data?.json as Array<{ tenantId: string }>).map((c) => c.tenantId)).toEqual(
      [tenantA.tenantId],
    );
    expect((await trpcGet('brand.list', jar, tenantA.tenantId)).status).toBe(200);

    // Selecting tenant B is refused (membership not active), and B's ids under A are NOT_FOUND.
    const inB = await trpcGet('brand.list', jar, tenantB.tenantId);
    expect(inB.status).toBe(403);
    expect(inB.body.error?.json?.data?.envelope?.code).toBe('FORBIDDEN');
    const foreign = await trpcGet('brand.get', jar, tenantA.tenantId, { brandId: tenantB.brandIds[0] });
    expect(foreign.status).toBe(404);

    // The sign-in wrote nothing into tenant B; the non-matching invitation stays invited.
    expect(await tenantB.snapshot()).toEqual(before);
    const m = (await tdb.db.select().from(memberships).where(eq(memberships.id, pendingInB)))[0];
    expect(m?.status).toBe('invited');
  });

  it('a placeholder whose only membership was disabled before the first sign-in is refused and writes nothing', async () => {
    // Invited to tenant B, then the membership is disabled before the first sign-in: the placeholder is not
    // claimable (it has a non-invited membership) and the sign-in is refused outright.
    const email = `removed-${randomUUID().slice(0, 8)}@example.test`;
    const userId = newId('user');
    await tdb.db.insert(users).values({ id: userId, email, name: 'Removed', status: 'disabled' });
    await tdb.db.insert(memberships).values({
      id: newId('membership'),
      tenantId: tenantB.tenantId,
      userId,
      role: 'creator',
      status: 'disabled',
      invitedEmail: email,
    });
    // A matching invitation in tenant A as well: the placeholder still has a non-invited membership, so it is not
    // claimed and the invitation to A is not accepted either.
    const invitedToA = newId('membership');
    await tdb.db.insert(memberships).values({
      id: invitedToA,
      tenantId: tenantA.tenantId,
      userId,
      role: 'creator',
      status: 'invited',
      invitedEmail: email,
    });
    const before = await tenantB.snapshot();
    provider.reset({
      sub: `google-removed-${randomUUID()}`,
      email,
      email_verified: true,
      hd: 'example.test',
    });
    const jar = new CookieJar();
    const run = await runGoogleSignIn(api, jar);
    expect(run.location).toBe('/sign-in?error=account_disabled');
    expect(jar.cookies.has('oremedia_session')).toBe(false);
    expect(await tenantB.snapshot()).toEqual(before);
    const a = (await tdb.db.select().from(memberships).where(eq(memberships.id, invitedToA)))[0];
    expect(a?.status).toBe('invited');
  });
});
