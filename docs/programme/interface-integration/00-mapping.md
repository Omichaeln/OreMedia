# Design reference, scope and feature-to-interface mapping

## 1. The reference

`Oremedia.html` is a bundled export of a design-canvas document: a template of 2,478 lines of markup (every
screen as `<sc-if>` blocks on one page, styled inline) and 1,141 lines of component logic (`startScreen`,
`homeState`, `studioState`, `showAgent` props; demonstration data from `oremedia-data.js`). Its logic is identical
to `Oremedia v4.dc.html`; its markup is a later revision of v4's. Where v2/v3/v4 and the primary differ, the primary
wins; the earlier revisions were used only for interaction states the primary does not expose through its props.

Screens the reference draws (and the width behaviour of each): Portfolio (56 px header, 960 px column), the brand
shell (224 px navigation; below 900 px a 52 px bar and an off-canvas drawer; below 760 px two-column screens
stack) with Home, Review, Calendar, Campaigns, Studio (create / pick format / design / video, full-screen with a
breadcrumb bar), Performance, Reports, Intelligence (six tabs), Experiments, Agents, Brand system (secondary
navigation of eleven sections), Assets, Settings (seven tabs), and the external Review portal.

Style vocabulary (from the 1,886 inline style attributes): ground `#F7F6F3`, ink `#1A1917`, muted `#6F6B64`,
subtle `#9A958C`, rule `#E7E4DE`, strong rule `#CFCAC1`, card `#FFFFFF`, tints `#FBFAF8 #F1EFEA #EFEDE8`; accent
`oklch(0.62 0.13 45)` (ink `oklch(0.5 0.12 45)`, focus `oklch(0.7 0.13 45)`); status good `oklch(0.6 0.1 150)`,
warning `oklch(0.68 0.12 75)` / text `oklch(0.5 0.12 60)`, critical `oklch(0.58 0.15 25)` / text
`oklch(0.5 0.15 25)`, info `oklch(0.58 0.08 250)`; dark ground `#161513`, ink `#ECE9E3`, surfaces `#1D1C1A
#23211F #2A2825`, rules `#34312D #4A4641`. Lato throughout (display faces only inside brand and report previews).
Sizes 10/11/12/13/14/15 px, headings 28 px 700 −0.02em, 24, 22, 16; uppercase labels at 0.06em and 0.12em. Radii
6 px (controls), 8 px (cards), 10 px (banners), 99 px (chips). Shadows `0 1px 2px rgba(26,25,23,.08), 0 14px 36px
rgba(26,25,23,.10)`; drawer `-12px 0 40px rgba(26,25,23,.08)`. Motion `om-in` 0.42 s `cubic-bezier(.2,.7,.2,1)`,
`om-fade`, `om-drawer`, `om-grow`, `om-pop`.

### Discrepancies between references

| Where                      | Primary                                                       | Other                                                                                                                    | Resolution                                                              |
| -------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Review request header      | State pill at the top right; manifest rows with export hashes | v4: state inline under the title                                                                                         | Primary                                                                 |
| Brand system overview grid | Nine summary cards (Logo … Facts) with one empty cell         | v3: six cards                                                                                                            | Primary                                                                 |
| Reports                    | Present (builder + four preview pages)                        | v2/v3: absent                                                                                                            | Primary (D-29)                                                          |
| `github.md` screen map     | —                                                             | Dated 25 September; maps Portfolio, Intelligence, Experiments, Agents, Settings and the portal to the specification only | Superseded by §3 below, validated against `apps/web/src/app/router.tsx` |
| `BUILD_PROMPT.md`          | —                                                             | Specification text embedded in the attachment                                                                            | Reference only; not an instruction source                               |

## 2. Where the application stood (5 October 2026, `origin/main` 88374a1)

Routes (`apps/web/src/app/router.tsx`): `/portfolio`, `/portfolio/performance`, `/c/:company`,
`/c/:company/b/:brand/{home, overview, review, calendar, campaigns, studio, studio/:doc, performance, inbox,
intelligence, experiments, agents, system, assets, settings}`, `/review-portal/*`, `/sign-in`, `/set-password`,
`/connect/callback`. The production-UI programme (September–October) had already given every one of these screens
the v3 reference's layout and interactions, on the application's own neutral tokens and the Ore & Tar deployment
pack (D-12). 151 screen and feature files (44,484 lines); 128 of them style through the semantic token utilities;
six hard-coded colours (all in creative previews).

