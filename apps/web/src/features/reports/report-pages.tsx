import type { ReactNode } from 'react';
import { REPORT_TOP_POSTS, type ReportSection } from '@oremedia/contracts/reports';
import { PackageTitle } from '../content/package-title';
import {
  compareShort,
  daysIn,
  dayOf,
  fmtChange,
  fmtK,
  fmtN,
  fmtPts,
  fmtRate,
  highlightsOf,
  kicker,
  monthLabel,
  monthName,
  pageNumber,
  pageOrder,
  shiftMonth,
  type ReportKit,
} from './report-helpers';
import type { ReportFiguresDto } from './use-reports';

/** The page as the interface draws it: A4 at 96 dpi, inline colours from the brand kit (never the app tokens). */
const PAGE = { width: 794, height: 1122 };
const GOOD = '#3f7a4a';
const BAD = '#a8432f';

export interface ReportPagesProps {
  figures: ReportFiguresDto;
  sections: readonly ReportSection[];
  theme: 'dark' | 'light';
  kit: ReportKit;
  /** The display face's CSS family once loaded, else null (the fallback face is used and said so). */
  displayFamily: string | null;
  executiveSummary: string;
  recommendationsText: string;
  preparedFor: string;
  preparedBy: string;
  /** publication id → content package id, for the post titles (the calendar's month). */
  packageOf: ReadonlyMap<string, string>;
  issuedAt: Date;
}

const Label = ({ color, children }: { color: string; children: ReactNode }) => (
  <span style={{ fontSize: 11, letterSpacing: '.12em', textTransform: 'uppercase', color }}>{children}</span>
);

/**
 * The preview pages (cover, Across every platform, Consolidated by channel, What people engaged with,
 * Recommendations) from the composed figures: every number is one the measurement module reported, under D-15
 * (reach is listed per post, never summed; the share bar and the trend are impressions, a flow) and D-14 (a
 * comparison below the sample reads so). `data-report-page` wrappers keep the app's dark theme out of the pages.
 */
