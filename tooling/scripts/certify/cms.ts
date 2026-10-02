/**
 * RA-01: the CMS commands of the certification harness (a WordPress site with an application password): connect
 * (the identity verified against the site), write a draft article and read it back, update it under its
 * read-back precondition, set it back to a draft, delete it, revoke the secret. Each command records its step's
 * evidence (harness.ts REQUIRED_STEPS.cms). The secret lives in the session file (mode 0600) until `forget`.
 */
import { randomBytes } from 'node:crypto';
import type { CmsRemoteArticle, CmsSite } from '@oremedia/providers';
import { recordEvidence, type CmsDeps, type CertifySession } from './harness';

const print = (deps: CmsDeps, label: string, value: unknown) =>
  deps.out(`${label}\n${JSON.stringify(value, null, 2)}`);

/** The read-back as it is printed and kept: identity, state, hash and modified instant; never the body. */
const describeArticle = (a: CmsRemoteArticle) => ({
  remoteId: a.remoteId,
  remoteUrl: a.remoteUrl,
  title: a.title,
  slug: a.slug,
  status: a.status,
  modifiedAt: a.modifiedAt,
  contentHash: a.contentHash,
});

function requireSite(deps: CmsDeps): { session: CertifySession; cms: NonNullable<CertifySession['cms']> } {
  const session = deps.load();
  if (!session.cms) throw new Error(`no connected site for ${deps.key}: run connect first`);
  return { session, cms: session.cms };
}

function requireArticle(deps: CmsDeps) {
  const { session, cms } = requireSite(deps);
  if (!cms.article) throw new Error('nothing written yet: run write first');
  return { session, cms, article: cms.article };
}

/** Reads the article back after a write and records whether the remote holds what the write returned. */
async function readBack(deps: CmsDeps, step: string, written: CmsRemoteArticle, expectStatus?: string) {
  const { session, cms } = requireSite(deps);
  const read = await deps.adapter.readArticle(cms.site, cms.credentials, deps.io, written.remoteId);
  print(deps, 'Read back', read.outcome === 'found' ? describeArticle(read.article) : read);
  const ok =
    read.outcome === 'found' &&
    read.article.contentHash === written.contentHash &&
    (expectStatus === undefined || read.article.status === expectStatus);
  deps.save({
    ...session,
    cms: {
      ...cms,
      article: {
        remoteId: written.remoteId,
        contentHash: read.outcome === 'found' ? read.article.contentHash : written.contentHash,
        modifiedAt: read.outcome === 'found' ? read.article.modifiedAt : written.modifiedAt,
        html: written.html,
      },
    },
  });
  recordEvidence(
    deps,
    step,
    ok,
    ok
      ? `article ${written.remoteId} read back with hash ${written.contentHash.slice(0, 12)}`
      : read.outcome === 'found'
        ? `read-back differs (hash ${read.article.contentHash.slice(0, 12)} vs ${written.contentHash.slice(0, 12)}, status ${read.article.status})`
        : `read-back ${read.outcome}`,
  );
}

/** Connect: the site and the integration identity's secret, verified against the site (the connect flow's health check). */
export async function cmsConnect(deps: CmsDeps, site: CmsSite, secret: string): Promise<void> {
  const credentials = { accessToken: secret, extra: { username: site.username } };
  deps.save({ ...deps.load(), cms: { site, credentials } });
  await cmsVerify(deps);
}

/** Verify; after `revoke` (or revoking the application password on the site by hand) it must report reconnect_required. */
export async function cmsVerify(deps: CmsDeps): Promise<void> {
  const { session, cms } = requireSite(deps);
  const result = await deps.adapter.verify(cms.site, cms.credentials, deps.io);
  print(deps, 'Verify', result);
  if (result.ok) {
    recordEvidence(
      deps,
      'connect',
      true,
      `${result.displayName}${result.canPublish ? ', can publish' : ', drafts only'}`,
    );
    return;
  }
  if (session.revokeRequestedAt && result.reason === 'reconnect_required')
    recordEvidence(deps, 'revoke', true, 'verify refused with reconnect_required after revoke');
  else recordEvidence(deps, 'connect', false, `${result.reason}: ${result.detail}`);
}

