import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  BrandAssistEstimateV1,
  BrandAssistJobDto,
  BrandSuggestionDto,
} from '@oremedia/contracts/brand-assist';
import type { BrandSystemDocumentV1, LogoRuleV1 } from '@oremedia/contracts/brand';
import type { CreativeDocumentV1, Operation } from '@oremedia/contracts/creative';
import type {
  GenerationCostEstimate,
  GenerationInputs,
  GenerationResult,
} from '@oremedia/contracts/generation';
import { operationsOfGroups } from '@oremedia/editor/generation';
import { instantiateStarter, starterByKey, type StarterBrand } from '@oremedia/editor/starters/index';
import type { AcceptanceConfig } from '../../../../tooling/scripts/acceptance/config';
import { fail, pass, skip, type AcceptanceResult } from '../../../../tooling/scripts/acceptance/report';
import { randomPng } from '../../../../tooling/scripts/smoke/checks';
import { ensureFontAssetVersion, sessionKey, type Sessions } from './checks';
import { mutate, putObject, query, sleep, type ApiSession } from './client';
import type { FixtureTenant } from './fixtures';

/**
 * The api journeys of the features shipped after RA-14 (BSC-1..5, STU-1a/1b, STU-2a), run by the acceptance job
 * against the deployed api and workers with the fixture brand (docs/runbooks/staging-acceptance.md). Same contract
 * as checks.ts: one pass, fail or skip per step, a journey stops at its first failed step and says where, and every
 * step reads the server state back rather than trusting a 200. The steps that call the model spend through the
 * fixture brand's own day limit, capped at `cfg.journeys.modelBudgetMicros`, and print what they spent. Every run
 * leaves the brand as it found it apart from append-only history (facts, documents, packages, retired assets):
 * the brand system is restored, its source removed, earlier acceptance logos and clips retired.
 */

/** Whether the object store takes uploads, as the SVG logo upload found it; the steps that need it skip otherwise. */
export type StoreState = { usable: true; detail: string } | { usable: false; reason: string };

/** Poll cadence of every wait; the tests shorten it. */
export interface JourneyOptions {
  pollMs?: number;
}

const DEFAULT_POLL_MS = 5000;

/** A short run marker that makes this run's statements, source text and artwork unique (dedupe would reuse them). */
export const runMarker = (now = new Date()): string => now.toISOString().replace(/\D/g, '').slice(0, 14);

const NO_MODEL_BUDGET = 'ACCEPTANCE_MODEL_BUDGET_MICROS=0: the model journeys are switched off';

/** An id as a line prints it whole (ids are not secrets), or a fallback when the answer had none. */
const idOf = (v: string | null | undefined, fallback = '(none)') => v ?? fallback;

interface BudgetSummaryPeriod {
  limitMicros: number;
  committedMicros: number;
  remainingMicros: number;
}
interface BudgetSummary {
  day: BudgetSummaryPeriod;
  month: BudgetSummaryPeriod;
}

/**
 * Room for one model job, capped: the estimate must fit the cap, then the brand's day limit is set to what today
 * already committed plus the cap (so nothing these checks start can spend more than the cap), and the company's
 * month limit is raised to make room for the cap when it has less (the api holds it at the entitlement). Read back:
 * the stored day limit and enough room left for the estimate on both periods.
 */
export async function capModelSpend(
  api: ApiSession,
  brandId: string,
  estimateMicros: number,
  capMicros: number,
): Promise<{ ok: true; detail: string } | { ok: false; reason: string }> {
  if (estimateMicros > capMicros)
    return {
      ok: false,
      reason: `the estimate ${estimateMicros} µUSD is above the cap ${capMicros} µUSD (ACCEPTANCE_MODEL_BUDGET_MICROS)`,
    };
  const before = await query<BudgetSummary>(api, 'agents.budgets.read', { brandId });
  if (!before.data) return { ok: false, reason: `agents.budgets.read: ${before.error}` };
  const dayLimitMicros = before.data.day.committedMicros + capMicros;
  const set = await mutate(api, 'agents.budgets.setLimit', {
    brandId,
    period: 'day',
    limitMicros: dayLimitMicros,
  });
  if (set.status !== 200) return { ok: false, reason: `day limit: ${set.error}` };
  if (before.data.month.remainingMicros < capMicros) {
    const month = await mutate(api, 'agents.budgets.setLimit', {
      brandId,
      period: 'month',
      limitMicros: before.data.month.committedMicros + capMicros,
    });
    if (month.status !== 200) return { ok: false, reason: `month limit: ${month.error}` };
  }
  const after = await query<BudgetSummary>(api, 'agents.budgets.read', { brandId });
  if (!after.data) return { ok: false, reason: `agents.budgets.read: ${after.error}` };
  if (after.data.day.limitMicros !== dayLimitMicros)
    return {
      ok: false,
      reason: `the day limit reads ${after.data.day.limitMicros} µUSD after setting ${dayLimitMicros}`,
    };
  if (after.data.day.remainingMicros < estimateMicros || after.data.month.remainingMicros < estimateMicros)
    return {
      ok: false,
      reason: `no room for ${estimateMicros} µUSD: ${after.data.day.remainingMicros} left today, ${after.data.month.remainingMicros} this month (the month is held at the entitlement)`,
    };
  return {
    ok: true,
    detail: `estimate ${estimateMicros} µUSD, cap ${capMicros}, day limit ${dayLimitMicros} (${after.data.day.remainingMicros} left)`,
  };
}

/** Polls a read until `done` holds or the time is up; the last value read comes back either way. */
async function waitFor<T>(
  read: () => Promise<{ data: T | null; error: string }>,
  done: (v: T) => boolean,
  timeoutMs: number,
  pollMs: number,
): Promise<{ value: T; timedOut: boolean } | { error: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = await read();
    if (!got.data) return { error: got.error || 'no data' };
    if (done(got.data)) return { value: got.data, timedOut: false };
    if (Date.now() >= deadline) return { value: got.data, timedOut: true };
    await sleep(pollMs);
  }
}

interface BrandRow {
  id: string;
  publishedVersionId: string | null;
  version: number;
}
interface BrandVersionRow {
  id: string;
  number: number;
  state: string;
  document: BrandSystemDocumentV1;
  contentHash: string;
  version: number;
}

/** The brand and its applied brand system, as the api reads them. */
async function appliedSystem(
  api: ApiSession,
  brandId: string,
): Promise<{ brand: BrandRow; applied: BrandVersionRow } | { error: string }> {
  const brand = await query<BrandRow>(api, 'brand.get', { brandId });
  if (!brand.data) return { error: `brand.get: ${brand.error}` };
  if (!brand.data.publishedVersionId) return { error: 'the fixture brand has no applied brand system' };
  const applied = await query<BrandVersionRow>(api, 'brand.versions.get', {
    brandId,
    versionId: brand.data.publishedVersionId,
  });
  if (!applied.data) return { error: `brand.versions.get: ${applied.error}` };
  return { brand: brand.data, applied: applied.data };
}

/** A save of the whole brand system over the applied version, read back: the brand now points at the version saved. */
async function saveSystem(
  api: ApiSession,
  brandId: string,
  basedOnVersionId: string,
  document: BrandSystemDocumentV1,
  proposal?: { versionId: string; expectedVersion: number },
): Promise<{ versionId: string; document: BrandSystemDocumentV1 } | { error: string }> {
  const saved = await mutate<{ versionId: string | null; changed: boolean }>(api, 'brand.system.save', {
    brandId,
    basedOnVersionId,
    document,
    ...(proposal ? { proposal } : {}),
  });
  if (!saved.data?.versionId) return { error: `brand.system.save: ${saved.error || 'no version'}` };
  const now = await appliedSystem(api, brandId);
  if ('error' in now) return now;
  if (now.applied.id !== saved.data.versionId)
    return {
      error: `brand.system.save answered ${saved.data.versionId}, but the brand reads ${now.applied.id} as applied`,
    };
  return { versionId: now.applied.id, document: now.applied.document };
}

// ---- AI-assisted brand setup (BSC-4/5) ---------------------------------------------------------------------

const ASSIST_DONE = new Set(['ready', 'partially_ready', 'failed', 'cancelled']);
const SOURCE_TITLE = 'Acceptance voice notes';

