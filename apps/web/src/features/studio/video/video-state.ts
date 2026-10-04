import type { Finding } from '@oremedia/contracts/creative';
import type { VideoMediaInfo, VideoOperation, VideoProjectV1 } from '@oremedia/contracts/video';
import { applyVideoBatch, type VideoRebaseConflict } from '@oremedia/editor';
import type { UiError } from '../../../lib/errors';
import type { SaveStatus } from '../types';

/**
 * The timeline studio's state as a pure machine, the video counterpart of studio-reducer.ts (spec 21.4): the
 * preview and timeline render the committed revision plus the local pending batch; the batch is flushed on idle
 * (autosave) or on request; STALE_REVISION leads to a rebase or a conflict; undo and redo commit inverse batches as
 * new revisions. Everything asynchronous lives in use-video-studio.ts and only dispatches here.
 */
export interface VideoCommitted {
  revisionId: string;
  number: number;
  snapshot: VideoProjectV1;
  contentHash: string;
}

export interface VideoIntent {
  operations: VideoOperation[];
  summary: string;
}

export interface VideoPending extends VideoIntent {
  key: string;
}

export type VideoCommitMode = 'autosave' | 'undo' | 'redo' | 'restore';

export interface VideoInFlight extends VideoPending {
  baseRevisionId: string;
  before: VideoProjectV1;
  mode: VideoCommitMode;
}

export interface VideoHistoryEntry {
  before: VideoProjectV1;
  operations: VideoOperation[];
  summary: string;
}

export interface VideoSelection {
  trackId: string;
  itemId: string;
}

export interface VideoStudioState {
  committed: VideoCommitted;
  pending: VideoPending | null;
  inFlight: VideoInFlight | null;
  save: SaveStatus;
  conflict: { head: VideoCommitted; localOps: VideoOperation[]; conflicts: VideoRebaseConflict[] } | null;
  undo: VideoHistoryEntry[];
  redo: VideoHistoryEntry[];
  findings: Finding[];
  /** What is known about each source (from the document read, the library, and each save). */
  media: Record<string, VideoMediaInfo>;
  selection: VideoSelection | null;
  playheadMs: number;
  notice: { tone: 'warning' | 'critical' | 'info'; text: string } | null;
}

export type VideoStudioAction =
  | { type: 'intent'; intent: VideoIntent; key: string }
  | { type: 'commit:start'; mode: 'autosave' }
  | {
      type: 'commit:start';
      mode: 'undo' | 'redo' | 'restore';
      operations: VideoOperation[];
      summary: string;
      key: string;
    }
  | { type: 'commit:success'; revision: VideoCommitted; findings: Finding[]; media: VideoMediaInfo[] }
  /**
   * STU-3: a revision the server wrote for this person (an assembled storyboard, an accepted AI proposal). It becomes
   * the head and an undo entry (what it applied, to the head it replaced), exactly like a commit of theirs.
   */
  | {
      type: 'commit:external';
      revision: VideoCommitted;
      operations: VideoOperation[];
      summary: string;
      findings: Finding[];
      media: VideoMediaInfo[];
    }
  | { type: 'commit:failed'; error: UiError; key: string }
  | { type: 'commit:stale' }
  | { type: 'rebase:applied'; head: VideoCommitted; operations: VideoOperation[]; key: string }
  | {
      type: 'rebase:conflict';
      head: VideoCommitted;
      localOps: VideoOperation[];
      conflicts: VideoRebaseConflict[];
    }
  | { type: 'conflict:keep-server' }
  | { type: 'conflict:keep-mine'; key: string }
  | { type: 'head:refresh'; head: VideoCommitted; media: VideoMediaInfo[] }
  | { type: 'media'; media: VideoMediaInfo[] }
  | { type: 'select'; selection: VideoSelection | null }
  | { type: 'playhead'; ms: number }
  | { type: 'notice'; notice: VideoStudioState['notice'] };

export function initialVideoState(committed: VideoCommitted, media: VideoMediaInfo[]): VideoStudioState {
  return {
    committed,
    pending: null,
    inFlight: null,
    save: { kind: 'saved', at: Date.now() },
    conflict: null,
    undo: [],
    redo: [],
    findings: [],
    media: Object.fromEntries(media.map((m) => [m.assetVersionId, m])),
    selection: null,
    playheadMs: 0,
    notice: null,
  };
}

