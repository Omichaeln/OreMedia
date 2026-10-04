import { describe, expect, it } from 'vitest';
import { IllegalTransitionError } from './machine';
import { publicationMachine, type PublicationEvent } from './publication';
import { contentRevisionMachine } from './content-revision';
import { renderJobMachine } from './render-job';
import { videoAiJobMachine } from './video-ai-job';
import { agentRunMachine } from './agent-run';
import { approvalMachine } from './approval';
import { brandVersionMachine } from './brand-version';
import { approvedFactMachine } from './approved-fact';
import { policyVersionMachine } from './policy-version';
import { reviewRequestMachine } from './review-request';

/** Spec 13.1: the publication transition table, exhaustively. */
const PUBLICATION_TABLE: Array<[string, PublicationEvent, string]> = [
  ['scheduled', 'claim', 'dispatching'],
  ['scheduled', 'user_cancel', 'cancelled'],
  ['scheduled', 'dependency_revoked', 'held'],
  ['dispatching', 'release_policy_failed', 'held'],
  ['dispatching', 'provider_accepted', 'published'],
  ['dispatching', 'provider_pending', 'processing'],
  ['dispatching', 'provider_rejected', 'failed'],
  ['dispatching', 'ambiguous_failure', 'outcome_unknown'],
  ['dispatching', 'retryable_pre_send', 'scheduled'],
  ['processing', 'poll_published', 'published'],
  ['processing', 'poll_failed', 'failed'],
  ['processing', 'poll_unknown', 'outcome_unknown'],
  ['outcome_unknown', 'reconcile_found', 'published'],
  ['outcome_unknown', 'reconcile_absent', 'retry_eligible'],
  ['outcome_unknown', 'reconcile_exhausted', 'held'],
  ['retry_eligible', 'reschedule', 'scheduled'],
  ['held', 'hold_resolved_schedule', 'scheduled'],
  ['held', 'hold_resolved_cancel', 'cancelled'],
  // Spec 17.6 restore rule: only the in-flight states that can still be unsent; never a terminal or a hold-resolving one.
  ['scheduled', 'restored_from_backup', 'held'],
  ['dispatching', 'restored_from_backup', 'held'],
  // publication.delete_remote carried out on the platform (the only way out of published).
  ['published', 'remote_deleted', 'removed'],
];

describe('publication state machine', () => {
  it.each(PUBLICATION_TABLE)('%s --%s--> %s', (from, event, to) => {
    expect(publicationMachine.transition(from as never, event)).toBe(to);
  });
  it('rejects every transition not in the table', () => {
    const allowed = new Set(PUBLICATION_TABLE.map(([f, e]) => `${f}:${e}`));
    let rejected = 0;
    for (const s of publicationMachine.states) {
      for (const e of publicationMachine.events) {
        if (allowed.has(`${s}:${e}`)) continue;
        expect(() => publicationMachine.transition(s, e)).toThrow(IllegalTransitionError);
        rejected++;
      }
    }
    expect(rejected).toBe(
      publicationMachine.states.length * publicationMachine.events.length - PUBLICATION_TABLE.length,
    );
  });
  it('failed, cancelled and removed are terminal; published leaves only by a remote deletion', () => {
    for (const s of ['failed', 'cancelled', 'removed'] as const) {
      for (const e of publicationMachine.events) expect(publicationMachine.can(s, e)).toBe(false);
    }
    expect(publicationMachine.terminal).toEqual(['failed', 'cancelled', 'removed']);
    expect(publicationMachine.events.filter((e) => publicationMachine.can('published', e))).toEqual([
      'remote_deleted',
    ]);
  });
  it('the restore hold applies only to scheduled and dispatching (spec 17.6); a sent row goes to reconciliation', () => {
    const from = publicationMachine.states.filter((s) => publicationMachine.can(s, 'restored_from_backup'));
    expect(from.sort()).toEqual(['dispatching', 'scheduled']);
    // processing was always sent: it can only go to outcome_unknown (spec 14.3), never to held and later a re-send.
    // outcome_unknown and retry_eligible already wait for reconciliation or a person; held stays held.
    for (const s of ['processing', 'outcome_unknown', 'retry_eligible', 'held'] as const)
      expect(publicationMachine.can(s, 'restored_from_backup')).toBe(false);
    // The moves a restored, possibly-live row takes are the existing 13.1 ones, and held never reaches published.
    expect(publicationMachine.transition('dispatching', 'ambiguous_failure')).toBe('outcome_unknown');
    expect(publicationMachine.transition('processing', 'poll_unknown')).toBe('outcome_unknown');
    expect(publicationMachine.events.filter((e) => publicationMachine.can('held', e)).sort()).toEqual([
      'hold_resolved_cancel',
      'hold_resolved_schedule',
    ]);
  });
  it('outcome_unknown never transitions by a retry event', () => {
    expect(publicationMachine.can('outcome_unknown', 'retryable_pre_send')).toBe(false);
    expect(publicationMachine.can('outcome_unknown', 'reschedule')).toBe(false);
  });
});

