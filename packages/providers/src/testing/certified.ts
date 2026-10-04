import { CertifiableCapability, type CapabilityCertifications } from '@oremedia/contracts/providers';

/**
 * Test-only (PR-06): a certification record for every certifiable capability, so a fixture adapter behaves as a
 * provider certified capability by capability. A capability the adapter does not support stays `not_supported`.
 */
export function allCapabilitiesCertifiedForTest(
  certifiedAt = '2026-10-01T00:00:00.000Z',
): CapabilityCertifications {
  return Object.fromEntries(
    CertifiableCapability.options.map((c) => [
      c,
      { certifiedAt, environment: 'test', evidence: 'test fixture (never a platform run)' },
    ]),
  ) as CapabilityCertifications;
}

/**
 * Test-only: a view of an adapter (channel or source) whose capability carries `certifiedAt`, so a test can prove
 * the registry gate opens only through certification (spec 14.6). Production registration never does this. Every
 * capability is certified too unless `certifications` says otherwise (PR-06).
 */
export function certifiedForTest<
  A extends { capability: { certifiedAt: string | null; certifications?: CapabilityCertifications } },
>(
  adapter: A,
  certifiedAt = '2026-10-01T00:00:00.000Z',
  certifications: CapabilityCertifications = allCapabilitiesCertifiedForTest(certifiedAt),
): A {
  return Object.create(adapter, {
    capability: { value: { ...adapter.capability, certifiedAt, certifications }, enumerable: true },
  }) as A;
}
