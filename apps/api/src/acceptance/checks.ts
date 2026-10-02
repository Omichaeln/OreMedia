import { runSmoke } from '../../../../tooling/scripts/smoke/checks';
import {
  fail,
  fromSmoke,
  pass,
  skip,
  type AcceptanceResult,
  type ModelEvalResult,
} from '../../../../tooling/scripts/acceptance/report';
import type { AcceptanceConfig } from '../../../../tooling/scripts/acceptance/config';
import { mutate, query, signInWithPassword, sleep, type ApiSession } from './client';
import type { FixtureRole, FixtureTenant } from './fixtures';

/**
 * The deployed checks the acceptance job runs against staging with the fixtures (docs/runbooks/staging-acceptance.md):
 * every one reports pass, fail or skip with a detail that never carries a credential. Independent checks run even
 * when an earlier one failed; a journey stops at its first failed step and says where.
 */
export type Sessions = Map<string, ApiSession>;
export const sessionKey = (tenant: FixtureTenant, role: FixtureRole): string => `${tenant.slug}:${role}`;

/**
 * Every synthetic member signs in through the deployed /auth/password/sign-in (the password path as a browser uses
 * it), one check per person; the sessions are what the other checks call the api with.
 */
export async function signInFixtures(
  cfg: AcceptanceConfig,
  tenants: FixtureTenant[],
): Promise<{ results: AcceptanceResult[]; sessions: Sessions }> {
  const results: AcceptanceResult[] = [];
  const sessions: Sessions = new Map();
  // The password route is limited per address (20 attempts per 60 s window): the twelve sign-ins are paced so that
  // the smoke check's own sign-in, which follows, never meets a full window.
  for (const tenant of tenants)
    for (const member of Object.values(tenant.members)) {
      const name = `sign-in:${tenant.slug}:${member.role}`;
      if (sessions.size) await sleep(1000);
      try {
        const answer = await signInWithPassword(cfg.webOrigin, member.email, member.password);
        if (!answer.ok) {
          results.push(fail(name, answer.error));
          continue;
        }
        sessions.set(sessionKey(tenant, member.role), {
          baseUrl: cfg.webOrigin,
          token: answer.token,
          tenantId: tenant.tenantId,
        });
        results.push(pass(name, 'session issued through the password endpoint'));
      } catch (err) {
        results.push(fail(name, err instanceof Error ? `${err.name}: ${err.message}` : 'request failed'));
      }
    }
  return { results, sessions };
}

/** The production smoke checks (tooling/scripts/smoke) with the fixture brand manager as the smoke user. */
export async function smokeChecks(
  cfg: AcceptanceConfig,
  tenantA: FixtureTenant,
): Promise<AcceptanceResult[]> {
  const manager = tenantA.members.brand_manager;
  const results = await runSmoke({
    baseUrl: cfg.webOrigin,
    ...(cfg.expectStoreOrigin ? { expectStoreOrigin: cfg.expectStoreOrigin } : {}),
    upload: {
      email: manager.email,
      password: manager.password,
      tenantId: tenantA.tenantId,
      brandId: tenantA.brandId,
    },
    ...(cfg.ingestTimeoutMs ? { ingestTimeoutMs: cfg.ingestTimeoutMs } : {}),
  });
  return fromSmoke(results);
}

/** Company B's owner can see nothing of company A: a foreign brand id, A's tenant header, and A's brand in a list. */
export async function isolationChecks(
  sessions: Sessions,
  tenantA: FixtureTenant,
  tenantB: FixtureTenant,
): Promise<AcceptanceResult[]> {
  const b = sessions.get(sessionKey(tenantB, 'owner'));
  if (!b) return [skip('isolation', 'company B owner has no session')];
  const out: AcceptanceResult[] = [];
  const foreign = await query<{ id?: string }>(b, 'brand.get', { brandId: tenantA.brandId });
  out.push(
    foreign.status === 200
      ? fail('isolation:brand-get', `company B read company A's brand (HTTP 200)`)
      : pass('isolation:brand-get', `refused with ${foreign.error}`),
  );
  const header = await query<unknown[]>({ ...b, tenantId: tenantA.tenantId }, 'brand.list');
  out.push(
    header.status === 200
      ? fail('isolation:tenant-header', `company B's session was accepted for company A's tenant header`)
      : pass('isolation:tenant-header', `refused with ${header.error}`),
  );
  const list = await query<Array<{ id: string }>>(b, 'brand.list');
  if (list.status !== 200 || !list.data) out.push(fail('isolation:brand-list', list.error || 'no list'));
  else
    out.push(
      list.data.some((x) => x.id === tenantA.brandId)
        ? fail('isolation:brand-list', `company A's brand is listed for company B`)
        : pass('isolation:brand-list', `${list.data.length} brand(s), none of company A`),
    );
  return out;
}

