import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { VIDEO_FORMATS, type VideoFormatKey, type VideoProjectV1 } from '@oremedia/contracts/video';
import type {
  Storyboard,
  StoryboardScene,
  VideoAiRequestInput,
  VideoAudioPreference,
  VideoPacing,
} from '@oremedia/contracts/video-ai';
import { Badge, Button, Field, Input, StatusBanner, Textarea } from '@oremedia/ui';
import { Select } from '../../../components/select';
import { toUiError } from '../../../lib/errors';
import { intentContext, mutationIntent, newIntentKey, useIntentKey } from '../../../lib/intent-key';
import { useTRPC, useTRPCClient } from '../../../lib/trpc';
import { useBrandContext } from '../../brand/brand-context';
import { ProposalReview } from './proposal-review';
import { timecode } from './timecode';
import {
  useEffectiveFacts,
  useShotAssets,
  useVideoAiActive,
  useVideoAiJob,
  useVideoAiPreflight,
  type VideoAiJobDto,
} from './use-video-ai';
import type { VideoStudioApi } from './use-video-studio';
import { VideoAiJobStatus } from './video-ai-job';

const PACING: Array<{ value: VideoPacing; label: string }> = [
  { value: 'calm', label: 'Calm (crossfades)' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'fast', label: 'Fast (cuts)' },
];
const AUDIO: Array<{ value: VideoAudioPreference; label: string }> = [
  { value: 'music', label: 'Music bed' },
  { value: 'clip_sound', label: 'The clips’ own sound' },
  { value: 'voiceover', label: 'Voice-over (needs a recording)' },
  { value: 'none', label: 'No sound' },
];
const NO_CHANNEL = 'none';

interface BriefState {
  objective: string;
  audience: string;
  keyMessage: string;
  channelKey: string;
  durationS: string;
  pacing: VideoPacing;
  captions: boolean;
  audio: VideoAudioPreference;
  logo: boolean;
  factIds: string[];
}

const requestOf = (b: BriefState, formatKey: VideoFormatKey): VideoAiRequestInput => ({
  kind: 'storyboard',
  brief: {
    objective: b.objective,
    audience: b.audience,
    keyMessage: b.keyMessage,
    ...(b.channelKey !== NO_CHANNEL ? { channelKey: b.channelKey } : {}),
    formatKey,
    durationMs: Math.min(180_000, Math.max(1_000, Math.round(Number(b.durationS || '15') * 1000))),
    pacing: b.pacing,
    captions: b.captions,
    audio: b.audio,
    logo: b.logo,
    factIds: b.factIds,
  },
});

/** The value after it has stopped changing for `ms` (the preflight follows the brief without a call per key). */
function useSettled<T>(value: T, ms = 500): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/**
 * STU-3 storyboard: a brief (objective, audience, key message, channel, length, pacing, captions, sound, approved
 * facts) checked as it is written (what it would use, what blocks it, the cost), a durable job that writes a script,
 * scenes and a shot list from the brand's eligible assets, then the storyboard to refine (reorder, edit text, swap
 * assets, remove scenes and shots, change lengths) and assemble into the timeline: at once into an empty video,
 * otherwise as a proposal accepted per group.
 */