describe('other machines', () => {
  it('content revision: draft → in_review → approved → superseded; approved cannot be edited back', () => {
    expect(contentRevisionMachine.transition('draft', 'request_review')).toBe('in_review');
    expect(contentRevisionMachine.transition('in_review', 'approve')).toBe('approved');
    expect(contentRevisionMachine.transition('approved', 'supersede')).toBe('superseded');
    expect(contentRevisionMachine.can('approved', 'reopen')).toBe(false);
    expect(contentRevisionMachine.can('approved', 'request_review')).toBe(false);
  });
  it('render job: pending → rendering → ready | failed → retry', () => {
    expect(renderJobMachine.transition('pending', 'start')).toBe('rendering');
    expect(renderJobMachine.transition('rendering', 'fail')).toBe('failed');
    expect(renderJobMachine.transition('failed', 'retry')).toBe('pending');
    expect(renderJobMachine.can('ready', 'retry')).toBe(false);
  });
  it('render job (STU-2a): pending or rendering jobs can be cancelled; cancelled and ready are final', () => {
    expect(renderJobMachine.transition('pending', 'cancel')).toBe('cancelled');
    expect(renderJobMachine.transition('rendering', 'cancel')).toBe('cancelled');
    expect(renderJobMachine.can('ready', 'cancel')).toBe(false);
    expect(renderJobMachine.can('failed', 'cancel')).toBe(false);
    for (const e of renderJobMachine.events) expect(renderJobMachine.can('cancelled', e)).toBe(false);
  });
  it('studio video job (STU-3): saving cannot be cancelled, failed and cancelled jobs retry, completed is final', () => {
    expect(videoAiJobMachine.transition('queued', 'start')).toBe('generating');
    expect(videoAiJobMachine.transition('generating', 'validate')).toBe('validating');
    expect(videoAiJobMachine.transition('validating', 'save')).toBe('saving');
    expect(videoAiJobMachine.transition('saving', 'complete')).toBe('completed');
    expect(videoAiJobMachine.can('saving', 'cancel')).toBe(false);
    expect(videoAiJobMachine.transition('cancelled', 'retry')).toBe('queued');
    expect(videoAiJobMachine.transition('failed', 'retry')).toBe('queued');
    for (const e of videoAiJobMachine.events) expect(videoAiJobMachine.can('completed', e)).toBe(false);
  });
  it('agent run: waiting_for_review expires or resumes; terminal states are final', () => {
    expect(agentRunMachine.transition('running', 'await_review')).toBe('waiting_for_review');
    expect(agentRunMachine.transition('waiting_for_review', 'waiting_expired')).toBe('waiting_expired');
    expect(agentRunMachine.transition('waiting_for_review', 'review_decided')).toBe('running');
    for (const s of agentRunMachine.terminal)
      for (const e of agentRunMachine.events) expect(agentRunMachine.can(s, e)).toBe(false);
  });
  it('approval: valid → consumed | invalidated | expired, never back', () => {
    expect(approvalMachine.transition('valid', 'invalidate')).toBe('invalidated');
    expect(approvalMachine.can('invalidated', 'consume')).toBe(false);
    expect(approvalMachine.can('consumed', 'invalidate')).toBe(false);
  });
  it('brand version: exactly the spec lifecycle', () => {
    expect(brandVersionMachine.transition('draft', 'submit')).toBe('in_review');
    expect(brandVersionMachine.transition('in_review', 'publish')).toBe('published');
    expect(brandVersionMachine.transition('published', 'retire')).toBe('retired');
    expect(brandVersionMachine.can('published', 'submit')).toBe(false);
    expect(brandVersionMachine.can('draft', 'publish')).toBe(false);
    expect(() => brandVersionMachine.transition('retired', 'submit')).toThrow(IllegalTransitionError);
  });
  it('approved fact: proposed → approved → revoked; a proposal can be withdrawn; revoked is final', () => {
    expect(approvedFactMachine.transition('proposed', 'approve')).toBe('approved');
    expect(approvedFactMachine.transition('approved', 'revoke')).toBe('revoked');
    expect(approvedFactMachine.transition('proposed', 'revoke')).toBe('revoked');
    expect(approvedFactMachine.can('approved', 'approve')).toBe(false);
    for (const e of approvedFactMachine.events) expect(approvedFactMachine.can('revoked', e)).toBe(false);
  });
  it('approved fact (BSC-3): a correction or a merge supersedes a proposed or approved fact; superseded is final', () => {
    expect(approvedFactMachine.transition('approved', 'supersede')).toBe('superseded');
    expect(approvedFactMachine.transition('proposed', 'supersede')).toBe('superseded');
    expect(approvedFactMachine.can('revoked', 'supersede')).toBe(false);
    expect(approvedFactMachine.terminal).toEqual(['revoked', 'superseded']);
    for (const e of approvedFactMachine.events) expect(approvedFactMachine.can('superseded', e)).toBe(false);
    expect(() => approvedFactMachine.transition('superseded', 'approve')).toThrow(IllegalTransitionError);
  });
  it('policy version: draft → active → retired; a retired policy never re-activates', () => {
    expect(policyVersionMachine.transition('draft', 'activate')).toBe('active');
    expect(policyVersionMachine.transition('active', 'retire')).toBe('retired');
    expect(policyVersionMachine.transition('draft', 'retire')).toBe('retired');
    expect(policyVersionMachine.can('active', 'activate')).toBe(false);
    for (const e of policyVersionMachine.events) expect(policyVersionMachine.can('retired', e)).toBe(false);
  });
  it('review request: open → stale on package change; stale cannot be decided', () => {
    expect(reviewRequestMachine.transition('open', 'package_changed')).toBe('stale');
    expect(reviewRequestMachine.can('stale', 'decide')).toBe(false);
  });
});
