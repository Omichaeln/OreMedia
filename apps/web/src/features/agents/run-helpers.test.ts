import { describe, expect, it } from 'vitest';
import { AgentRunState } from '@oremedia/contracts/agents';
import {
  formatCompactTokens,
  formatDuration,
  formatMicros,
  invocationLine,
  isTerminalState,
  modifyBatchOf,
  needsAttention,
  reviewedOperations,
  pendingProposal,
  proposalPayloadOf,
  recordedException,
  relativeTime,
  runFigures,
  runStateChip,
  runTitle,
  stepTone,
} from './run-helpers';
import type { RunDto, StepDto } from './use-agent-runs';

const run = (state: RunDto['state'], costMicros = 0): RunDto => ({
  id: 'run_1',
  brandId: 'brd_1',
  state,
  taskKind: 'copywriting',
  autonomyMode: 'create',
  servicePrincipalId: 'sp_1',
  initiatorKind: 'user',
  initiatorId: 'usr_1',
  brief: {},
  contextSnapshotHash: null,
  skillVersionIds: [],
  modelConfig: { provider: 'anthropic', model: 'm' },
  budgetReservationId: null,
  costMicros,
  deadlineAt: '2026-01-01T00:00:00.000Z',
  workflowId: 'run:run_1',
  correlationId: 'c',
  finishedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 0,
});

