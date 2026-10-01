# Metric dictionary (D-15)

Decision D-15 of the production-UI programme (`docs/programme/production-ui/04-decision-log.md`): every metric is
classified before any aggregate is formed, and the classification decides what may be added together. This document
is the dictionary; the code that applies it is `kindFor` in `packages/contracts/src/measurement.ts` (the rule),
`aggregateByComparableGroup` in `packages/modules/measurement/src/normalise.ts` (the aggregate), and
`measurement.definitions.list`, which reports each definition's `kind`. The owner approves this document (D-14,
D-15); a change to a kind is a change here first, then in `kindFor`, with a definition version bump when a stored
number's meaning moves.

Status: **draft for owner approval** (Phase 1 / WP-6). The rules below are what the product does from this
release; the approval confirms or amends them.

## Kinds

| Kind       | What the number is                                                                    | Across posts of one brand                                               | Across days                           | Across platforms                                                   |
| ---------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| `flow`     | A count of events that happened (impressions, clicks, likes, comments, shares, saves) | Summed                                                                  | Summed                                | Summed only within the same comparable group                       |
| `unique`   | A count of distinct people (reach, unique viewers)                                    | **Never summed**: audiences overlap; shown per post                     | **Never summed**                      | **Never summed**                                                   |
| `snapshot` | A level at a moment (follower count)                                                  | Not summed; the latest value per account stands                         | The latest value; a series when asked | Never summed; listed side by side                                  |
| `gauge`    | An intensity or duration (watch time, retention curve)                                | Averaged when a mean is meaningful, else kept as series                 | Kept as series                        | Never summed; listed side by side                                  |
| `rate`     | numerator ÷ denominator of two flows                                                  | **Pooled**: Σ numerator ÷ Σ denominator, never a mean of per-post rates | Pooled over the days' flows           | Pooled only when both operands share their groups across platforms |

A number of kind `unique`, `snapshot` or `gauge` therefore has no total on a screen: the tile says so and the
per-post values stand. A rate always carries its denominator (the operand snapshot ids travel on every rate value,
spec 15.2). Currency stays per source; nothing here converts money.

## Comparable groups

Provider-native names map to one comparable group (`comparableGroupFor`, spec 15.1); a group has one kind.

| Comparable group    | Kind       | Unit   | Members by provider                                                                                                                                                                                                                 |
| ------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `impressions`       | `flow`     | count  | LinkedIn `impressionCount`; Instagram `views`; X `impression_count`; Facebook `page_media_view` (account)                                                                                                                           |
| `reach`             | `unique`   | count  | LinkedIn `uniqueImpressionsCount`; Instagram `reach`; Facebook `post_total_media_view_unique`, `page_total_media_view_unique`                                                                                                       |
| `engagement`        | `flow`     | count  | LinkedIn `engagement`; X `engagements`; Facebook `page_post_engagements`; Instagram `total_interactions`                                                                                                                            |
| `likes`             | `flow`     | count  | LinkedIn `likeCount`; Instagram `likes`; X `like_count`; Facebook `post_reactions_by_type_total`                                                                                                                                    |
| `comments`          | `flow`     | count  | LinkedIn `commentCount`; Instagram `comments`; X `reply_count`                                                                                                                                                                      |
| `shares`            | `flow`     | count  | LinkedIn `shareCount`; Instagram `shares`; X `retweet_count`, `quote_count`                                                                                                                                                         |
| `saves`             | `flow`     | count  | Instagram `saved`, `saves`; X `bookmark_count`                                                                                                                                                                                      |
| `clicks`            | `flow`     | count  | LinkedIn `clickCount`; X `url_link_clicks`, `user_profile_clicks`; Facebook `post_clicks`, `post_clicks_by_type`                                                                                                                    |
| `followers`         | `snapshot` | count  | Instagram `follower_count`; X `followers_count`; LinkedIn `followerGains.*` (gains are flows of a snapshot: shown per day, never summed with counts); Facebook `page_daily_follows`                                                 |
| `watch_time`        | `gauge`    | varies | Retention and duration metrics (`series` aggregation, spec 15.2)                                                                                                                                                                    |
| `negative_feedback` | `flow`     | count  | Hides, unfollows, reports, dislikes where a provider reports them                                                                                                                                                                   |
| `other:<name>`      | by name    | count  | A native name no rule recognises: a flow when its name counts something that happens, a unique count when it says unique, a rate when it says rate, percent or ratio, otherwise a gauge; never mixed with another provider's number |

## Derived rates (spec 15.2)

| Key                  | Group                         | Numerator ÷ denominator      | Across posts                                   |
| -------------------- | ----------------------------- | ---------------------------- | ---------------------------------------------- |
| `engagement_rate`    | `rate:engagement/impressions` | `engagement` ÷ `impressions` | Σ engagement ÷ Σ impressions of the same posts |
| `click_through_rate` | `rate:clicks/impressions`     | `clicks` ÷ `impressions`     | Σ clicks ÷ Σ impressions                       |
| `save_rate`          | `rate:saves/impressions`      | `saves` ÷ `impressions`      | Σ saves ÷ Σ impressions                        |

A zero or unavailable denominator makes the rate unavailable, never zero or infinity. A pooled rate exists only
when both operand flows are in the same result; otherwise the aggregate carries no value and the per-post rates
stand.

