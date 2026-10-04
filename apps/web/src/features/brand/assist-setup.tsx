import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ASSIST_SECTION_LABEL,
  AssistSection,
  type BrandAssistRequest,
} from '@oremedia/contracts/brand-assist';
import { Badge, Button, StatusBanner } from '@oremedia/ui';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { formatMicros } from '../agents/run-helpers';
import { useBrandContext } from './brand-context';
import { JobProgress, SuggestionReview } from './assist-review';
import { SourceAdders, SourceExplainer, SourceList, isUsableSource } from './assist-sources';
import { useAssistEstimate, useAssistJob, useBrandSources } from './use-assist';

/**
 * BSC-4 guided setup ("Set up your brand system", later "Import more sources"): add sources and see what each one
 * is, choose the sections, read the cost before starting, follow the job, then review its suggestions section by
 * section and take the accepted ones to the usual review and save of the proposed update.
 */

/** Start a job and say what stopped it, in words. */
export function useStartAssist(onStarted: (jobId: string) => void) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  return useMutation(
    trpc.brand.assist.start.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.brand.assist.pathFilter());
        onStarted(res.jobId);
      },
      onError: () => intent.renew(),
    }),
  );
}

/** The estimate of a request: the cost per section and whatever would stop it. */
export function EstimateLine({ request }: { request: BrandAssistRequest | null }) {
  const estimate = useAssistEstimate(request);
  if (!request) return null;
  if (estimate.isError)
    return (
      <StatusBanner
        tone="warning"
        title="The cost could not be estimated"
        description={toUiError(estimate.error).message}
      />
    );
  const e = estimate.data;
  if (!e) return <p className="text-sm text-muted-foreground">Estimating the cost…</p>;
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="assist-estimate" aria-live="polite">
      <p>
        Estimated cost <span className="font-medium tabular-nums">{formatMicros(e.estimateMicros)}</span> for{' '}
        {e.sections.length} section{e.sections.length === 1 ? '' : 's'}, reserved from the AI budget when it
        starts (only what is used is charged). Remaining today:{' '}
        <span className="tabular-nums">{formatMicros(e.remaining.dayMicros)}</span>.
      </p>
      {e.blockers.map((b) => (
        <p key={b.code} className="text-status-critical" data-testid="assist-blocker">
          {b.message}
        </p>
      ))}
    </div>
  );
}