const invocation = (over: Partial<StepDto['invocations'][number]>): StepDto['invocations'][number] => ({
  id: 'ti_1',
  toolName: 'facts.list',
  inputHash: 'a'.repeat(64),
  inputRedacted: {},
  policyDecision: 'allowed',
  policyReason: null,
  outcome: 'ok',
  outputRef: 'ok',
  proposal: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const step = (over: Partial<StepDto>): StepDto => ({
  id: 'st_1',
  index: 0,
  kind: 'tool_call',
  summary: 'a step',
  tokensIn: 0,
  tokensOut: 0,
  costMicros: 0,
  durationMs: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  invocations: [],
  ...over,
});

describe('run state chips', () => {
  it('every contract state has a chip with a label and a tone (never colour alone)', () => {
    for (const state of AgentRunState.options) {
      const chip = runStateChip(state);
      expect(chip.label.length).toBeGreaterThan(0);
      expect(['neutral', 'good', 'warning', 'critical', 'info']).toContain(chip.tone);
    }
    expect(runStateChip('planned')).toEqual({ tone: 'info', label: 'Queued' });
    expect(runStateChip('waiting_for_review').tone).toBe('warning');
    expect(runStateChip('budget_exhausted').tone).toBe('critical');
    expect(runStateChip('policy_denied').tone).toBe('critical');
    expect(runStateChip('cancelled').tone).toBe('neutral');
  });
  it('terminal states are the six finish states', () => {
    expect(AgentRunState.options.filter(isTerminalState)).toEqual([
      'completed',
      'failed',
      'cancelled',
      'budget_exhausted',
      'policy_denied',
      'waiting_expired',
    ]);
  });
});

describe('money and time', () => {
  it('converts micros to currency and never shows raw micros', () => {
    expect(formatMicros(0, 'USD', 'en-US')).toBe('$0.00');
    expect(formatMicros(1_500_000, 'USD', 'en-US')).toBe('$1.50');
    expect(formatMicros(12_340_000, 'USD', 'en-US')).toBe('$12.34');
    expect(formatMicros(1500, 'USD', 'en-US')).toBe('$0.0015'); // sub-cent costs keep their precision
    expect(formatMicros(12_340, 'USD', 'en-US')).toBe('$0.0123');
    expect(formatMicros(9_990, 'USD', 'en-US')).toBe('$0.01');
    expect(formatMicros(999_990, 'USD', 'en-US')).toBe('$1.00');
    expect(formatMicros(2_500, 'EUR', 'en-US')).toBe('€0.0025');
  });
  it('formats durations for reading', () => {
    expect(formatDuration(420)).toBe('420 ms');
    expect(formatDuration(2_300)).toBe('2.3 s');
    expect(formatDuration(42_000)).toBe('42 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
  });
});

describe('needs attention', () => {
  it('waiting, cancelled, budget exhausted, policy denied and expired each have a named item', () => {
    expect(needsAttention(run('waiting_for_review'), [])[0]?.title).toBe('Waiting for your decision');
    expect(needsAttention(run('cancelled'), [])[0]?.tone).toBe('neutral');
    const budget = needsAttention(run('budget_exhausted', 2_500_000), [])[0];
    expect(budget?.title).toBe('Budget exhausted');
    expect(budget?.detail).toContain('$2.50');
    expect(needsAttention(run('waiting_expired'), [])[0]?.title).toBe('Review expired');
    expect(needsAttention(run('completed'), [])).toEqual([]);
  });
  it('policy denied names the denied tool and its recorded reason once', () => {
    const steps = [
      step({
        invocations: [
          invocation({
            toolName: 'publications.proposeSchedule',
            policyDecision: 'denied',
            outcome: 'denied',
            policyReason: 'autonomy_below_prepare_release',
            outputRef: 'autonomy_below_prepare_release',
          }),
        ],
      }),
    ];
    const items = needsAttention(run('policy_denied'), steps);
    expect(items).toHaveLength(1);
    expect(items[0]?.detail).toContain('publications.proposeSchedule');
    expect(items[0]?.detail).toContain('autonomy_below_prepare_release');
  });
  it('failed surfaces the recorded exception; other denials and invalid inputs are listed too', () => {
    const steps = [
      step({
        id: 'st_1',
        invocations: [invocation({ id: 'ti_1', policyDecision: 'invalid', outcome: 'invalid' })],
      }),
      step({
        id: 'st_2',
        index: 1,
        invocations: [
          invocation({
            id: 'ti_2',
            toolName: 'images.generate',
            outcome: 'error',
            outputRef: 'provider_unavailable',
          }),
        ],
      }),
    ];
    expect(recordedException(steps)).toBe('images.generate: provider_unavailable');
    const items = needsAttention(run('failed'), steps);
    expect(items[0]).toMatchObject({ tone: 'critical', title: 'Failed' });
    expect(items[0]?.detail).toContain('images.generate: provider_unavailable');
    expect(items.some((i) => i.title === 'Invalid input: facts.list')).toBe(true);
    expect(recordedException([step({ summary: 'context_changed' })])).toBe('context_changed');
    expect(recordedException([])).toBeNull();
  });
});

describe('proposals', () => {
  const payload = {
    documentId: 'doc_1',
    baseRevisionId: 'rev_1',
    operations: [{ op: 'setText', pageId: 'p', elementId: 'e', text: 't' }],
    summary: 'Tighten the headline',
    contentHash: 'h',
    findings: [{ code: 'x', severity: 'warning', message: 'long headline' }],
  };
  it('takes the newest proposal invocation of the run, verbatim', () => {
    const steps = [
      step({
        id: 'st_1',
        invocations: [
          invocation({ id: 'ti_1', outcome: 'proposal', proposal: { ...payload, summary: 'older' } }),
        ],
      }),
      step({
        id: 'st_2',
        index: 1,
        invocations: [invocation({ id: 'ti_2', outcome: 'proposal', proposal: payload })],
      }),
    ];
    const p = pendingProposal(steps);
    expect(p?.stepId).toBe('st_2');
    expect(p?.payload.summary).toBe('Tighten the headline');
    expect(p?.payload.findings).toEqual([{ severity: 'warning', message: 'long headline' }]);
    expect(pendingProposal([step({})])).toBeNull();
    expect(proposalPayloadOf({ documentId: 'd' })).toBeNull();
    expect(proposalPayloadOf('nope')).toBeNull();
  });
  it('the modify batch is what the server validates (origin is added by the server)', () => {
    const p = proposalPayloadOf(payload);
    expect(p).not.toBeNull();
    const rows = reviewedOperations(p!.operations);
    const batch = modifyBatchOf(p!, rows, 'Edited by me');
    expect(Object.keys(batch).sort()).toEqual(['baseRevisionId', 'documentId', 'operations', 'summary']);
    expect(batch.documentId).toBe('doc_1');
    expect(batch.summary).toBe('Edited by me');
  });

  it('Modify reviews the operations as rows: a removed one is left out, an edited text replaces the proposed one', () => {
    const operations = [
      { op: 'setText', pageId: 'page_1', elementId: 'el_h', text: 'Proposed' },
      { op: 'moveElement', pageId: 'page_1', elementId: 'el_h', x: 1, y: 2 },
      { op: 'addPage', page: { id: 'page_2' } },
    ];
    const rows = reviewedOperations(operations);
    expect(rows.map((r) => [r.label, r.target, r.text])).toEqual([
      ['Set the text', 'element el_h on page page_1', 'Proposed'],
      ['Move an element', 'element el_h on page page_1', null],
      ['Add a page', 'the document', null],
    ]);
    const p = { documentId: 'doc_1', baseRevisionId: 'rev_1', operations, summary: 's', findings: [] };
    const edited = rows.map((r) =>
      r.index === 0 ? { ...r, text: 'Mine' } : r.index === 1 ? { ...r, kept: false } : r,
    );
    expect(modifyBatchOf(p, edited, 'Mine').operations).toEqual([
      { op: 'setText', pageId: 'page_1', elementId: 'el_h', text: 'Mine' },
      { op: 'addPage', page: { id: 'page_2' } },
    ]);
  });
});

describe('the interface’s run rows and figures', () => {
  it('titles a run by its brief’s goal, or by the task kind when the skill’s brief has none', () => {
    expect(runTitle({ ...run('running'), brief: { goal: ' Draft 3 caption variants ' } })).toBe(
      'Draft 3 caption variants',
    );
    expect(runTitle({ ...run('running'), brief: { goal: '' } })).toBe('copywriting');
    expect(runTitle({ ...run('running'), taskKind: 'campaign_planning', brief: { goal: 42 } })).toBe(
      'campaign planning',
    );
  });

  it('says when a run started in the interface’s words, never a raw timestamp', () => {
    const now = new Date('2026-10-05T12:00:00.000Z');
    expect(relativeTime('2026-10-05T11:59:40.000Z', now)).toBe('Just now');
    expect(relativeTime('2026-10-05T11:48:00.000Z', now)).toBe('12 min ago');
    expect(relativeTime('2026-10-05T10:00:00.000Z', now)).toBe('2 h ago');
    expect(relativeTime('2026-10-04T12:00:00.000Z', now)).toBe('Yesterday');
    expect(relativeTime('2026-10-02T12:00:00.000Z', now)).toBe('3 days ago');
  });

  it('counts tool calls and tokens from the recorded steps and formats tokens compactly', () => {
    const steps = [
      step({ tokensIn: 1200, tokensOut: 300 }),
      step({ id: 'st_2', invocations: [invocation({}), invocation({ id: 'ti_2' })] }),
      step({ id: 'st_3', tokensIn: 1400, tokensOut: 250, invocations: [invocation({ id: 'ti_3' })] }),
    ];
    expect(runFigures(run('running', 140_000), steps)).toEqual({
      toolCalls: 3,
      tokens: 3150,
      costMicros: 140_000,
    });
    expect(formatCompactTokens(900)).toBe('900');
    expect(formatCompactTokens(3150)).toBe('3.2k');
    expect(formatCompactTokens(4000)).toBe('4k');
    expect(formatCompactTokens(38_400)).toBe('38k');
  });

  it('a step’s dot is its worst invocation outcome; a step without calls is what the model or validator did', () => {
    expect(stepTone(step({ kind: 'model_call' }))).toBe('good');
    expect(stepTone(step({ invocations: [invocation({})] }))).toBe('good');
    expect(stepTone(step({ invocations: [invocation({ outcome: 'proposal' })] }))).toBe('warning');
    expect(
      stepTone(
        step({ invocations: [invocation({ outcome: 'proposal' }), invocation({ outcome: 'error' })] }),
      ),
    ).toBe('critical');
  });

  it('writes the tool line as "tool → result", naming a denial’s recorded reason', () => {
    expect(invocationLine(invocation({ outputRef: 'sn_9f3a' }))).toBe('facts.list → sn_9f3a');
    expect(invocationLine(invocation({ outputRef: null }))).toBe('facts.list');
    expect(invocationLine(invocation({ outcome: 'proposal', outputRef: 'proposal:st_x' }))).toBe(
      'facts.list → proposal',
    );
    expect(
      invocationLine(
        invocation({
          toolName: 'publications.schedule',
          policyDecision: 'denied',
          policyReason: 'autonomy_below_prepare_release',
          outcome: 'denied',
        }),
      ),
    ).toBe('publications.schedule → denied: autonomy_below_prepare_release');
  });
});