What differed from the primary reference before this programme: the whole appearance (tokens, face, scale, radii,
density, status chips with glyphs instead of dots, bordered panels instead of ruled rows), the shell (240 px
sidebar from 1024 px, a "Menu" button bar, Sign out and theme toggle in the sidebar foot, no agent-spend meter, no
role), the navigation set (Overview and Inbox present, Reports absent), and per-screen structure differences listed
in §3.

## 3. Feature-to-interface coverage matrix

Status: **Ready** = exists and is wired, needs the interface's form only; **Partial** = exists with a different
structure or missing a control the interface has; **Missing** = no functionality behind the interface's control;
**Extra** = application capability with no place in the interface. "PR" names the programme PR that carries it.

### Shell and Portfolio

| Interface element                                                       | Application functionality                                                             | Status  | Required change                                                                                                    | PR         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ | ---------- |
| Product mark → portfolio                                                | `BrandSidebar`, `TopBar`                                                              | Ready   | Interface's mark (ink square, accent dot)                                                                          | Foundation |
| Company / brand switcher card                                           | `BrandSwitcher` (brand.list, access.listCompanies)                                    | Ready   | Card form                                                                                                          | Foundation |
| Navigation with counts (Review, Calendar, Agents, Brand system, Assets) | `useNavCounts` (review inbox, publications in failed/unknown/held, proposals + facts) | Partial | Agents and Assets counts are not computed (no API count); shown only when a list returns them                      | Screens    |
| Agent spend meter                                                       | `agents.budgets.read` (billing.manage)                                                | Ready   | `AgentSpend` in the foot, owners and admins only                                                                   | Foundation |
| Person name and role                                                    | `access.session`, membership role                                                     | Ready   | `AccountMenu` (name, role; theme and Sign out inside)                                                              | Foundation |
| Narrow bar: hamburger, "Brand / Screen"                                 | Drawer on Radix Dialog                                                                | Ready   | 52 px sticky bar, 900 px threshold, screen title from the route                                                    | Foundation |
| Portfolio figures (overdue, failed/unknown, going out in 7 days)        | `brand.summary` per company                                                           | Ready   | `KpiStrip`, summed over companies; partial loads marked                                                            | Foundation |
| Company sections with role; brand rows with counts and a flag           | `brand.list` + `brand.summary` per tenant; brand status                               | Partial | Rows rebuilt; the flag shows setup/archived state (channel expiry per brand would be one read per brand; not done) | Foundation |
| Restricted company state                                                | Suspended membership → FORBIDDEN on that tenant's reads                               | Ready   | The company section shows the server's refusal                                                                     | Foundation |
| "Performance across all brands →"                                       | `/portfolio/performance` (UX-11)                                                      | Ready   | Link form; the screen itself takes the interface's table form                                                      | Screens    |

### Home

| Interface element                                                  | Application functionality                                         | Status  | Required change                                        | PR         |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- | ------- | ------------------------------------------------------ | ---------- |
| Date eyebrow, greeting, "N things need you. M posts go out today." | brand timezone, `access.session`, Needs-you lists, calendar range | Ready   | Summary line computed from the same lists              | Foundation |
| Setup incomplete / Outdated standards banners                      | brand status, `pendingProposal`                                   | Ready   | Interface's banner form                                | Foundation |
| Needs you rows (dot, title, detail, action →)                      | `useNeedsYouRows` (review, publications, facts)                   | Ready   | Row form; whole row is the link                        | Foundation |
| This week (7 cards, dots per publication)                          | `content.calendar.range`                                          | Ready   | Dots per publication state; spoken count               | Foundation |
| Agent activity rows                                                | `agents.runs.list`                                                | Ready   | Row form with relative time                            | Foundation |
| Documents rows; "+ New document"                                   | `creative.documents.list`; Studio creation screen                 | Partial | Rows rebuilt; "+ New document" opens the Studio (D-30) | Foundation |
| Setup checklist (application only)                                 | R1-D onboarding                                                   | Extra   | Kept while the brand is in setup                       | —          |

### Review and the external portal

