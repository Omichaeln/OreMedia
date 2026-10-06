import type { AgentRunState } from '@oremedia/contracts/agents';
import type { Tone } from '@oremedia/ui';
import type { InvocationDto, RunDto, StepDto } from './use-agent-runs';

export interface StateChip {
  tone: Tone;
  label: string;
}

/** Spec 12.2 states as the contract defines them; every chip carries a glyph and a label (spec 21.3). */
export const RUN_STATE_CHIP: Record<AgentRunState, StateChip> = {
  planned: { tone: 'info', label: 'Queued' },
  running: { tone: 'info', label: 'Running' },
  waiting_for_review: { tone: 'warning', label: 'Waiting for review' },
  completed: { tone: 'good', label: 'Completed' },
  failed: { tone: 'critical', label: 'Failed' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  budget_exhausted: { tone: 'critical', label: 'Budget exhausted' },
  policy_denied: { tone: 'critical', label: 'Policy denied' },
  waiting_expired: { tone: 'warning', label: 'Review expired' },
};

export const runStateChip = (state: AgentRunState): StateChip => RUN_STATE_CHIP[state];

const TERMINAL: ReadonlySet<AgentRunState> = new Set<AgentRunState>([
  'completed',
  'failed',
  'cancelled',
  'budget_exhausted',
  'policy_denied',
  'waiting_expired',
]);

export const isTerminalState = (state: AgentRunState): boolean => TERMINAL.has(state);

/** Spec 6.1: money is integer micro-units (USD micro-dollars); the UI never shows raw micros. */
export function formatMicros(micros: number, currency = 'USD', locale?: string): string {
  const amount = micros / 1_000_000;
  // Model and tool costs are usually fractions of a cent: below one unit the sub-cent digits are kept.
  const small = amount !== 0 && Math.abs(amount) < 1;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: small ? 4 : 2,
  }).format(amount);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

export const formatTokens = (n: number): string => new Intl.NumberFormat().format(n);