export function StoryboardPanel({
  documentId,
  project,
  studio,
}: {
  documentId: string;
  project: VideoProjectV1;
  studio: VideoStudioApi;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { brandId } = useBrandContext();
  const startKey = useIntentKey();
  const active = useVideoAiActive(documentId);
  const [jobId, setJobId] = useState<string | null>(null);
  const live = active.data?.items.find((j) => j.kind === 'storyboard');
  const shownId = jobId ?? live?.id ?? active.data?.lastStoryboard?.id ?? null;
  const job = useVideoAiJob(shownId);
  const facts = useEffectiveFacts(brandId);
  const [brief, setBrief] = useState<BriefState>({
    objective: '',
    audience: '',
    keyMessage: '',
    channelKey: NO_CHANNEL,
    durationS: String(Math.round(project.durationMs / 1000)),
    pacing: 'balanced',
    captions: true,
    audio: 'music',
    logo: true,
    factIds: [],
  });
  const [writing, setWriting] = useState(false);
  const baseRevisionId = studio.state.committed.revisionId;
  const request = useSettled(
    useMemo(() => requestOf(brief, project.format.key), [brief, project.format.key]),
  );
  const showForm = writing || !shownId;
  const preflight = useVideoAiPreflight(documentId, baseRevisionId, showForm ? request : null);
  const start = useMutation(
    trpc.creative.videoAi.start.mutationOptions({
      ...mutationIntent(startKey.key),
      onSuccess: (res) => {
        startKey.renew();
        setJobId(res.id);
        setWriting(false);
        void queryClient.invalidateQueries(trpc.creative.videoAi.active.pathFilter());
      },
    }),
  );
  const set = <K extends keyof BriefState>(k: K, v: BriefState[K]) => setBrief((b) => ({ ...b, [k]: v }));
  const localWork = Boolean(studio.state.pending || studio.state.inFlight);
  const channels = VIDEO_FORMATS[project.format.key].providerKeys;

  const form = (
    <form
      className="flex flex-col gap-2"
      aria-labelledby="brief-heading"
      onSubmit={(e) => {
        e.preventDefault();
        start.mutate({ documentId, baseRevisionId, request: requestOf(brief, project.format.key) });
      }}
      data-testid="storyboard-brief"
    >
      <h3 id="brief-heading" className="text-sm font-semibold">
        Brief
      </h3>
      <Field label="Objective" htmlFor="sb-objective">
        <Textarea
          id="sb-objective"
          rows={2}
          maxLength={500}
          value={brief.objective}
          onChange={(e) => set('objective', e.target.value)}
        />
      </Field>
      <Field label="Audience" htmlFor="sb-audience">
        <Input
          id="sb-audience"
          maxLength={300}
          value={brief.audience}
          onChange={(e) => set('audience', e.target.value)}
        />
      </Field>
      <Field label="Key message" htmlFor="sb-message">
        <Input
          id="sb-message"
          maxLength={500}
          value={brief.keyMessage}
          onChange={(e) => set('keyMessage', e.target.value)}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Channel" htmlFor="sb-channel">
          <Select
            id="sb-channel"
            size="sm"
            value={brief.channelKey}
            onValueChange={(v) => set('channelKey', v)}
            options={[
              { value: NO_CHANNEL, label: 'Any' },
              ...channels.map((c) => ({ value: c, label: c.replace(/_/g, ' ') })),
            ]}
          />
        </Field>
        <Field
          label="Length (seconds)"
          htmlFor="sb-duration"
          hint={`Format ${project.format.width}×${project.format.height}`}
        >
          <Input
            id="sb-duration"
            type="number"
            min={1}
            max={180}
            value={brief.durationS}
            onChange={(e) => set('durationS', e.target.value)}
          />
        </Field>
        <Field label="Pacing" htmlFor="sb-pacing">
          <Select
            id="sb-pacing"
            size="sm"
            value={brief.pacing}
            onValueChange={(v) => set('pacing', v as VideoPacing)}
            options={PACING}
          />
        </Field>
        <Field label="Sound" htmlFor="sb-audio">
          <Select
            id="sb-audio"
            size="sm"
            value={brief.audio}
            onValueChange={(v) => set('audio', v as VideoAudioPreference)}
            options={AUDIO}
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={brief.captions}
            onChange={(e) => set('captions', e.target.checked)}
          />
          Captions from the script
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={brief.logo} onChange={(e) => set('logo', e.target.checked)} />
          Titles and logo
        </label>
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium text-muted-foreground">
          Approved facts the script may state
        </legend>
        {(facts.data?.items ?? []).length === 0 && (
          <p className="text-xs text-muted-foreground">
            No approved facts in force; the script will state none.
          </p>
        )}
        {(facts.data?.items ?? []).map((f) => (
          <label key={f.id} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={brief.factIds.includes(f.id)}
              onChange={(e) =>
                set(
                  'factIds',
                  e.target.checked ? [...brief.factIds, f.id] : brief.factIds.filter((id) => id !== f.id),
                )
              }
            />
            <span>{f.statement}</span>
          </label>
        ))}
      </fieldset>
      {preflight.data && (
        <div
          className="flex flex-col gap-1 rounded-md bg-secondary/40 p-2 text-xs"
          data-testid="storyboard-preflight"
        >
          <p>
            Uses {preflight.data.inputs.eligible.clips} clip
            {preflight.data.inputs.eligible.clips === 1 ? '' : 's'}, {preflight.data.inputs.eligible.stills}{' '}
            still{preflight.data.inputs.eligible.stills === 1 ? '' : 's'} and{' '}
            {preflight.data.inputs.eligible.audio} audio file
            {preflight.data.inputs.eligible.audio === 1 ? '' : 's'} with recorded rights; estimated cost{' '}
            {(preflight.data.cost.totalMicros / 1_000_000).toFixed(2)} credits.
          </p>
          <ul className="flex flex-col gap-1">
            {preflight.data.issues.map((i) => (
              <li key={`${i.code}-${i.ref ?? ''}`} className="flex items-start gap-2">
                <Badge
                  tone={
                    i.severity === 'blocking' ? 'critical' : i.severity === 'warning' ? 'warning' : 'info'
                  }
                >
                  {i.severity}
                </Badge>
                <span>{i.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {start.isError && (
        <StatusBanner
          tone="critical"
          title="The storyboard could not start"
          description={toUiError(start.error).message}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={start.isPending}
          disabledReason={
            preflight.data?.blocking
              ? 'Resolve the blocking issues above first'
              : localWork
                ? 'Save your pending changes first'
                : undefined
          }
          data-testid="generate-storyboard"
        >
          Write storyboard
        </Button>
        {shownId && (
          <Button size="sm" variant="ghost" onClick={() => setWriting(false)}>
            Back to the storyboard
          </Button>
        )}
      </div>
    </form>
  );

  return (
    <section
      aria-labelledby="storyboard-heading"
      className="flex flex-col gap-3"
      data-testid="storyboard-panel"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="storyboard-heading" className="text-sm font-semibold">
          Storyboard
        </h2>
        {!showForm && (
          <Button size="sm" variant="ghost" onClick={() => setWriting(true)} data-testid="new-storyboard">
            New brief
          </Button>
        )}
      </div>
      {showForm ? form : job.data ? <StoryboardJob job={job.data} studio={studio} project={project} /> : null}
    </section>
  );
}

/** A storyboard job: its status, then (once written) the storyboard to refine and assemble. */
function StoryboardJob({
  job,
  studio,
  project,
}: {
  job: VideoAiJobDto;
  studio: VideoStudioApi;
  project: VideoProjectV1;
}) {
  const storyboard = job.result?.storyboard ?? null;
  const proposal = job.result?.proposal ?? null;
  const [showProposal, setShowProposal] = useState(true);
  return (
    <div className="flex flex-col gap-3">
      <VideoAiJobStatus job={job} />
      {job.result && job.result.refused.length > 0 && (
        <StatusBanner
          tone="info"
          title={`${job.result.refused.length} part${job.result.refused.length === 1 ? ' was' : 's were'} not used`}
          description={job.result.refused
            .map((r) =>
              r.reason === 'asset_not_eligible'
                ? `An asset that is not approved for use (${r.detail ?? ''})`
                : r.reason === 'claim_without_effective_fact'
                  ? `A claim without an approved fact: “${r.detail ?? ''}”`
                  : `${r.reason.replace(/_/g, ' ')}${r.detail ? ` (${r.detail})` : ''}`,
            )
            .join('; ')}
        />
      )}
      {proposal && showProposal && !proposal.acceptedRevisionId ? (
        <ProposalReview job={job} proposal={proposal} studio={studio} onDone={() => setShowProposal(false)} />
      ) : storyboard ? (
        <StoryboardEditor key={job.id} job={job} initial={storyboard} studio={studio} project={project} />
      ) : null}
    </div>
  );
}

const DRAFT_SETTLE_MS = 800;
const DRAFT_RETRY_MAX_MS = 30_000;

/**
 * Saves the person's storyboard edits on the job (videoAi.saveDraft) once they settle. One save at a time, each on
 * the version the previous one returned, so two are never in flight on the same expectedVersion; the newest edit
 * wins. A save is marked done only when it succeeded; a failure is retried with backoff, and a conflict (the job
 * moved on, e.g. another device saved) re-reads the job's version first. An unsaved edit is flushed when the editor
 * closes. Each payload carries its own idempotency key (retries of the same payload reuse it).
 */
function useStoryboardDraftSaver(job: VideoAiJobDto, draft: Storyboard) {
  const client = useTRPCClient();
  const settled = useSettled(draft, DRAFT_SETTLE_MS);
  const [error, setError] = useState<unknown>(null);
  const state = useRef({
    jobId: job.id,
    version: job.version,
    saved: draft as Storyboard,
    pending: null as Storyboard | null,
    attempt: null as { storyboard: Storyboard; version: number; key: string } | null,
    inFlight: false,
    failures: 0,
    timer: 0,
  });
  useEffect(() => {
    state.current.version = Math.max(state.current.version, job.version);
  }, [job.version]);

  const pump = useCallback(async (): Promise<void> => {
    const s = state.current;
    if (s.inFlight || s.timer) return;
    const storyboard = s.pending;
    if (!storyboard) {
      setError(null);
      return;
    }
    if (storyboard === s.saved) {
      s.pending = null;
      return;
    }
    // The same payload on the same version is the same intent: a retry reuses its key.
    const same = s.attempt && s.attempt.storyboard === storyboard && s.attempt.version === s.version;
    const attempt = same && s.attempt ? s.attempt : { storyboard, version: s.version, key: newIntentKey() };
    s.attempt = attempt;
    s.inFlight = true;
    try {
      const res = await client.creative.videoAi.saveDraft.mutate(
        { jobId: s.jobId, expectedVersion: attempt.version, storyboard },
        intentContext(attempt.key),
      );
      s.version = Math.max(s.version, res.version);
      s.saved = storyboard;
      if (s.pending === storyboard) s.pending = null;
      s.failures = 0;
      setError(null);
    } catch (err) {
      s.failures += 1;
      setError(err);
      const kind = toUiError(err).kind;
      // A refusal that a retry cannot change (the job is not an editable storyboard, no access) is shown, not retried.
      if (kind === 'validation' || kind === 'forbidden' || kind === 'not_found' || kind === 'sign_in') return;
      if (kind === 'conflict') {
        try {
          s.version = (await client.creative.videoAi.get.query({ jobId: s.jobId })).version;
        } catch {
          // The retry below tries again.
        }
      }
      s.timer = window.setTimeout(
        () => {
          s.timer = 0;
          void pump();
        },
        Math.min(DRAFT_RETRY_MAX_MS, 1_000 * 2 ** (s.failures - 1)),
      );
      return;
    } finally {
      s.inFlight = false;
    }
    if (s.pending) void pump(); // an edit that settled while this save ran
  }, [client]);

  useEffect(() => {
    const s = state.current;
    if (settled === s.saved) return;
    s.pending = settled;
    void pump();
  }, [settled, pump]);

  // Flush on close: the newest edit (even one that has not settled yet) goes through the same queue, after a save
  // still in flight, without waiting out a retry delay.
  const latest = useRef(draft);
  latest.current = draft;
  useEffect(
    () => () => {
      const s = state.current;
      window.clearTimeout(s.timer);
      s.timer = 0;
      if (latest.current === s.saved) return;
      s.pending = latest.current;
      void pump();
    },
    [pump],
  );

  /** After assembling: the server cleared the draft and moved the job on; what is on screen counts as saved. */
  const assembled = useCallback((version: number) => {
    const s = state.current;
    s.version = Math.max(s.version, version);
    s.saved = latest.current;
    s.pending = null;
    s.attempt = null;
    s.failures = 0;
    window.clearTimeout(s.timer);
    s.timer = 0;
    setError(null);
  }, []);

  return { error, assembled };
}

function StoryboardEditor({
  job,
  initial,
  studio,
  project,
}: {
  job: VideoAiJobDto;
  initial: Storyboard;
  studio: VideoStudioApi;
  project: VideoProjectV1;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { brandId } = useBrandContext();
  const assets = useShotAssets(brandId);
  const assembleKey = useIntentKey();
  // The person's edits are kept on the job (a reload or another device picks them up), saved once they settle.
  const [draft, setDraft] = useState<Storyboard>(() => job.result?.draft ?? initial);
  const drafts = useStoryboardDraftSaver(job, draft);
  const assemble = useMutation(
    trpc.creative.videoAi.assemble.mutationOptions({
      ...mutationIntent(assembleKey.key),
      onSuccess: (res) => {
        assembleKey.renew();
        drafts.assembled(res.job.version); // the server cleared the draft: what was assembled is the storyboard now
        if (res.applied) studio.adoptRevision(res);
        void queryClient.invalidateQueries(trpc.creative.videoAi.pathFilter());
      },
    }),
  );
  const options = useMemo(
    () => [
      { value: '', label: 'No asset yet (gap)' },
      ...(assets.data?.items ?? []).map((a) => ({
        value: a.assetVersionId,
        label: `${a.altText ?? a.kind} · ${a.kind}${a.durationMs ? ` ${timecode(a.durationMs)}` : ''}`,
      })),
    ],
    [assets.data],
  );
  const total = draft.scenes.reduce((s, sc) => s + sc.shots.reduce((t, sh) => t + sh.durationMs, 0), 0);
  const scene = (i: number, patch: Partial<StoryboardScene>) =>
    setDraft((d) => ({ ...d, scenes: d.scenes.map((s, k) => (k === i ? { ...s, ...patch } : s)) }));
  const moveScene = (i: number, by: -1 | 1) =>
    setDraft((d) => {
      const scenes = [...d.scenes];
      const [s] = scenes.splice(i, 1);
      if (s) scenes.splice(i + by, 0, s);
      return { ...d, scenes };
    });
  const localWork = Boolean(studio.state.pending || studio.state.inFlight);
  const footageGaps = draft.gaps.filter((g) => g.kind === 'footage');
  return (
    <div className="flex flex-col gap-3" data-testid="storyboard-editor">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{draft.title}</h3>
        <span className="text-xs tabular-nums text-muted-foreground" data-testid="storyboard-length">
          {draft.scenes.length} scene{draft.scenes.length === 1 ? '' : 's'} · {timecode(total)}
        </span>
      </div>
      <ol className="flex flex-col gap-2">
        {draft.scenes.map((s, i) => (
          <li
            key={s.id}
            className="flex flex-col gap-2 rounded-md border border-border p-2"
            data-testid={`sb-scene-${i}`}
          >
            <div className="flex flex-wrap items-end gap-2">
              <Field label={`Scene ${i + 1} title`} htmlFor={`sb-title-${s.id}`} className="min-w-0 flex-1">
                <Input
                  id={`sb-title-${s.id}`}
                  maxLength={80}
                  value={s.title}
                  onChange={(e) => scene(i, { title: e.target.value })}
                />
              </Field>
              <div className="flex gap-1" role="group" aria-label={`Scene ${i + 1} order`}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={i === 0}
                  onClick={() => moveScene(i, -1)}
                  aria-label={`Move scene ${i + 1} up`}
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={i === draft.scenes.length - 1}
                  onClick={() => moveScene(i, 1)}
                  aria-label={`Move scene ${i + 1} down`}
                >
                  ↓
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={draft.scenes.length === 1}
                  onClick={() => setDraft((d) => ({ ...d, scenes: d.scenes.filter((_, k) => k !== i) }))}
                  aria-label={`Remove scene ${i + 1}`}
                >
                  Remove
                </Button>
              </div>
            </div>
            <Field label="On-screen title" htmlFor={`sb-ost-${s.id}`}>
              <Input
                id={`sb-ost-${s.id}`}
                maxLength={120}
                value={s.onScreenText}
                onChange={(e) => scene(i, { onScreenText: e.target.value })}
              />
            </Field>
            <Field label="Script (captions are made from it)" htmlFor={`sb-narr-${s.id}`}>
              <Textarea
                id={`sb-narr-${s.id}`}
                rows={2}
                maxLength={600}
                value={s.narration}
                onChange={(e) => scene(i, { narration: e.target.value })}
              />
            </Field>
            {s.claims.length > 0 && (
              <ul className="flex flex-col gap-1 text-xs" aria-label="Approved claims in this scene">
                {s.claims.map((c) => (
                  <li key={c.text} className="flex items-start gap-2">
                    <Badge tone="good">fact</Badge>
                    <span>{c.text}</span>
                  </li>
                ))}
              </ul>
            )}
            <ol className="flex flex-col gap-2" aria-label={`Shots of scene ${i + 1}`}>
              {s.shots.map((sh, k) => (
                <li
                  key={sh.id}
                  className="grid grid-cols-1 gap-1 rounded bg-secondary/30 p-2 sm:grid-cols-[1fr_6rem]"
                >
                  <Field label={`Shot ${k + 1}`} htmlFor={`sb-shot-${sh.id}`}>
                    <Input
                      id={`sb-shot-${sh.id}`}
                      maxLength={300}
                      value={sh.description}
                      onChange={(e) =>
                        scene(i, {
                          shots: s.shots.map((x, j) => (j === k ? { ...x, description: e.target.value } : x)),
                        })
                      }
                    />
                  </Field>
                  <Field label="Seconds" htmlFor={`sb-dur-${sh.id}`}>
                    <Input
                      id={`sb-dur-${sh.id}`}
                      type="number"
                      min={0.5}
                      max={30}
                      step={0.5}
                      value={sh.durationMs / 1000}
                      onChange={(e) => {
                        const ms = Math.round(Number(e.target.value) * 1000);
                        if (Number.isFinite(ms) && ms >= 500 && ms <= 30_000)
                          scene(i, {
                            shots: s.shots.map((x, j) => (j === k ? { ...x, durationMs: ms } : x)),
                          });
                      }}
                    />
                  </Field>
                  <Field label="Asset" htmlFor={`sb-asset-${sh.id}`} className="sm:col-span-2">
                    <Select
                      id={`sb-asset-${sh.id}`}
                      size="sm"
                      value={sh.assetVersionId ?? ''}
                      onValueChange={(v) =>
                        scene(i, {
                          shots: s.shots.map((x, j) =>
                            j === k ? { ...x, assetVersionId: v || null, sourceInMs: 0 } : x,
                          ),
                        })
                      }
                      options={options}
                    />
                  </Field>
                  {s.shots.length > 1 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="justify-self-start"
                      onClick={() => scene(i, { shots: s.shots.filter((_, j) => j !== k) })}
                      aria-label={`Remove shot ${k + 1} of scene ${i + 1}`}
                    >
                      Remove shot
                    </Button>
                  )}
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
      {draft.gaps.length > 0 && (
        <section aria-labelledby="sb-gaps" className="flex flex-col gap-2" data-testid="storyboard-gaps">
          <h4 id="sb-gaps" className="text-xs font-semibold">
            Gaps ({draft.gaps.length})
          </h4>
          <ul className="flex flex-col gap-2 text-xs">
            {draft.gaps.map((g) => (
              <li key={g.id} className="rounded-md border border-dashed border-border p-2">
                <p className="font-medium">{g.description}</p>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {g.alternatives.map((a) => (
                    <li key={a.kind} className="flex items-start gap-2">
                      <Badge tone={a.available ? 'good' : 'neutral'}>
                        {a.available ? 'available' : 'unavailable'}
                      </Badge>
                      <span>
                        {a.label}
                        {a.costMicros !== undefined
                          ? ` · about ${(a.costMicros / 1_000_000).toFixed(2)} credits`
                          : ''}
                        {!a.available && a.reason ? ` (${a.reason})` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          {footageGaps.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Shots without an asset stay empty in the video until you pick footage or a still for them.
            </p>
          )}
        </section>
      )}
      {assemble.isError && (
        <StatusBanner
          tone="critical"
          title="Could not assemble"
          description={toUiError(assemble.error).message}
        />
      )}
      {assemble.data && !assemble.data.applied && (
        <p className="text-xs text-muted-foreground" role="status">
          The video already has work in it, so the assembly is a proposal: choose what to keep below.
        </p>
      )}
      {assemble.data?.applied && (
        <p className="text-xs text-muted-foreground" role="status" data-testid="assembled">
          Assembled as revision {assemble.data.revision.number}. Undo takes it back.
        </p>
      )}
      {assemble.data && assemble.data.conflicts.length > 0 && (
        <StatusBanner
          tone="warning"
          title="Some parts could not be placed"
          description={assemble.data.conflicts.map((c) => c.message).join(' ')}
        />
      )}
      {drafts.error !== null && (
        <StatusBanner
          tone="warning"
          title="Your storyboard edits are not saved yet; retrying"
          description={toUiError(drafts.error).message}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={assemble.isPending}
          disabledReason={localWork ? 'Save your pending changes first' : undefined}
          onClick={() =>
            assemble.mutate({
              jobId: job.id,
              baseRevisionId: studio.state.committed.revisionId,
              storyboard: draft,
            })
          }
          data-testid="assemble-storyboard"
        >
          {project.tracks.some((t) => (t.kind === 'video' || t.kind === 'audio') && t.items.length > 0)
            ? 'Assemble (as a proposal)'
            : 'Assemble into the video'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDraft(initial)} data-testid="reset-storyboard">
          Undo my storyboard edits
        </Button>
      </div>
    </div>
  );
}