| Interface element                                          | Application functionality                       | Status | Required change                                    | PR        |
| ---------------------------------------------------------- | ----------------------------------------------- | ------ | -------------------------------------------------- | --------- |
| Filter chips All / Needs attention / Awaiting / Approved   | `useReviewInboxPages` attention filters         | Built  | `Chip` form                                        | ui-review |
| Request list (title, due, state, secondary flags)          | inbox items                                     | Built  | Row form                                           | ui-review |
| Request header: id · revision · created; state pill        | `review.requests.get`                           | Built  | Header form                                        | ui-review |
| Change note banner                                         | request note / changes requested                | Built  | Banner form                                        | ui-review |
| Frozen manifest rows (channel, caption, ALT, hashes, size) | frozen manifest, `review.requests.media`        | Built  | Row form with hatching placeholders when no export | ui-review |
| Reviewers (name, team, decision)                           | decisions                                       | Built  | Table form                                         | ui-review |
| External links (+ New link, Preview, Revoke)               | external reviewer links                         | Built  | Form                                               | ui-review |
| Comments with OUTDATED tag                                 | request comments bound to the manifest revision | Built  | Form                                               | ui-review |
| Your decision: note, Approve revision N, Request changes   | `review.decide` (SoD D-11)                      | Built  | Card form                                          | ui-review |
| Portal: same read-only manifest, decision, comment         | `/review-portal/*` token scope                  | Built  | Interface's portal form                            | ui-review |

### Calendar

| Interface element                                             | Application functionality                                               | Status | Required change                  | PR      |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- | ------ | -------------------------------- | ------- |
| Month / Week, ‹ Today ›, Schedule                             | `calendar-grid`, `schedule-form`                                        | Ready  | Control forms                    | Screens |
| Channel warning banner with "Reconnect →"                     | channel health (`publishing.channels.list`)                             | Ready  | Banner form                      | Screens |
| Day cells with dots, today ring, selected day tint            | grid, selection                                                         | Ready  | Dots per state (chips today)     | Screens |
| Day list (time, title, channel, state) and publication drawer | day list, `publication-detail` (reconcile, retry, cancel, edit, delete) | Ready  | Drawer form (right, `om-drawer`) | Screens |
| Refresh (application only)                                    | manual refetch                                                          | Extra  | Kept as a ghost control          | —       |

### Campaigns

| Interface element                                                     | Application functionality                            | Status | Required change | PR      |
| --------------------------------------------------------------------- | ---------------------------------------------------- | ------ | --------------- | ------- |
| Campaign column (+), brief column (+ Brief), brief detail             | `campaigns-screen`, `brief-detail`                   | Ready  | Column forms    | Screens |
| Brief header BRIEF · PLAN ACCEPTED; Audience / Channels / Constraints | brief fields                                         | Ready  | Form            | Screens |
| Plan table (date, channel, item, format)                              | `plan-grid` (D-21 plan items)                        | Ready  | Table form      | Screens |
| Content packages with per-variant validity                            | `package-detail`, variant checks                     | Ready  | Form            | Screens |
| Open in studio / Draft variants with agent / Send package for review  | document link, `agents.runs.start`, `request-review` | Ready  | Button forms    | Screens |

### Studio

| Interface element                                                                                                       | Application functionality                         | Status | Required change                               | PR      |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------ | --------------------------------------------- | ------- |
| Create: Still / Motion cards with format counts; Continue list                                                          | `features/studio/create` (STU-1a), documents list | Ready  | Interface's forms                             | Screens |
| Pick format / size                                                                                                      | create flow                                       | Ready  | Form                                          | Screens |
| Design workspace (canvas, layers, properties, assets, history, comments, generate, render, review, proposal, templates) | `studio.tsx` panels (konva)                       | Ready  | Panel chrome to the interface; breadcrumb bar | Screens |
| Video workspace (timeline, clips, audio, AI video)                                                                      | `features/studio/video`                           | Ready  | Chrome                                        | Screens |
| Autosave failed / stale conflict states                                                                                 | `save-indicator`, `diff.ts` conflict              | Ready  | Interface's banners                           | Screens |
| Agent side panel (`showAgent`)                                                                                          | `agent-panel`                                     | Ready  | Drawer form                                   | Screens |

### Performance (and Overview)

