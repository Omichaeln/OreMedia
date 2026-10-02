# Technical SEO audit: the check catalogue (R2-4)

The audit is a bounded crawl of a brand's own website (a `cms_site` destination's origin, never a free URL),
run weekly by `seoAuditSweepWorkflowV1` (Mondays 05:00 UTC, task queue `ingest-metrics`, worker-ingest) and on
demand through `destinations.audit.run` (`seo_audit.run`: admins and publishers; never an agent). It runs only
when the brand's source-use policy allows `read` of `cms.audit` (D-17); with `retain` the policy's
`retentionDays` applies to the stored runs, otherwise the last 4 runs per website are kept.

**Lab data only.** Every figure below is what the crawler measured when it fetched the page. Field data (real-user
measurements) is not connected: `destinations.audit.summary` says so (`data.note`) and carries `fieldData: null`
for a later connector. Nothing is fabricated to fill the slot.

## Findings as tracked work (RA-11)

A finding is one check across one run (`findingId` = `<runId>:<check>`). `destinations.audit.createWork` (one or
many checks of a run, the last finished one by default; `insight.manage`: managers and analysts, never an agent)
turns each into the product's trackable work object, a recommendation (`create_brief`, spec 16.4), whose chain
starts from an observed insight carrying the provenance as evidence: the finding, the run, the rule, the website
and the example pages. The link lives in `seo_finding_work` (tenant and brand scoped, one open row per
destination and check): a second call for a tracked finding returns the existing item. The findings list carries
each finding's `status` and `work`: `open` (nothing tracks it), `tracked` (its recommendation, with title and
state read from the intelligence module, and a link back from the Performance screen), `resolved` (a later
completed run no longer reported the check: the finish marks the row with that run; a failed run resolves
nothing). A check that comes back after that is open again and may become new work. The audit record is
`seo_audit.work_created` with the finding as scope and the recommendation as downstream.

## Limits (every one is a hard cap; a run records which it hit in `limitsHit`)

| Cap                   | Value                                          | Where it is enforced                                  |
| --------------------- | ---------------------------------------------- | ----------------------------------------------------- |
| Pages per run         | 200 (`max_pages`)                              | the workflow (one page per activity)                  |
| Link depth            | 3 from the seeds (`max_depth`)                 | the workflow                                          |
| Run deadline          | 20 minutes (`deadline`)                        | the workflow clock                                    |
| Pause between fetches | ≥ 250 ms                                       | the workflow                                          |
| Bytes per page        | 2 MiB (read truncated beyond)                  | `fetchPageBounded` (packages/providers/page-fetch.ts) |
| Time per fetch        | 10 s                                           | the ProviderIO timeout                                |
| Redirect hops         | 3, each re-checked and pinned to the origin    | `fetchPageBounded`                                    |
| Sitemap seeds         | 200 URLs (`sitemap_seeds`), index 1 level deep | the plan activity                                     |
| robots.txt rules      | 200 `Disallow` rules for `*` (`robots_rules`)  | the plan activity                                     |

Scope: same-origin links only (`<a href>`), robots.txt `Disallow` rules for `User-agent: *` respected (`*` and
`$` in a rule; `Allow` and other agents ignored), every URL through `assertSafeUrl` (https, no credentials, no
blocked address; DNS pinned by the dispatcher), no credentials sent. A page body never enters Temporal or the
database: the stored data is URLs, status, check results and hashes (sha-256 of the lower-cased title and meta
description, for the duplicate checks) plus the same-origin links a page carried (at most 50 per page, so a run's
activity results stay under ~5 MB of Temporal history).

## Per-page checks (`seo_audit_pages.checks`)

| Key                | Passes when                                                | Fails as                                                     |
| ------------------ | ---------------------------------------------------------- | ------------------------------------------------------------ |
| `status`           | 200                                                        | 4xx major (`status=404`); 5xx critical; unreachable critical |
| `redirect_chain`   | at most one hop                                            | minor (`hops=n`)                                             |
| `title`            | present, ≤ 60 characters                                   | missing major; > 70 major; 61–70 minor (`length=n`)          |
| `meta_description` | present, 50–160 characters                                 | missing major; off-length minor (`length=n`)                 |
| `h1`               | exactly one                                                | none major (`count=0`); several minor (`count=n`)            |
| `canonical`        | present and on the site's origin (self-referencing or not) | missing minor; another origin major                          |
| `robots_meta`      | no `noindex` / `nofollow` in `robots` or `googlebot`       | `noindex` critical; `nofollow` minor                         |
| `viewport`         | a viewport meta                                            | minor                                                        |
| `lang`             | `<html lang>`                                              | minor                                                        |
| `image_alt`        | every `<img>` has an `alt` (empty counts as present)       | minor (`count=n`)                                            |
| `hreflang`         | absent, or absolute URLs including the page itself         | relative minor; no self-reference minor                      |
| `structured_data`  | at least one `application/ld+json` block, all parse        | absent minor; invalid JSON major                             |
| `page_size`        | ≤ 1.5 MiB and not truncated                                | > 1.5 MiB minor (`bytes=n`); truncated at 2 MiB major        |
| `mixed_content`    | no `http://` subresource on an https page                  | major (`count=n`)                                            |

A page that is not 200 or not HTML gets `status` and `redirect_chain` only. A page's `severity` is its worst
failed check (`ok` when none).

## Cross-page checks (added at finish, over the whole crawl)

| Key                     | Fails as                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `broken_links`          | major: same-origin links on the page whose target the crawl fetched with status ≥ 400 (`count=n`) |
| `duplicate_title`       | minor: the title (case-folded) is shared with other crawled pages (`count=` pages sharing it)     |
| `duplicate_description` | minor: as above for the meta description                                                          |

## Findings → tasks

`destinations.audit.findings` groups the run's failing checks: one finding per check with the worst severity,
the number of failing pages, up to 5 example URLs and a `suggestedTask` from the rule table in
`packages/modules/destinations/src/audit-crawl.ts` (`FINDING_RULES`; generic wording, no vendor named). Findings
are read-only: the Performance screen's Audit section offers "Copy task" so a person carries the task into a
brief. Nothing creates briefs or recommendations from an audit on its own.

## Run record (`seo_audit_runs`)

`outcome` is `running` until the finish activity closes it as `completed` (the origin answered and pages were
recorded) or `failed` (`origin_unreachable`, or `abandoned` when a later plan found it open past 30 minutes);
`reason` also carries `failed_pages=n` when activities failed after retries, or the plan's skip reason (`locked`,
`no_policy`, …) when an on-demand row's workflow did not crawl. The per-destination lock is released when the
run closes or the plan skips. Activity failures `PolicyDenied`, `ValidationFailed` and `NotFound` are
deliberately non-retryable in `seoAuditWorkflowV1`: a refused or unknown destination or run never retries. `summary` holds the counts of pages
by worst severity and of failing pages by check. An on-demand run is idempotent per website per day (the run of
the day is returned) and refused with CONFLICT while one is in progress.