/** The pasted text a run's setup job reads: plain voice notes with one principle unique to the run. */
export const assistSourceText = (marker: string): string =>
  [
    `Voice notes for the acceptance brand (run ${marker}).`,
    'We write plainly and warmly, and we explain before we sell.',
    `One of our principles: "Say run ${marker} out loud": we name the run we mean, never "this one".`,
    'We never use exclamation marks, and we keep every sentence under twenty words.',
  ].join('\n');

/**
 * The suggestion a run accepts: an item of the brand system document (not a fact, which lives outside it), keyed
 * items first because they carry their provenance in the document; additions and replacements only.
 */
export function pickSuggestion(items: readonly BrandSuggestionDto[]): BrandSuggestionDto | null {
  const usable = items.filter(
    (s) => s.status === 'pending' && s.op !== 'remove' && !s.changedSince && s.section !== 'facts',
  );
  return usable.find((s) => s.path.includes('#')) ?? usable[0] ?? null;
}

/** Every object in a document that records which suggestion wrote it (`provenance.suggestionId`). */
function itemsBySuggestion(value: unknown, suggestionId: string, out: Array<Record<string, unknown>> = []) {
  if (Array.isArray(value)) for (const v of value) itemsBySuggestion(v, suggestionId, out);
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if ((o['provenance'] as { suggestionId?: unknown } | undefined)?.suggestionId === suggestionId)
      out.push(o);
    for (const v of Object.values(o)) itemsBySuggestion(v, suggestionId, out);
  }
  return out;
}

/** A plain field of the document by its dotted suggestion path (`voice.summary`, `channelBaseline.cta`). */
const fieldAt = (document: BrandSystemDocumentV1, dotted: string): unknown =>
  dotted
    .split('.')
    .reduce<unknown>(
      (v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined),
      document,
    );

/**
 * The provenance an accepted suggestion left in a document: the item that names the suggestion (every guidance list
 * item and writing pattern carries provenance) with the origin the suggestion stated. A plain field (a summary, the
 * tone) carries none in the document; for it the value is checked instead, and the suggestion's origin reported.
 */
export function provenanceVerdict(
  document: BrandSystemDocumentV1,
  suggestion: Pick<BrandSuggestionDto, 'id' | 'path' | 'provenance' | 'value'>,
): { ok: true; detail: string } | { ok: false; reason: string } {
  const [item] = itemsBySuggestion(document, suggestion.id);
  if (item) {
    const origin = (item['provenance'] as { origin?: string }).origin;
    return origin === suggestion.provenance.origin
      ? { ok: true, detail: `${suggestion.path}: origin ${origin}, suggestion ${suggestion.id}` }
      : {
          ok: false,
          reason: `${suggestion.path} has origin ${origin ?? 'none'}, the suggestion said ${suggestion.provenance.origin}`,
        };
  }
  if (suggestion.path.includes('#'))
    return {
      ok: false,
      reason: `no item of the brand system names suggestion ${suggestion.id} (${suggestion.path})`,
    };
  return JSON.stringify(fieldAt(document, suggestion.path)) === JSON.stringify(suggestion.value)
    ? {
        ok: true,
        detail: `${suggestion.path} holds the accepted value (a field carries no provenance in the document; the suggestion's origin is ${suggestion.provenance.origin})`,
      }
    : { ok: false, reason: `${suggestion.path} does not hold the accepted value` };
}

/** Pending proposals an interrupted earlier run left (newer than the applied version): discarded before starting. */
async function discardStaleProposals(
  api: ApiSession,
  brandId: string,
  appliedNumber: number,
): Promise<string[]> {
  const listed = await query<{
    items: Array<{ id: string; number: number; state: string; version: number }>;
  }>(api, 'brand.versions.list', { brandId, page: { limit: 50 } });
  const stale = (listed.data?.items ?? []).filter(
    (v) => v.number > appliedNumber && (v.state === 'draft' || v.state === 'in_review'),
  );
  for (const v of stale)
    await mutate(api, 'brand.system.discardProposal', {
      brandId,
      versionId: v.id,
      expectedVersion: v.version,
    });
  return stale.map((v) => v.id);
}

/** Text sources this job added in earlier runs, removed so the brand stays under its source limit. */
async function removeAcceptanceSources(api: ApiSession, brandId: string, keep?: string): Promise<number> {
  const listed = await query<{ items: Array<{ id: string; title: string; version: number }> }>(
    api,
    'brand.sources.list',
    { brandId, page: { limit: 100 } },
  );
  let removed = 0;
  for (const s of listed.data?.items ?? [])
    if (s.title === SOURCE_TITLE && s.id !== keep) {
      const done = await mutate(api, 'brand.sources.remove', {
        brandId,
        sourceId: s.id,
        expectedVersion: s.version,
      });
      if (done.status === 200) removed++;
    }
  return removed;
}

/**
 * AI-assisted setup through the deployed api and worker-core: a pasted-text source (nothing is crawled), a setup
 * job for the voice section with its spend capped through the brand's day limit, waited for through the real
 * worker; one suggestion accepted into the pending proposal, the proposal applied with brand.system.save, the
 * accepted item's provenance read back from the applied document; then the brand system the run started from is
 * restored through brand.history.restore and the source removed, so reruns start from the same place.
 */