## Freshness, completeness and sample (spec 15.2, D-14)

- Every value carries `fetchedAt`, its age and the provider's reporting latency; it is stale beyond latency × 2.
- Unavailable is a row with no value, never zero; a partial operand makes a partial rate.
- Comparisons use the same post age on both sides (the +1/+3/+7/+28-day pulls), against the previous period of
  equal length (D-14). A comparison with fewer than 5 publications on either side reads "insufficient sample".
- Any rolling reference (an 8-week mean, for instance) is a separately named baseline and never relabels the
  period comparison.

## What a screen may show

- A total tile only for `flow` groups and pooled rates; a `unique`, `snapshot` or `gauge` tile reads "not summed"
  with the per-post values beneath.
- Every figure names its denominator or coverage: "n of m posts have numbers", "k stale".
- A brand-level rollup (UX-11) separates additive totals (flows, pooled rates) from non-additive figures (reach,
  followers), which are listed, never summed across brands.

## Web sources (R2-1: GA4 and Search Console reports)

The daily sweep stores one row per report, day and dimension set (`destination_report_rows`); the read model
(`destinations.reports.summary`, `rows`) forms the aggregates below with `webMetricSums` / `webMetricValues` in
`packages/contracts/src/destinations.ts`, the same rules as the kinds above. A day the platform did not return is
absent, never a zero; a metric a row does not carry adds nothing. Comparisons (D-14) use the previous window of
equal length in days and read "insufficient sample" below 5 days with data on either side.

| Metric                   | Source                   | Kind    | Aggregate across days and dimension values                                                                    |
| ------------------------ | ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------- |
| `sessions`               | GA4 (`ga4.*`)            | `flow`  | Summed                                                                                                        |
| `engagedSessions`        | GA4                      | `flow`  | Summed                                                                                                        |
| `keyEvents`              | GA4                      | `flow`  | Summed                                                                                                        |
| `totalUsers`             | GA4                      | `flow`  | Summed as user-days (a day's total users per row), labelled "Users (daily, summed)"; never presented as reach |
| `averageSessionDuration` | GA4                      | `gauge` | Mean weighted by `sessions`; never compared                                                                   |
| `engagementRate`         | derived (GA4)            | `rate`  | Σ `engagedSessions` ÷ Σ `sessions`                                                                            |
| `clicks`                 | Search Console (`gsc.*`) | `flow`  | Summed                                                                                                        |
| `impressions`            | Search Console           | `flow`  | Summed                                                                                                        |
| `ctr`                    | Search Console           | `rate`  | Σ `clicks` ÷ Σ `impressions` (the per-row `ctr` is never averaged)                                            |
| `position`               | Search Console           | `gauge` | Mean weighted by `impressions`; never compared                                                                |

Reports and their dimensions (the date is always a dimension): `ga4.acquisition` (`sessionDefaultChannelGroup`),
`ga4.landing_pages` (`landingPage`), `ga4.engagement` (none); `gsc.queries` (`query`), `gsc.pages` (`page`),
`gsc.countries_devices` (`country`, `device`). Freshness: a report is stale when its latest day ended more than
latency × 2 ago (GA4 48 h, Search Console 72 h). The opportunity queue (`destinations.reports.opportunities`) is
computed over the last 28 days: queries and pages with ≥ 100 impressions and a CTR below half the site's pooled CTR,
landing pages with ≥ 50 sessions and an engagement rate below half the property's pooled rate. AI search (D-19):
no figure; the screen links to the vendor's console.

## Technical SEO audit (R2-4)

The audit's checks, limits and findings are catalogued in [seo-audit.md](./seo-audit.md). They are lab data the
crawler measured, never field data; nothing in them is aggregated with the metrics above.

## Overview (R2-5)

`overview.summary` (`packages/modules/overview`, contract `OverviewSummaryV1`) composes the read models above for one
brand and one window of UTC day bounds; it forms no new number. Composition: the social figures are the brand rollup
(`measurement.metrics.brandSummary`: flows summed, rates pooled, unique counts / levels / gauges listed with the
dictionary's words, the D-14 sample on both sides), the per-channel coverage and freshness come from
`measurement.metrics.query` over the window's released publications grouped by channel, the web figures are each
destination's `destinations.reports.summary` tiles (the adapter's presentation names them) and the audit is
`destinations.audit.summary`. Labels: every figure carries its source (`Social channels`, or the destination with its
kind), its coverage in the source's unit (posts, days, pages) and its freshness (stale beyond latency × 2; the audit's
latency is the weekly sweep, 168 h). Source states, in one precedence: blocked by policy (D-17), not connected, no data,
stale, insufficient sample (D-14), fresh, each with its reason as a sentence. Limits: the policy blocks with the
Settings pointer, uncertified source adapters, the audit's lab-only data, AI search as a labelled external link and
never a figure (D-19), paid as "not connected" (R3-4: no paid-media connector; definitions marked
`separatesPaidOrganic` are named, nothing is split or estimated), native posts as "not observed" (ingestion collects
per publication Oremedia released), insufficient samples, stale sources and, when no post age is asked for, that the
social comparison is at each post's latest fetch rather than one post age (the Performance trend compares at one age).