/**
 * Consecutive edits of the same kind on the same item collapse into one (a drag stays one moveClip, typing a
 * caption one upsertCaption), so a pending batch stays small and its summary readable.
 */
export function coalesceVideo(operations: VideoOperation[], next: VideoOperation): VideoOperation[] {
  const last = operations[operations.length - 1];
  const itemOf = (op: VideoOperation): string | null =>
    op.op === 'upsertCaption'
      ? op.caption.id
      : op.op === 'setOverlay'
        ? op.overlay.id
        : 'itemId' in op
          ? op.itemId
          : null;
  const SAME = new Set([
    'moveClip',
    'trimClip',
    'setClipFrame',
    'upsertCaption',
    'setOverlay',
    'setTransition',
  ]);
  if (
    last &&
    last.op === next.op &&
    SAME.has(next.op) &&
    itemOf(last) !== null &&
    itemOf(last) === itemOf(next)
  ) {
    // A ripple edit changes other items; only plain repeats collapse.
    const ripple = (op: VideoOperation) => 'ripple' in op && op.ripple === true;
    if (!ripple(last) && !ripple(next)) return [...operations.slice(0, -1), next];
  }
  if (last && last.op === 'setAudio' && next.op === 'setAudio' && last.itemId === next.itemId)
    return [...operations.slice(0, -1), { ...last, ...next }];
  return [...operations, next];
}

const joinSummary = (a: string | undefined, b: string): string => {
  if (!a) return b;
  if (a === b || a.endsWith(b)) return a;
  const next = `${a}; ${b}`;
  return next.length > 500 ? next.slice(next.length - 500) : next;
};

export const hasLocalVideoWork = (s: VideoStudioState): boolean =>
  s.pending !== null || s.inFlight !== null || s.conflict !== null;

/** The project the editor shows: committed, then in-flight, then pending operations (with what it knows of sources). */
export function localProject(s: VideoStudioState): { project: VideoProjectV1; error: string | null } {
  const ops = [...(s.inFlight?.operations ?? []), ...(s.pending?.operations ?? [])];
  if (!ops.length) return { project: s.committed.snapshot, error: null };
  try {
    return {
      project: applyVideoBatch(s.committed.snapshot, { operations: ops }, { media: s.media }),
      error: null,
    };
  } catch (err) {
    return { project: s.committed.snapshot, error: err instanceof Error ? err.message : String(err) };
  }
}

const restStatus = (s: VideoStudioState): SaveStatus =>
  s.pending ? { kind: 'pending' } : { kind: 'saved', at: Date.now() };

