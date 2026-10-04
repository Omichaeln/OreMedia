import type {
  BrandChangeImpactActivitiesV1,
  BrandChangeImpactInputV1,
} from '@oremedia/contracts/brand-change-impact';
import type {
  DestinationRefreshActivitiesV1,
  DestinationRevokeActivitiesV1,
  DestinationVerifyActivitiesV1,
} from '@oremedia/contracts/destinations';
import type { BrandFactSweepActivitiesV1 } from '@oremedia/contracts/fact-sweep';
import type {
  AnalystSweepActivitiesV1,
  BaselineComparisonActivitiesV1,
  BrandAnalystActivitiesV1,
  BrandAnalystWorkflowInputV1,
  PrepareAnalysisResultV1,
} from '@oremedia/contracts/intelligence';
import type {
  DeletionActivitiesV1,
  IdempotencyKeyPurgeActivitiesV1,
  RetentionActivitiesV1,
} from '@oremedia/contracts/operations';
import type {
  ChannelRevokeActivitiesV1,
  ConnectChoicePurgeActivitiesV1,
  PublicationSweepActivitiesV1,
  RemoteChangeSweepActivitiesV1,
  RenderedValidationActivitiesV1,
  TokenRefreshActivitiesV1,
} from '@oremedia/contracts/publishing';
import { LONG_AGO, next, nonRetryable, tenant, type Recorder, type RecordingCase } from './types';

/**
 * Task queue `core`: the scheduled platform jobs, the remote-revoke and verify one-shots, brand change impact, the
 * analyst runs and the delayed checks. Each case is one representative execution; see ./types.ts.
 */
const core = (rec: Recorder, ...impls: object[]) => ({
  core: Object.assign({}, ...impls.map((i) => rec(i))),
});

const analyst = (prepared: Partial<PrepareAnalysisResultV1>, runStates: string[]) => {
  const states = [...runStates];
  return {
    prepareAnalysis: async () => ({
      runId: 'run_replay_1',
      skippedReason: null,
      changeInsightIds: ['ins_replay_1'],
      coverage: {
        sources: ['replay_metrics'],
        competitors: [],
        languages: ['en'],
        periodStart: '2026-01-01T00:00:00.000Z',
        periodEnd: LONG_AGO,
      },
      ...prepared,
    }),
    readAnalystRun: async () => {
      const state = next(states);
      return { state, terminal: state === 'completed' || state === 'failed' };
    },
    recordAnalystOutcome: async () => ({
      insights: 2,
      recommendations: 1,
      rankingPolicy: 'baseline' as const,
    }),
  } satisfies BrandAnalystActivitiesV1;
};
const analystInput: BrandAnalystWorkflowInputV1 = {
  ...tenant(1),
  actor: { kind: 'service_principal', id: 'sp_replay_1' },
  brandId: 'brd_replay_1',
  servicePrincipalId: 'sp_replay_1',
  periodStart: '2025-12-29T09:00:00.000Z',
  periodEnd: LONG_AGO,
};

const brandChange = (change: BrandChangeImpactInputV1['change']): BrandChangeImpactInputV1 => ({
  ...tenant(1),
  brandId: 'brd_replay_1',
  change,
});
const brandChangeActs: BrandChangeImpactActivitiesV1 = {
  invalidateApprovals: async () => ({ approvalsInvalidated: 2, requestsStaled: 1 }),
  reevaluateScheduledPublications: async () => ({ held: ['pub_replay_1'], unchanged: ['pub_replay_2'] }),
  applyFactRevocation: async () => ({
    hold: true,
    held: ['pub_replay_1'],
    flagged: [],
    unchanged: ['pub_replay_2'],
  }),
};

const tokenRefresh = (
  schedule: () => Awaited<ReturnType<TokenRefreshActivitiesV1['readRefreshSchedule']>>,
  refresh: Awaited<ReturnType<TokenRefreshActivitiesV1['refreshCredentials']>>,
): TokenRefreshActivitiesV1 => ({
  readRefreshSchedule: async () => schedule(),
  refreshCredentials: async () => refresh,
});
const tokenInput = { ...tenant(1), channelConnectionId: 'cc_replay_1' };