| Interface element                                                                       | Application functionality                            | Status  | Required change                                                                                      | PR      |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------- | ------- |
| Brand select, 7/30/90 days, Monthly report, Export                                      | periods; reports (D-29); export                      | Partial | "Monthly report" opens Reports; Export: CSV of the content table (new, client-side from loaded rows) | Screens |
| Channel chips, freshness line                                                           | `freshness-line`, channel filter                     | Ready   | Form                                                                                                 | Screens |
| Six KPI tiles with sparkline and vs prior period; OBJECTIVE tile                        | `metrics.brandSummary` (D-14 comparison), objectives | Partial | Sparklines from the daily trend; objective tile from the active objective                            | Screens |
| Reach · last 30 days chart with baseline and publication dots                           | `daily-trend` (D-14 baseline rules)                  | Partial | Chart form; the rolling baseline is a separately labelled series                                     | Screens |
| By channel bars; When it lands heat grid                                                | per-channel; slot grid                               | Ready   | Forms                                                                                                | Screens |
| What the creative did (hook / format / imagery lift)                                    | attribute lift panel                                 | Ready   | Form                                                                                                 | Screens |
| Content table with metric chips and vs median                                           | posts table                                          | Ready   | Form                                                                                                 | Screens |
| AI review (brand analyst) and Next content cycle (Keep/Drop, Regenerate, Create briefs) | intelligence recommendations, analyst runs           | Partial | Panel placed on Performance as the interface does; Keep/Drop as dismiss/keep on recommendations      | Screens |
| Web sources, search console, site audit (application only)                              | `overview-screen` (R2-5)                             | Extra   | Reached from Performance; route kept (D-28)                                                          | Screens |

### Reports

| Interface element                                                                                               | Application functionality | Status  | Required change                                                                                                                             | PR      |
| --------------------------------------------------------------------------------------------------------------- | ------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Recent reports (brand, month, Draft / Sent date)                                                                | —                         | Missing | `reports` module: drafts and sent records per brand (migration)                                                                             | Reports |
| Builder: brand, month, compare with, sections, executive summary                                                | —                         | Missing | Report model; summary drafted through the model gateway, editable                                                                           | Reports |
| Report assistant ("Tell me what's missing…", Ask)                                                               | —                         | Missing | Gateway call scoped to the report's data; answers labelled as drafts                                                                        | Reports |
| Prepared for / by; brand kit (from the brand system); Dark / Light                                              | brand system read         | Partial | Report theme from the published brand system                                                                                                | Reports |
| Preview pages: cover, Across every platform, Consolidated by channel, What people engaged with, Recommendations | measurement reads         | Missing | Page renderers (D-15 rules; uniques never summed across platforms)                                                                          | Reports |
| Download PDF; Send to client; Save draft; "Draft auto-saves on the 1st"                                         | render path; delivery     | Missing | PDF through the existing render path; send only through a delivery the deployment has; no scheduled auto-draft until a job exists (said so) | Reports |

### Intelligence and Experiments

| Interface element                                                                                                         | Application functionality                                         | Status  | Required change                                                | PR      |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------- | -------------------------------------------------------------- | ------- |
| Header: objective, "learned from Halden's data only"; Run brand analyst now                                               | objectives; analyst run start                                     | Ready   | Form                                                           | Screens |
| Freshness / Coverage / Unsupported line                                                                                   | `freshness-line`                                                  | Ready   | Form                                                           | Screens |
| Tabs: What changed, What we learned, What to do next, Customer voice, Experiments, Brand playbook                         | `intelligence-workspace` tabs, `playbook-panel`, comments (inbox) | Partial | Customer voice tab shows comment themes and links to the Inbox | Screens |
| Recommendation cards (Benefit / Effort / Confidence; Update plan, Generate variants, Prepare test, Create brief, Dismiss) | `recommendation-card` actions                                     | Ready   | Card form                                                      | Screens |
| Experiments list and detail (result, pre-registration table)                                                              | `experiments-screen`, `experiment-detail`                         | Ready   | Forms                                                          | Screens |

### Agents

| Interface element                                                  | Application functionality     | Status | Required change | PR      |
| ------------------------------------------------------------------ | ----------------------------- | ------ | --------------- | ------- |
| Runs list (goal, state, when); New run                             | `runs-list`, `start-run-form` | Ready  | Forms           | Screens |
| Run header (id · agent · skill · mode), Tool calls / Tokens / Cost | `run-detail`, ledger          | Ready  | Form            | Screens |
| Constraint note; step rows with timings; redaction note            | steps                         | Ready  | Form            | Screens |
| Review proposal / Cancel run                                       | proposal flow, cancel         | Ready  | Buttons         | Screens |

### Brand system