export function ReportPages(p: ReportPagesProps) {
  const { figures: f, kit } = p;
  const order = pageOrder(p.sections);
  const cmp = compareShort(f.compareMonth, f.compareMode);
  const dark = p.theme === 'dark';
  const font = p.displayFamily ? `'${p.displayFamily}', Georgia, serif` : 'var(--font-sans)';
  const text = 'var(--font-sans)';
  const pageStyle = {
    width: PAGE.width,
    height: PAGE.height,
    flexShrink: 0,
    overflow: 'hidden',
    background: '#ffffff',
    color: kit.ink,
    fontFamily: text,
    display: 'flex',
    flexDirection: 'column' as const,
    padding: '44px 64px 32px',
    boxShadow: 'var(--shadow-card)',
  };
  const head = (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingBottom: 12,
        borderBottom: `1px solid ${kit.rule}`,
        fontSize: 10,
        letterSpacing: '.12em',
        textTransform: 'uppercase',
        color: kit.muted,
      }}
    >
      <span style={{ fontFamily: font, fontSize: 15, fontWeight: kit.displayWeight, textTransform: 'none', color: kit.ink }}>
        {f.brandName}
      </span>
      <span>{monthLabel(f.periodMonth)} · Marketing report</span>
    </div>
  );
  const foot = (section: ReportSection, left: ReactNode) => (
    <div
      style={{
        marginTop: 'auto',
        display: 'flex',
        justifyContent: 'space-between',
        borderTop: `1px solid ${kit.rule}`,
        paddingTop: 12,
        fontSize: 10,
        color: kit.muted,
      }}
    >
      <span>{left}</span>
      <span>
        {pageNumber(order, section)} / {order.length}
      </span>
    </div>
  );
  const title = (section: ReportSection, kick: string, h: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 36 }}>
      <span style={{ fontSize: 11, letterSpacing: '.14em', textTransform: 'uppercase', color: kit.accentInk }}>
        {kicker(order, section)} · {kick}
      </span>
      <h2 style={{ margin: 0, fontFamily: font, fontSize: 40, lineHeight: 1.05, fontWeight: kit.displayWeight, letterSpacing: '-.02em' }}>
        {h}
      </h2>
    </div>
  );
  const deltaColor = (c: number | null) => (c === null ? kit.muted : c >= 0 ? GOOD : BAD);
  const channelName = (id: string) => f.channels.find((c) => c.channelConnectionId === id)?.displayName ?? 'Channel';
  const postTitle = (id: string) => {
    const pkg = p.packageOf.get(id);
    return pkg ? <PackageTitle contentPackageId={pkg} /> : id;
  };
  const summaryParagraphs = p.executiveSummary.split(/\n{2,}/).filter((s) => s.trim());
  const byImpressions = f.channels.filter((c) => c.shareOfImpressions !== null);
  const byRate = [...f.channels].filter((c) => c.engagementRate !== null).sort((a, b) => (b.engagementRate as number) - (a.engagementRate as number));
  const pooled = f.figures.find((x) => x.kind === 'rate');
  const palette = [kit.accent, kit.second, kit.third, kit.muted];
  const colourOf = (i: number) => palette[i % palette.length] as string;
  const tiles = f.figures.filter((x) => ['impressions', 'reach', 'engagement', 'rate:engagement/impressions', 'clicks', 'likes', 'comments', 'shares'].includes(x.key));
  const trendMax = Math.max(0, ...f.trend.map((t) => t.impressions ?? 0));
  const featureName = f.formats[0]?.feature ?? null;
  const formats = featureName ? f.formats.filter((x) => x.feature === featureName).sort((a, b) => (b.rate as number) - (a.rate as number)) : [];
  const fMax = formats[0]?.rate ?? 0;
  const fBest = formats[0];
  const fWorst = formats[formats.length - 1];
  const nextMonth = monthName(shiftMonth(f.periodMonth, 1));
  const recText = p.recommendationsText.split(/\n{2,}/).filter((s) => s.trim());
  const issued = p.issuedAt.toLocaleDateString('en-GB', { timeZone: f.timeZone, day: 'numeric', month: 'short', year: 'numeric' });
  const sample = f.sample.sufficient
    ? `${f.sample.current} posts this month, ${f.sample.previous} ${cmp.replace('vs. ', 'in ')}: compared`
    : `${f.sample.current} and ${f.sample.previous} posts of ${f.sample.minimum} needed: insufficient sample, no change figures`;

  return (
    <>
      {order.includes('cover') && (
        <div
          data-report-page="cover"
          data-testid="report-page-cover"
          aria-label="Report cover"
          style={{
            ...pageStyle,
            background: dark ? kit.dark : kit.light,
            color: dark ? kit.light : kit.ink,
            padding: '64px 72px 56px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontFamily: font, fontSize: 24, fontWeight: kit.displayWeight, letterSpacing: '.08em' }}>{f.brandName}</span>
            <span style={{ fontSize: 11, letterSpacing: '.14em', textTransform: 'uppercase' }}>Marketing report</span>
          </div>
          <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 22 }}>
            <span style={{ fontSize: 12, letterSpacing: '.14em', textTransform: 'uppercase', color: dark ? kit.accent : kit.accentInk }}>
              {monthLabel(f.periodMonth)}
            </span>
            <span style={{ fontFamily: font, fontSize: 72, lineHeight: 1, fontWeight: kit.displayWeight, letterSpacing: '-.02em', textWrap: 'balance' }}>
              {monthName(f.periodMonth)} in review
            </span>
            <span style={{ fontSize: 16, lineHeight: 1.55, maxWidth: 480, textWrap: 'pretty' }}>
              Performance across {f.channels.length === 0 ? 'the connected channels' : f.channels.map((c) => c.displayName).join(', ')}, {cmp.replace('vs.', 'measured against')}.
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6, margin: '56px 0 28px' }}>
            {[kit.accent, kit.second, kit.third].map((w, i) => (
              <span key={i} style={{ width: 56, height: 8, background: w }} />
            ))}
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3,minmax(0,1fr))',
              gap: 24,
              borderTop: `1px solid ${dark ? 'rgba(255,255,255,.22)' : kit.rule}`,
              paddingTop: 18,
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            {[
              ['Prepared for', p.preparedFor || '—'],
              ['Prepared by', p.preparedBy || '—'],
              ['Period', `1 – ${daysIn(f.periodMonth)} ${monthLabel(f.periodMonth)}`],
            ].map(([k, v]) => (
              <span key={k} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: dark ? kit.accent : kit.accentInk }}>{k}</span>
                {v}
              </span>
            ))}
          </div>
        </div>
      )}

      {order.includes('overview') && (
        <div data-report-page="overview" data-testid="report-page-overview" aria-label="Report overview" style={pageStyle}>
          {head}
          {title('overview', 'Overall performance', 'Across every platform')}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }} data-testid="report-summary-preview">
            {summaryParagraphs.length === 0 ? (
              <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: kit.muted }}>No executive summary yet: write one, or draft it from this month’s figures.</p>
            ) : (
              summaryParagraphs.map((s, i) => (
                <p key={i} style={{ margin: 0, fontSize: 14, lineHeight: 1.6, textWrap: 'pretty' }}>
                  {s}
                </p>
              ))
            )}
          </div>
          <div style={{ marginTop: 26, display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', borderTop: `1px solid ${kit.ink}` }}>
            {tiles.map((x) => {
              const value = x.notSummed ? 'Not summed' : x.kind === 'rate' ? fmtRate(x.value) : fmtN(x.value);
              const delta = x.notSummed ? null : x.kind === 'rate' ? fmtPts(x.value, x.previous) : fmtChange(x.change);
              return (
                <div key={x.key} data-testid={`report-figure-${x.key}`} style={{ padding: '14px 12px 14px 0', borderBottom: `1px solid ${kit.rule}`, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 11, color: kit.muted }}>{x.label}</span>
                  <span style={{ fontFamily: font, fontSize: x.notSummed ? 18 : 28, fontWeight: kit.displayWeight, letterSpacing: '-.01em', lineHeight: 1.1 }}>{value}</span>
                  <span style={{ fontSize: 11, color: x.notSummed ? kit.muted : deltaColor(x.change) }}>
                    {x.notSummed
                      ? x.notSummed
                      : delta
                        ? <>{delta} <span style={{ color: kit.muted }}>{cmp}</span></>
                        : x.value === null
                          ? 'not reported'
                          : f.sample.sufficient
                            ? `${cmp.replace('vs.', 'no figure for')}`
                            : 'insufficient sample'}
                  </span>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 20, background: kit.dark, color: kit.light, padding: '18px 22px', display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: '10px 24px', alignItems: 'end' }} data-testid="report-sample">
            <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: kit.accent }}>Posts published · sample</span>
              <span style={{ fontFamily: font, fontSize: 34, fontWeight: kit.displayWeight, lineHeight: 1 }}>
                {f.sample.current} <span style={{ fontFamily: text, fontSize: 13 }}>{sample}</span>
              </span>
            </span>
            <span style={{ fontSize: 12, textAlign: 'right' }}>
              {pooled && pooled.coverage.withData > 0 ? `${pooled.coverage.withData} of ${pooled.coverage.requested} posts have numbers` : 'No post has numbers yet'}
            </span>
            <span style={{ gridColumn: '1/-1', height: 4, background: 'rgba(255,255,255,.18)' }}>
              <span style={{ display: 'block', height: '100%', width: `${pooled && pooled.coverage.requested ? Math.round((pooled.coverage.withData / pooled.coverage.requested) * 100) : 0}%`, background: kit.accent }} />
            </span>
          </div>
          <div style={{ marginTop: 26, display: 'grid', gridTemplateColumns: 'minmax(0,1.1fr) minmax(0,1fr)', gap: 36 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Label color={kit.muted}>Impressions · last six months</Label>
              <div style={{ height: 170, display: 'flex', gap: 10, alignItems: 'stretch', borderBottom: `1px solid ${kit.ink}` }} role="img" aria-label={`Impressions by month: ${f.trend.map((t) => `${monthLabel(t.month)} ${t.impressions === null ? 'not reported' : fmtN(t.impressions)}`).join(', ')}`}>
                {f.trend.map((t, i) => (
                  <div key={t.month} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontSize: 10, color: kit.muted }}>{t.impressions === null ? 'n/a' : fmtK(t.impressions)}</span>
                    <span style={{ width: '100%', height: `${trendMax > 0 && t.impressions !== null ? Math.round((t.impressions / trendMax) * 82) : 0}%`, background: i === f.trend.length - 1 ? kit.accent : kit.rule }} />
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                {f.trend.map((t) => (
                  <span key={t.month} style={{ flex: 1, textAlign: 'center', fontSize: 10, color: kit.muted }}>{t.month.slice(5) === '01' ? `${t.month.slice(0, 4)} Jan` : monthName(t.month).slice(0, 3)}</span>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Label color={kit.muted}>Highlights</Label>
              <div style={{ marginTop: 6 }}>
                {highlightsOf(f, cmp).map((h, i) => (
                  <div key={i} style={{ display: 'flex', gap: 10, borderTop: `1px solid ${kit.rule}`, padding: '9px 0', fontSize: 12.5, lineHeight: 1.45 }}>
                    <span style={{ color: h.up ? GOOD : BAD }} aria-hidden="true">{h.up ? '↑' : '↓'}</span>
                    <span style={{ textWrap: 'pretty' }}>{h.text}</span>
                  </div>
                ))}
                {highlightsOf(f, cmp).length === 0 && <p style={{ margin: 0, fontSize: 12.5, color: kit.muted }}>Nothing to highlight: no post of the month carries a number yet.</p>}
              </div>
            </div>
          </div>
          {foot('overview', <>Confidential · prepared for {p.preparedFor || '—'}</>)}
        </div>
      )}

      {order.includes('channels') && (
        <div data-report-page="channels" data-testid="report-page-channels" aria-label="Report channels" style={pageStyle}>
          {head}
          {title('channels', 'Channel performance', 'Consolidated by channel')}
          <p style={{ margin: '6px 0 0', fontSize: 14, lineHeight: 1.6, textWrap: 'pretty' }}>
            {byImpressions[0]
              ? `${byImpressions[0].displayName} delivered ${fmtRate(byImpressions[0].shareOfImpressions)} of impressions.`
              : 'No channel reported impressions this month.'}{' '}
            {byRate[0] ? `${byRate[0].displayName} returned the highest engagement rate at ${fmtRate(byRate[0].engagementRate)}${pooled?.value !== null && pooled ? `, against ${fmtRate(pooled.value)} pooled across channels` : ''}.` : ''}
          </p>
          <div style={{ marginTop: 28, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Label color={kit.muted}>Share of impressions</Label>
            <div style={{ display: 'flex', height: 14, gap: 2 }} role="img" aria-label={`Share of impressions: ${byImpressions.map((c) => `${c.displayName} ${fmtRate(c.shareOfImpressions)}`).join(', ')}`}>
              {byImpressions.map((c, i) => (
                <span key={c.channelConnectionId} style={{ width: `${(c.shareOfImpressions as number) * 100}%`, background: colourOf(i) }} />
              ))}
            </div>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 11 }}>
              {byImpressions.map((c, i) => (
                <span key={c.channelConnectionId} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, background: colourOf(i) }} />
                  {c.displayName} · {fmtRate(c.shareOfImpressions)}
                </span>
              ))}
            </div>
          </div>
          <table style={{ marginTop: 26, width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <caption className="sr-only">Channels of the month</caption>
            <thead>
              <tr style={{ fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', color: kit.muted }}>
                {['Channel', 'Posts', 'Impressions', 'Engagements', 'Eng. rate', 'Clicks', 'Impr. Δ'].map((h, i) => (
                  <th key={h} scope="col" style={{ textAlign: i === 0 ? 'left' : 'right', fontWeight: 400, padding: '0 0 8px', borderBottom: `1px solid ${kit.ink}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {f.channels.map((c, i) => (
                <tr key={c.channelConnectionId} data-testid={`report-channel-${c.channelConnectionId}`}>
                  <th scope="row" style={{ textAlign: 'left', fontWeight: 500, padding: '11px 0', borderBottom: `1px solid ${kit.rule}` }}>
                    <span style={{ display: 'inline-block', width: 8, height: 8, background: colourOf(byImpressions.indexOf(c) < 0 ? i : byImpressions.indexOf(c)), marginRight: 8 }} />
                    {c.displayName}
                  </th>
                  {[String(c.publications), fmtN(c.impressions), fmtN(c.engagement), fmtRate(c.engagementRate), fmtN(c.clicks)].map((v, j) => (
                    <td key={j} style={{ textAlign: 'right', padding: '11px 0', borderBottom: `1px solid ${kit.rule}` }}>{v}</td>
                  ))}
                  <td style={{ textAlign: 'right', padding: '11px 0', borderBottom: `1px solid ${kit.rule}`, color: deltaColor(c.impressionsChange) }}>
                    {fmtChange(c.impressionsChange) ?? (c.sufficient ? '—' : 'insufficient sample')}
                  </td>
                </tr>
              ))}
              <tr style={{ fontWeight: 700 }}>
                <th scope="row" style={{ textAlign: 'left', padding: '11px 0', borderBottom: `1px solid ${kit.ink}` }}>All channels</th>
                {[String(f.sample.current), fmtN(f.figures.find((x) => x.key === 'impressions')?.value ?? null), fmtN(f.figures.find((x) => x.key === 'engagement')?.value ?? null), fmtRate(pooled?.value ?? null), fmtN(f.figures.find((x) => x.key === 'clicks')?.value ?? null)].map((v, j) => (
                  <td key={j} style={{ textAlign: 'right', padding: '11px 0', borderBottom: `1px solid ${kit.ink}` }}>{v}</td>
                ))}
                <td style={{ textAlign: 'right', padding: '11px 0', borderBottom: `1px solid ${kit.ink}`, color: deltaColor(f.figures.find((x) => x.key === 'impressions')?.change ?? null) }}>
                  {fmtChange(f.figures.find((x) => x.key === 'impressions')?.change ?? null) ?? (f.sample.sufficient ? '—' : 'insufficient sample')}
                </td>
              </tr>
            </tbody>
          </table>
          <div style={{ marginTop: 30, display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: '24px 32px' }}>
            {f.channels.slice(0, 4).map((c, i) => (
              <div key={c.channelConnectionId} style={{ borderTop: `2px solid ${colourOf(byImpressions.indexOf(c) < 0 ? i : byImpressions.indexOf(c))}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontFamily: font, fontSize: 19, fontWeight: kit.displayWeight }}>{c.displayName}</span>
                <span style={{ fontSize: 12.5, lineHeight: 1.55, textWrap: 'pretty' }}>
                  {c.engagementRate === null ? 'No engagement rate: a post needs both engagements and impressions.' : `${fmtRate(c.engagementRate)} engagement rate from ${c.publications} posts`}
                  {c.impressionsChange !== null ? `; impressions ${c.impressionsChange >= 0 ? 'up' : 'down'} ${Math.abs(c.impressionsChange * 100).toFixed(1)}% ${cmp}.` : c.sufficient ? '.' : `; ${c.publications} and ${c.previousPublications} posts: insufficient sample to compare.`}
                  {c === byRate[0] && byRate.length > 1 ? ' Strongest engagement of any channel.' : ''}
                  {c === byImpressions[0] && byImpressions.length > 1 ? ' Largest share of impressions.' : ''}
                </span>
                <span style={{ fontSize: 11, color: kit.muted }}>
                  Best post · {c.bestPublicationId ? <>“{postTitle(c.bestPublicationId)}”</> : '—'}
                </span>
              </div>
            ))}
          </div>
          {foot('channels', <>Engagement rate = engagements ÷ impressions (pooled). Impr. Δ {cmp}.</>)}
        </div>
      )}

      {order.includes('posts') && (
        <div data-report-page="posts" data-testid="report-page-posts" aria-label="Report posts" style={pageStyle}>
          {head}
          {title('posts', 'Post performance', 'What people engaged with')}
          <p style={{ margin: '6px 0 0', fontSize: 14, lineHeight: 1.6, textWrap: 'pretty' }}>
            {f.posts.total} posts went out in {monthName(f.periodMonth)}; {f.posts.withNumbers} carry a number.
            {f.posts.topShare !== null ? ` The top ${Math.min(REPORT_TOP_POSTS, f.posts.ranked.length)} earned ${Math.round(f.posts.topShare * 100)}% of engagements among the posts tracked here.` : ''}
          </p>
          <table style={{ marginTop: 24, width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <caption className="sr-only">Top posts by engagements</caption>
            <thead>
              <tr style={{ fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', color: kit.muted }}>
                {['#', 'Top posts', 'Reach', 'Eng.', 'ER', 'Clicks'].map((h, i) => (
                  <th key={h} scope="col" style={{ textAlign: i < 2 ? 'left' : 'right', fontWeight: 400, padding: '0 0 8px', borderBottom: `1px solid ${kit.ink}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {f.posts.ranked.map((post, i) => (
                <tr key={post.publicationId} data-testid={`report-post-${post.publicationId}`}>
                  <td style={{ fontFamily: font, fontSize: 22, fontWeight: kit.displayWeight, color: kit.accentInk, padding: '10px 0', borderBottom: `1px solid ${kit.rule}`, width: 28 }}>{i + 1}</td>
                  <th scope="row" style={{ textAlign: 'left', padding: '10px 0', borderBottom: `1px solid ${kit.rule}` }}>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{postTitle(post.publicationId)}</span>
                      <span style={{ fontSize: 11, fontWeight: 400, color: kit.muted }}>{channelName(post.channelConnectionId)} · {dayOf(post.scheduledFor, f.timeZone)}{post.stale ? ' · stale' : ''}</span>
                    </span>
                  </th>
                  {[fmtN(post.reach), fmtN(post.engagement), fmtRate(post.engagementRate), fmtN(post.clicks)].map((v, j) => (
                    <td key={j} style={{ textAlign: 'right', padding: '10px 0', borderBottom: `1px solid ${kit.rule}` }}>{v}</td>
                  ))}
                </tr>
              ))}
              {f.posts.ranked.length === 0 && (
                <tr><td colSpan={6} style={{ padding: '10px 0', color: kit.muted }}>No post of the month carries a number yet.</td></tr>
              )}
            </tbody>
          </table>
          <div style={{ marginTop: 30, display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 36 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Label color={kit.muted}>Engagement rate by {featureName ? featureName.replace(/([A-Z])/g, ' $1').toLowerCase() : 'format'}</Label>
              {formats.map((x, i) => (
                <div key={x.value} style={{ display: 'grid', gridTemplateColumns: '96px minmax(0,1fr) 44px', gap: 10, alignItems: 'center', fontSize: 12 }}>
                  <span>{x.value}{x.sufficient ? '' : ' *'}</span>
                  <span style={{ height: 10, background: kit.light }}><span style={{ display: 'block', height: '100%', width: `${fMax > 0 ? Math.round(((x.rate as number) / fMax) * 100) : 0}%`, background: i === 0 ? kit.accent : kit.third }} /></span>
                  <span style={{ textAlign: 'right' }}>{fmtRate(x.rate)}</span>
                </div>
              ))}
              <span style={{ fontSize: 11, color: kit.muted }}>
                {formats.length === 0
                  ? 'No creative attributes captured for this month’s posts.'
                  : fBest && fWorst && fBest !== fWorst && (fWorst.rate as number) > 0
                    ? `${fBest.value} averaged ${((fBest.rate as number) / (fWorst.rate as number)).toFixed(1)}× the engagement rate of ${fWorst.value}.${formats.some((x) => !x.sufficient) ? ' * fewer than 5 posts.' : ''}`
                    : 'Pooled per value: engagements ÷ impressions.'}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Label color={kit.muted}>Below the line</Label>
              <div style={{ marginTop: 6 }}>
                {f.posts.lowest.map((post) => (
                  <div key={post.publicationId} style={{ display: 'flex', flexDirection: 'column', gap: 2, borderTop: `1px solid ${kit.rule}`, padding: '9px 0' }}>
                    <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12.5 }}>
                      <span style={{ fontWeight: 500 }}>{postTitle(post.publicationId)}</span>
                      <span>{fmtRate(post.engagementRate)}</span>
                    </span>
                    <span style={{ fontSize: 11, color: kit.muted }}>{channelName(post.channelConnectionId)} · {dayOf(post.scheduledFor, f.timeZone)} · {fmtN(post.impressions)} impressions</span>
                  </div>
                ))}
                {f.posts.lowest.length === 0 && <p style={{ margin: 0, fontSize: 12.5, color: kit.muted }}>Nothing below the line: fewer posts than the top list holds.</p>}
              </div>
            </div>
          </div>
          {foot('posts', <>{f.posts.total} posts published · ranked by engagements · reach is each post’s own, never summed</>)}
        </div>
      )}

      {order.includes('recommendations') && (
        <div data-report-page="recommendations" data-testid="report-page-recommendations" aria-label="Report recommendations" style={pageStyle}>
          {head}
          {title('recommendations', 'Next month', `Recommendations for ${nextMonth}`)}
          <div style={{ marginTop: 26, display: 'flex', flexDirection: 'column' }}>
            {f.recommendations.map((r, i) => (
              <div key={r.id} data-testid={`report-recommendation-${r.id}`} style={{ display: 'grid', gridTemplateColumns: '56px minmax(0,1fr)', gap: 16, borderTop: `1px solid ${kit.rule}`, padding: '20px 0' }}>
                <span style={{ fontFamily: font, fontSize: 34, fontWeight: kit.displayWeight, lineHeight: 1, color: kit.accentInk }}>{String(i + 1).padStart(2, '0')}</span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontFamily: font, fontSize: 21, fontWeight: kit.displayWeight, lineHeight: 1.2 }}>{r.title}</span>
                  <span style={{ fontSize: 13, lineHeight: 1.6, textWrap: 'pretty' }}>{r.rationale}</span>
                  <span style={{ fontSize: 11, color: kit.muted }}>Expected · {r.expectedBenefit.metricKey.replace(/_/g, ' ')} {r.expectedBenefit.direction}{r.expectedBenefit.magnitude ? ` · ${r.expectedBenefit.magnitude}` : ''} · {r.state}</span>
                </span>
              </div>
            ))}
            {recText.map((s, i) => (
              <div key={`t${i}`} style={{ display: 'grid', gridTemplateColumns: '56px minmax(0,1fr)', gap: 16, borderTop: `1px solid ${kit.rule}`, padding: '20px 8px', margin: '0 -8px', background: '#fbf3e4' }}>
                <span style={{ fontFamily: font, fontSize: 34, fontWeight: kit.displayWeight, lineHeight: 1, color: kit.accentInk }}>{String(f.recommendations.length + i + 1).padStart(2, '0')}</span>
                <span style={{ fontSize: 13, lineHeight: 1.6, textWrap: 'pretty' }}>{s}</span>
              </div>
            ))}
            {f.recommendations.length === 0 && recText.length === 0 && (
              <p style={{ margin: 0, fontSize: 13, color: kit.muted, borderTop: `1px solid ${kit.rule}`, padding: '20px 0' }}>No recommendations yet: the intelligence analyst has none for this brand, and none were written here.</p>
            )}
          </div>
          <div style={{ marginTop: 12, background: kit.light, padding: '22px 24px', display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: '18px 32px', fontSize: 11.5, lineHeight: 1.55, color: kit.ink }}>
            <span style={{ gridColumn: '1/-1' }}><Label color={kit.muted}>About this report</Label></span>
            {[
              ['Impressions', 'Times a post was shown, as reported by each platform; summed across posts and channels.'],
              ['Engagement rate', 'Engagements divided by impressions, pooled over the posts that carry both; never a mean of per-post rates.'],
              ['Reach', 'Unique accounts that saw a post, as each platform reports it; shown per post and never summed.'],
              ['Comparison', `Against ${monthLabel(f.compareMonth)}, ${f.compareMode === 'last_year' ? 'the same month last year' : 'the previous month'}; fewer than ${f.sample.minimum} posts on either side reads insufficient sample.`],
              ['Data sources', `${f.channels.map((c) => c.displayName).join(', ') || 'No channel'} via Oremedia. ${f.freshness.latestFetchedAt ? `Latest figures fetched ${new Date(f.freshness.latestFetchedAt).toLocaleDateString('en-GB', { timeZone: f.timeZone, day: 'numeric', month: 'short', year: 'numeric' })}` : 'No figures fetched'}${f.freshness.staleValues ? `; ${f.freshness.staleValues} of ${f.freshness.valuesWithData} values stale` : ''}.`],
            ].map(([k, v]) => (
              <span key={k} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontWeight: 700 }}>{k}</span>
                <span style={{ textWrap: 'pretty' }}>{v}</span>
              </span>
            ))}
          </div>
          <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 24 }}>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <span style={{ fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: kit.muted }}>Prepared by</span>
              {p.preparedBy || '—'} · Issued {issued}
            </span>
            <span style={{ fontFamily: font, fontSize: 20, fontWeight: kit.displayWeight }}>{f.brandName}</span>
          </div>
          <div style={{ marginTop: 18, display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${kit.rule}`, paddingTop: 12, fontSize: 10, color: kit.muted }}>
            <span>Confidential · prepared for {p.preparedFor || '—'}</span>
            <span>{pageNumber(order, 'recommendations')} / {order.length}</span>
          </div>
        </div>
      )}
    </>
  );
}
