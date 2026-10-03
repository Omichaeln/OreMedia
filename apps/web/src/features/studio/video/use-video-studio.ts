import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useBlocker } from 'react-router';
import type { VideoMediaInfo, VideoOperation, VideoProjectV1 } from '@oremedia/contracts/video';
import {
  applyVideoBatch,
  invertVideoBatch,
  rebaseVideoBatch,
  restoreVideoOps,
  videoOpItemIds,
} from '@oremedia/editor';
import { useTRPC, useTRPCClient } from '../../../lib/trpc';
import { intentContext, newIntentKey } from '../../../lib/intent-key';
import { toUiError } from '../../../lib/errors';
import { isVideoDocument, type VideoDocumentDto, type VideoRevisionDto } from '../types';
import {
  hasLocalVideoWork,
  initialVideoState,
  localProject,
  videoStudioReducer,
  type VideoCommitMode,
  type VideoCommitted,
  type VideoIntent,
  type VideoSelection,
  type VideoStudioAction,
  type VideoStudioState,
} from './video-state';

/** Autosave after this long without edits (the graphic studio's idle time). */
export const VIDEO_AUTOSAVE_IDLE_MS = 800;

export const committedOfVideo = (rev: VideoRevisionDto): VideoCommitted => ({
  revisionId: rev.id,
  number: rev.number,
  snapshot: rev.snapshot,
  contentHash: rev.contentHash,
});

export interface VideoStudioApi {
  state: VideoStudioState;
  project: VideoProjectV1;
  localError: string | null;
  dispatch: React.Dispatch<VideoStudioAction>;
  /** Checks the intent against the local project, then queues it (false when the reducer refused it). */
  applyIntent: (intent: VideoIntent) => boolean;
  saveNow: () => Promise<void>;
  undo: () => void;
  redo: () => void;
  undoBlocked: string | null;
  redoBlocked: string | null;
  restore: (target: VideoProjectV1, number: number) => void;
  select: (selection: VideoSelection | null) => void;
  setPlayhead: (ms: number) => void;
  addMedia: (media: VideoMediaInfo[]) => void;
  keepServer: () => void;
  keepMine: () => void;
  pendingItemIds: string[];
  blocker: ReturnType<typeof useBlocker>;
}

/**
 * The timeline studio's orchestration (spec 21.4, as use-studio.ts for pages): applyVideo commits, the rebase on a
 * stale base, undo/redo as inverse batches, restore of an earlier revision as a new one, autosave on idle and the
 * leave guard. Commits run through `operations.applyVideo`; the reducer never sees a network call.
 */