export function AssistSetup({
  initialJobId,
  canDecide,
  onApply,
  onClose,
}: {
  initialJobId: string | null;
  canDecide: boolean;
  /** Opens the proposed update for review and save. */
  onApply: () => void;
  onClose: () => void;
}) {
  const { brandId } = useBrandContext();
  const [jobs, setJobs] = useState<string[]>(initialJobId ? [initialJobId] : []);
  const latest = jobs[0] ?? null;
  const job = useAssistJob(brandId, latest);
  const sources = useBrandSources(
    brandId,
    job.data !== undefined && !['ready', 'partially_ready', 'failed', 'cancelled'].includes(job.data.state),
  );
  // Every usable source is used unless the person leaves it out (new sources are used too).
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [sections, setSections] = useState<Set<AssistSection>>(new Set(AssistSection.options));
  const [adding, setAdding] = useState(jobs.length === 0);
  const usable = useMemo(
    () => (sources.data?.items ?? []).filter(isUsableSource).map((s) => s.id),
    [sources.data],
  );
  const chosen = useMemo(() => new Set(usable.filter((id) => !excluded.has(id))), [usable, excluded]);
  const sourceIds = usable.filter((id) => chosen.has(id));
  const request: BrandAssistRequest | null =
    sourceIds.length && sections.size
      ? { brandId, kind: 'setup', sections: AssistSection.options.filter((s) => sections.has(s)), sourceIds }
      : null;
  const start = useStartAssist((jobId) => {
    setJobs((j) => [jobId, ...j]);
    setAdding(false);
  });
  const startError = start.error ? toUiError(start.error) : null;
  const retry = (failed: AssistSection[]) =>
    job.data &&
    start.mutate({
      brandId,
      kind: 'section',
      sections: failed,
      sourceIds: job.data.sourceIds,
      instruction: 'Try again.',
    });
  const alternatives = (jobId: string) => (section: AssistSection) => {
    const of = jobId === latest ? job.data : undefined;
    start.mutate({
      brandId,
      kind: 'section',
      sections: [section],
      sourceIds: of?.sourceIds ?? sourceIds,
      alternativesForJobId: jobId,
      instruction: 'Offer different alternatives to the suggestions that were rejected.',
    });
  };
  const toggleSource = (id: string) =>
    setExcluded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <section aria-labelledby="assist-setup" className="flex flex-col gap-4" data-testid="assist-setup">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="assist-setup" className="text-lg font-semibold">
            {initialJobId || jobs.length
              ? 'Suggestions from your sources'
              : 'Set up your brand system from what you have'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Add your website and documents; AI reads them and suggests what each section of the brand system
            could say. You decide on every suggestion; nothing changes until you review and save the update.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!adding && (
            <Button size="sm" onClick={() => setAdding(true)}>
              Import more sources
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      {adding && (
        <div
          className="flex flex-col gap-4 rounded-md border border-border p-3"
          data-testid="assist-sources-step"
        >
          <h3 className="text-sm font-semibold">1. Add sources</h3>
          <SourceExplainer />
          <SourceAdders />
          <SourceList
            selected={chosen}
            onToggle={toggleSource}
            polling={sources.data?.items.some((s) => s.status === 'pending') ?? false}
          />
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-semibold">2. Choose the sections</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {AssistSection.options.map((s) => (
                <label key={s} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={sections.has(s)}
                    onChange={() =>
                      setSections((cur) => {
                        const next = new Set(cur);
                        if (next.has(s)) next.delete(s);
                        else next.add(s);
                        return next;
                      })
                    }
                  />
                  {ASSIST_SECTION_LABEL[s]}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">3. Start</h3>
            <EstimateLine request={request} />
            {!request && (
              <p className="text-sm text-muted-foreground">
                Add at least one source that can be read and choose at least one section.
              </p>
            )}
            {startError && (
              <StatusBanner
                tone="critical"
                title="Not started"
                description={startError.message}
                data-testid="assist-start-error"
              />
            )}
            <div>
              <Button
                variant="primary"
                size="sm"
                disabled={!request || start.isPending || !canDecide}
                disabledReason={canDecide ? undefined : 'A brand manager, admin or owner starts this'}
                onClick={() => request && start.mutate(request)}
              >
                {start.isPending ? 'Starting…' : 'Read the sources and suggest'}
              </Button>
            </div>
          </div>
        </div>
      )}
      {jobs.map((id) => (
        <AssistJobBlock
          key={id}
          jobId={id}
          canDecide={canDecide}
          onRetry={retry}
          onFollowUp={(next) => setJobs((j) => [next, ...j])}
          onAlternatives={alternatives(id)}
          onApply={onApply}
        />
      ))}
    </section>
  );
}

/** One job: its progress, then its suggestions to review. */
export function AssistJobBlock({
  jobId,
  canDecide,
  sections,
  onRetry,
  onFollowUp,
  onAlternatives,
  onApply,
}: {
  jobId: string;
  canDecide: boolean;
  sections?: AssistSection[];
  onRetry?: (sections: AssistSection[]) => void;
  onFollowUp: (jobId: string) => void;
  onAlternatives: (section: AssistSection) => void;
  onApply?: () => void;
}) {
  const { brandId } = useBrandContext();
  const job = useAssistJob(brandId, jobId);
  if (!job.data) return null;
  return (
    <div className="flex flex-col gap-3" data-testid="assist-job">
      {job.data.parentJobId && (
        <Badge tone="neutral" glyph={false}>
          Updated with your answers
        </Badge>
      )}
      <JobProgress job={job.data} {...(onRetry ? { onRetry } : {})} />
      <SuggestionReview
        jobId={jobId}
        canDecide={canDecide}
        onFollowUp={onFollowUp}
        onAlternatives={onAlternatives}
        {...(sections ? { sections } : {})}
        {...(onApply ? { onApply } : {})}
      />
    </div>
  );
}
