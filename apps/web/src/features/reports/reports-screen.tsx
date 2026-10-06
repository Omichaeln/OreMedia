import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import { REPORT_SECTIONS, type ReportSection } from '@oremedia/contracts/reports';
import {
  Button,
  EmptyState,
  Field,
  Input,
  Skeleton,
  StatusBanner,
  StatusDot,
  Textarea,
  cn,
} from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { useToast } from '../../components/toast';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { hasCredential } from '../../lib/session';
import { useTRPC } from '../../lib/trpc';
import { useBrandFonts } from '../assets/use-assets';
import { useFontFaces } from '../assets/use-font-faces';
import { brandPath, useBrandContext } from '../brand/brand-context';
import { useBrandVersion, useBrands } from '../brand/use-brand';
import { useCalendarRange } from '../publishing/use-publishing';
import { useSessionUser } from '../session/use-session-user';
import { ReportPages } from './report-pages';
import {
  DEFAULT_FIELDS,
  currentMonth,
  fieldsOf,
  kitOf,
  monthLabel,
  monthOptions,
  pageNumber,
  pageOrder,
  sameFields,
  sectionLabel,
  stateLabel,
} from './report-helpers';
import {
  useReport,
  useReportDelivery,
  useReportFigures,
  useReportPreferences,
  useReports,
  type ReportAskDto,
} from './use-reports';

const SECTION_HEADING = 'om-label mb-1.5';
const PAGE_WIDTH = 794;
const CONTENT_SECTIONS: readonly ReportSection[] = ['overview', 'channels', 'posts', 'recommendations'];

interface ChatLine {
  me: boolean;
  text: string;
}

/**
 * D-29 Reports, as the supplied interface lays it out: a 300 px builder column (recent reports, the report's
 * brand, month and comparison, the sections with their page numbers, the executive summary with a model draft,
 * the report assistant, prepared-for/by, the brand kit and theme, the delivery note and the actions) beside the
 * preview pages at the interface's sizes. Every figure is the measurement module's (reports.figures); the summary
 * and the assistant's text are drafts the person edits and saves; the send is recorded, never claimed, on a
 * deployment with no delivery; Download PDF prints the pages (A4, one per section).
 */