export async function brandSystemChecks(
  cfg: AcceptanceConfig,
  sessions: Sessions,
  tenant: FixtureTenant,
  opts: JourneyOptions = {},
): Promise<AcceptanceResult[]> {
  const owner = sessions.get(sessionKey(tenant, 'owner'));
  if (!owner) return [skip('brand-system', 'company A owner has no session')];
  if (cfg.journeys.modelBudgetMicros === 0) return [skip('brand-system', NO_MODEL_BUDGET)];
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const brandId = tenant.brandId;
  const out: AcceptanceResult[] = [];
  const marker = runMarker();

  const start = await appliedSystem(owner, brandId);
  if ('error' in start) return [fail('brand-system:source', start.error)];
  const discarded = await discardStaleProposals(owner, brandId, start.applied.number);
  await removeAcceptanceSources(owner, brandId);

  const added = await mutate<{ sourceId: string }>(owner, 'brand.sources.add', {
    kind: 'text',
    brandId,
    title: SOURCE_TITLE,
    text: assistSourceText(marker),
  });
  if (!added.data) return [fail('brand-system:source', `brand.sources.add: ${added.error}`)];
  const sourceId = added.data.sourceId;
  const source = await query<{ status: string; charCount: number | null }>(owner, 'brand.sources.get', {
    brandId,
    sourceId,
  });
  if (source.data?.status !== 'captured')
    return [
      fail(
        'brand-system:source',
        `${sourceId} reads ${source.data?.status ?? source.error}, expected captured`,
      ),
    ];
  out.push(
    pass(
      'brand-system:source',
      `${sourceId} captured (${source.data.charCount ?? 0} chars)${discarded.length ? `; discarded stale proposal(s) ${discarded.join(', ')}` : ''}`,
    ),
  );

  try {
    const request = {
      brandId,
      kind: 'setup',
      sections: ['voice'],
      sourceIds: [sourceId],
      instruction: 'Propose at least one voice principle drawn from the notes.',
    };
    const estimate = await query<BrandAssistEstimateV1>(owner, 'brand.assist.estimate', request);
    if (!estimate.data)
      return [...out, fail('brand-system:budget', `brand.assist.estimate: ${estimate.error}`)];
    const room = await capModelSpend(
      owner,
      brandId,
      estimate.data.estimateMicros,
      cfg.journeys.modelBudgetMicros,
    );
    if (!room.ok) return [...out, fail('brand-system:budget', room.reason)];
    const ready = await query<BrandAssistEstimateV1>(owner, 'brand.assist.estimate', request);
    const blockers = ready.data?.blockers ?? [];
    if (!ready.data || blockers.length)
      return [
        ...out,
        fail(
          'brand-system:budget',
          ready.data
            ? `the api still refuses: ${blockers.map((b) => `${b.code} (${b.message})`).join('; ')}`
            : `brand.assist.estimate: ${ready.error}`,
        ),
      ];
    out.push(pass('brand-system:budget', room.detail));

    const started = await mutate<{ jobId: string; state: string }>(owner, 'brand.assist.start', request);
    if (!started.data) return [...out, fail('brand-system:assist', `brand.assist.start: ${started.error}`)];
    const jobId = started.data.jobId;
    const waited = await waitFor(
      () => query<BrandAssistJobDto>(owner, 'brand.assist.get', { brandId, jobId }),
      (j) => ASSIST_DONE.has(j.state),
      cfg.journeys.timeoutMs,
      pollMs,
    );
    if ('error' in waited) return [...out, fail('brand-system:assist', `brand.assist.get: ${waited.error}`)];
    const job = waited.value;
    const spent = `spent ${job.spentMicros} µUSD of the ${cfg.journeys.modelBudgetMicros} cap (reserved ${job.reservedMicros})`;
    if (waited.timedOut) {
      await mutate(owner, 'brand.assist.cancel', { brandId, jobId });
      return [
        ...out,
        fail(
          'brand-system:assist',
          `${jobId} still ${job.state} after ${cfg.journeys.timeoutMs / 1000} s (worker-core runs brandAssistWorkflowV1 on the agents queue); cancelled; ${spent}`,
        ),
      ];
    }
    if (job.state !== 'ready' && job.state !== 'partially_ready')
      return [
        ...out,
        fail(
          'brand-system:assist',
          `${jobId} ended ${job.state}: ${job.error ?? 'no error recorded'}; ${spent}`,
        ),
      ];
    if (job.spentMicros > cfg.journeys.modelBudgetMicros)
      return [...out, fail('brand-system:assist', `${jobId} ${spent}: above the cap`)];
    const listed = await query<{ items: BrandSuggestionDto[] }>(owner, 'brand.suggestions.list', {
      brandId,
      jobId,
      page: { limit: 200 },
    });
    if (!listed.data) return [...out, fail('brand-system:assist', `brand.suggestions.list: ${listed.error}`)];
    const chosen = pickSuggestion(listed.data.items);
    if (!chosen)
      return [
        ...out,
        fail(
          'brand-system:assist',
          `${jobId} ${job.state} with ${listed.data.items.length} suggestion(s), none a pending change to the brand system document; ${spent}`,
        ),
      ];
    out.push(
      pass(
        'brand-system:assist',
        `${jobId} ${job.state}, ${listed.data.items.length} suggestion(s); ${spent}`,
      ),
    );

    const accepted = await mutate<{
      proposalVersionId: string | null;
      decided: string[];
      skipped: unknown[];
    }>(owner, 'brand.suggestions.accept', { brandId, suggestionIds: [chosen.id] });
    if (!accepted.data?.decided.includes(chosen.id) || !accepted.data.proposalVersionId)
      return [
        ...out,
        fail(
          'brand-system:accept',
          accepted.data
            ? `${chosen.id} not decided (skipped: ${JSON.stringify(accepted.data.skipped)})`
            : `brand.suggestions.accept: ${accepted.error}`,
        ),
      ];
    const proposalId = accepted.data.proposalVersionId;
    const proposal = await query<BrandVersionRow>(owner, 'brand.versions.get', {
      brandId,
      versionId: proposalId,
    });
    const row = await query<{ items: BrandSuggestionDto[] }>(owner, 'brand.suggestions.list', {
      brandId,
      jobId,
      status: 'accepted',
      page: { limit: 200 },
    });
    const held = proposal.data ? provenanceVerdict(proposal.data.document, chosen) : null;
    if (!proposal.data || !held?.ok)
      return [
        ...out,
        fail(
          'brand-system:accept',
          `the proposal ${proposalId} does not hold ${chosen.path}: ${held && !held.ok ? held.reason : proposal.error}`,
        ),
      ];
    if (!row.data?.items.some((s) => s.id === chosen.id))
      return [...out, fail('brand-system:accept', `${chosen.id} does not read as accepted`)];
    out.push(pass('brand-system:accept', `${chosen.id} (${chosen.label}) into proposal ${proposalId}`));

    const saved = await saveSystem(owner, brandId, start.applied.id, proposal.data.document, {
      versionId: proposalId,
      expectedVersion: proposal.data.version,
    });
    if ('error' in saved) return [...out, fail('brand-system:publish', saved.error)];
    const closed = await query<BrandVersionRow>(owner, 'brand.versions.get', {
      brandId,
      versionId: proposalId,
    });
    if (closed.data?.state !== 'retired')
      return [
        ...out,
        fail(
          'brand-system:publish',
          `the proposal reads ${closed.data?.state ?? closed.error} after the save, expected retired`,
        ),
      ];
    out.push(
      pass('brand-system:publish', `version ${saved.versionId} applied; proposal ${proposalId} closed`),
    );

    const verdict = provenanceVerdict(saved.document, chosen);
    out.push(
      verdict.ok
        ? pass('brand-system:provenance', verdict.detail)
        : fail('brand-system:provenance', verdict.reason),
    );

    const restored = await mutate<{ versionId: string | null }>(owner, 'brand.history.restore', {
      brandId,
      versionId: start.applied.id,
      basedOnVersionId: saved.versionId,
    });
    const after = await appliedSystem(owner, brandId);
    if (!restored.data || 'error' in after || after.applied.contentHash !== start.applied.contentHash)
      out.push(
        fail(
          'brand-system:restore',
          !restored.data
            ? `brand.history.restore: ${restored.error}`
            : 'error' in after
              ? after.error
              : `the applied brand system does not match the one the run started from (${after.applied.id})`,
        ),
      );
    else
      out.push(pass('brand-system:restore', `${after.applied.id} holds the document of ${start.applied.id}`));
    return out;
  } finally {
    await removeAcceptanceSources(owner, brandId);
  }
}

// ---- facts (BSC-3) -----------------------------------------------------------------------------------------

interface FactRow {
  id: string;
  state: string;
  statement: string;
  effective: boolean;
  expired: boolean;
  reviewDue: boolean;
  reviewedAt: string | null;
  reviewDueAt: string | null;
  revokeReason: string | null;
  supersededByFactId: string | null;
  conflicts: Array<{ id: string; factId?: string; status: string; resolution?: { outcome: string } }>;
  version: number;
}

/**
 * The fact lifecycle the api exposes, each transition read back through brand.facts.list: a brand manager proposes
 * (valid for three days), the owner approves (in force, listed as expiring within a week), marks it reviewed (next
 * review date stored); a second fact raised in conflict with it is listed as conflicting and, resolved in favour of
 * the first, becomes superseded by it; a fact whose validity already ended is approved yet not in force (expired);
 * the first fact is withdrawn with a reason. Statements carry the run marker, so reruns never meet a duplicate.
 */