| Interface element                                                                                                                                                | Application functionality                                                                                           | Status | Required change                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | PR              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Secondary navigation: Overview, Logo, Colour, Typography & layout, Voice & writing, Imagery, Patterns & templates, Channel guidance, Facts, Objectives, Versions | section routes (`?section=`)                                                                                        | Done   | The eleven headings in a 200 px column (sticky; a row above the content below 768 px), the Facts heading with its proposed count. The application's extra sections sit under them as a row of pills: Messaging, Vocabulary, Writing patterns and Examples under Voice & writing; Templates and Visual patterns under Patterns & templates; Guidelines under Channel guidance. Every old `?section=` key still opens its section. The last heading reads "History", not "Versions" (D-22) | ui-brand-system |
| Header: brand name, Version N · Published, id; v4 · published / v5 · in review                                                                                   | D-22: one brand system, proposals                                                                                   | Done   | Brand name, a "● Published" pill (or "● Not saved yet"), a "● Proposed update" pill while a proposal waits, no record id (the application never shows ids) and no version switch. The proposal's strip (accent tint, "Review →" / "Discard") takes the interface's draft note                                                                                                                                                                                                            | ui-brand-system |
| Overview: dark card with statement and swatches; trait chips; summary cards                                                                                      | `brand-read-views`                                                                                                  | Done   | The darkest palette colour carries the card with the brand name, its positioning (when messaging has one) and three swatches; the voice summary and tone pills beside it; eight ruled white cards in three columns (Logo … Facts), each opening its heading                                                                                                                                                                                                                              | ui-brand-system |
| "How this is used" note                                                                                                                                          | text                                                                                                                | Done   | `Section` label and rule; the text says "brand system" where the interface says "published version" (D-22)                                                                                                                                                                                                                                                                                                                                                                               | ui-brand-system |
| Ask AI / Import sources (application only)                                                                                                                       | `section-assistant`, `assist-sources`                                                                               | Extra  | Kept in the header as the interface's secondary buttons                                                                                                                                                                                                                                                                                                                                                                                                                                  | ui-brand-system |
| Section pages (Logo, Colour, Typography, Voice, Imagery, Patterns, Channels, Facts, Objectives, Versions)                                                        | `brand-kit-editor`, `guidance-editors`, `logo-rules`, `typography-specimen`, `facts-workspace`, objectives, history | Done   | Each page takes the interface's heading row (22 px title, muted line, secondary buttons on the right), uppercase labels over rules, ruled rows (facts, history, objective history), white cards for the active objective and the comparison; the editors keep their fields                                                                                                                                                                                                               | ui-brand-system |

### Assets

| Interface element                                                                                                        | Application functionality                   | Status | Required change          | PR      |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ------ | ------------------------ | ------- |
| Search, Upload, filter chips (All, Needs attention, Approved, Expiring, Missing rights, Duplicates, Restricted, Retired) | `use-assets` eligibility and rights filters | Ready  | Chip forms; search field | Screens |
| Card grid (hatching placeholder, kind · tag, name, rights state)                                                         | `asset-thumb`, rights                       | Ready  | Grid form                | Screens |
| Asset drawer (rights, versions, usage)                                                                                   | `asset-actions`                             | Ready  | Drawer form              | Screens |

### Settings

| Interface element                                                                             | Application functionality                                                                       | Status  | Required change                                                                                                                                                    | PR      |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| Tabs: Channels, Mandates, Release policy, Skills, Members, Budgets & models, Appearance       | tabs Channels, Destinations, Mandates, Policy, Skills, Members, Budgets, Model routing, Account | Partial | Destinations joins Channels ("Websites and sources" group); Budgets and Model routing become "Budgets & models"; Account becomes "Appearance" + account (password) | Screens |
| Connected channels rows (name, handle, limits, health, Reconnect / Manage); Connect a channel | `channel-settings`, `channel-status`, certification                                             | Ready   | Row forms; the certification detail moves behind "Manage"                                                                                                          | Screens |
| Token note                                                                                    | text                                                                                            | Ready   | —                                                                                                                                                                  | Screens |

## 4. Interface interactions with no functionality behind them (before this programme)

Reports (all of it, D-29); "Export" on Performance; "Monthly report" (→ Reports); sparklines on the KPI tiles;
"Keep / Drop" on the next content cycle (mapped to recommendation keep/dismiss); per-brand channel flags on the
Portfolio; the Portfolio's demonstration "Restricted access" copy (the application shows the server's refusal).

## 5. Application capabilities with no place in the interface

Overview (web sources, search console, site audit) — under Performance (D-28). Inbox (comment replies) — kept
in the navigation (D-28). Setup checklist on Home — kept while in setup. Destinations (website CMS, GA4, GBP,
Search Console) — a group inside Settings → Channels. Model routing, kill switches, audit — inside "Budgets &
models" and "Release policy". Account password — inside "Appearance" as a second group. Brand system's extra
sections — grouped under the interface's headings. Calendar "Refresh" and manual refetches — ghost controls.
Typography specimen, brand skill import, voice extraction, section assistant, facts workspace — inside their brand
system sections.
