import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Field, Input, Skeleton, StatusBanner, StatusDot, cn, toneGlyph } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { verdictChip } from '../intelligence/intelligence-helpers';
import {
  allocationText,
  conclusionText,
  differenceText,
  experimentProgress,
  experimentStateChip,
  formatRate,
  intervalText,
  isDesignChanged,
  modeLabel,
  modeNote,
  resultsRefusalText,
  shortHash,
  stoppingText,
  windowEnd,
  windowText,
} from './experiment-helpers';
import { useExperiment, useExperimentResults, type ExperimentDto, type ResultDto } from './use-experiments';

export interface ExperimentDetailProps {
  experimentId: string;
}

/** The detail column's gutter: the interface's 32 × 36 px, less at phone width (as the agents' run detail). */
const GUTTER = 'px-5 py-6 sm:px-9 sm:py-8';

/** A ruled section with the interface's uppercase label ("Result", "Pre-registration"). */
function Block({
  id,
  title,
  testId,
  children,
}: {
  id: string;
  title: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col" data-testid={testId}>
      <h3 id={id} className="om-label mb-2">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * The result as the interface sets it: one ruled row per arm (n, successes, rate), then the difference and the
 * verdict in bold, the interval and p-value, the guardrails and the conclusion label (verbatim) in muted lines.
 */
function ResultView({ result, experiment }: { result: ResultDto; experiment: ExperimentDto }) {
  const verdict = verdictChip(result.verdict);
  const interval = intervalText(result.interval, result.pValue);
  const exposures = experiment.variants.flatMap((v) => {
    const e = result.perVariant[v.id]?.exposure;
    return e === undefined ? [] : [`${v.label} ${e.toLocaleString()}`];
  });
  return (
    <div className="flex flex-col" data-testid="experiment-result" data-verdict={result.verdict}>
      <table className="w-full text-sm">
        <caption className="sr-only">Observations per variant</caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Variant</th>
            <th scope="col">Units (n)</th>
            <th scope="col">Successes (x)</th>
            <th scope="col">Rate</th>
          </tr>
        </thead>
        <tbody>
          {experiment.variants.map((v) => {
            const o = result.perVariant[v.id];
            return (
              <tr key={v.id} className="border-t border-border">
                <th scope="row" className="py-2.5 pr-3 text-left font-normal">
                  {v.label}
                </th>
                <td className="w-[90px] py-2.5 pr-3 text-xs tabular-nums text-muted-foreground">
                  n {o ? o.n.toLocaleString() : '—'}
                </td>
                <td className="w-[70px] py-2.5 pr-3 text-xs tabular-nums text-muted-foreground">
                  {o ? o.x.toLocaleString() : '—'}
                </td>
                <td className="w-[80px] py-2.5 text-right text-xs tabular-nums">
                  {formatRate(o?.rate ?? null)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="flex flex-col gap-1 border-t border-border py-3">
        <p className="text-md font-bold">
          {differenceText(result.estimate)} · {verdict.label}
        </p>
        {interval && <p className="text-xs text-muted-foreground">{interval}</p>}
        <p className="text-xs text-muted-foreground">{result.verdictReason}</p>
        {result.guardrailBreached.length > 0 ? (
          <p className="text-xs text-status-critical" data-testid="guardrail-breach">
            <span className="sr-only">{toneGlyph.critical} </span>
            Guardrail breached: {result.guardrailBreached.join(', ')}. A primary-metric win with a guardrail
            breach is not supported for the campaign objective (spec 16.6).
          </p>
        ) : (
          experiment.guardrailMetricKeys.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Guardrails held: {experiment.guardrailMetricKeys.join(', ')}
            </p>
          )
        )}
        {exposures.length > 0 && (
          <p className="text-xs text-muted-foreground">Exposure: {exposures.join(' · ')}</p>
        )}
        <p className="text-xs text-muted-foreground">
          <span data-testid="conclusion-label">{conclusionText(result.conclusionLabel)}</span> · computed{' '}
          {new Date(result.computedAt).toLocaleString()} · method {result.methodVersion} · design{' '}
          {shortHash(result.preRegistrationHash)}
        </p>
      </div>
    </div>
  );
}

/** Spec 16.6 results: entered as delivered observations per variant, computed against the frozen design hash. */
function ComputeResultsForm({ experiment }: { experiment: ExperimentDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [rows, setRows] = useState<Record<string, { n: string; x: string }>>(() =>
    Object.fromEntries(experiment.variants.map((v) => [v.id, { n: '', x: '' }])),
  );
  const compute = useMutation(
    trpc.experiments.results.compute.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.experiments.pathFilter());
        void queryClient.invalidateQueries(trpc.intelligence.pathFilter());
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!experiment.preRegistrationHash) return;
    compute.mutate({
      experimentId: experiment.id,
      preRegistrationHash: experiment.preRegistrationHash,
      observations: experiment.variants.map((v) => ({
        variantId: v.id,
        n: Number(rows[v.id]?.n ?? 0),
        x: Number(rows[v.id]?.x ?? 0),
        guardrails: {},
      })),
    });
  };
  const ui = compute.isError ? toUiError(compute.error) : null;
  const refusal = ui?.kind === 'validation' ? resultsRefusalText(ui.details) : [];
  const set = (id: string, key: 'n' | 'x', value: string) =>
    setRows((r) => ({ ...r, [id]: { ...(r[id] ?? { n: '', x: '' }), [key]: value } }));
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
      <p className="text-xs text-muted-foreground">
        Delivered observations per variant: units (n) and primary-metric successes (x). Exposure is recorded
        separately by measurement and never assumed equal across arms.
      </p>
      {experiment.variants.map((v) => (
        <fieldset key={v.id} className="grid grid-cols-2 gap-2">
          <legend className="text-xs font-medium">{v.label}</legend>
          <Field label="n" htmlFor={`obs-${v.id}-n`}>
            <Input
              id={`obs-${v.id}-n`}
              type="number"
              min={0}
              value={rows[v.id]?.n ?? ''}
              onChange={(e) => set(v.id, 'n', e.target.value)}
            />
          </Field>
          <Field label="x" htmlFor={`obs-${v.id}-x`}>
            <Input
              id={`obs-${v.id}-x`}
              type="number"
              min={0}
              value={rows[v.id]?.x ?? ''}
              onChange={(e) => set(v.id, 'x', e.target.value)}
            />
          </Field>
        </fieldset>
      ))}
      {ui && ui.kind === 'validation' && isDesignChanged(ui.details) && (
        <StatusBanner
          tone="critical"
          title="Results rejected: the design changed"
          description={
            <>
              {ui.message} Stored hash {shortHash(experiment.preRegistrationHash)}. {refusal.join(' ')}
            </>
          }
          data-testid="design-changed"
        />
      )}
      {ui && ui.kind === 'validation' && !isDesignChanged(ui.details) && (
        <StatusBanner
          tone="warning"
          title="No result yet"
          description={
            <>
              {ui.message}
              {refusal.length ? ` ${refusal.join(' ')}` : ''}
            </>
          }
          data-testid="results-refused"
        />
      )}
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Computing results needs experiment.manage for this brand.`}
        />
      )}
      {ui && ui.kind !== 'validation' && ui.kind !== 'forbidden' && (
        <RequestError error={compute.error} title="Results were not computed" />
      )}
      <div>
        <Button type="submit" variant="primary" size="sm" disabled={compute.isPending}>
          {compute.isPending ? 'Computing…' : 'Compute results'}
        </Button>
      </div>
    </form>
  );
}

/**
 * One experiment as the interface sets it: the mode as a pill and the design hash, the hypothesis as the title, what
 * the mode lets a result claim; the progress bar with the state; the result (or why there is none yet); the frozen
 * pre-registration as a ruled table; then the lifecycle action the state allows.
 */
export function ExperimentDetail({ experimentId }: ExperimentDetailProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const experiment = useExperiment(experimentId);
  const results = useExperimentResults(experimentId);
  const preIntent = useIntentKey();
  const startIntent = useIntentKey();
  const stopIntent = useIntentKey();
  const [stopReason, setStopReason] = useState('');
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.experiments.pathFilter());
    void queryClient.invalidateQueries(trpc.intelligence.pathFilter());
  };
  const preRegister = useMutation(
    trpc.experiments.preRegister.mutationOptions({
      ...mutationIntent(preIntent.key),
      onSuccess: () => {
        preIntent.renew();
        invalidate();
      },
    }),
  );
  const start = useMutation(
    trpc.experiments.start.mutationOptions({
      ...mutationIntent(startIntent.key),
      onSuccess: () => {
        startIntent.renew();
        invalidate();
      },
    }),
  );
  const stop = useMutation(
    trpc.experiments.stop.mutationOptions({
      ...mutationIntent(stopIntent.key),
      onSuccess: () => {
        stopIntent.renew();
        invalidate();
      },
    }),
  );
  const actionError = [preRegister, start, stop].find((m) => m.isError);
  const actionUi = actionError ? toUiError(actionError.error) : null;

  if (experiment.isPending)
    return (
      <div className={GUTTER} data-testid="experiment-detail">
        <Skeleton label="Loading experiment" lines={4} />
      </div>
    );
  if (experiment.isError)
    return (
      <div className={GUTTER} data-testid="experiment-detail">
        <RequestError error={experiment.error} onRetry={() => void experiment.refetch()} />
      </div>
    );
  const x = experiment.data;
  const chip = experimentStateChip(x.state);
  const latest = (results.data?.items[0] as ResultDto | undefined) ?? null;
  const progress = experimentProgress(x, latest);
  const pre = x.preRegistration;
  const rows: Array<{ k: string; v: ReactNode; testId?: string }> = [
    { k: 'Hypothesis', v: x.hypothesis },
    { k: 'Variants', v: x.variants.map((v) => v.label).join(' · ') },
    { k: 'Primary metric', v: x.primaryMetricKey },
    { k: 'Guardrails', v: x.guardrailMetricKeys.length ? x.guardrailMetricKeys.join(', ') : 'none' },
    { k: 'Allocation', v: allocationText(x.allocationMethod, x.variants) },
    { k: 'Unit', v: pre ? pre.unitType.replace(/_/g, ' ') : 'set at pre-registration' },
    { k: 'Minimum sample', v: `${x.minSamplePerArm.toLocaleString()} per arm` },
    {
      k: 'Window',
      v: `${windowText(x.observationWindowHours)}${x.startedAt ? `, ends ${windowEnd(x.startedAt, x.observationWindowHours).toLocaleString()}` : ''}`,
    },
    { k: 'Stopping rule', v: pre ? stoppingText(pre.stoppingRule) : 'frozen at pre-registration' },
    {
      k: 'Design hash',
      v: x.preRegistrationHash ? (
        <span className="break-all tabular-nums">{x.preRegistrationHash}</span>
      ) : (
        'not frozen yet'
      ),
      testId: 'design-hash',
    },
    ...(x.preRegisteredAt
      ? [
          {
            k: 'Frozen',
            v: `Pre-registered ${new Date(x.preRegisteredAt).toLocaleString()}; results computed against any other design are rejected.`,
            testId: 'design-frozen',
          },
        ]
      : []),
    ...(x.recommendationId ? [{ k: 'Origin', v: 'Prepared from an analyst recommendation' }] : []),
  ];

  return (
    <section
      aria-labelledby="experiment-title"
      className={cn('flex max-w-[760px] flex-col gap-6 pb-12 sm:pb-16', GUTTER)}
      data-testid="experiment-detail"
      data-experiment-state={x.state}
    >
      <div className="flex flex-col gap-1.5">
        <p className="flex flex-wrap items-center gap-2">
          <Badge variant="pill" glyph={false}>
            {modeLabel(x.mode)}
          </Badge>
          <span className="text-xs tabular-nums text-muted-foreground">
            {x.preRegistrationHash ? `design ${shortHash(x.preRegistrationHash)}` : 'design not frozen yet'}
          </span>
        </p>
        <h2 id="experiment-title" className="text-pretty text-xl font-bold tracking-title">
          {x.hypothesis}
        </h2>
        <p className="text-sm text-muted-foreground">{modeNote(x.mode, x.conclusionLabel)}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{progress.label}</span>
          <span className="flex items-center gap-1.5" data-testid="experiment-state">
            <StatusDot tone={chip.tone} size="sm" />
            <span className="sr-only">{toneGlyph[chip.tone]} </span>
            {chip.label}
          </span>
        </p>
        <div aria-hidden="true" className="h-1 overflow-hidden rounded-sm bg-border">
          <div className="h-full bg-primary" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
        </div>
      </div>
      <Block id="result-heading" title="Result" testId="results">
        {results.isPending && <Skeleton label="Loading results" />}
        {results.isError && <RequestError error={results.error} onRetry={() => void results.refetch()} />}
        {latest && <ResultView result={latest} experiment={x} />}
        {results.data && results.data.items.length === 0 && (
          <div className="rounded-lg border border-border bg-card px-3.5 py-2.5 text-sm text-muted-foreground">
            <span className="text-foreground">No result before the sample and window.</span>{' '}
            {x.startedAt
              ? `Results stay hidden until every arm has ${x.minSamplePerArm.toLocaleString()} observations and the window ends ${windowEnd(x.startedAt, x.observationWindowHours).toLocaleString()}${pre?.stoppingRule.kind === 'sequential_msprt' ? ', or earlier under the pre-registered sequential rule' : ''}. No peeking.`
              : 'The experiment has not started; pre-register the design, then start it.'}
          </div>
        )}
        {(x.state === 'running' || x.state === 'stopped') && x.preRegistrationHash && (
          <div className="mt-4 border-t border-border pt-4">
            <ComputeResultsForm key={x.version} experiment={x} />
          </div>
        )}
      </Block>
      <Block id="prereg-heading" title="Pre-registration">
        <dl className="flex flex-col">
          {rows.map((r) => (
            <div
              key={r.k}
              className="grid grid-cols-[minmax(0,110px)_minmax(0,1fr)] gap-4 border-t border-border py-2.5 text-sm sm:grid-cols-[140px_minmax(0,1fr)]"
            >
              <dt className="text-muted-foreground">{r.k}</dt>
              <dd className="min-w-0 text-pretty" data-testid={r.testId}>
                {r.v}
              </dd>
            </div>
          ))}
        </dl>
      </Block>
      {actionUi && actionUi.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${actionUi.message} Managing an experiment needs experiment.manage for this brand.`}
          data-testid="experiment-denied"
        />
      )}
      {actionUi && actionUi.kind !== 'forbidden' && actionError && (
        <RequestError error={actionError.error} title="The action was not applied" />
      )}
      <div className="flex flex-wrap items-end gap-2" role="group" aria-label="Experiment actions">
        {x.state === 'designed' && (
          <>
            <Button
              variant="primary"
              onClick={() => preRegister.mutate({ experimentId: x.id, expectedVersion: x.version })}
              disabled={preRegister.isPending}
            >
              {preRegister.isPending ? 'Freezing…' : 'Pre-register (freeze design)'}
            </Button>
            <span className="self-center text-xs text-muted-foreground">
              Freezes the design with a hash; nothing about it can change afterwards.
            </span>
          </>
        )}
        {x.state === 'pre_registered' && (
          <>
            <Button
              variant="primary"
              onClick={() => start.mutate({ experimentId: x.id, expectedVersion: x.version })}
              disabled={start.isPending}
            >
              {start.isPending ? 'Starting…' : 'Start'}
            </Button>
            <span className="self-center text-xs text-muted-foreground">
              Starts the {windowText(x.observationWindowHours)} observation window.
            </span>
          </>
        )}
        {x.state === 'running' && (
          <>
            <Field label="Stop reason (optional)" htmlFor="stop-reason" className="min-w-48 flex-1">
              <Input id="stop-reason" value={stopReason} onChange={(e) => setStopReason(e.target.value)} />
            </Field>
            <Button
              variant="danger"
              onClick={() =>
                stop.mutate({
                  experimentId: x.id,
                  expectedVersion: x.version,
                  ...(stopReason.trim() ? { reason: stopReason.trim() } : {}),
                })
              }
              disabled={stop.isPending}
            >
              {stop.isPending ? 'Stopping…' : 'Stop'}
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