export const corePlatformCases: RecordingCase[] = [
  {
    workflowType: 'remoteChangeSweepWorkflowV1',
    name: 'swept',
    description: 'The hourly schedule run: one sweep closes two stale remote changes.',
    queue: 'core',
    activities: (rec) =>
      core(rec, {
        sweepStaleRemoteChanges: async () => ({ closed: 2 }),
      } satisfies RemoteChangeSweepActivitiesV1),
    args: [],
    workflowId: 'remote-change-sweep-replay-1',
    state: 'completed',
  },
  {
    workflowType: 'connectChoicePurgeWorkflowV1',
    name: 'scheduled',
    description: 'Started by the schedule with no args: the run id and workflow clock fill the input.',
    queue: 'core',
    activities: (rec) =>
      core(rec, {
        purgeExpiredConnectChoices: async () => ({ rows: 3 }),
      } satisfies ConnectChoicePurgeActivitiesV1),
    args: [{}],
    workflowId: 'connect-choice-purge-replay-1',
    state: 'completed',
  },
  {
    workflowType: 'connectChoicePurgeWorkflowV1',
    name: 'explicit-args',
    description: 'Started with an explicit correlation id and clock.',
    queue: 'core',
    activities: (rec) =>
      core(rec, {
        purgeExpiredConnectChoices: async () => ({ rows: 0 }),
      } satisfies ConnectChoicePurgeActivitiesV1),
    args: [{ correlationId: 'corr_replay_purge', now: LONG_AGO }],
    workflowId: 'connect-choice-purge-replay-2',
    state: 'completed',
  },
  {
    workflowType: 'idempotencyKeyPurgeWorkflowV1',
    name: 'scheduled',
    description: 'The hourly schedule run deletes expired idempotency records.',
    queue: 'core',
    activities: (rec) =>
      core(rec, {
        purgeExpiredIdempotencyKeys: async () => ({ rows: 12 }),
      } satisfies IdempotencyKeyPurgeActivitiesV1),
    args: [{}],
    workflowId: 'idempotency-key-purge-replay-1',
    state: 'completed',
  },
  {
    workflowType: 'retentionSweepWorkflowV1',
    name: 'dry-run-default',
    description: 'The schedule run (dry run by default) over two tenants.',
    queue: 'core',
    activities: (rec) =>
      core(rec, {
        listRetentionTenants: async () => ['tnt_replay_1', 'tnt_replay_2'],
        applyRetention: async (i) => ({
          tenantId: i.tenantId,
          dryRun: i.dryRun,
          classes: [
            {
              dataClass: 'creative_revisions',
              handler: 'creative',
              retentionDays: 365,
              cutoff: LONG_AGO,
              rows: 4,
            },
          ],
        }),
      } satisfies RetentionActivitiesV1),
    args: [{}],
    workflowId: 'retention-sweep-replay-1',
    state: 'completed',
  },
  {
    workflowType: 'retentionSweepWorkflowV1',
    name: 'apply-one-tenant-fails',
    description: 'Apply mode; one tenant fails non-retryably and is counted, the others are applied.',
    queue: 'core',
    activities: (rec) =>
      core(rec, {
        listRetentionTenants: async () => ['tnt_replay_1', 'tnt_replay_2', 'tnt_replay_3'],
        applyRetention: async (i) => {
          if (i.tenantId === 'tnt_replay_2') throw nonRetryable('ValidationFailed');
          return { tenantId: i.tenantId, dryRun: false, classes: [] };
        },
      } satisfies RetentionActivitiesV1),
    args: [{ dryRun: false, correlationId: 'corr_replay_retention', now: LONG_AGO }],
    workflowId: 'retention-sweep-replay-2',
    state: 'completed',
  },
  {
    workflowType: 'deletionRequestWorkflowV1',
    name: 'completed',
    description: 'Two pending handlers run in order and the request completes.',
    queue: 'core',
    activities: (rec) =>
      core(rec, {
        beginDeletion: async () => ({ state: 'in_progress', pending: ['publishing', 'assets'] }),
        runDeletionHandler: async (i) => ({ handler: i.handler, status: 'done', evidence: { rows: 3 } }),
        finishDeletion: async () => ({ state: 'completed', operatorActions: [] }),
      } satisfies DeletionActivitiesV1),
    args: [{ ...tenant(1), deletionRequestId: 'del_replay_1' }],
    workflowId: 'deletion:del_replay_1',
    state: 'completed',
  },
  {
    workflowType: 'deletionRequestWorkflowV1',
    name: 'operator-actions',
    description: 'One handler needs an operator; the request is left blocked with the actions named.',
    queue: 'core',
    activities: (rec) =>
      core(rec, {
        beginDeletion: async () => ({ state: 'in_progress', pending: ['assets', 'backups'] }),
        runDeletionHandler: async (i) => ({
          handler: i.handler,
          status: i.handler === 'backups' ? 'operator_action_required' : 'not_applicable',
          evidence: {},
        }),
        finishDeletion: async () => ({
          state: 'blocked',
          operatorActions: ['backups', 'temporal_visibility'],
        }),
      } satisfies DeletionActivitiesV1),
    args: [{ ...tenant(2), deletionRequestId: 'del_replay_2' }],
    workflowId: 'deletion:del_replay_2',
    state: 'completed',
  },
  {
    workflowType: 'channelRevokeWorkflowV1',
    name: 'revoked',
    description: 'The platform revokes the grant; the credential is destroyed.',
    queue: 'core',
    activities: (rec) =>
      core(rec, {
        revokeChannelAccess: async () => ({ outcome: 'revoked' as const }),
      } satisfies ChannelRevokeActivitiesV1),
    args: [{ ...tenant(1), channelConnectionId: 'cc_replay_1' }],
    workflowId: 'channel-revoke:cc_replay_1',
    state: 'completed',
  },
  {
    workflowType: 'channelRevokeWorkflowV1',
    name: 'not-found-fails',
    description: 'The activity fails non-retryably (NotFound): the workflow fails.',
    queue: 'core',
    activities: (rec) =>
      core(rec, {
        revokeChannelAccess: async () => {
          throw nonRetryable('NotFound');
        },
      } satisfies ChannelRevokeActivitiesV1),
    args: [{ ...tenant(1), channelConnectionId: 'cc_replay_2' }],
    workflowId: 'channel-revoke:cc_replay_2',
    state: 'failed',
  },
  {
    workflowType: 'destinationVerifyWorkflowV1',
    name: 'verified',
    description: 'The sealed secret verifies; the destination is healthy.',
    queue: 'core',
    activities: (rec) =>
      core(rec, {
        verifyDestinationCredential: async () => ({ ok: true as const, health: 'healthy' as const }),
      } satisfies DestinationVerifyActivitiesV1),
    args: [{ ...tenant(1), destinationId: 'dst_replay_1' }],
    workflowId: 'destination-verify:dst_replay_1',
    state: 'completed',
  },
  {
    workflowType: 'destinationVerifyWorkflowV1',
    name: 'reconnect-required',
    description: 'The site refuses the secret: the result asks for a reconnect.',
    queue: 'core',
    activities: (rec) =>
      core(rec, {
        verifyDestinationCredential: async () => ({
          ok: false as const,
          reason: 'reconnect_required' as const,
        }),
      } satisfies DestinationVerifyActivitiesV1),
    args: [{ ...tenant(1), destinationId: 'dst_replay_2' }],
    workflowId: 'destination-verify:dst_replay_2',
    state: 'completed',
  },
  {
    workflowType: 'destinationRevokeWorkflowV1',
    name: 'revoked',
    description: 'The platform revokes the destination grant.',
    queue: 'core',
    activities: (rec) =>
      core(rec, {
        revokeDestinationAccess: async () => ({ outcome: 'revoked' as const }),
      } satisfies DestinationRevokeActivitiesV1),
    args: [{ ...tenant(1), destinationId: 'dst_replay_1' }],
    workflowId: 'destination-revoke:dst_replay_1',
    state: 'completed',
  },
  {
    workflowType: 'destinationRevokeWorkflowV1',
    name: 'platform-failed',
    description: 'The platform answers with a failure; the outcome is recorded and the workflow completes.',
    queue: 'core',
    activities: (rec) =>
      core(rec, {
        revokeDestinationAccess: async () => ({ outcome: 'failed' as const, reason: 'http_500' }),
      } satisfies DestinationRevokeActivitiesV1),
    args: [{ ...tenant(1), destinationId: 'dst_replay_2' }],
    workflowId: 'destination-revoke:dst_replay_2',
    state: 'completed',
  },
  {
    workflowType: 'destinationTokenRefreshWorkflowV1',
    name: 'mixed-results',
    description: 'Four due destinations: refreshed, reconnect needed, locked, and one failing non-retryably.',
    queue: 'core',
    activities: (rec) =>
      core(rec, {
        listDueDestinationRefreshes: async () => [
          { tenantId: 'tnt_replay_1', destinationId: 'dst_replay_1' },
          { tenantId: 'tnt_replay_1', destinationId: 'dst_replay_2' },
          { tenantId: 'tnt_replay_2', destinationId: 'dst_replay_3' },
          { tenantId: 'tnt_replay_2', destinationId: 'dst_replay_4' },
        ],
        refreshDestinationCredential: async (i) => {
          if (i.destinationId === 'dst_replay_1') return { ok: true as const, tokenExpiresAt: LONG_AGO };
          if (i.destinationId === 'dst_replay_2')
            return { ok: false as const, reason: 'reconnect_required' as const };
          if (i.destinationId === 'dst_replay_3') return { ok: false as const, reason: 'locked' as const };
          throw nonRetryable('PolicyDenied');
        },
      } satisfies DestinationRefreshActivitiesV1),
    args: [{}],
    workflowId: 'destination-token-refresh-replay-1',
    state: 'completed',
  },
  {
    workflowType: 'brandFactSweepWorkflowV1',
    name: 'one-brand-fails',
    description: 'Three brands swept as the platform job; one fails non-retryably and is counted.',
    queue: 'core',
    activities: (rec) =>
      core(rec, {
        listBrandFactSweepTargets: async () => [
          { tenantId: 'tnt_replay_1', brandId: 'brd_replay_1' },
          { tenantId: 'tnt_replay_2', brandId: 'brd_replay_2' },
          { tenantId: 'tnt_replay_2', brandId: 'brd_replay_3' },
        ],
        sweepBrandFacts: async (i) => {
          if (i.brandId === 'brd_replay_2') throw nonRetryable('ValidationFailed');
          return { expired: 1, reviewDue: 2, keyed: 0 };
        },
      } satisfies BrandFactSweepActivitiesV1),
    args: [{}],
    workflowId: 'brand-fact-sweep-replay-1',
    state: 'completed',
  },
  {
    workflowType: 'brandChangeImpactWorkflowV1',
    name: 'version-published',
    description: 'A published brand version invalidates approvals and re-evaluates scheduled publications.',
    queue: 'core',
    activities: (rec) => core(rec, brandChangeActs),
    args: [brandChange({ kind: 'version_published', brandVersionId: 'bv_replay_2' })],
    workflowId: 'brand-change:evt_replay_1',
    state: 'completed',
  },
  {
    workflowType: 'brandChangeImpactWorkflowV1',
    name: 'fact-revoked',
    description: 'A revoked fact invalidates approvals and applies the fact policy (hold).',
    queue: 'core',
    activities: (rec) => core(rec, brandChangeActs),
    args: [brandChange({ kind: 'fact_revoked', factId: 'fact_replay_1' })],
    workflowId: 'brand-change:evt_replay_2',
    state: 'completed',
  },
  {
    workflowType: 'baselineComparisonWorkflowV1',
    name: 'one-target-fails',
    description:
      'The monthly comparison over three brands: learned beats baseline, a fallback, and a failure.',
    queue: 'core',
    activities: (rec) =>
      core(rec, {
        listBaselineTargets: async () => [
          { tenantId: 'tnt_replay_1', brandId: 'brd_replay_1', servicePrincipalId: 'sp_replay_1' },
          { tenantId: 'tnt_replay_2', brandId: 'brd_replay_2', servicePrincipalId: 'sp_replay_2' },
          { tenantId: 'tnt_replay_2', brandId: 'brd_replay_3', servicePrincipalId: 'sp_replay_3' },
        ],
        compareRankingBaseline: async (i) => {
          if (i.brandId === 'brd_replay_3') throw nonRetryable('PolicyDenied');
          const beaten = i.brandId === 'brd_replay_1';
          return {
            brandId: i.brandId,
            evaluated: 14,
            learnedScore: beaten ? 0.61 : 0.4,
            baselineScore: 0.5,
            margin: 0.05,
            beaten,
            selected: beaten ? ('learned' as const) : ('baseline' as const),
            insightId: beaten ? null : 'ins_replay_2',
          };
        },
      } satisfies BaselineComparisonActivitiesV1),
    args: [{}],
    workflowId: 'baseline-comparison-replay-1',
    state: 'completed',
  },
  {
    workflowType: 'brandAnalystWorkflowV1',
    name: 'run-completed',
    description: 'The performance-review run is already terminal on the first read; the outcome is recorded.',
    queue: 'core',
    activities: (rec) => core(rec, analyst({}, ['completed'])),
    args: [analystInput],
    workflowId: 'brand-analyst:brd_replay_1:2026-01-05',
    state: 'completed',
  },
  {
    workflowType: 'brandAnalystWorkflowV1',
    name: 'polled-then-completed',
    description: 'The run is still running on the first read; one 30 s poll timer, then it is terminal.',
    queue: 'core',
    activities: (rec) => core(rec, analyst({}, ['running', 'completed'])),
    args: [analystInput],
    workflowId: 'brand-analyst:brd_replay_1:2026-01-06',
    state: 'completed',
  },
  {
    workflowType: 'brandAnalystWorkflowV1',
    name: 'skipped',
    description: 'No run could start and nothing changed: the analysis is skipped.',
    queue: 'core',
    activities: (rec) =>
      core(rec, analyst({ runId: null, skippedReason: 'no_objective', changeInsightIds: [] }, ['completed'])),
    args: [analystInput],
    workflowId: 'brand-analyst:brd_replay_1:2026-01-07',
    state: 'completed',
  },
  {
    workflowType: 'brandAnalystWorkflowV1',
    name: 'polling-open',
    description: 'In flight: the run is not terminal and the workflow waits on its poll timer.',
    queue: 'core',
    activities: (rec) => core(rec, analyst({}, ['running'])),
    args: [analystInput],
    workflowId: 'brand-analyst:brd_replay_1:2026-01-08',
    state: 'open',
  },
  {
    workflowType: 'brandAnalystSweepWorkflowV1',
    name: 'two-targets',
    description: 'The weekly sweep starts one abandoned child analysis per brand.',
    queue: 'core',
    activities: (rec) =>
      core(
        rec,
        {
          listAnalystTargets: async () => [
            { tenantId: 'tnt_replay_1', brandId: 'brd_replay_1', servicePrincipalId: 'sp_replay_1' },
            { tenantId: 'tnt_replay_2', brandId: 'brd_replay_2', servicePrincipalId: 'sp_replay_2' },
          ],
        } satisfies AnalystSweepActivitiesV1,
        analyst({}, ['completed']),
      ),
    args: [{ correlationId: 'corr_replay_analyst', now: '2026-02-02T09:00:00.000Z' }],
    workflowId: 'analyst-sweep-replay-1',
    state: 'completed',
  },
  {
    workflowType: 'renderedValidationWorkflowV1',
    name: 'both-checks-due',
    description: 'Published long ago: both delayed checks are due at once and both validate.',
    queue: 'core',
    activities: (rec) =>
      core(rec, {
        validateRenderedPublication: async () => ({
          outcome: 'validated' as const,
          ok: true,
          verification: 'verified' as const,
        }),
      } satisfies RenderedValidationActivitiesV1),
    args: [{ ...tenant(1), publicationId: 'pub_replay_1', publishedAt: LONG_AGO }],
    workflowId: 'rendered-validation:pub_replay_1',
    state: 'completed',
  },
  {
    workflowType: 'renderedValidationWorkflowV1',
    name: 'skipped',
    description: 'The publication is no longer a live article: the first check skips and the run ends.',
    queue: 'core',
    activities: (rec) =>
      core(rec, {
        validateRenderedPublication: async () => ({ outcome: 'skipped' as const, reason: 'not_published' }),
      } satisfies RenderedValidationActivitiesV1),
    args: [{ ...tenant(1), publicationId: 'pub_replay_2', publishedAt: LONG_AGO }],
    workflowId: 'rendered-validation:pub_replay_2',
    state: 'completed',
  },
  {
    workflowType: 'renderedValidationWorkflowV1',
    name: 'waiting-open',
    description: 'In flight: published just now, the workflow waits on the two-minute timer.',
    queue: 'core',
    activities: (rec) =>
      core(rec, {
        validateRenderedPublication: async () => ({
          outcome: 'validated' as const,
          ok: false,
          verification: 'failed' as const,
        }),
      } satisfies RenderedValidationActivitiesV1),
    args: () => [{ ...tenant(1), publicationId: 'pub_replay_3', publishedAt: new Date().toISOString() }],
    workflowId: 'rendered-validation:pub_replay_3',
    state: 'open',
  },
  {
    workflowType: 'publicationSweeperWorkflowV1',
    name: 'continued-as-new',
    description: 'Two passes one second apart, then continue-as-new with the same configuration.',
    queue: 'core',
    activities: (rec) =>
      core(rec, {
        sweepPublications: async () => ({
          scheduledReemitted: 1,
          dispatchingExpired: 0,
          credentialsShredded: 0,
        }),
      } satisfies PublicationSweepActivitiesV1),
    args: [{ intervalSeconds: 1, passesPerRun: 2 }],
    workflowId: 'publication-sweeper-replay-1',
    state: 'continued_as_new',
  },
  {
    workflowType: 'publicationSweeperWorkflowV1',
    name: 'default-open',
    description: 'In flight with the default configuration: after the first pass it waits on the 60 s timer.',
    queue: 'core',
    activities: (rec) =>
      core(rec, {
        sweepPublications: async () => ({ scheduledReemitted: 0, dispatchingExpired: 1 }),
      } satisfies PublicationSweepActivitiesV1),
    args: [],
    workflowId: 'publication-sweeper-replay-2',
    state: 'open',
  },
  {
    workflowType: 'tokenRefreshWorkflowV1',
    name: 'refreshed-continued-as-new',
    description: 'The token is past its margin: refreshed at once, then continue-as-new for the next expiry.',
    queue: 'core',
    activities: (rec) =>
      core(
        rec,
        tokenRefresh(() => ({ status: 'active', tokenExpiresAt: LONG_AGO }), {
          ok: true,
          tokenExpiresAt: null,
        }),
      ),
    args: [tokenInput],
    workflowId: 'token-refresh:cc_replay_1',
    state: 'continued_as_new',
  },
  {
    workflowType: 'tokenRefreshWorkflowV1',
    name: 'waiting-open',
    description: 'In flight: the token expires in two hours, the workflow sleeps until the margin.',
    queue: 'core',
    activities: (rec) =>
      core(
        rec,
        tokenRefresh(
          () => ({ status: 'active', tokenExpiresAt: new Date(Date.now() + 2 * 3_600_000).toISOString() }),
          {
            ok: true,
            tokenExpiresAt: null,
          },
        ),
      ),
    args: [{ ...tokenInput, channelConnectionId: 'cc_replay_2' }],
    workflowId: 'token-refresh:cc_replay_2',
    state: 'open',
  },
  {
    workflowType: 'tokenRefreshWorkflowV1',
    name: 'not-active',
    description: 'The connection was disconnected: nothing to refresh.',
    queue: 'core',
    activities: (rec) =>
      core(
        rec,
        tokenRefresh(() => ({ status: 'disabled', tokenExpiresAt: LONG_AGO }), {
          ok: true,
          tokenExpiresAt: null,
        }),
      ),
    args: [{ ...tokenInput, channelConnectionId: 'cc_replay_3' }],
    workflowId: 'token-refresh:cc_replay_3',
    state: 'completed',
  },
  {
    workflowType: 'tokenRefreshWorkflowV1',
    name: 'reconnect-needed',
    description: 'The refresh token is rejected: the run ends asking for a reconnect.',
    queue: 'core',
    activities: (rec) =>
      core(
        rec,
        tokenRefresh(() => ({ status: 'active', tokenExpiresAt: LONG_AGO }), {
          ok: false,
          reason: 'reconnect_required',
        }),
      ),
    args: [{ ...tokenInput, channelConnectionId: 'cc_replay_4' }],
    workflowId: 'token-refresh:cc_replay_4',
    state: 'completed',
  },
  {
    workflowType: 'tokenRefreshWorkflowV1',
    name: 'transient-retry-open',
    description: 'In flight: a transient refresh failure, the workflow waits on the two-minute retry timer.',
    queue: 'core',
    activities: (rec) =>
      core(
        rec,
        tokenRefresh(() => ({ status: 'refresh_needed', tokenExpiresAt: LONG_AGO }), {
          ok: false,
          reason: 'transient',
        }),
      ),
    args: [{ ...tokenInput, channelConnectionId: 'cc_replay_5' }],
    workflowId: 'token-refresh:cc_replay_5',
    state: 'open',
  },
];