export async function factChecks(sessions: Sessions, tenant: FixtureTenant): Promise<AcceptanceResult[]> {
  const owner = sessions.get(sessionKey(tenant, 'owner'));
  const manager = sessions.get(sessionKey(tenant, 'brand_manager'));
  if (!owner || !manager) return [skip('facts', 'owner or brand manager has no session')];
  const brandId = tenant.brandId;
  const marker = runMarker();
  const now = Date.now();
  const out: AcceptanceResult[] = [];
  const source = { kind: 'other', ref: 'staging acceptance', title: 'Acceptance job' };
  const read = async (factId: string): Promise<FactRow | null> =>
    (
      await query<{ items: FactRow[] }>(owner, 'brand.facts.list', {
        brandId,
        ids: [factId],
        page: { limit: 1 },
      })
    ).data?.items[0] ?? null;
  const listed = async (filter: Record<string, unknown>, factId: string) =>
    (
      await query<{ items: FactRow[] }>(owner, 'brand.facts.list', {
        brandId,
        ...filter,
        ids: [factId],
        page: { limit: 1 },
      })
    ).data?.items.some((f) => f.id === factId) ?? false;

  const proposed = await mutate<{ factId: string; duplicate: boolean }>(manager, 'brand.facts.propose', {
    brandId,
    category: 'company',
    statement: `Acceptance run ${marker} ships free delivery all week.`,
    sources: [source],
    validUntil: new Date(now + 3 * 86_400_000).toISOString(),
  });
  if (!proposed.data) return [fail('facts:propose', `brand.facts.propose: ${proposed.error}`)];
  const factId = proposed.data.factId;
  let fact = await read(factId);
  if (fact?.state !== 'proposed' || proposed.data.duplicate)
    return [
      fail(
        'facts:propose',
        `${factId} reads ${fact?.state ?? 'nothing'}${proposed.data.duplicate ? ' (a duplicate)' : ''}`,
      ),
    ];
  out.push(pass('facts:propose', `${factId} proposed by the brand manager`));

  const approved = await mutate(owner, 'brand.facts.approve', {
    brandId,
    factId,
    expectedVersion: fact.version,
  });
  fact = await read(factId);
  if (approved.status !== 200 || fact?.state !== 'approved' || !fact.effective)
    return [
      ...out,
      fail('facts:approve', approved.error || `${factId} reads ${fact?.state}, effective=${fact?.effective}`),
    ];
  if (!(await listed({ expiringWithinDays: 7 }, factId)))
    return [...out, fail('facts:approve', `${factId} is not listed as expiring within 7 days`)];
  out.push(pass('facts:approve', `${factId} approved, in force, listed as expiring within 7 days`));

  const nextReview = new Date(now + 30 * 86_400_000).toISOString();
  const reviewed = await mutate(owner, 'brand.facts.markReviewed', {
    brandId,
    factId,
    expectedVersion: fact.version,
    nextReviewDueAt: nextReview,
  });
  fact = await read(factId);
  if (reviewed.status !== 200 || !fact?.reviewedAt || fact.reviewDueAt !== nextReview || fact.reviewDue)
    return [
      ...out,
      fail(
        'facts:review',
        reviewed.error || `${factId} next review ${fact?.reviewDueAt ?? 'unset'}, expected ${nextReview}`,
      ),
    ];
  out.push(pass('facts:review', `${factId} reviewed, next review ${nextReview}`));

  const rival = await mutate<{ factId: string }>(manager, 'brand.facts.propose', {
    brandId,
    category: 'company',
    statement: `Acceptance run ${marker} charges for delivery.`,
    sources: [source],
    conflicts: [{ factId, note: 'Contradicts the free delivery fact' }],
  });
  if (!rival.data) return [...out, fail('facts:conflict', `brand.facts.propose: ${rival.error}`)];
  const rivalId = rival.data.factId;
  let other = await read(rivalId);
  const conflict = other?.conflicts.find((c) => c.factId === factId && c.status === 'open');
  if (!other || !conflict || !(await listed({ hasConflicts: true }, rivalId)))
    return [...out, fail('facts:conflict', `${rivalId} carries no open conflict with ${factId}`)];
  const resolved = await mutate(owner, 'brand.facts.resolveConflict', {
    brandId,
    factId: rivalId,
    expectedVersion: other.version,
    conflictId: conflict.id,
    outcome: 'kept_other',
  });
  other = await read(rivalId);
  const settled = other?.conflicts.find((c) => c.id === conflict.id);
  if (
    resolved.status !== 200 ||
    other?.state !== 'superseded' ||
    other.supersededByFactId !== factId ||
    settled?.status !== 'resolved'
  )
    return [
      ...out,
      fail(
        'facts:conflict',
        resolved.error ||
          `${rivalId} reads ${other?.state}, superseded by ${idOf(other?.supersededByFactId)}, conflict ${settled?.status}`,
      ),
    ];
  out.push(pass('facts:conflict', `${rivalId} conflicted with ${factId}, resolved: superseded by it`));

  const lapsed = await mutate<{ factId: string }>(manager, 'brand.facts.propose', {
    brandId,
    category: 'offer',
    statement: `Acceptance run ${marker} offered a launch discount.`,
    sources: [source],
    validFrom: new Date(now - 2 * 86_400_000).toISOString(),
    validUntil: new Date(now - 86_400_000).toISOString(),
  });
  if (!lapsed.data) return [...out, fail('facts:expiry', `brand.facts.propose: ${lapsed.error}`)];
  const lapsedId = lapsed.data.factId;
  const toApprove = await read(lapsedId);
  const lapsedApproved = toApprove
    ? await mutate(owner, 'brand.facts.approve', {
        brandId,
        factId: lapsedId,
        expectedVersion: toApprove.version,
      })
    : null;
  const expired = await read(lapsedId);
  const inForce = await listed({ effective: true }, lapsedId);
  if (
    lapsedApproved?.status !== 200 ||
    expired?.state !== 'approved' ||
    !expired.expired ||
    expired.effective ||
    inForce
  )
    out.push(
      fail(
        'facts:expiry',
        lapsedApproved?.error ||
          `${lapsedId} reads ${expired?.state}, expired=${expired?.expired}, effective=${expired?.effective}, listed in force=${inForce}`,
      ),
    );
  else out.push(pass('facts:expiry', `${lapsedId} approved after its validity ended: expired, not in force`));
  if (expired?.state === 'approved')
    await mutate(owner, 'brand.facts.withdraw', {
      brandId,
      factId: lapsedId,
      expectedVersion: expired.version,
      reason: 'Acceptance cleanup',
    });

  const reason = `Acceptance run ${marker} is over`;
  const withdrawn = await mutate(owner, 'brand.facts.withdraw', {
    brandId,
    factId,
    expectedVersion: fact.version,
    reason,
  });
  fact = await read(factId);
  out.push(
    withdrawn.status === 200 && fact?.state === 'revoked' && fact.revokeReason === reason && !fact.effective
      ? pass('facts:withdraw', `${factId} withdrawn with its reason, no longer in force`)
      : fail(
          'facts:withdraw',
          withdrawn.error || `${factId} reads ${fact?.state}, reason ${fact?.revokeReason ?? 'none'}`,
        ),
  );
  return out;
}

// ---- uploads (spec 9.1) ------------------------------------------------------------------------------------

export type UploadOutcome =
  | { kind: 'accepted'; intentId: string; assetId: string }
  /** The upload path (the object store, its signing or its bucket) did not take the file: steps that need it skip. */
  | { kind: 'store'; reason: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'failed'; reason: string };

/**
 * One file through the real upload flow a browser uses: an intent (signed PUT URL), the PUT to the store, complete,
 * then the intent polled until ingest accepts or rejects it. A failure of the store itself (no intent for a 5xx,
 * a PUT that does not land, a completion the store cannot confirm) is reported as `store`, never as a pass.
 */
export async function uploadThroughIntent(
  api: ApiSession,
  file: { brandId: string; kind: string; mime: string; filename: string; bytes: Uint8Array },
  timeoutMs: number,
  pollMs: number,
): Promise<UploadOutcome> {
  const intent = await mutate<{ intentId: string; uploadUrl: string }>(api, 'assets.uploads.createIntent', {
    brandId: file.brandId,
    kind: file.kind,
    declaredMime: file.mime,
    declaredBytes: file.bytes.length,
    originalFilename: file.filename,
  });
  if (!intent.data)
    return intent.status >= 500
      ? { kind: 'store', reason: `assets.uploads.createIntent: ${intent.error}` }
      : { kind: 'failed', reason: `assets.uploads.createIntent: ${intent.error}` };
  const put = await putObject(intent.data.uploadUrl, file.bytes, file.mime);
  if (put.error) return { kind: 'store', reason: `PUT to the object store: ${put.error}` };
  const completed = await mutate(api, 'assets.uploads.complete', { intentId: intent.data.intentId });
  if (completed.status !== 200)
    return completed.status >= 500
      ? { kind: 'store', reason: `assets.uploads.complete: ${completed.error}` }
      : { kind: 'failed', reason: `assets.uploads.complete: ${completed.error}` };
  const intentId = intent.data.intentId;
  const waited = await waitFor(
    () =>
      query<{
        state: string;
        assetId: string | null;
        rejectionReason: string | null;
        rejectionDetail: string | null;
      }>(api, 'assets.uploads.get', { intentId }),
    (s) => s.state === 'accepted' || s.state === 'rejected',
    timeoutMs,
    pollMs,
  );
  if ('error' in waited) return { kind: 'failed', reason: `assets.uploads.get: ${waited.error}` };
  const s = waited.value;
  if (waited.timedOut)
    return {
      kind: 'failed',
      reason: `${intentId} still ${s.state} after ${timeoutMs / 1000} s (worker-render ingest)`,
    };
  if (s.state === 'rejected')
    return {
      kind: 'rejected',
      reason: `${intentId} rejected: ${s.rejectionReason ?? 'no reason'}${s.rejectionDetail ? ` (${s.rejectionDetail})` : ''}`,
    };
  if (!s.assetId) return { kind: 'failed', reason: `${intentId} accepted without an asset` };
  return { kind: 'accepted', intentId, assetId: s.assetId };
}