export function ReportsScreen() {
  const { companyId, companyName, brandId, brand } = useBrandContext();
  const timeZone = brand.timezone || 'UTC';
  const navigate = useNavigate();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const nowMonth = useMemo(() => currentMonth(new Date(), timeZone), [timeZone]);
  const months = monthOptions(nowMonth);
  const periodMonth = months.includes(params.get('month') ?? '') ? (params.get('month') as string) : nowMonth;
  const setMonth = (m: string) => {
    const p = new URLSearchParams(params);
    if (m === nowMonth) p.delete('month');
    else p.set('month', m);
    setParams(p, { replace: true });
  };

  const user = useSessionUser(hasCredential());
  const brands = useBrands();
  const reports = useReports(brandId);
  const report = useReport(brandId, periodMonth);
  const delivery = useReportDelivery(brandId);
  const preferences = useReportPreferences(brandId);
  const version = useBrandVersion(brandId, brand.publishedVersionId);
  const fonts = useBrandFonts(brandId);

  const defaults = useMemo(
    () => DEFAULT_FIELDS(brand.name, [user.data?.name, companyName].filter(Boolean).join(', ')),
    [brand.name, user.data?.name, companyName],
  );
  const [fields, setFields] = useState(defaults);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  // The form follows the month: the saved report's fields, or the defaults until one is saved.
  useEffect(() => {
    if (!report.isSuccess) return;
    const key = `${periodMonth}:${report.data?.version ?? 'new'}`;
    if (loadedFor === key) return;
    setLoadedFor(key);
    setFields(report.data ? fieldsOf(report.data) : defaults);
    setDrafted(report.data ? null : null);
  }, [report.isSuccess, report.data, periodMonth, defaults, loadedFor]);
  const saved = report.data ? fieldsOf(report.data) : null;
  const dirty = saved ? !sameFields(saved, fields) : !sameFields(defaults, fields);
  const set = <K extends keyof typeof fields>(key: K, value: (typeof fields)[K]) =>
    setFields((f) => ({ ...f, [key]: value }));

  const figures = useReportFigures(brandId, periodMonth, fields.compareMode);
  const calendar = useCalendarRange(
    brandId,
    figures.data?.window.start ?? '',
    figures.data?.window.end ?? '',
  );
  const packageOf = useMemo(
    () => new Map((calendar.data?.publications ?? []).map((p) => [p.publicationId, p.contentPackageId])),
    [calendar.data],
  );

  // The brand kit: colours and the display face from the published brand system, else the fallback (said so).
  const document = version.data ? BrandSystemDocumentV1.parse(version.data.document) : null;
  const kit = useMemo(() => kitOf(document), [document]);
  const face = kit.displayFontRef
    ? (fonts.data?.items.find(
        (f) => f.assetId === kit.displayFontRef || f.assetVersionId === kit.displayFontRef,
      ) ?? null)
    : null;
  const fontFiles = useMemo(
    () =>
      face
        ? face.files.map((x) => ({
            family: face.assetVersionId,
            assetVersionId: x.assetVersionId,
            unicodeRange: x.unicodeRange,
          }))
        : [],
    [face],
  );
  const loadedFaces = useFontFaces(fontFiles);
  const displayFamily = face && loadedFaces.has(face.assetVersionId) ? face.assetVersionId : null;

  // Preview scale: the pages keep their size and the column scales them to fit (the interface's zoom).
  const previewRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const fit = () => setZoom(Math.min(1, Math.max(0.3, (el.clientWidth - 48) / PAGE_WIDTH)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- mutations ----
  const invalidate = () => void queryClient.invalidateQueries(trpc.reports.pathFilter());
  const saveIntent = useIntentKey();
  const save = useMutation(
    trpc.reports.save.mutationOptions({
      ...mutationIntent(saveIntent.key),
      onSuccess: (r) => {
        saveIntent.renew();
        setLoadedFor(`${periodMonth}:${r.version}`);
        invalidate();
        toast({ tone: 'good', title: 'Draft saved' });
      },
    }),
  );
  const sendIntent = useIntentKey();
  const markSent = useMutation(
    trpc.reports.markSent.mutationOptions({
      ...mutationIntent(sendIntent.key),
      onSuccess: (r) => {
        sendIntent.renew();
        setSendOpen(false);
        setLoadedFor(`${periodMonth}:${r.version}`);
        invalidate();
        toast({
          tone: 'good',
          title: `Marked as sent to ${r.sentTo ?? ''}`,
          description: 'Nothing was emailed: send the PDF yourself.',
        });
      },
    }),
  );
  const draftIntent = useIntentKey();
  const [drafted, setDrafted] = useState<string | null>(null);
  const draft = useMutation(
    trpc.reports.draftSummary.mutationOptions({
      ...mutationIntent(draftIntent.key),
      onSuccess: (res) => {
        draftIntent.renew();
        if (res.available) {
          set('executiveSummary', res.text);
          setDrafted(res.text);
          toast({
            tone: 'good',
            title: 'Summary drafted from this month’s figures',
            description: 'A draft: read it before it goes out.',
          });
        } else
          toast({ tone: 'warning', title: 'The summary could not be drafted', description: res.message });
      },
    }),
  );
  const askIntent = useIntentKey();
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [question, setQuestion] = useState('');
  const [proposal, setProposal] = useState<Extract<ReportAskDto, { available: true }> | null>(null);
  const [added, setAdded] = useState<Array<{ section: ReportSection; text: string }>>([]);
  const ask = useMutation(
    trpc.reports.ask.mutationOptions({
      ...mutationIntent(askIntent.key),
      onSuccess: (res) => {
        askIntent.renew();
        if (res.available) {
          setProposal(res);
          setChat((c) => [...c, { me: false, text: res.reply }]);
        } else setChat((c) => [...c, { me: false, text: res.message }]);
      },
      onError: (err) => setChat((c) => [...c, { me: false, text: toUiError(err).message }]),
    }),
  );
  const submitAsk = (e: FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || ask.isPending) return;
    setChat((c) => [...c, { me: true, text: q }]);
    setQuestion('');
    setProposal(null);
    ask.mutate({ brandId, periodMonth, compareMode: fields.compareMode, question: q });
  };
  const accept = () => {
    if (!proposal) return;
    const text = proposal.text.trim();
    if (proposal.section === 'recommendations')
      set('recommendations', [fields.recommendations, text].filter(Boolean).join('\n\n'));
    else set('executiveSummary', [fields.executiveSummary, text].filter(Boolean).join('\n\n'));
    if (!fields.sections.includes(proposal.section === 'recommendations' ? 'recommendations' : 'overview'))
      set('sections', [
        ...fields.sections,
        proposal.section === 'recommendations' ? 'recommendations' : 'overview',
      ]);
    setAdded((a) => [...a, { section: proposal.section, text }]);
    setChat((c) => [
      ...c,
      {
        me: false,
        text: `Added to ${proposal.section === 'recommendations' ? 'Recommendations' : 'the executive summary'}. Save the draft to keep it.`,
      },
    ]);
    setProposal(null);
  };
  const prefIntent = useIntentKey();
  const setPreference = useMutation(
    trpc.reports.preferences.set.mutationOptions({
      ...mutationIntent(prefIntent.key),
      onSuccess: (res) => {
        prefIntent.renew();
        invalidate();
        toast({
          tone: 'info',
          title: res.autoDraft ? 'Automatic drafts switched on' : 'Automatic drafts off',
          description: res.scheduleActive
            ? undefined
            : 'Stored as a preference: no job drafts on the 1st on this deployment yet.',
        });
      },
    }),
  );

  const [sendOpen, setSendOpen] = useState(false);
  const [sendTo, setSendTo] = useState('');
  const doSave = () =>
    save.mutate({ brandId, periodMonth, expectedVersion: report.data?.version ?? null, fields });
  const doMarkSent = (e: FormEvent) => {
    e.preventDefault();
    if (!report.data || !sendTo.trim()) return;
    markSent.mutate({
      brandId,
      reportId: report.data.id,
      expectedVersion: report.data.version,
      sentTo: sendTo.trim(),
    });
  };
  const download = () => {
    const t0 = window.document.title;
    window.document.title = `${brand.name} — Marketing report — ${monthLabel(periodMonth)}`;
    window.setTimeout(() => {
      window.print();
      window.document.title = t0;
    }, 150);
  };
  const toggleSection = (s: ReportSection) => {
    const next = fields.sections.includes(s)
      ? fields.sections.filter((x) => x !== s)
      : [...fields.sections, s];
    if (!CONTENT_SECTIONS.some((x) => next.includes(x))) {
      toast({ tone: 'warning', title: 'Keep at least one content section' });
      return;
    }
    set('sections', next);
  };
  const order = pageOrder(fields.sections);
  const edited = drafted !== null && fields.executiveSummary !== drafted;
  const summaryNote =
    drafted !== null && !edited
      ? 'Drafted by the model from this month’s figures · a draft, edit freely'
      : fields.executiveSummary
        ? 'Your wording is used in the report'
        : 'Write the summary, or draft it from this month’s figures';
  const mutationError = [save, markSent, draft, setPreference].find((m) => m.isError);
  const stale = figures.data && figures.data.freshness.staleValues > 0;
  const freshText = !figures.data
    ? 'Checking the channels’ figures…'
    : figures.data.freshness.valuesWithData === 0
      ? 'No figures fetched for this month yet.'
      : stale
        ? `${figures.data.freshness.staleValues} of ${figures.data.freshness.valuesWithData} values are stale (past the provider’s reporting latency).`
        : 'All figures are current for the month.';
  const state = report.data ? stateLabel(report.data, timeZone) : null;

  return (
    <main
      id="main"
      className="om-in grid min-h-full grid-cols-1 items-start md:grid-cols-[300px_minmax(0,1fr)]"
      data-testid="reports-screen"
    >
      <div
        className="flex flex-col gap-[22px] border-b border-border bg-background px-6 pb-10 pt-7 md:sticky md:top-0 md:max-h-screen md:overflow-auto md:border-b-0 md:border-r print:hidden"
        data-print-hide=""
      >
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-bold tracking-title">Reports</h1>
          <p className="text-sm text-muted-foreground">
            Monthly client reports built from connected channel data and set in each brand’s published system.
          </p>
        </div>

        <section aria-labelledby="reports-recent" className="flex flex-col">
          <h2 id="reports-recent" className={SECTION_HEADING}>
            Recent
          </h2>
          {reports.isPending && <Skeleton label="Loading reports" lines={3} />}
          {reports.isError && <RequestError error={reports.error} onRetry={() => void reports.refetch()} />}
          {reports.isSuccess && reports.data.items.length === 0 && (
            <p className="border-t border-border py-2 text-xs text-muted-foreground">
              No reports saved for this brand yet. Save a draft to keep one.
            </p>
          )}
          {reports.isSuccess && reports.data.items.length > 0 && (
            <ul aria-label="Recent reports" data-testid="reports-recent" className="flex flex-col">
              {reports.data.items.map((r) => {
                const s = stateLabel(r, timeZone);
                const selected = r.periodMonth === periodMonth;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      aria-current={selected ? 'true' : undefined}
                      onClick={() => setMonth(r.periodMonth)}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 border-t border-border px-2 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                        selected ? 'bg-secondary' : 'hover:bg-muted',
                      )}
                    >
                      <span className="flex min-w-0 flex-col gap-px">
                        <span className="font-medium">{brand.name}</span>
                        <span className="text-xs text-muted-foreground">{monthLabel(r.periodMonth)}</span>
                      </span>
                      <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
                        <StatusDot tone={s.sent ? 'good' : 'warning'} size="sm" />
                        {s.label}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-labelledby="reports-report" className="flex flex-col gap-3">
          <h2 id="reports-report" className="om-label">
            Report
          </h2>
          <Field label="Brand" htmlFor="report-brand">
            <Select
              id="report-brand"
              value={brandId}
              onValueChange={(id) => {
                if (id !== brandId) void navigate(brandPath(companyId, id, 'reports'));
              }}
              options={(brands.data ?? [{ id: brandId, name: brand.name }]).map((b) => ({
                value: b.id,
                label: b.name,
              }))}
            />
          </Field>
          <Field label="Month" htmlFor="report-month">
            <Select
              id="report-month"
              value={periodMonth}
              onValueChange={setMonth}
              options={months.map((m) => ({ value: m, label: monthLabel(m) }))}
            />
          </Field>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground" id="report-compare">
              Compare with
            </span>
            <div
              role="group"
              aria-labelledby="report-compare"
              className="flex overflow-hidden rounded-lg border border-border bg-card"
            >
              {(
                [
                  ['previous_month', 'Previous month'],
                  ['last_year', 'Last year'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={fields.compareMode === k}
                  onClick={() => set('compareMode', k)}
                  className={cn(
                    'h-8 flex-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    fields.compareMode === k ? 'bg-secondary font-medium' : 'hover:bg-muted',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section aria-labelledby="reports-sections" className="flex flex-col">
          <h2 id="reports-sections" className={SECTION_HEADING}>
            Sections
          </h2>
          {REPORT_SECTIONS.map((s) => {
            const on = fields.sections.includes(s);
            return (
              <button
                key={s}
                type="button"
                role="checkbox"
                aria-checked={on}
                data-testid={`report-section-${s}`}
                onClick={() => toggleSection(s)}
                className="flex items-center gap-2.5 border-t border-border px-0.5 py-2 text-left text-sm hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded border text-2xs',
                    on ? 'border-primary bg-primary text-primary-foreground' : 'border-border-strong bg-card',
                  )}
                >
                  {on ? '✓' : ''}
                </span>
                <span className="flex-1">{sectionLabel(s)}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {on ? `p. ${pageNumber(order, s)}` : '—'}
                </span>
              </button>
            );
          })}
        </section>

        <section aria-labelledby="reports-summary" className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <h2 id="reports-summary" className="om-label">
              Executive summary
            </h2>
            <button
              type="button"
              onClick={() => draft.mutate({ brandId, periodMonth, compareMode: fields.compareMode })}
              disabled={draft.isPending || !figures.data}
              className="inline-flex min-h-6 items-center text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              {draft.isPending ? 'Drafting…' : 'Re-draft'}
            </button>
          </div>
          <Textarea
            id="report-summary"
            aria-label="Executive summary"
            data-testid="report-summary"
            rows={7}
            value={fields.executiveSummary}
            onChange={(e) => set('executiveSummary', e.target.value)}
            className="bg-card"
          />
          <span className="text-xs text-muted-foreground" data-testid="report-summary-note">
            {summaryNote}
          </span>
        </section>

        <section
          aria-labelledby="reports-assistant"
          className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3.5"
          data-testid="report-assistant"
        >
          <div className="flex items-baseline justify-between gap-2">
            <h2
              id="reports-assistant"
              className="text-2xs tabular-nums uppercase tracking-wider text-accent-ink"
            >
              Report assistant
            </h2>
            <span className="text-xs text-muted-foreground">
              {added.length ? `${added.length} added` : 'Writes in brand voice'}
            </span>
          </div>
          <div
            className="flex max-h-[260px] flex-col gap-2 overflow-auto"
            role="log"
            aria-label="Assistant conversation"
          >
            <p className="max-w-[92%] self-start rounded-xl border border-border bg-background px-2.5 py-1.5 text-xs leading-relaxed">
              Tell me what’s missing and I’ll write it in {brand.name}’s voice and place it in the right
              section. Every answer is a draft over this month’s figures; you add it, and the draft keeps it
              once saved.
            </p>
            {chat.map((m, i) => (
              <p
                key={i}
                className={cn(
                  'max-w-[92%] rounded-xl border px-2.5 py-1.5 text-xs leading-relaxed',
                  m.me
                    ? 'self-end border-primary bg-primary text-primary-foreground'
                    : 'self-start border-border bg-background',
                )}
              >
                {m.text}
              </p>
            ))}
            {ask.isPending && (
              <p className="text-xs text-muted-foreground" role="status">
                Drafting in {brand.name}’s voice…
              </p>
            )}
          </div>
          {proposal && (
            <div
              className="flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent-tint p-2.5"
              data-testid="report-proposal"
            >
              <span className="text-2xs uppercase tracking-wider text-accent-ink">
                Adds to · {sectionLabel(proposal.section)} · draft
              </span>
              <Textarea
                aria-label="Text to add"
                rows={4}
                value={proposal.text}
                onChange={(e) => setProposal({ ...proposal, text: e.target.value })}
                className="bg-card"
              />
              <div className="flex gap-1.5">
                <Button size="sm" variant="primary" onClick={accept}>
                  Add to report
                </Button>
                <Button size="sm" onClick={() => setProposal(null)}>
                  Discard
                </Button>
              </div>
            </div>
          )}
          <form onSubmit={submitAsk} className="flex gap-1.5">
            <Input
              aria-label="What’s missing from the report?"
              placeholder="What’s missing from the report?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              className="min-w-0 flex-1"
            />
            <Button type="submit" variant="primary" disabled={ask.isPending || !question.trim()}>
              Ask
            </Button>
          </form>
        </section>

        <section aria-label="Prepared for and by" className="flex flex-col gap-3">
          <Field label="Prepared for" htmlFor="report-for">
            <Input
              id="report-for"
              value={fields.preparedFor}
              onChange={(e) => set('preparedFor', e.target.value)}
              className="bg-card"
            />
          </Field>
          <Field label="Prepared by" htmlFor="report-by">
            <Input
              id="report-by"
              value={fields.preparedBy}
              onChange={(e) => set('preparedBy', e.target.value)}
              className="bg-card"
            />
          </Field>
        </section>

        <section
          aria-labelledby="reports-kit"
          className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3.5"
        >
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="reports-kit" className="text-sm font-medium">
              Brand kit
            </h2>
            <Link
              to={brandPath(companyId, brandId, 'system')}
              className="inline-flex min-h-6 items-center text-xs text-muted-foreground hover:text-foreground"
            >
              {version.data ? `Brand system v${version.data.number} · published →` : 'Brand system →'}
            </Link>
          </div>
          <span className="flex gap-1" aria-hidden="true">
            {kit.swatches.map((w, i) => (
              <span
                key={i}
                className="h-[22px] flex-1 rounded border border-border"
                style={{ background: w }}
              />
            ))}
          </span>
          <span className="text-xs text-muted-foreground">
            {version.data
              ? `${face ? (face.family ?? face.name) : 'No display face'} · colour and type pulled from the published version`
              : 'Nothing published yet: the report uses the fallback kit.'}
          </span>
          <div className="flex flex-col gap-1">
            <span id="report-theme" className="text-xs text-muted-foreground">
              Cover
            </span>
            <div
              role="group"
              aria-labelledby="report-theme"
              className="flex overflow-hidden rounded-lg border border-border"
            >
              {(['dark', 'light'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={fields.theme === k}
                  onClick={() => set('theme', k)}
                  className={cn(
                    'h-[30px] flex-1 text-xs capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    fields.theme === k ? 'bg-secondary font-medium' : 'hover:bg-muted',
                  )}
                >
                  {k}
                </button>
              ))}
            </div>
          </div>
        </section>

        <div className="flex items-start gap-2 text-xs text-muted-foreground" data-testid="report-freshness">
          <StatusDot
            tone={
              !figures.data
                ? 'neutral'
                : stale || figures.data.freshness.valuesWithData === 0
                  ? 'warning'
                  : 'good'
            }
            size="sm"
            className="mt-1.5"
          />
          <span className="flex-1">{freshText}</span>
        </div>

        {mutationError && <RequestError error={mutationError.error} onRetry={() => mutationError.reset()} />}
        <div className="flex flex-col gap-2">
          <Button variant="primary" className="h-[38px]" onClick={download} disabled={!figures.data}>
            Download PDF
          </Button>
          <div className="flex gap-2">
            <Button
              className="h-[34px] flex-1"
              aria-expanded={sendOpen}
              onClick={() => setSendOpen((o) => !o)}
            >
              Send to client
            </Button>
            <Button
              className="h-[34px] flex-1"
              onClick={doSave}
              disabled={save.isPending || (!dirty && Boolean(report.data))}
              data-testid="report-save"
            >
              {save.isPending ? 'Saving…' : 'Save draft'}
            </Button>
          </div>
          {sendOpen && (
            <form
              onSubmit={doMarkSent}
              className="om-pop flex flex-col gap-2 rounded-xl border border-border bg-card p-3"
              data-testid="report-send"
            >
              {delivery.isPending && <Skeleton label="Checking delivery" lines={1} />}
              {delivery.data && (
                <StatusBanner
                  tone="warning"
                  title="Email delivery is not configured"
                  description={`${delivery.data.email.reason} ${delivery.data.link.reason} ${delivery.data.pdf.note} Then record the send here.`}
                />
              )}
              {!report.data && (
                <p className="text-xs text-muted-foreground">Save the draft first, then mark it as sent.</p>
              )}
              <Field label="Sent to" htmlFor="report-send-to">
                <Input
                  id="report-send-to"
                  value={sendTo}
                  onChange={(e) => setSendTo(e.target.value)}
                  placeholder="client@example.com"
                />
              </Field>
              <Button
                type="submit"
                variant="primary"
                disabled={!report.data || !sendTo.trim() || markSent.isPending}
              >
                {markSent.isPending ? 'Recording…' : 'Mark as sent'}
              </Button>
              {state?.sent && (
                <p className="text-xs text-muted-foreground">
                  {state.label} to {report.data?.sentTo}.
                </p>
              )}
            </form>
          )}
          <button
            type="button"
            role="switch"
            aria-checked={preferences.data?.autoDraft ?? false}
            disabled={!preferences.data || setPreference.isPending}
            onClick={() =>
              preferences.data && setPreference.mutate({ brandId, autoDraft: !preferences.data.autoDraft })
            }
            className="flex items-start gap-2.5 pt-1.5 text-left text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            data-testid="report-auto-draft"
          >
            <span
              aria-hidden="true"
              className={cn(
                'relative mt-px h-4 w-7 shrink-0 rounded-full transition-colors',
                preferences.data?.autoDraft ? 'bg-primary' : 'bg-border-strong',
              )}
            >
              <span
                className={cn(
                  'absolute top-0.5 h-3 w-3 rounded-full bg-card transition-[left]',
                  preferences.data?.autoDraft ? 'left-3.5' : 'left-0.5',
                )}
              />
            </span>
            <span>
              Draft this report automatically on the 1st of each month
              {preferences.data && !preferences.data.scheduleActive && (
                <span className="block">
                  Stored as a preference: the schedule is not active on this deployment yet.
                </span>
              )}
            </span>
          </button>
        </div>
      </div>

      <div
        ref={previewRef}
        className="flex min-h-screen min-w-0 justify-center overflow-hidden bg-muted px-6 pb-20 pt-8 print:min-h-0 print:bg-card print:p-0"
        data-report-pages=""
      >
        {(figures.isPending || report.isPending) && (
          <div className="w-full max-w-md">
            <Skeleton label="Composing the report’s figures" lines={6} />
          </div>
        )}
        {figures.isError && (
          <div className="w-full max-w-md">
            <RequestError
              error={figures.error}
              onRetry={() => void figures.refetch()}
              title={
                toUiError(figures.error).kind === 'forbidden'
                  ? 'Restricted access: you cannot read this brand’s figures'
                  : undefined
              }
            />
          </div>
        )}
        {figures.isSuccess && report.isSuccess && order.length === 0 && (
          <EmptyState title="No pages" description="Switch a section on to see its page." />
        )}
        {figures.isSuccess && report.isSuccess && order.length > 0 && (
          <div
            className="flex flex-col items-center gap-7 print:gap-0"
            style={{ zoom }}
            data-testid="report-pages"
          >
            <ReportPages
              figures={figures.data}
              sections={fields.sections}
              theme={fields.theme}
              kit={kit}
              displayFamily={displayFamily}
              executiveSummary={fields.executiveSummary}
              recommendationsText={fields.recommendations}
              preparedFor={fields.preparedFor}
              preparedBy={fields.preparedBy}
              packageOf={packageOf}
              issuedAt={new Date()}
            />
          </div>
        )}
      </div>
    </main>
  );
}