/** "4.1k", "38k", "900": a token figure as the interface's strip sets it, never a thousands-separated count. */
export function formatCompactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(Math.round(n / 100) / 10).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(n / 1000)}k`;
}

/** "12 min ago", "2 h ago", "Yesterday", "3 days ago": the interface's relative times, never a raw timestamp. */
export function relativeTime(iso: string, now = new Date()): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export const humanise = (key: string): string => key.replace(/_/g, ' ');

/**
 * What the run is for, as the interface titles a run: the brief's goal when the skill's schema has one (every
 * published copywriting and planning skill does), otherwise the task kind. Nothing is invented from reasoning.
 */
export function runTitle(run: Pick<RunDto, 'brief' | 'taskKind'>): string {
  const goal = run.brief['goal'];
  return typeof goal === 'string' && goal.trim() ? goal.trim() : humanise(run.taskKind);
}

/** The interface's figure strip: tool calls made, tokens spent, cost, all from the recorded steps (spec 12.7). */
export function runFigures(run: Pick<RunDto, 'costMicros'>, steps: readonly StepDto[]) {
  return {
    toolCalls: steps.reduce((n, s) => n + s.invocations.length, 0),
    tokens: steps.reduce((n, s) => n + s.tokensIn + s.tokensOut, 0),
    costMicros: run.costMicros,
  };
}

/** A step's dot: its worst invocation outcome; a step without invocations records what the model or validator did. */
export function stepTone(step: StepDto): Tone {
  const outcomes = step.invocations.map((i) => OUTCOME_TONE[i.outcome]);
  if (outcomes.includes('critical')) return 'critical';
  if (outcomes.includes('warning')) return 'warning';
  return 'good';
}

/** The interface's tool line, "tool → result": the invocation's name and its recorded output reference or denial. */
export function invocationLine(i: InvocationDto): string {
  if (i.policyDecision === 'denied' || i.outcome === 'denied')
    return `${i.toolName} → denied: ${i.policyReason ?? i.outputRef ?? 'no reason recorded'}`;
  if (i.outcome === 'proposal') return `${i.toolName} → proposal`;
  return i.outputRef ? `${i.toolName} → ${i.outputRef}` : i.toolName;
}

export const POLICY_DECISION_TONE: Record<InvocationDto['policyDecision'], Tone> = {
  allowed: 'good',
  denied: 'critical',
  invalid: 'warning',
};

export const OUTCOME_TONE: Record<InvocationDto['outcome'], Tone> = {
  ok: 'good',
  error: 'critical',
  denied: 'critical',
  invalid: 'warning',
  proposal: 'warning',
};

export const STEP_KIND_LABEL: Record<StepDto['kind'], string> = {
  plan: 'Plan',
  model_call: 'Model call',
  tool_call: 'Tool call',
  validation: 'Validation',
};

export interface AttentionItem {
  tone: Tone;
  title: string;
  detail: string;
}

/** The last recorded exception of a run: the newest invocation that errored, or the newest step summary. */
export function recordedException(steps: StepDto[]): string | null {
  const invocations = steps.flatMap((s) => s.invocations);
  const errored = [...invocations].reverse().find((i) => i.outcome === 'error');
  if (errored) return `${errored.toolName}: ${errored.outputRef ?? 'error'}`;
  const last = steps.at(-1);
  return last ? last.summary : null;
}

/**
 * Spec 21.2 "Agent activity" states: waiting, cancelled, budget exhausted, policy denied, recovery required. Every
 * exception and denial is surfaced here with its recorded reason; nothing is inferred from private reasoning.
 */
export function needsAttention(run: RunDto, steps: StepDto[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  const invocations = steps.flatMap((s) => s.invocations);
  const denied = invocations.filter((i) => i.policyDecision === 'denied' || i.outcome === 'denied');
  const invalid = invocations.filter((i) => i.policyDecision === 'invalid' || i.outcome === 'invalid');
  switch (run.state) {
    case 'waiting_for_review':
      items.push({
        tone: 'warning',
        title: 'Waiting for your decision',
        detail:
          'The agent proposed a change and cannot continue until a person accepts, modifies or rejects it. The wait expires after 72 hours.',
      });
      break;
    case 'budget_exhausted':
      items.push({
        tone: 'critical',
        title: 'Budget exhausted',
        detail: `The run stopped when it reached a budget limit (steps, tokens, cost or deadline) after spending ${formatMicros(run.costMicros)}. Raise the limit or start a smaller run.`,
      });
      break;
    case 'policy_denied': {
      const reason = denied.at(-1);
      items.push({
        tone: 'critical',
        title: 'Policy denied',
        detail: reason
          ? `The run ended because ${reason.toolName} was denied: ${reason.policyReason ?? reason.outputRef ?? 'no reason recorded'}.`
          : 'The run ended because an action was denied by policy; the recorded reason is in the timeline.',
      });
      break;
    }
    case 'cancelled':
      items.push({
        tone: 'neutral',
        title: 'Cancelled',
        detail:
          'A person cancelled this run. Its budget reservation was released; nothing further will happen.',
      });
      break;
    case 'failed': {
      const exception = recordedException(steps);
      items.push({
        tone: 'critical',
        title: 'Failed',
        detail: exception
          ? `Recorded exception: ${exception}`
          : 'The run failed before any step was recorded. Start it again or contact support with the run id.',
      });
      break;
    }
    case 'waiting_expired':
      items.push({
        tone: 'warning',
        title: 'Review expired',
        detail:
          'Nobody decided on the proposal within 72 hours, so the run ended. Start a new run to propose again.',
      });
      break;
    default:
      break;
  }
  for (const i of denied)
    if (run.state !== 'policy_denied' || i !== denied.at(-1))
      items.push({
        tone: 'critical',
        title: `Denied: ${i.toolName}`,
        detail: i.policyReason ?? i.outputRef ?? 'No reason recorded',
      });
  for (const i of invalid)
    items.push({
      tone: 'warning',
      title: `Invalid input: ${i.toolName}`,
      detail: 'The tool input failed schema validation and was returned to the model to correct.',
    });
  return items;
}

export interface PendingProposal {
  stepId: string;
  invocation: InvocationDto;
  payload: ProposalPayload;
}

/** The verbatim proposal payload the runtime stored (packages/ai creative.proposeOperations). */
export interface ProposalPayload {
  documentId: string;
  baseRevisionId: string;
  operations: unknown[];
  summary: string;
  findings: Array<{ severity: string; message: string }>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function proposalPayloadOf(value: unknown): ProposalPayload | null {
  if (!isRecord(value)) return null;
  if (typeof value['documentId'] !== 'string' || !Array.isArray(value['operations'])) return null;
  return {
    documentId: value['documentId'],
    baseRevisionId: typeof value['baseRevisionId'] === 'string' ? value['baseRevisionId'] : '',
    operations: value['operations'],
    summary: typeof value['summary'] === 'string' ? value['summary'] : '',
    findings: Array.isArray(value['findings'])
      ? value['findings'].filter(isRecord).map((f) => ({
          severity: String(f['severity'] ?? 'info'),
          message: String(f['message'] ?? ''),
        }))
      : [],
  };
}

/** The newest proposal awaiting a decision (the run is in waiting_for_review). */
export function pendingProposal(steps: StepDto[]): PendingProposal | null {
  for (const step of [...steps].reverse())
    for (const invocation of [...step.invocations].reverse())
      if (invocation.outcome === 'proposal' && invocation.proposal !== null) {
        const payload = proposalPayloadOf(invocation.proposal);
        if (payload) return { stepId: step.id, invocation, payload };
      }
  return null;
}

/** One proposed creative operation as the person reviews it: what it does, where, and the text it sets if any. */
export interface ReviewedOperation {
  /** Position in the proposal; stable while operations are removed and restored. */
  index: number;
  op: string;
  label: string;
  /** The element (or page) the operation targets, for the person to find it in the studio. */
  target: string;
  /** setText only: the text the person may edit in place. */
  text: string | null;
  kept: boolean;
}

const OPERATION_LABEL: Readonly<Record<string, string>> = {
  insertElement: 'Insert an element',
  removeElement: 'Remove an element',
  setText: 'Set the text',
  setStyle: 'Change the style',
  replaceAsset: 'Replace the asset',
  moveElement: 'Move an element',
  resizeElement: 'Resize an element',
  reorderElement: 'Reorder an element',
  setCrop: 'Crop an element',
  applyTemplate: 'Apply a template',
  addPage: 'Add a page',
  createFormatVariant: 'Create a format variant',
  setLock: 'Lock or unlock an element',
  setVisibility: 'Show or hide an element',
  groupElements: 'Group elements',
  ungroupElement: 'Ungroup a group',
  setRotation: 'Rotate an element',
  setMask: 'Mask an image',
  removePage: 'Remove a page',
  duplicatePage: 'Duplicate a page',
  reorderPage: 'Reorder a page',
  setPageLock: 'Lock or unlock a page',
  alignElements: 'Align elements',
  distributeElements: 'Distribute elements',
};

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The proposal's operations as review rows (spec 11.3 operation contract), all kept until the person removes one. */
export function reviewedOperations(operations: readonly unknown[]): ReviewedOperation[] {
  return operations.map((raw, index) => {
    const o = isRecord(raw) ? raw : {};
    const op = str(o['op']) ?? 'unknown';
    const element = str(o['elementId']);
    const page = str(o['pageId']) ?? str(o['sourcePageId']);
    const target = element
      ? `element ${element}${page ? ` on page ${page}` : ''}`
      : page
        ? `page ${page}`
        : 'the document';
    return {
      index,
      op,
      label: OPERATION_LABEL[op] ?? `Operation ${op}`,
      target,
      text: op === 'setText' ? (str(o['text']) ?? '') : null,
      kept: true,
    };
  });
}

/**
 * The batch Modify applies in place of the proposal: the kept operations in their proposed order, each setText
 * carrying the person's edited text, under the person's summary. `origin` is set by the server, never here.
 */
export function modifyBatchOf(
  p: ProposalPayload,
  rows: readonly ReviewedOperation[],
  summary: string,
): { documentId: string; baseRevisionId: string; operations: unknown[]; summary: string } {
  const operations = rows
    .filter((r) => r.kept)
    .map((r) => {
      const raw = p.operations[r.index];
      return r.text !== null && isRecord(raw) ? { ...raw, text: r.text } : raw;
    });
  return { documentId: p.documentId, baseRevisionId: p.baseRevisionId, operations, summary };
}