interface AssetRead {
  id: string;
  kind: string;
  name: string;
  state: string;
  rightsState: string;
  version: number;
  currentVersion: {
    id: string;
    mime: string;
    width: number | null;
    height: number | null;
    durationMs: number | null;
  } | null;
  derivatives: Array<{ purpose: string }>;
}

/** Assets of this job by name prefix that are still live, retired (all but `keep`): earlier runs' leftovers. */
async function retireLeftovers(
  api: ApiSession,
  brandId: string,
  kind: string,
  prefix: string,
  keep: string[] = [],
) {
  const listed = await query<{ items: Array<{ id: string; name: string; state: string; version: number }> }>(
    api,
    'assets.list',
    { brandId, kinds: [kind], query: prefix, page: { limit: 100 } },
  );
  const retired: string[] = [];
  for (const a of listed.data?.items ?? [])
    if (
      a.name.startsWith(prefix) &&
      !keep.includes(a.id) &&
      (a.state === 'approved' || a.state === 'pending_review')
    ) {
      const done = await mutate(api, 'assets.retire', {
        assetId: a.id,
        expectedVersion: a.version,
        reason: 'Acceptance cleanup',
      });
      if (done.status === 200) retired.push(a.id);
    }
  return retired;
}

/** A retire read back: the asset's state is retired afterwards. */
async function retireAsset(api: ApiSession, assetId: string): Promise<string | null> {
  const got = await query<AssetRead>(api, 'assets.get', { assetId });
  if (!got.data) return `assets.get: ${got.error}`;
  const done = await mutate(api, 'assets.retire', {
    assetId,
    expectedVersion: got.data.version,
    reason: 'Acceptance cleanup',
  });
  if (done.status !== 200) return `assets.retire: ${done.error}`;
  const after = await query<AssetRead>(api, 'assets.get', { assetId });
  return after.data?.state === 'retired'
    ? null
    : `${assetId} reads ${after.data?.state ?? after.error} after retiring`;
}

// ---- the Studio browser suite's photo ------------------------------------------------------------------------

const PHOTO_PREFIX = 'oremedia-acceptance-photo';

/**
 * An approved photo with recorded rights (the `creative` purpose requires both) for the Studio browser suite: its
 * real-API path seeds the fixture's hero image layer from it, and the rebase and hide-layer cases act on that layer.
 * An earlier run's photo is reused; otherwise a small PNG goes through the real upload flow, its rights are recorded
 * and it is approved unless ingest approved it already. Without a usable store there is none, and the suite skips.
 */
export async function ensurePhotoAssetVersion(
  cfg: AcceptanceConfig,
  sessions: Sessions,
  tenant: FixtureTenant,
  store: StoreState,
  opts: JourneyOptions = {},
): Promise<{ assetVersionId: string | null; detail: string }> {
  const owner = sessions.get(sessionKey(tenant, 'owner'));
  if (!owner) return { assetVersionId: null, detail: 'company A owner has no session' };
  if (!store.usable) return { assetVersionId: null, detail: store.reason };
  const listed = await query<{ items: Array<{ id: string; name: string; state: string }> }>(
    owner,
    'assets.list',
    { brandId: tenant.brandId, kinds: ['photo'], query: PHOTO_PREFIX, page: { limit: 100 } },
  );
  for (const a of listed.data?.items ?? []) {
    if (!a.name.startsWith(PHOTO_PREFIX) || a.state !== 'approved') continue;
    const got = await query<AssetRead>(owner, 'assets.get', { assetId: a.id });
    if (got.data?.state === 'approved' && got.data.rightsState === 'recorded' && got.data.currentVersion)
      return { assetVersionId: got.data.currentVersion.id, detail: `approved photo ${a.id}` };
  }
  const uploaded = await uploadThroughIntent(
    owner,
    {
      brandId: tenant.brandId,
      kind: 'photo',
      mime: 'image/png',
      filename: `${PHOTO_PREFIX}-${runMarker()}.png`,
      bytes: randomPng(64),
    },
    cfg.journeys.timeoutMs,
    opts.pollMs ?? 3000,
  );
  if (uploaded.kind !== 'accepted')
    return { assetVersionId: null, detail: `photo upload: ${uploaded.reason}` };
  const assetId = uploaded.assetId;
  const rights = await mutate(owner, 'assets.rights.set', {
    assetId,
    owner: tenant.brandName,
    permittedChannels: 'all',
    territories: 'all',
  });
  if (rights.status !== 200) return { assetVersionId: null, detail: `assets.rights.set: ${rights.error}` };
  const current = await query<AssetRead>(owner, 'assets.get', { assetId });
  // An owner's upload is approved at ingest; approve is a pending_review transition only (as the logo journey).
  if (current.data && current.data.state !== 'approved') {
    const approved = await mutate(owner, 'assets.approve', {
      assetId,
      expectedVersion: current.data.version,
    });
    if (approved.status !== 200) return { assetVersionId: null, detail: `assets.approve: ${approved.error}` };
  }
  const after = await query<AssetRead>(owner, 'assets.get', { assetId });
  return after.data?.state === 'approved' &&
    after.data.rightsState === 'recorded' &&
    after.data.currentVersion
    ? { assetVersionId: after.data.currentVersion.id, detail: `uploaded and approved photo ${assetId}` }
    : {
        assetVersionId: null,
        detail: `${assetId} reads ${after.data?.state ?? after.error}, rights ${after.data?.rightsState}`,
      };
}

// ---- SVG logo (BSC-2) ---------------------------------------------------------------------------------------

const LOGO_PREFIX = 'oremedia-acceptance-logo';

/** A small, safe SVG (no script, no external reference) whose geometry differs per run: ingest refuses duplicates. */
export function acceptanceLogoSvg(seed: number): string {
  const x = 96 + (Math.abs(Math.trunc(seed)) % 97);
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="90" viewBox="0 0 300 90">',
    '<rect width="300" height="90" rx="6" fill="#172120"/>',
    '<rect x="12" y="12" width="66" height="66" rx="8" fill="#F4F6F3"/>',
    '<path d="M30 62 L45 28 L60 62 Z" fill="#172120"/>',
    `<rect x="${x}" y="38" width="96" height="14" rx="3" fill="#F4F6F3"/>`,
    '</svg>',
  ].join('');
}

/**
 * The SVG logo journey: a safe SVG through the real upload flow (kind logo), its ingest read back (vector original
 * kept, PNG rendition made), rights recorded and the logo approved, then chosen as the brand system's primary
 * variant with its version pinned (read back from the applied document). The logo an earlier run chose, and any
 * acceptance logo left behind, is retired afterwards. Depends on the object store: when it does not take the file
 * every step skips with what failed, and `store` tells the later checks.
 */
