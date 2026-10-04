import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnyProcedure, AnyRouter, inferProcedureOutput } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { allProcedures, appRouter, type AppRouter } from '@oremedia/api';
import { BrandSystemDocumentV1, PolicyDocumentV1, defaultPolicyDocument } from '@oremedia/contracts/brand';
import { CreativeDocumentV1 } from '@oremedia/contracts/creative';
import { zodToJsonSchema } from '../../../tooling/scripts/zod-json';
import { createMockRouter, E2E, MockBackend, t } from './mock-api';

/**
 * The browser suites drive the built app against the hand-written tRPC mock in this folder (mock-api.ts and the
 * mock-*.ts routers it composes), so the mock is only evidence while it answers what the real API answers. This
 * checks it against apps/api's appRouter: every mock procedure exists in the real router with the same type and the
 * same input shape; every real procedure the web app calls is served by the mock; every mock procedure's output type
 * is assignable to the real one (a compile-time check, below, that `pnpm typecheck` runs); and the outputs that carry
 * a contract document are parsed with that contract's schema.
 */
const WEB_SRC = fileURLToPath(new URL('../src', import.meta.url));

type ProcedureMap = Record<string, { _def: { type: string; inputs: unknown[] } }>;
const real = appRouter._def.procedures as unknown as ProcedureMap;
const mock = createMockRouter(new MockBackend())._def.procedures as unknown as ProcedureMap;
const realPaths = allProcedures().map((p) => p.path);
const mockPaths = Object.keys(mock).sort();

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });

/**
 * The real procedures the web app calls: a `trpc.a.b.c.queryOptions(...)`-style chain (or the vanilla client's
 * `.query(...)`/`.mutate(...)`), whitespace-tolerant because Prettier breaks long chains. The chains are typed against
 * AppRouter, so every match names a real procedure.
 */
const TERMINALS =
  'queryOptions|mutationOptions|infiniteQueryOptions|queryKey|infiniteQueryKey|queryFilter|pathFilter|query|mutate';
function proceduresUsedByWeb(): string[] {
  const src = sourceFiles(WEB_SRC)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  return realPaths.filter((path) =>
    new RegExp(`\\.\\s*${path.split('.').join('\\s*\\.\\s*')}\\s*\\.\\s*(?:${TERMINALS})\\b`).test(src),
  );
}

const inputShape = (p: { _def: { inputs: unknown[] } }) => p._def.inputs.map((i) => zodToJsonSchema(i));

describe('the e2e mock API matches the real appRouter', () => {
  it('serves only procedures the real router has, with the same type', () => {
    expect(mockPaths.length).toBeGreaterThan(100);
    expect(mockPaths.filter((p) => !real[p])).toEqual([]);
    expect(mockPaths.filter((p) => real[p] && real[p]._def.type !== mock[p]?._def.type)).toEqual([]);
  });

  it('serves every real procedure the web app calls', () => {
    const used = proceduresUsedByWeb();
    expect(used.length).toBeGreaterThan(100);
    expect(used.filter((p) => !mock[p])).toEqual([]);
  });

  it('takes the same input shape as the real procedure', () => {
    const drift = mockPaths
      .filter((p) => real[p])
      .filter(
        (p) =>
          JSON.stringify(inputShape(real[p] as ProcedureMap[string])) !==
          JSON.stringify(inputShape(mock[p] as ProcedureMap[string])),
      );
    expect(drift).toEqual([]);
  });

  it('flags a procedure the real router does not have, and an input that drifted', () => {
    const extra = { ...mock, 'brand.invented': { _def: { type: 'query', inputs: [] } } };
    expect(Object.keys(extra).filter((p) => !real[p])).toEqual(['brand.invented']);
    const get = real['brand.get'] as ProcedureMap[string];
    const other = real['brand.versions.list'] as ProcedureMap[string];
    expect(JSON.stringify(inputShape(get))).not.toBe(JSON.stringify(inputShape(other)));
  });
});

describe('mock outputs that carry a contract document parse with its schema', () => {
  const backend = new MockBackend();
  const caller = t.createCallerFactory(createMockRouter(backend));
  let key = 0;
  const call = () =>
    caller({
      headers: {
        authorization: `Bearer ${E2E.token}`,
        'x-oremedia-tenant': E2E.tenantId,
        'idempotency-key': `mock-contract-${++key}`,
      },
      correlationId: 'mock-contract',
    });

  it('brand.versions.get: BrandSystemDocumentV1', async () => {
    const { items } = await call().brand.versions.list({ brandId: E2E.brandId, page: { limit: 50 } });
    expect(items.length).toBeGreaterThan(0);
    for (const v of items) {
      const got = await call().brand.versions.get({ brandId: E2E.brandId, versionId: v.id });
      expect(() => BrandSystemDocumentV1.parse(got.document)).not.toThrow();
    }
  });

  it('brand.policy.get: PolicyDocumentV1', async () => {
    const created = await call().brand.policy.createVersion({
      brandId: E2E.brandId,
      document: defaultPolicyDocument(),
    });
    const got = await call().brand.policy.get({
      brandId: E2E.brandId,
      policyVersionId: created.policyVersionId,
    });
    expect(() => PolicyDocumentV1.parse(got.document)).not.toThrow();
  });

  it('creative.documents.get: the head revision snapshot is a CreativeDocumentV1', async () => {
    await call().creative.documents.create({ brandId: E2E.brandId, title: 'Contract check' });
    const { items } = await call().creative.documents.list({ brandId: E2E.brandId, page: { limit: 50 } });
    expect(items.length).toBeGreaterThan(0);
    for (const d of items) {
      const got = await call().creative.documents.get({ documentId: d.id });
      expect(() => CreativeDocumentV1.parse(got.revision.snapshot)).not.toThrow();
    }
  });
});

/**
 * Compile-time: the paths of mock procedures whose output is not assignable to the real procedure's. `pnpm typecheck`
 * fails on the assignment below while this union is not empty, naming each drifting path as a missing property.
 */
type RecordOf<T> = T extends AnyRouter ? T['_def']['record'] : T;
type OutputDrift<M, R, P extends string = ''> = {
  [K in keyof M & keyof R & string]: M[K] extends AnyProcedure
    ? R[K] extends AnyProcedure
      ? inferProcedureOutput<M[K]> extends inferProcedureOutput<R[K]>
        ? never
        : `${P}${K}`
      : `${P}${K}`
    : OutputDrift<RecordOf<M[K]>, RecordOf<R[K]>, `${P}${K}.`>;
}[keyof M & keyof R & string];
type MockRecord = ReturnType<typeof createMockRouter>['_def']['record'];
type RealRecord = AppRouter['_def']['record'];
const noOutputDrift: Record<OutputDrift<MockRecord, RealRecord>, true> = {};
void noOutputDrift;