export function useVideoStudio(documentId: string, initial: VideoDocumentDto): VideoStudioApi {
  const client = useTRPCClient();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(videoStudioReducer, undefined, () =>
    initialVideoState(committedOfVideo(initial.revision), initial.media),
  );
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const local = useMemo(() => localProject(state), [state]);

  const afterCommit = useCallback(
    (raw: VideoRevisionDto) => {
      queryClient.setQueryData(trpc.creative.documents.get.queryKey({ documentId }), (old) =>
        old ? { ...old, currentRevisionId: raw.id, revision: raw } : old,
      );
      void queryClient.invalidateQueries(trpc.creative.revisions.pathFilter());
    },
    [documentId, queryClient, trpc],
  );

  /** STALE_REVISION: the head and the batches since our base, rebased, re-applied or surfaced as a conflict. */
  const rebase = useCallback(
    async (localOps: VideoOperation[], baseNumber: number) => {
      try {
        const head = await client.creative.documents.get.query({ documentId });
        if (!isVideoDocument(head)) throw new Error('This document is no longer a video');
        const list = await client.creative.revisions.list.query({ documentId, page: { limit: 200 } });
        const since = list.items.filter((r) => r.number > baseNumber).sort((a, b) => a.number - b.number);
        const remote = await Promise.all(
          since.map(async (r) => {
            const rev = await client.creative.revisions.get.query({ documentId, revisionId: r.id });
            return rev.kind === 'video' ? rev.operations.operations : [];
          }),
        );
        const headCommitted = committedOfVideo(head.revision);
        dispatch({ type: 'media', media: head.media });
        const result = rebaseVideoBatch(localOps, remote);
        if (!result.ok) {
          dispatch({ type: 'rebase:conflict', head: headCommitted, localOps, conflicts: result.conflicts });
          return;
        }
        try {
          applyVideoBatch(
            headCommitted.snapshot,
            { operations: result.operations },
            { media: stateRef.current.media },
          );
        } catch {
          const flat = remote.flat();
          dispatch({
            type: 'rebase:conflict',
            head: headCommitted,
            localOps,
            conflicts: localOps.map((op) => ({
              key: videoOpItemIds(op)[0] ?? op.op,
              localOp: op,
              remoteOp: flat[0] ?? op,
            })),
          });
          return;
        }
        dispatch({
          type: 'rebase:applied',
          head: headCommitted,
          operations: result.operations,
          key: newIntentKey(),
        });
      } catch (err) {
        dispatch({ type: 'commit:failed', error: toUiError(err), key: newIntentKey() });
      }
    },
    [client, documentId],
  );

  const runCommit = useCallback(
    async (req: {
      operations: VideoOperation[];
      summary: string;
      key: string;
      baseRevisionId: string;
      baseNumber: number;
    }) => {
      try {
        const res = await client.creative.operations.applyVideo.mutate(
          {
            documentId,
            baseRevisionId: req.baseRevisionId,
            operations: req.operations,
            summary: req.summary,
            origin: 'user',
          },
          intentContext(req.key),
        );
        dispatch({
          type: 'commit:success',
          revision: committedOfVideo(res.revision),
          findings: res.findings,
          media: res.media,
        });
        afterCommit(res.revision);
      } catch (err) {
        const ui = toUiError(err);
        if (ui.kind === 'stale_revision') {
          dispatch({ type: 'commit:stale' });
          await rebase(req.operations, req.baseNumber);
          return;
        }
        dispatch({ type: 'commit:failed', error: ui, key: newIntentKey() });
      }
    },
    [afterCommit, client, documentId, rebase],
  );

  const flush = useCallback(async () => {
    const s = stateRef.current;
    if (!s.pending || s.inFlight || s.conflict) return;
    const { pending, committed } = s;
    dispatch({ type: 'commit:start', mode: 'autosave' });
    await runCommit({ ...pending, baseRevisionId: committed.revisionId, baseNumber: committed.number });
  }, [runCommit]);

  useEffect(() => {
    if (!state.pending || state.inFlight || state.conflict || state.save.kind === 'failed') return;
    const t = window.setTimeout(() => void flush(), VIDEO_AUTOSAVE_IDLE_MS);
    return () => window.clearTimeout(t);
  }, [state.pending, state.inFlight, state.conflict, state.save.kind, flush]);

  const dirty = hasLocalVideoWork(state);
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  const blocker = useBlocker(dirty);

  const applyIntent = useCallback((intent: VideoIntent): boolean => {
    const s = stateRef.current;
    try {
      applyVideoBatch(localProject(s).project, intent, { media: s.media });
    } catch (err) {
      dispatch({
        type: 'notice',
        notice: {
          tone: 'warning',
          text: `That change is not possible: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
      return false;
    }
    dispatch({ type: 'intent', intent, key: newIntentKey() });
    return true;
  }, []);

  const commitDirect = useCallback(
    (mode: Exclude<VideoCommitMode, 'autosave'>, operations: VideoOperation[], summary: string) => {
      const s = stateRef.current;
      const key = newIntentKey();
      dispatch({ type: 'commit:start', mode, operations, summary, key });
      void runCommit({
        operations,
        summary,
        key,
        baseRevisionId: s.committed.revisionId,
        baseNumber: s.committed.number,
      });
    },
    [runCommit],
  );

  const history = useCallback(
    (mode: 'undo' | 'redo') => {
      const s = stateRef.current;
      const entry = (mode === 'undo' ? s.undo : s.redo).at(-1);
      if (!entry || hasLocalVideoWork(s)) return;
      const inv = invertVideoBatch(entry.before, { operations: entry.operations }, { media: s.media });
      if (!inv.ok) {
        dispatch({
          type: 'notice',
          notice: { tone: 'warning', text: `Cannot ${mode} "${entry.summary}": ${inv.reason}` },
        });
        return;
      }
      const base = entry.summary.replace(/^(Undo|Redo): /, '');
      commitDirect(mode, inv.operations, `${mode === 'undo' ? 'Undo' : 'Redo'}: ${base}`.slice(0, 500));
    },
    [commitDirect],
  );

  const restore = useCallback(
    (target: VideoProjectV1, number: number) => {
      const s = stateRef.current;
      if (hasLocalVideoWork(s)) return;
      const ops = restoreVideoOps(s.committed.snapshot, target);
      if (!ops.ok) {
        dispatch({
          type: 'notice',
          notice: { tone: 'warning', text: `Cannot restore revision ${number}: ${ops.reason}` },
        });
        return;
      }
      commitDirect('restore', ops.operations, `Restore revision ${number}`);
    },
    [commitDirect],
  );

  const blockedReason = (stack: VideoStudioState['undo'], verb: string): string | null => {
    if (stack.length === 0) return `Nothing to ${verb}`;
    if (hasLocalVideoWork(state)) return 'Save your pending changes first';
    return null;
  };
  const pendingItemIds = useMemo(
    () =>
      [...(state.inFlight?.operations ?? []), ...(state.pending?.operations ?? [])].flatMap(videoOpItemIds),
    [state.inFlight, state.pending],
  );

  return {
    state,
    project: local.project,
    localError: local.error,
    dispatch,
    applyIntent,
    saveNow: flush,
    undo: () => history('undo'),
    redo: () => history('redo'),
    undoBlocked: blockedReason(state.undo, 'undo'),
    redoBlocked: blockedReason(state.redo, 'redo'),
    restore,
    select: (selection) => dispatch({ type: 'select', selection }),
    setPlayhead: (ms) => dispatch({ type: 'playhead', ms }),
    addMedia: (media) => dispatch({ type: 'media', media }),
    keepServer: () => dispatch({ type: 'conflict:keep-server' }),
    keepMine: () => dispatch({ type: 'conflict:keep-mine', key: newIntentKey() }),
    pendingItemIds,
    blocker,
  };
}