export async function logoChecks(
  cfg: AcceptanceConfig,
  sessions: Sessions,
  tenant: FixtureTenant,
  opts: JourneyOptions = {},
): Promise<{ results: AcceptanceResult[]; store: StoreState }> {
  const owner = sessions.get(sessionKey(tenant, 'owner'));
  if (!owner)
    return {
      results: [skip('logo', 'company A owner has no session')],
      store: { usable: false, reason: 'the logo upload did not run (no owner session)' },
    };
  const brandId = tenant.brandId;
  const steps = ['logo:upload', 'logo:approve', 'logo:primary'];
  const svg = Buffer.from(acceptanceLogoSvg(Date.now()), 'utf8');
  const uploaded = await uploadThroughIntent(
    owner,
    {
      brandId,
      kind: 'logo',
      mime: 'image/svg+xml',
      filename: `${LOGO_PREFIX}-${runMarker()}.svg`,
      bytes: svg,
    },
    cfg.journeys.timeoutMs,
    opts.pollMs ?? 3000,
  );
  if (uploaded.kind === 'store') {
    const reason = `the object store did not take the upload: ${uploaded.reason}`;
    return { results: steps.map((s) => skip(s, reason)), store: { usable: false, reason } };
  }
  const store: StoreState = { usable: true, detail: 'the SVG logo upload reached the store' };
  if (uploaded.kind !== 'accepted') return { results: [fail('logo:upload', uploaded.reason)], store };
  const out: AcceptanceResult[] = [];
  const assetId = uploaded.assetId;
  const got = await query<AssetRead>(owner, 'assets.get', { assetId });
  const asset = got.data;
  if (
    !asset ||
    asset.kind !== 'logo' ||
    asset.currentVersion?.mime !== 'image/svg+xml' ||
    !asset.derivatives.some((d) => d.purpose === 'png')
  )
    return {
      results: [
        fail(
          'logo:upload',
          asset
            ? `${assetId} reads kind ${asset.kind}, ${asset.currentVersion?.mime ?? 'no version'}, renditions [${asset.derivatives.map((d) => d.purpose).join(', ')}]: expected a logo kept as SVG with a PNG rendition`
            : `assets.get: ${got.error}`,
        ),
      ],
      store,
    };
  const versionId = asset.currentVersion.id;
  out.push(
    pass(
      'logo:upload',
      `${assetId} version ${versionId}: SVG kept, PNG rendition made (${svg.length} bytes)`,
    ),
  );

  const rights = await mutate(owner, 'assets.rights.set', {
    assetId,
    owner: tenant.brandName,
    permittedChannels: 'all',
    territories: 'all',
  });
  const current = await query<AssetRead>(owner, 'assets.get', { assetId });
  // Spec 9.1 step 8: ingest catalogues the upload as approved when the uploader holds asset.approve (the owner
  // does), and approve is a pending_review transition only (assetMachine), so an approved asset is not approved again.
  const atIngest = current.data?.state === 'approved';
  const approved =
    rights.status === 200 && current.data && !atIngest
      ? await mutate(owner, 'assets.approve', { assetId, expectedVersion: current.data.version })
      : null;
  const after = await query<AssetRead>(owner, 'assets.get', { assetId });
  if (
    rights.status !== 200 ||
    (approved && approved.status !== 200) ||
    after.data?.state !== 'approved' ||
    after.data.rightsState !== 'recorded'
  )
    return {
      results: [
        ...out,
        fail(
          'logo:approve',
          rights.status !== 200
            ? `assets.rights.set: ${rights.error}`
            : approved?.error
              ? `assets.approve (the asset read ${current.data?.state} at version ${current.data?.version}): ${approved.error}`
              : `${assetId} reads ${after.data?.state ?? after.error}, rights ${after.data?.rightsState}`,
        ),
      ],
      store,
    };
  out.push(
    pass(
      'logo:approve',
      atIngest
        ? `${assetId} approved at ingest (the uploader holds asset.approve) with its rights recorded`
        : `${assetId} approved with its rights recorded`,
    ),
  );

  const system = await appliedSystem(owner, brandId);
  if ('error' in system) return { results: [...out, fail('logo:primary', system.error)], store };
  const doc = system.applied.document;
  const previous = doc.logoRules.find((r) => r.variant === 'primary');
  const rule: LogoRuleV1 = {
    assetId,
    assetVersionId: versionId,
    variant: 'primary',
    allowedBackgroundColourKeys: doc.tokens.colours.filter((c) => c.role === 'background').map((c) => c.key),
    clearSpaceRatio: 0.25,
    minWidthPx: 120,
    preferredFormat: 'svg',
  };
  const saved = await saveSystem(owner, brandId, system.applied.id, {
    ...doc,
    logoRules: [...doc.logoRules.filter((r) => r.variant !== 'primary'), rule],
  });
  if ('error' in saved) return { results: [...out, fail('logo:primary', saved.error)], store };
  const primary = saved.document.logoRules.find((r) => r.variant === 'primary');
  if (primary?.assetId !== assetId || primary.assetVersionId !== versionId)
    return {
      results: [
        ...out,
        fail(
          'logo:primary',
          `the applied primary logo is ${idOf(primary?.assetId)}@${idOf(primary?.assetVersionId)}`,
        ),
      ],
      store,
    };
  const retired = await retireLeftovers(owner, brandId, 'logo', LOGO_PREFIX, [assetId]);
  out.push(
    pass(
      'logo:primary',
      `${assetId}@${versionId} is the primary logo of ${saved.versionId}${previous ? ` (was ${previous.assetId})` : ''}${retired.length ? `; retired earlier acceptance logo(s) ${retired.join(', ')}` : ''}`,
    ),
  );
  return { results: out, store };
}

// ---- Studio (STU-1a/1b) -------------------------------------------------------------------------------------

const STARTER_KEY = 'post-bold-headline';
const TYPE_ROLES = ['display', 'heading', 'body', 'label', 'caption'] as const;
const TYPE_MIN_SIZES: Record<(typeof TYPE_ROLES)[number], number> = {
  display: 40,
  heading: 28,
  body: 16,
  label: 14,
  caption: 12,
};
const GENERATION_DONE = new Set(['completed', 'failed', 'cancelled']);

interface FontFace {
  assetId: string;
  assetVersionId: string;
  state: string;
}
interface GenerationJob {
  id: string;
  state: string;
  costReservedMicros: number;
  costSpentMicros: number;
  error: { code: string; message: string } | null;
  result: GenerationResult | null;
  version: number;
}
interface RevisionRead {
  id: string;
  number: number;
  authorKind: string;
  snapshot: CreativeDocumentV1;
  generationInputs: GenerationInputs | null;
}

/**
 * The fixture brand's published system in the shape a starter is instantiated with, as the creation gallery builds
 * it (apps/web/src/features/studio/create/use-starter-brand.ts): colours, each type role's font resolved to the
 * brand's approved face, each logo rule's logo at its current version (a superseded pin leaves it out).
 */
async function starterBrandOf(
  api: ApiSession,
  versionId: string,
  doc: BrandSystemDocumentV1,
  faces: readonly FontFace[],
): Promise<StarterBrand> {
  const typeRoles = TYPE_ROLES.flatMap((role) => {
    const t = doc.tokens.typeRoles.find((r) => r.role === role);
    const face = t ? faces.find((f) => f.assetId === t.fontAssetId && f.state === 'approved') : undefined;
    return t && face
      ? [{ role, fontAssetVersionId: face.assetVersionId, weight: t.weight, minSizePx: t.minSizePx }]
      : [];
  });
  const logos: StarterBrand['logos'][number][] = [];
  for (const rule of doc.logoRules) {
    const got = await query<AssetRead>(api, 'assets.get', { assetId: rule.assetId });
    const current = got.data?.currentVersion;
    if (
      !current ||
      got.data?.state !== 'approved' ||
      (rule.assetVersionId && rule.assetVersionId !== current.id)
    )
      continue;
    logos.push({
      variant: rule.variant,
      assetVersionId: current.id,
      aspect: current.width && current.height ? current.width / current.height : 3,
      minWidthPx: rule.minWidthPx,
      allowedBackgroundColourKeys: rule.allowedBackgroundColourKeys,
    });
  }
  return { brandVersionId: versionId, colours: doc.tokens.colours, typeRoles, logos };
}

/**
 * Studio through the deployed api: a document from a built-in starter (instantiated with the brand's system, its
 * font and logos), a person's edit, then creative.generation (a real model call in worker-core, the budget reserved
 * against the brand's capped day limit) whose proposal is read back, one group accepted (the revision records the
 * generation inputs and the group kept), a render of that revision through worker-render, and a package pinning the
 * document sent for review. Needs an approved font (imported through the object store); the render needs the store
 * too; the review request needs a usable channel, as in the content journey; each skips with its reason otherwise.
 */