export function videoStudioReducer(s: VideoStudioState, a: VideoStudioAction): VideoStudioState {
  switch (a.type) {
    case 'intent': {
      const operations = a.intent.operations.reduce(coalesceVideo, s.pending?.operations ?? []);
      const pending = { operations, summary: joinSummary(s.pending?.summary, a.intent.summary), key: a.key };
      return { ...s, pending, save: s.inFlight ? s.save : { kind: 'pending' }, notice: null };
    }
    case 'commit:start': {
      if (a.mode === 'autosave') {
        if (!s.pending) return s;
        return {
          ...s,
          inFlight: {
            ...s.pending,
            baseRevisionId: s.committed.revisionId,
            before: s.committed.snapshot,
            mode: 'autosave',
          },
          pending: null,
          save: { kind: 'saving' },
        };
      }
      return {
        ...s,
        inFlight: {
          operations: a.operations,
          summary: a.summary,
          key: a.key,
          baseRevisionId: s.committed.revisionId,
          before: s.committed.snapshot,
          mode: a.mode,
        },
        save: { kind: 'saving' },
      };
    }
    case 'commit:success': {
      const f = s.inFlight;
      const entry: VideoHistoryEntry | null = f
        ? { before: f.before, operations: f.operations, summary: f.summary }
        : null;
      const media = { ...s.media, ...Object.fromEntries(a.media.map((m) => [m.assetVersionId, m])) };
      const base = { ...s, committed: a.revision, inFlight: null, findings: a.findings, media };
      if (!f || !entry) return { ...base, save: restStatus(base) };
      // An entry is what was applied and the project it was applied to: undo commits its inverse (and that commit
      // becomes the redo entry), redo commits the inverse of the undo (and becomes an undo entry again).
      const next =
        f.mode === 'undo'
          ? { ...base, undo: s.undo.slice(0, -1), redo: [...s.redo, entry] }
          : f.mode === 'redo'
            ? { ...base, undo: [...s.undo, entry], redo: s.redo.slice(0, -1) }
            : { ...base, undo: [...s.undo, entry], redo: [] };
      return { ...next, save: restStatus(next) };
    }
    case 'commit:external': {
      if (hasLocalVideoWork(s)) return s; // the panels only offer it with nothing unsaved
      const entry: VideoHistoryEntry = {
        before: s.committed.snapshot,
        operations: a.operations,
        summary: a.summary,
      };
      return {
        ...s,
        committed: a.revision,
        findings: a.findings,
        media: { ...s.media, ...Object.fromEntries(a.media.map((m) => [m.assetVersionId, m])) },
        undo: [...s.undo, entry],
        redo: [],
        save: { kind: 'saved', at: Date.now() },
      };
    }
    case 'commit:failed': {
      // An autosave's operations go back in front of anything queued since, with a fresh idempotency key.
      const f = s.inFlight;
      const pending =
        f && f.mode === 'autosave'
          ? {
              operations: [...f.operations, ...(s.pending?.operations ?? [])],
              summary: joinSummary(f.summary, s.pending?.summary ?? ''),
              key: a.key,
            }
          : s.pending;
      return { ...s, inFlight: null, pending, save: { kind: 'failed', error: a.error } };
    }
    case 'commit:stale':
      return { ...s, save: { kind: 'rebasing' } };
    case 'rebase:applied': {
      const f = s.inFlight;
      const pending = {
        operations: [...a.operations, ...(s.pending?.operations ?? [])],
        summary: joinSummary(f?.summary, s.pending?.summary ?? ''),
        key: a.key,
      };
      return {
        ...s,
        committed: a.head,
        inFlight: null,
        pending,
        save: { kind: 'pending' },
        undo: [],
        redo: [],
      };
    }
    case 'rebase:conflict':
      return {
        ...s,
        conflict: { head: a.head, localOps: a.localOps, conflicts: a.conflicts },
        inFlight: null,
        save: { kind: 'conflict' },
      };
    case 'conflict:keep-server': {
      if (!s.conflict) return s;
      return {
        ...s,
        committed: s.conflict.head,
        conflict: null,
        pending: null,
        save: { kind: 'saved', at: Date.now() },
        undo: [],
        redo: [],
      };
    }
    case 'conflict:keep-mine': {
      if (!s.conflict) return s;
      // Each local operation the head can still take is kept (in order); the rest are dropped and named.
      const kept: VideoOperation[] = [];
      const dropped: string[] = [];
      let project = s.conflict.head.snapshot;
      for (const op of s.conflict.localOps) {
        try {
          project = applyVideoBatch(project, { operations: [op] }, { media: s.media });
          kept.push(op);
        } catch (err) {
          dropped.push(err instanceof Error ? err.message : op.op);
        }
      }
      return {
        ...s,
        committed: s.conflict.head,
        conflict: null,
        pending: kept.length ? { operations: kept, summary: 'Keep my changes', key: a.key } : null,
        save: kept.length ? { kind: 'pending' } : { kind: 'saved', at: Date.now() },
        undo: [],
        redo: [],
        notice: dropped.length
          ? {
              tone: 'warning',
              text: `${dropped.length} of your changes no longer apply: ${dropped.join('; ')}`,
            }
          : null,
      };
    }
    case 'head:refresh':
      if (hasLocalVideoWork(s)) return s;
      return {
        ...s,
        committed: a.head,
        media: { ...s.media, ...Object.fromEntries(a.media.map((m) => [m.assetVersionId, m])) },
      };
    case 'media':
      return {
        ...s,
        media: { ...s.media, ...Object.fromEntries(a.media.map((m) => [m.assetVersionId, m])) },
      };
    case 'select':
      return { ...s, selection: a.selection };
    case 'playhead':
      return { ...s, playheadMs: Math.max(0, Math.round(a.ms)) };
    case 'notice':
      return { ...s, notice: a.notice };
  }
}
