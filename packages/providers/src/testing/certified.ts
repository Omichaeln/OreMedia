/**
 * Test-only: a view of an adapter (channel or source) whose capability carries `certifiedAt`, so a test can prove
 * the registry gate opens only through certification (spec 14.6). Production registration never does this.
 */
export function certifiedForTest<A extends { capability: { certifiedAt: string | null } }>(
  adapter: A,
  certifiedAt = '2026-10-01T00:00:00.000Z',
): A {
  return Object.create(adapter, {
    capability: { value: { ...adapter.capability, certifiedAt }, enumerable: true },
  }) as A;
}