/** Write: a draft article (never a live one unless `--publish`), then its read-back. */
export async function cmsWrite(
  deps: CmsDeps,
  input: { title: string; html: string; publish: boolean },
): Promise<void> {
  const { cms } = requireSite(deps);
  const slug = `oremedia-certification-${randomBytes(4).toString('hex')}`;
  const result = await deps.adapter.createArticle(
    cms.site,
    cms.credentials,
    deps.io,
    {
      title: input.title,
      slug,
      excerpt: 'Oremedia certification run',
      html: input.html,
      categories: [],
      tags: [],
      status: input.publish ? 'publish' : 'draft',
    },
    `cert_${randomBytes(8).toString('hex')}`,
  );
  print(deps, 'Write outcome', result.outcome === 'done' ? describeArticle(result.article) : result);
  if (result.outcome !== 'done') {
    recordEvidence(deps, 'write', false, `${result.outcome}: ${'code' in result ? result.code : 'conflict'}`);
    return;
  }
  await readBack(deps, 'write', { ...result.article, html: input.html });
}

/** Update: new content under the precondition of the last read-back (a remote that moved is a conflict), then read back. */
export async function cmsUpdate(deps: CmsDeps, html: string): Promise<void> {
  const { cms, article } = requireArticle(deps);
  const result = await deps.adapter.updateArticle(
    cms.site,
    cms.credentials,
    deps.io,
    article.remoteId,
    { html },
    { expectedHash: article.contentHash, expectedModifiedAt: article.modifiedAt },
  );
  print(deps, 'Update outcome', result.outcome === 'done' ? describeArticle(result.article) : result);
  if (result.outcome !== 'done') {
    recordEvidence(deps, 'update', false, `${result.outcome}${'code' in result ? `: ${result.code}` : ''}`);
    return;
  }
  await readBack(deps, 'update', { ...result.article, html });
}

/** Unpublish: the article back to a draft (the rollback of a publish), read back as a draft. */
export async function cmsUnpublish(deps: CmsDeps): Promise<void> {
  const { cms, article } = requireArticle(deps);
  const result = await deps.adapter.unpublishArticle(cms.site, cms.credentials, deps.io, article.remoteId);
  print(
    deps,
    'Unpublish outcome',
    result.outcome === 'done' && result.article ? describeArticle(result.article) : result,
  );
  if (result.outcome !== 'done' || !result.article) {
    recordEvidence(
      deps,
      'unpublish',
      false,
      `${result.outcome}${'code' in result ? `: ${result.code}` : ''}`,
    );
    return;
  }
  await readBack(deps, 'unpublish', { ...result.article, html: article.html }, 'draft');
}

/** Delete: the article removed, proven by a read-back that finds it absent. */
export async function cmsDelete(deps: CmsDeps): Promise<void> {
  const { cms, article } = requireArticle(deps);
  const result = await deps.adapter.deleteArticle(cms.site, cms.credentials, deps.io, article.remoteId);
  print(deps, 'Delete outcome', result);
  if (result.outcome !== 'done' && result.outcome !== 'already_absent') {
    recordEvidence(deps, 'delete', false, `${result.outcome}: ${result.code}`);
    return;
  }
  const read = await deps.adapter.readArticle(cms.site, cms.credentials, deps.io, article.remoteId);
  print(deps, 'Read back', read.outcome === 'found' ? describeArticle(read.article) : read);
  recordEvidence(
    deps,
    'delete',
    read.outcome === 'absent',
    read.outcome === 'absent'
      ? `article ${article.remoteId} absent after delete`
      : `read-back ${read.outcome}`,
  );
}

/** Revokes the application password on the site through the adapter where it can; the next verify proves it. */
export async function cmsRevoke(deps: CmsDeps): Promise<void> {
  const { session, cms } = requireSite(deps);
  deps.save({ ...session, revokeRequestedAt: deps.now().toISOString() });
  if (!deps.adapter.revokeAccess) {
    deps.out(
      `${deps.key} has no remote revoke: revoke the application password on the site, then run verify (it must report reconnect_required).`,
    );
    return;
  }
  const result = await deps.adapter.revokeAccess(cms.site, cms.credentials, deps.io);
  print(deps, 'Revoke outcome', result);
  if (result.outcome === 'revoked') deps.out('Now run verify: it must report reconnect_required.');
  else
    recordEvidence(
      deps,
      'revoke',
      false,
      result.outcome === 'failed' ? `failed: ${result.reason}` : 'not supported by the adapter',
    );
}