/**
 * The content journey through the deployed api: a package; then, where the fixture brand has a usable channel, a
 * variant for it, a review request that freezes the revision, an external reviewer link (and the reviewer's read of
 * their frozen manifest), the reviewer's approval, and the variant scheduled under that approval and cancelled
 * again (nothing is published). Without a channel the steps after the package are skipped with the reason.
 */
export async function journeyChecks(
  sessions: Sessions,
  tenant: FixtureTenant,
  providerNote: string,
): Promise<AcceptanceResult[]> {
  const owner = sessions.get(sessionKey(tenant, 'owner'));
  const reviewer = sessions.get(sessionKey(tenant, 'reviewer'));
  const publisher = sessions.get(sessionKey(tenant, 'publisher'));
  if (!owner || !reviewer || !publisher)
    return [skip('journey', 'owner, reviewer or publisher has no session')];
  const out: AcceptanceResult[] = [];
  const at = new Date(Date.now() + 15 * 60_000);
  at.setUTCSeconds(0, 0);

  const pkg = await mutate<{ contentPackageId: string; contentRevisionId: string }>(
    owner,
    'content.packages.create',
    {
      brandId: tenant.brandId,
      title: `Acceptance ${at.toISOString()}`,
      copy: { schemaVersion: 1, master: { text: `Acceptance post for ${at.toISOString()}`, factRefs: [] } },
      creativeDocumentIds: [],
    },
  );
  if (!pkg.data) return [...out, fail('journey:package-create', pkg.error)];
  out.push(pass('journey:package-create', pkg.data.contentPackageId));

  // A review request needs at least one channel variant, and a variant needs a channel: without one the journey
  // ends here, and every later step says so rather than failing on a missing channel.
  const connection = tenant.channelConnectionIds[0];
  if (!connection) {
    const reason = `no usable channel connection on the fixture brand (${providerNote})`;
    for (const step of [
      'variants',
      'review-request',
      'external-reviewer-link',
      'external-reviewer-read',
      'approve',
      'schedule',
    ])
      out.push(skip(`journey:${step}`, reason));
    return out;
  }
  const gen = await mutate<{ created: string[] }>(owner, 'content.variants.generate', {
    contentRevisionId: pkg.data.contentRevisionId,
    channelConnectionIds: [connection],
  });
  const variantId = gen.data?.created[0];
  if (!variantId) return [...out, fail('journey:variants', gen.error || 'no variant created')];
  out.push(pass('journey:variants', variantId));

  const req = await mutate<{ reviewRequestId: string; manifestHash: string }>(
    owner,
    'review.requests.create',
    {
      contentRevisionId: pkg.data.contentRevisionId,
      assigneeUserIds: [],
      timing: { kind: 'exact', at: at.toISOString() },
    },
  );
  if (!req.data) return [...out, fail('journey:review-request', req.error)];
  out.push(pass('journey:review-request', req.data.reviewRequestId));

  const link = await mutate<{ linkId: string; token: string }>(owner, 'review.externalLinks.create', {
    reviewRequestId: req.data.reviewRequestId,
    email: tenant.externalReviewerEmail,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  if (!link.data) out.push(fail('journey:external-reviewer-link', link.error));
  else {
    out.push(pass('journey:external-reviewer-link', link.data.linkId));
    const view = await query<{ reviewRequestId?: string; id?: string }>(
      { baseUrl: owner.baseUrl, token: link.data.token, tenantId: tenant.tenantId },
      'review.requests.get',
      { reviewRequestId: req.data.reviewRequestId },
    );
    out.push(
      view.status === 200
        ? pass('journey:external-reviewer-read', 'the link reads its frozen manifest')
        : fail('journey:external-reviewer-read', view.error),
    );
  }

  const decided = await mutate<{ approvalId?: string }>(reviewer, 'review.decisions.submit', {
    reviewRequestId: req.data.reviewRequestId,
    decision: 'approve',
    expectedManifestHash: req.data.manifestHash,
  });
  if (!decided.data?.approvalId) return [...out, fail('journey:approve', decided.error || 'no approval id')];
  out.push(pass('journey:approve', decided.data.approvalId));

  const scheduled = await mutate<{ id: string; state: string; version: number }>(
    publisher,
    'publishing.publications.schedule',
    {
      channelVariantId: variantId,
      scheduledFor: at.toISOString(),
      authority: 'approval',
      approvalId: decided.data.approvalId,
    },
  );
  if (!scheduled.data || scheduled.data.state !== 'scheduled')
    return [
      ...out,
      fail('journey:schedule', scheduled.error || `state ${scheduled.data?.state ?? 'unknown'}`),
    ];
  out.push(pass('journey:schedule', `${scheduled.data.id} scheduled for ${at.toISOString()}`));
  const cancelled = await mutate<{ state: string }>(publisher, 'publishing.publications.cancel', {
    publicationId: scheduled.data.id,
    expectedVersion: scheduled.data.version,
  });
  out.push(
    cancelled.data?.state === 'cancelled'
      ? pass('journey:schedule-cancel', 'cancelled before dispatch; nothing reaches the channel')
      : fail('journey:schedule-cancel', cancelled.error || `state ${cancelled.data?.state ?? 'unknown'}`),
  );
  return out;
}

const FINISHED = new Set([
  'completed',
  'failed',
  'cancelled',
  'budget_exhausted',
  'policy_denied',
  'waiting_expired',
]);

/** The brief each Release 1 task kind's built-in skill declares as its input (packages/modules/skills/builtin). */
const briefFor = (taskKind: string): Record<string, unknown> =>
  taskKind === 'copywriting'
    ? {
        brief: {
          objective: 'Announce that the acceptance brand ships free this week',
          audience: 'Existing customers',
          keyMessages: ['Free shipping until Sunday', 'Every order, no minimum'],
          channelKey: 'linkedin_page',
          locale: 'en',
        },
        variantCount: 1,
      }
    : { objective: 'Acceptance evaluation', audience: 'Existing customers' };

/**
 * One bounded run per task kind through the deployed api under the fixture agent: a small spend limit on the
 * brand's day, the run started, polled to a final state, then its steps and the settled reservation are read back.
 * The model call itself happens in staging's worker-core (which holds the model key); the job only observes.
 */
export async function modelEvalChecks(
  cfg: AcceptanceConfig,
  sessions: Sessions,
  tenant: FixtureTenant,
): Promise<ModelEvalResult[]> {
  const owner = sessions.get(sessionKey(tenant, 'owner'));
  const out: ModelEvalResult[] = [];
  for (const taskKind of cfg.modelEval.taskKinds) {
    const result: ModelEvalResult = { taskKind, ok: false, steps: 0, costMicros: 0 };
    out.push(result);
    if (!owner) {
      result.reason = 'company A owner has no session';
      continue;
    }
    const api = { ...owner, baseUrl: cfg.apiBaseUrl };
    const limit = await mutate(api, 'agents.budgets.setLimit', {
      brandId: tenant.brandId,
      period: 'day',
      limitMicros: cfg.modelEval.budgetMicros,
    });
    if (limit.status !== 200) {
      result.reason = `budget limit: ${limit.error}`;
      continue;
    }
    const started = await mutate<{ runId: string; state: string }>(api, 'agents.runs.start', {
      brandId: tenant.brandId,
      servicePrincipalId: tenant.servicePrincipalId,
      requestedAutonomy: 'create',
      taskKind,
      brief: briefFor(taskKind),
    });
    if (!started.data) {
      result.reason = `start: ${started.error}`;
      continue;
    }
    const runId = started.data.runId;
    const deadline = Date.now() + cfg.modelEval.timeoutMs;
    let run: { state: string; costMicros: number; budgetReservationId: string | null } | null = null;
    for (;;) {
      const got = await query<{ state: string; costMicros: number; budgetReservationId: string | null }>(
        api,
        'agents.runs.get',
        { runId },
      );
      if (!got.data) {
        result.reason = `get: ${got.error}`;
        break;
      }
      run = got.data;
      if (FINISHED.has(run.state)) break;
      if (Date.now() >= deadline) {
        result.reason = `${runId} still ${run.state} after ${cfg.modelEval.timeoutMs / 1000} s`;
        await mutate(api, 'agents.runs.cancel', { runId, reason: 'acceptance timeout' });
        break;
      }
      await sleep(5000);
    }
    if (!run || result.reason) continue;
    result.costMicros = run.costMicros;
    const steps = await query<{ items: unknown[] }>(api, 'agents.runs.steps', {
      runId,
      page: { limit: 100 },
    });
    result.steps = steps.data?.items.length ?? 0;
    if (run.state !== 'completed') {
      result.reason = `${runId} ended ${run.state} after ${result.steps} step(s)`;
      continue;
    }
    if (result.steps === 0) {
      result.reason = `${runId} completed without a recorded step`;
      continue;
    }
    const budget = await query<{ reservations: Array<{ runId: string | null; state: string }> }>(
      api,
      'agents.budgets.read',
      { brandId: tenant.brandId },
    );
    const reservation = budget.data?.reservations.find((r) => r.runId === runId);
    if (!reservation) {
      result.reason = `${runId} has no budget reservation in the brand's ledger`;
      continue;
    }
    if (reservation.state !== 'settled') {
      result.reason = `${runId} reservation is ${reservation.state}, not settled`;
      continue;
    }
    result.ok = true;
  }
  return out;
}

/**
 * An approved font face of the fixture brand for the studio suite's text layers (the real api authorises every
 * asset version a document names). Reuses an approved face; otherwise imports one family from Google Fonts through
 * the api, waits for ingest and approves it. Null (with the reason) when none can be had within the timeout.
 */
export async function ensureFontAssetVersion(
  cfg: AcceptanceConfig,
  sessions: Sessions,
  tenant: FixtureTenant,
): Promise<{ assetVersionId: string | null; detail: string }> {
  const owner = sessions.get(sessionKey(tenant, 'owner'));
  if (!owner) return { assetVersionId: null, detail: 'company A owner has no session' };
  type Face = { assetId: string; assetVersionId: string; state: string; family: string | null };
  const faces = async () =>
    (await query<{ items: Face[] }>(owner, 'assets.fonts.list', { brandId: tenant.brandId })).data?.items ??
    [];
  const approved = (await faces()).find((f) => f.state === 'approved');
  if (approved)
    return { assetVersionId: approved.assetVersionId, detail: `approved face ${approved.assetId}` };
  const imported = await mutate<{ files: Array<{ outcome: string }> }>(owner, 'assets.fonts.importGoogle', {
    brandId: tenant.brandId,
    family: 'Karla',
    weights: [400],
    styles: ['normal'],
  });
  if (imported.status !== 200) return { assetVersionId: null, detail: `font import: ${imported.error}` };
  const deadline = Date.now() + (cfg.ingestTimeoutMs ?? 120_000);
  for (;;) {
    const face = (await faces()).find((f) => f.state === 'approved' || f.state === 'pending_review');
    if (face?.state === 'approved')
      return { assetVersionId: face.assetVersionId, detail: `face ${face.assetId}` };
    if (face) {
      const got = await query<{ version: number }>(owner, 'assets.get', { assetId: face.assetId });
      if (got.data) {
        const ok = await mutate(owner, 'assets.approve', {
          assetId: face.assetId,
          expectedVersion: got.data.version,
        });
        if (ok.status === 200)
          return { assetVersionId: face.assetVersionId, detail: `imported and approved ${face.assetId}` };
        return { assetVersionId: null, detail: `font approve: ${ok.error}` };
      }
    }
    if (Date.now() >= deadline)
      return { assetVersionId: null, detail: 'the imported font was not ingested in time' };
    await sleep(3000);
  }
}
