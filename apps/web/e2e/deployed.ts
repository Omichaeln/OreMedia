import type { Page } from 'playwright';
import { nodeHttpFetch, type FetchLike } from '../../../tooling/scripts/acceptance/http';

/**
 * Real-origin mode of the browser suites (docs/runbooks/staging-acceptance.md): `OREMEDIA_E2E_WEB_ORIGIN` names a
 * deployed web origin (its Caddy serves the built app and proxies /trpc and /auth to the api), so no static server
 * and no mock transport are started, and people sign in with the email-and-password form, as on any real host
 * name (the pasted-token form exists only on loopback addresses). The credentials come from the environment and
 * are typed into the form only; nothing prints them.
 */
export const deployedWebOrigin = (): string | null => process.env['OREMEDIA_E2E_WEB_ORIGIN']?.trim() || null;

/**
 * The transport for a suite's own requests (not the browser's) when it runs against a deployed origin: Node's HTTP
 * client (the acceptance job's node-https client), never the image's global fetch. On the staging acceptance image
 * that fetch sees no response headers (ACCEPTANCE_INFO probe `fetch … headers=[]`), so a gzip-encoded answer from the
 * edge reaches the caller still compressed (`Unexpected token '\x1f' … is not valid JSON` in the studio suite's
 * out-of-band tRPC client); Node's HTTP client sends no Accept-Encoding and reads every header. Local runs (the mock
 * transport, or OREMEDIA_E2E_API_URL) keep the global fetch.
 */
export const outOfBandFetch = (): FetchLike =>
  deployedWebOrigin() ? nodeHttpFetch : (input, init) => globalThis.fetch(input, init);

export interface DeployedPerson {
  email: string;
  password: string;
  tenantId: string;
  brandId: string;
}

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required with OREMEDIA_E2E_WEB_ORIGIN`);
  return value;
};

/** Company A's owner (OREMEDIA_E2E_EMAIL/PASSWORD/TENANT/BRAND) and company B's (the OREMEDIA_E2E_B_* four). */
export const deployedPeople = (): { a: DeployedPerson; b: DeployedPerson } => ({
  a: {
    email: required('OREMEDIA_E2E_EMAIL'),
    password: required('OREMEDIA_E2E_PASSWORD'),
    tenantId: required('OREMEDIA_E2E_TENANT'),
    brandId: required('OREMEDIA_E2E_BRAND'),
  },
  b: {
    email: required('OREMEDIA_E2E_B_EMAIL'),
    password: required('OREMEDIA_E2E_B_PASSWORD'),
    tenantId: required('OREMEDIA_E2E_B_TENANT'),
    brandId: required('OREMEDIA_E2E_B_BRAND'),
  },
});

/** Signs in through the sign-in page's email-and-password form and waits for the portfolio. */
export async function signInWithPasswordForm(
  page: Page,
  origin: string,
  person: Pick<DeployedPerson, 'email' | 'password'>,
): Promise<void> {
  await page.goto(`${origin}/sign-in?next=%2Fportfolio`);
  const form = page.getByTestId('password-sign-in');
  await form.waitFor({ timeout: 15_000 });
  await form.getByLabel('Email').fill(person.email);
  await form.getByLabel('Password').fill(person.password);
  await form.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/portfolio*', { timeout: 30_000 });
}