export async function studioChecks(
  cfg: AcceptanceConfig,
  sessions: Sessions,
  tenant: FixtureTenant,
  store: StoreState,
  providerNote: string,
  opts: JourneyOptions = {},
): Promise<AcceptanceResult[]> {
  const owner = sessions.get(sessionKey(tenant, 'owner'));
  if (!owner) return [skip('studio', 'company A owner has no session')];
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const brandId = tenant.brandId;
  const out: AcceptanceResult[] = [];
  const allSteps = ['document', 'edit', 'generate', 'accept', 'render', 'package', 'review-request'];
  const skipRest = (from: string, reason: string) =>
    allSteps.slice(allSteps.indexOf(from)).map((s) => skip(`studio:${s}`, reason));

  const font = await ensureFontAssetVersion(cfg, sessions, tenant);
  if (!font.assetVersionId) return skipRest('document', `no approved font face: ${font.detail}`);
  const faces =
    (await query<{ items: FontFace[] }>(owner, 'assets.fonts.list', { brandId })).data?.items ?? [];
  const face = faces.find((f) => f.assetVersionId === font.assetVersionId);
  if (!face) return [fail('studio:document', `the approved face ${font.assetVersionId} is not listed`)];

  let system = await appliedSystem(owner, brandId);
  if ('error' in system) return [fail('studio:document', system.error)];
  const approvedFonts = new Set(faces.filter((f) => f.state === 'approved').map((f) => f.assetId));
  if (!system.applied.document.tokens.typeRoles.some((r) => approvedFonts.has(r.fontAssetId))) {
    const doc = system.applied.document;
    const saved = await saveSystem(owner, brandId, system.applied.id, {
      ...doc,
      tokens: {
        ...doc.tokens,
        typeRoles: TYPE_ROLES.map((role) => ({
          role,
          fontAssetId: face.assetId,
          weight: 400,
          minSizePx: TYPE_MIN_SIZES[role],
        })),
      },
    });
    if ('error' in saved) return [fail('studio:document', `type roles: ${saved.error}`)];
    system = await appliedSystem(owner, brandId);
    if ('error' in system) return [fail('studio:document', system.error)];
  }
  const spec = starterByKey(STARTER_KEY);
  if (!spec) return [fail('studio:document', `no built-in starter ${STARTER_KEY}`)];
  let made: CreativeDocumentV1;
  try {
    made = instantiateStarter(
      spec,
      await starterBrandOf(owner, system.applied.id, system.applied.document, faces),
    ).document;
  } catch (err) {
    return [
      fail('studio:document', `starter ${STARTER_KEY}: ${err instanceof Error ? err.message : String(err)}`),
    ];
  }
  const created = await mutate<{ documentId: string; revisionId: string }>(
    owner,
    'creative.documents.create',
    {
      brandId,
      title: `Acceptance ${runMarker()}`,
      document: made,
      contentType: spec.contentType,
      source: { kind: 'starter', starterKey: STARTER_KEY },
    },
  );
  if (!created.data) return [fail('studio:document', `creative.documents.create: ${created.error}`)];
  const documentId = created.data.documentId;
  const head = async () =>
    (await query<{ currentRevisionId: string | null }>(owner, 'creative.documents.get', { documentId })).data
      ?.currentRevisionId ?? null;
  const revision = async (revisionId: string) =>
    (await query<RevisionRead>(owner, 'creative.revisions.get', { documentId, revisionId })).data;
  const first = await revision(created.data.revisionId);
  if ((await head()) !== created.data.revisionId || first?.number !== 1)
    return [
      fail(
        'studio:document',
        `${documentId} does not read revision 1 ${created.data.revisionId} as its head`,
      ),
    ];
  const page = first.snapshot.pages[0];
  const headline = page?.elements.find((e) => e.type === 'text' && e.semanticRole === 'headline');
  if (!page || !headline) return [fail('studio:document', `${documentId} has no headline from the starter`)];
  out.push(pass('studio:document', `${documentId} from starter ${STARTER_KEY} (${page.formatKey})`));

  const text = `Acceptance week ${runMarker().slice(0, 8)}`;
  const edited = await mutate<{ revision: { id: string } }>(owner, 'creative.operations.applyBatch', {
    documentId,
    baseRevisionId: created.data.revisionId,
    operations: [{ op: 'setText', pageId: page.id, elementId: headline.id, text }],
    summary: 'Acceptance: headline',
    origin: 'user',
  });
  const second = edited.data ? await revision(edited.data.revision.id) : null;
  const shown = second?.snapshot.pages[0]?.elements.find((e) => e.id === headline.id);
  if (!second || second.number !== 2 || (shown?.type === 'text' ? shown.text : null) !== text)
    return [...out, fail('studio:edit', edited.error || `revision 2 does not hold the edited headline`)];
  out.push(pass('studio:edit', `revision ${second.id} by a person`));
  let renderRevisionId = second.id;

  if (cfg.journeys.modelBudgetMicros === 0)
    out.push(skip('studio:generate', NO_MODEL_BUDGET), skip('studio:accept', NO_MODEL_BUDGET));
  else {
    const request = {
      documentId,
      baseRevisionId: second.id,
      request: {
        kind: 'generate',
        brief: {
          objective: 'Announce free delivery for the acceptance week',
          audience: 'Existing customers',
          keyMessage: 'Free delivery on every order this week',
          variations: 1,
        },
      },
    };
    type Preflight = {
      blocking: boolean;
      issues: Array<{ code: string; severity: 'blocking' | 'warning'; message: string }>;
      cost: GenerationCostEstimate;
    };
    const preflightOf = () => query<Preflight>(owner, 'creative.generation.preflight', request);
    const blocks = (p: Preflight, ignore: string[] = []) => {
      const blocking = p.issues.filter((i) => i.severity === 'blocking' && !ignore.includes(i.code));
      return blocking.length || (p.blocking && !ignore.length)
        ? `preflight blocks: ${p.issues.map((i) => `${i.code} (${i.message})`).join('; ')}`
        : null;
    };
    const preflight = await preflightOf();
    if (!preflight.data) return [...out, fail('studio:generate', `preflight: ${preflight.error}`)];
    // budget_insufficient is judged once the spend is capped: an earlier journey today (brand assist) spends under
    // the day limit it set, which can leave less than this estimate; capModelSpend sets today's limit to what is
    // committed plus the cap, and the preflight is asked again.
    const blocked = blocks(preflight.data, ['budget_insufficient']);
    if (blocked) return [...out, fail('studio:generate', blocked)];
    const room = await capModelSpend(
      owner,
      brandId,
      preflight.data.cost.totalMicros,
      cfg.journeys.modelBudgetMicros,
    );
    if (!room.ok) return [...out, fail('studio:generate', room.reason)];
    if (preflight.data.blocking) {
      const again = await preflightOf();
      if (!again.data) return [...out, fail('studio:generate', `preflight: ${again.error}`)];
      const still = blocks(again.data);
      if (still) return [...out, fail('studio:generate', `${still}; after the cap: ${room.detail}`)];
    }
    const started = await mutate<{ id: string }>(owner, 'creative.generation.start', request);
    if (!started.data)
      return [...out, fail('studio:generate', `creative.generation.start: ${started.error}`)];
    const jobId = started.data.id;
    const waited = await waitFor(
      () => query<GenerationJob>(owner, 'creative.generation.get', { jobId }),
      (j) => GENERATION_DONE.has(j.state),
      cfg.journeys.timeoutMs,
      pollMs,
    );
    if ('error' in waited)
      return [...out, fail('studio:generate', `creative.generation.get: ${waited.error}`)];
    const job = waited.value;
    const spent = `reserved ${job.costReservedMicros} µUSD, spent ${job.costSpentMicros} of the ${cfg.journeys.modelBudgetMicros} cap`;
    if (waited.timedOut) {
      await mutate(owner, 'creative.generation.cancel', { jobId, expectedVersion: job.version });
      return [
        ...out,
        fail(
          'studio:generate',
          `${jobId} still ${job.state} after ${cfg.journeys.timeoutMs / 1000} s (worker-core runs studioGenerationWorkflowV1 on the agents queue); cancelled; ${spent}`,
        ),
      ];
    }
    if (job.state !== 'completed')
      return [
        ...out,
        fail(
          'studio:generate',
          `${jobId} ended ${job.state}: ${job.error ? `${job.error.code} ${job.error.message}` : 'no error'}; ${spent}`,
        ),
      ];
    const proposal = job.result?.proposal;
    if (!proposal || proposal.baseRevisionId !== second.id)
      return [
        ...out,
        fail(
          'studio:generate',
          `${jobId} completed without a proposal on revision ${second.id} (a person had edited the document); ${spent}`,
        ),
      ];
    if (job.costSpentMicros > cfg.journeys.modelBudgetMicros || job.costReservedMicros <= 0)
      return [...out, fail('studio:generate', `${jobId} ${spent}: no reservation, or above the cap`)];
    out.push(
      pass(
        'studio:generate',
        `${jobId} proposed ${proposal.operations.length} operation(s) in ${proposal.groups.length} group(s); ${room.detail}; ${spent}`,
      ),
    );

    const group = proposal.groups[0];
    const operations: Operation[] = group
      ? operationsOfGroups(proposal.operations, proposal.groups, [group.id])
      : [];
    if (!group || operations.length === 0)
      return [...out, fail('studio:accept', `${jobId}: no group with operations to accept`)];
    const accepted = await mutate<{ revision: { id: string } }>(owner, 'creative.operations.applyBatch', {
      documentId,
      baseRevisionId: proposal.baseRevisionId,
      operations,
      summary: proposal.summary,
      origin: 'agent',
      generation: { jobId, groupIds: [group.id] },
    });
    const third = accepted.data ? await revision(accepted.data.revision.id) : null;
    const inputs = third?.generationInputs;
    if (
      !third ||
      (await head()) !== third.id ||
      inputs?.jobId !== jobId ||
      !inputs.acceptedGroupIds?.includes(group.id)
    )
      return [
        ...out,
        fail(
          'studio:accept',
          accepted.error ||
            `revision ${idOf(third?.id)} records ${inputs ? `job ${inputs.jobId}, groups [${(inputs.acceptedGroupIds ?? []).join(', ')}]` : 'no generation inputs'}`,
        ),
      ];
    out.push(
      pass(
        'studio:accept',
        `group "${group.label}" accepted as revision ${third.id}: inputs of ${jobId} (brand version ${inputs.brandVersionId}, cost ${inputs.costMicros} µUSD)`,
      ),
    );
    renderRevisionId = third.id;
  }

  if (!store.usable) out.push(skip('studio:render', store.reason));
  else {
    const requested = await mutate<{ renderJobId: string }>(owner, 'creative.renders.request', {
      documentId,
      revisionId: renderRevisionId,
      formatKeys: [page.formatKey],
    });
    const renderJobId = requested.data?.renderJobId;
    if (!renderJobId)
      out.push(fail('studio:render', `creative.renders.request: ${requested.error || 'no job'}`));
    else {
      const waited = await waitFor(
        () =>
          query<{ state: string; error: string | null; exports: Array<{ id: string }> }>(
            owner,
            'creative.renders.get',
            {
              renderJobId,
            },
          ),
        (j) => j.state === 'ready' || j.state === 'failed',
        cfg.journeys.timeoutMs,
        pollMs,
      );
      out.push(
        'error' in waited
          ? fail('studio:render', `creative.renders.get: ${waited.error}`)
          : waited.value.state === 'ready' && waited.value.exports.length > 0
            ? pass(
                'studio:render',
                `${renderJobId} ready with ${waited.value.exports.length} export(s) of ${renderRevisionId}`,
              )
            : fail(
                'studio:render',
                waited.timedOut
                  ? `${renderJobId} still ${waited.value.state} after ${cfg.journeys.timeoutMs / 1000} s (worker-render)`
                  : `${renderJobId} ${waited.value.state}: ${waited.value.error ?? 'no exports'}`,
              ),
      );
    }
  }

  const pkg = await mutate<{ contentPackageId: string; contentRevisionId: string }>(
    owner,
    'content.packages.create',
    {
      brandId,
      title: `Acceptance studio ${runMarker()}`,
      copy: { schemaVersion: 1, master: { text: 'Free delivery on every order this week.', factRefs: [] } },
      creativeDocumentIds: [documentId],
    },
  );
  if (!pkg.data) return [...out, fail('studio:package', `content.packages.create: ${pkg.error}`)];
  const pinning = await query<{
    items: Array<{ package: { id: string }; pinnedRevisionId: string; stale: boolean }>;
  }>(owner, 'content.packages.listForDocument', { documentId });
  const pinned = pinning.data?.items.find((i) => i.package.id === pkg.data?.contentPackageId);
  const current = await head();
  if (!pinned || pinned.stale || pinned.pinnedRevisionId !== current)
    return [
      ...out,
      fail(
        'studio:package',
        `${pkg.data.contentPackageId} pins ${idOf(pinned?.pinnedRevisionId)}, the document head is ${idOf(current)}`,
      ),
    ];
  out.push(
    pass('studio:package', `${pkg.data.contentPackageId} pins the document at ${pinned.pinnedRevisionId}`),
  );

  const connection = tenant.channelConnectionIds[0];
  if (!connection) {
    out.push(
      skip('studio:review-request', `no usable channel connection on the fixture brand (${providerNote})`),
    );
    return out;
  }
  const variants = await mutate<{ created: string[] }>(owner, 'content.variants.generate', {
    contentRevisionId: pkg.data.contentRevisionId,
    channelConnectionIds: [connection],
  });
  if (!variants.data?.created.length)
    return [
      ...out,
      fail('studio:review-request', `content.variants.generate: ${variants.error || 'no variant'}`),
    ];
  const at = new Date(Date.now() + 60 * 60_000);
  at.setUTCSeconds(0, 0);
  const req = await mutate<{ reviewRequestId: string }>(owner, 'review.requests.create', {
    contentRevisionId: pkg.data.contentRevisionId,
    assigneeUserIds: [],
    timing: { kind: 'exact', at: at.toISOString() },
  });
  const view = req.data
    ? await query<{ revisionState: string }>(owner, 'review.requests.get', {
        reviewRequestId: req.data.reviewRequestId,
      })
    : null;
  out.push(
    req.data && view?.data?.revisionState === 'in_review'
      ? pass('studio:review-request', `${req.data.reviewRequestId}: the package revision is in review`)
      : fail(
          'studio:review-request',
          req.error || `the package revision reads ${view?.data?.revisionState ?? view?.error}`,
        ),
  );
  return out;
}

// ---- video (STU-2a) -----------------------------------------------------------------------------------------

const CLIP_PREFIX = 'oremedia-acceptance-clip';
/** The repository's test clip (a few seconds of WebM), present in the acceptance image's checkout. */
export const CLIP_PATH = path.join('tooling', 'test-fixtures', 'media', 'clip.webm');

/**
 * Video ingest through the real upload flow, only when the store takes uploads: the repository's test clip uploaded
 * as a video, videoIngestWorkflowV1 (worker-render, task queue `video`) waited for, the asset read back with its
 * duration, poster and editing proxy, then retired (ingest refuses a live duplicate, so every run starts clean, and
 * a clip an interrupted run left live is retired first).
 */
export async function videoChecks(
  cfg: AcceptanceConfig,
  sessions: Sessions,
  tenant: FixtureTenant,
  store: StoreState,
  opts: JourneyOptions = {},
): Promise<AcceptanceResult[]> {
  const owner = sessions.get(sessionKey(tenant, 'owner'));
  if (!owner) return [skip('video', 'company A owner has no session')];
  if (!store.usable) return [skip('video:upload', store.reason)];
  let bytes: Buffer;
  try {
    bytes = await readFile(path.join(cfg.repoDir, CLIP_PATH));
  } catch (err) {
    return [
      skip(
        'video:upload',
        `no test clip at ${CLIP_PATH} in ${cfg.repoDir}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    ];
  }
  await retireLeftovers(owner, tenant.brandId, 'video', CLIP_PREFIX);
  const uploaded = await uploadThroughIntent(
    owner,
    { brandId: tenant.brandId, kind: 'video', mime: 'video/webm', filename: `${CLIP_PREFIX}.webm`, bytes },
    cfg.journeys.timeoutMs,
    opts.pollMs ?? 3000,
  );
  if (uploaded.kind === 'store')
    return [skip('video:upload', `the object store did not take the clip: ${uploaded.reason}`)];
  if (uploaded.kind !== 'accepted') return [fail('video:upload', uploaded.reason)];
  const got = await query<AssetRead>(owner, 'assets.get', { assetId: uploaded.assetId });
  const a = got.data;
  const purposes = a?.derivatives.map((d) => d.purpose) ?? [];
  const out: AcceptanceResult[] = [];
  out.push(
    a?.kind === 'video' &&
      (a.currentVersion?.durationMs ?? 0) > 0 &&
      purposes.includes('poster') &&
      purposes.includes('proxy')
      ? pass(
          'video:upload',
          `${a.id}: ${a.currentVersion?.durationMs} ms, ${a.currentVersion?.width}x${a.currentVersion?.height}, renditions [${purposes.join(', ')}]`,
        )
      : fail(
          'video:upload',
          a
            ? `${a.id} reads kind ${a.kind}, duration ${a.currentVersion?.durationMs ?? 'none'}, renditions [${purposes.join(', ')}]: expected a video with poster and proxy`
            : `assets.get: ${got.error}`,
        ),
  );
  const retired = await retireAsset(owner, uploaded.assetId);
  out.push(retired ? fail('video:cleanup', retired) : pass('video:cleanup', `${uploaded.assetId} retired`));
  return out;
}
