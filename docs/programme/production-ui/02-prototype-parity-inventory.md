# v3 prototype parity inventory

Source: `Oremedia v3.dc.html` (markup 1–1427, logic 1429–1980), `oremedia-data.js` (`window.OM_DATA`), `support.js`
(DC runtime only). The prototype is one component; `state.screen` is the route (no URL routing, no deep links).
Designer props: `startScreen`, `homeState` (normal / setup incomplete), `studioState` (normal / autosave failed /
stale conflict), `showAgent`.

Legend: **[D]** driven by `oremedia-data.js` · **[H]** hard-coded · **[toast]** handler only shows a toast ·
**[noop]** no handler · **[state]** changes local state. Disposition column: **build** (accepted for R1) ·
**build-R2/R3** · **capability** (show as unavailable with the reason) · **exclude** (deliberately not built) ·
**exists** (already in the app). Dispositions are the Phase 0 proposal; the ledger tracks evidence.

## Shell (all screens except Portfolio, the document studio, Portal)

| Element                                                                                                        | Prototype                               | Disposition                                    |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------- |
| Left nav with counts (Review, Calendar, Agents, Assets [H]; Brand system = proposed facts [D])                 | 224 px column                           | exists; counts from real reads (build)         |
| Logo → Portfolio; brand switcher card → Portfolio (not a dropdown)                                             |                                         | exists                                         |
| Footer agent spend "$41 / $120" bar [H], user and role [H]                                                     |                                         | build with UX-16 budgets read                  |
| `< 900` off-canvas nav drawer with hamburger and breadcrumb; `< 760` master-detail stacks; `mdH` panel heights |                                         | build (responsive parity)                      |
| Toast, stagger motion (disabled under reduced motion)                                                          |                                         | exists (status banners); motion: build lightly |
| Keyboard shortcuts                                                                                             | none implemented; Layers hint text only | exclude as a prototype promise; keep app's own |

## Portfolio

KPI strip (overdue 6, failed/unknown 3, going out 28 [H]) · company sections with role [D] · brand rows with flag,
overdue/failed/upcoming [D] (every row goes to Halden) · restricted state text · "Performance across all brands →".
Disposition: exists for counts; **build** the cross-brand performance route (UX-11); restricted-membership state
**build**.

## Home

Date/greeting/summary · setup-incomplete banner → system/overview · outdated-standards banner → versions · "Needs
you" rows [H except facts] → review, calendar day, agents run, facts · empty state · week strip [D] → calendar ·
agent activity (4 runs [D]) → agents · "+ New document" inline form → Studio · recent docs [H].
Disposition: exists except **build** documents catalogue (UX-13) and agent activity from `agents.runs.list`
(A today).

## Brand system

Secondary nav (11 tabs; horizontal scroll when stacked) · version pills v4 published / v5 in review with hash ·
draft banner with CHANGED tags. Tabs: Overview (8 tiles) · Logo (variants, clear space, misuse; "Upload logo file"
[noop]) · Colour (tokens, pairings table; "Add token" [noop]) · Typography (font cards, roles, spacing, radii;
"Manage font files" → Assets) · Voice (tone scale, audiences, terms, prohibited phrases, mechanics, examples; live
"Check a draft" against 11 patterns) · Imagery · Patterns & templates · Channel guidance · Facts [D] (filters,
approve/revoke, "Propose a fact" form with validation) · Objectives (active card, history, "Set objective" [toast])
· Versions (Extract [toast], New draft [toast], per-row submit/publish/read-only, conflict-then-reload, diff rows,
impact list).
Disposition: exists (brand kit editor, facts, objectives, versions, guidelines import); **build** the versions
impact preview before publish (UX-20). Superseded by D-22 (3 October 2026): no version pills, draft banner or
Versions tab; each section has Edit and Save (applied at once, impact confirmed first), and an import or agent
suggestion waits as one proposed update to review or discard; voice "check a draft" **build-R1 if cheap** (client-side pattern check is
already what the prototype does); noop buttons **exclude**.

## Review

List with filters (All / Needs attention / Awaiting / Approved) and flags [D] · detail: meta, state pill, flag
callout, frozen manifest per variant (format, channel, caption, alt, three sha256 bound) · reviewers · external
links (+ New link, Preview → portal, Revoke) · comments with OUTDATED · decision panel (note, Approve revision,
Request changes) · decided state with approval id and validity.
Disposition: exists except **build** media preview (UX-03) and the "Preview" of an external link.

## Calendar

Month/Week toggle · ‹ › [noop] · Today · Schedule inline form (variant, channel, datetime-local "Africa/Accra",
release authority; static validation; Schedule [toast]) · channel banner "token expires" → settings · month grid
with state dots · week view · day list with partial-success note · publication drawer (id, state pill, release
checks, history, actions by state: held → Open review/Cancel; outcome_unknown → Reconcile/View attempt ledger;
failed → Re-export and retry/Dismiss; scheduled → Reschedule/Cancel; processing → Cancel; published → View post/
Delete remote post; cancelled/retry_eligible → Reschedule).
Disposition: exists (schedule, cancel, reschedule, reconcile, delete/edit remote); **build** named selectors and
brand-zone time (UX-06), "View attempt ledger" (`publications.evidence` is D), token-expiry banner from channel
health; ‹ › **build** (trivial); week view **build**.

## Campaigns

Three-pane (campaigns | briefs | detail; narrows < 1100, stacks < 760) · "+" campaign [toast] · brief rows with
state · brief form (message, audience, channels, offer facts, constraints; Create brief [toast], Plan with agent
[toast]) · detail: gaps callout, plan table (when/channel/item/format; missed in red), "Suggested by Planner",
Accept plan [state → creates a package], Edit [noop] · packages with variant status dots · footer: Open in studio,
Draft variants with agent [toast], Send package for review [toast].
Disposition: exists (campaigns, briefs, packages, variants.generate, request review); **build** plan items and
"Plan with agent" (UX-09), variant editor (UX-04), package document truth (UX-02).

## Assets

Search (unbound) · Upload with 6-step simulated pipeline → Pending review · filter chips (All / Needs attention /
Approved / Expiring / Missing rights / Duplicates / Restricted / Retired) · card grid with state label [D] ·
drawer (id, version, state notice, kind/size, channels, territory, rights until, used-in, derivatives, sha256,
EXIF stripped) · actions by state (approved: Upload new version/Retire; expiring: Extend rights/Retire; missing:
Add rights; duplicate: Link to existing/Keep separate; restricted: Edit rights; retired: Restore). No bulk select.
Disposition: **build** management catalogue, upload status, rights/approve/retire actions (UX-05); duplicate
resolution **build** where the ingest already detects duplicates, else **capability**.

## Intelligence

"Run brand analyst now" [toast] · data-quality strip (freshness, coverage, unsupported) [H] · tabs: What changed
(4 metric cards, anomalies) · What we learned (grouped by evidence strength) · What to do next (ranked cards with
benefit/effort/confidence; accept by action; dismiss with reason chips) · Customer voice (clusters) · Experiments
mini list · Brand playbook.
Disposition: exists (workspace, recommendations accept/dismiss, voice, anomalies, playbook, analyst run behind
flag); **build** the freshness/coverage strip from `measurement.quality`/definitions; dismiss reasons **build**.

## Experiments

List with state · mode note (randomised can support causal claims; otherwise directional only) · progress · result
table, diff, CI, guardrail · running state "no peeking" · pre-registration fields · "Pre-register and start".
Disposition: exists.

## Agents

"New run" form: skill select (8 skills with versions), target, mode (Assist / Create / Prepare release /
Autopublish disabled), budgets (max tool calls, max cost, max variants), instructions · run list [D] · detail:
meters (tool calls, tokens, cost), findings, ordered steps with tool call and duration, "Model reasoning isn't
stored" · actions by state (waiting → Review proposal; recovery → Resume; budget → Retry with higher budget; denied
→ Create a mandate; completed → Open result; cancelled → Run again; running → Cancel).
Disposition: **build** named skill/target/principal selectors and schema-driven brief (UX-08), `runs.list`,
effective limits before start (UX-16); per-run budget inputs **build** where `RunStart` accepts them, else
**capability**.

## Settings

Tabs: Channels (rows with caps, token-expiry warning → Reconnect; Facebook "Certification pending" → Connect) ·
Mandates (pause/resume/renew; New mandate [toast]) · Release policy (5 rows; kill switch pause/resume) · Skills
(8 rows with rollout state; Import SKILL.md [toast]) · Members (7 rows incl. a service principal; Invite [toast]) ·
Budgets & models (bars; model routing summary).
Disposition: exists (channels, mandates pause/revoke, kill switch, routing policy, members invite, skills list);
**build** budgets tab (UX-16), skills lifecycle (UX-17), mandates.create, members.setRole and brand grants (D
today), release-policy authoring (D).

## Performance (all numbers synthetic; nothing from `oremedia-data.js`)

Scope select (All brands / brand) · period chips 7/30/90 · Export [toast] · channel chips · freshness line ·
panels: (1) six KPI cards with "±N% vs. prior period" and sparklines, objective card; (2) main chart "Daily ·
dashed line is the rolling 8-week baseline · dots mark publications" (in fact a flat line at 0.92 × mean); (3)
brands table (all-brands scope: reach, ER, posts, approval time, objective progress, trend); (4) by channel share
bars and ER with footnote "engagements ÷ reach, normalised per provider"; (5) "When it lands" ER heatmap slot ×
weekday; (6) "What the creative did" diverging bars by hook/format/imagery vs brand median; (7) content table with
sort chips, inline AI review, "Make variants from this", "Open document"; (8) AI review · Brand analyst (worked /
didn't / hypotheses); (9) Next content cycle (keep/drop, steer + regenerate, create briefs for kept items).
Disposition: **build** (UX-12) against agreed metric definitions: KPI cards from real definitions with denominators;
main chart keeps the app's same-age comparison (decision D-16) and labels any 8-week reference as a separate named
baseline; brands table = UX-11 rollup; by-channel exists; slot heatmap **build** from publication times × ER with
sample sizes; creative attributes **build** from `attributeService` once a brand-wide aggregate exists; content
table exists in part; AI review = analyst output (exists behind flag); next cycle = recommendations with keep/drop
→ `briefs.create` once per kept item (exists in part; steer/regenerate **build-R3** or **capability**).

## Studio

Header: back with leave dialog, breadcrumb [H], save pill (Saved rev N / Saving… / Not saved), Layers/Hide panels
(compact), Undo, Render (→ Rendered ✓), Send for review (blocked unless saved) · banners: autosave failed (Retry),
stale conflict (Keep mine / Keep Kofi's) · left panel tabs Layers / Assets (eligible only; hidden-count note) /
Templates · canvas with select, PROPOSED CHANGE badge, comment pins, compare banner, page thumbnails, format chips,
"+ Channel size" [toast], brand check summary · right panel Properties + tabs Agent (chat input, proposal with
Accept/Modify/Reject) / Comments / Checks / History (Compare with current; exports with failed reason) · leave
dialog · compact mode < 1100 with animated left panel.
Disposition: exists (editor, autosave, conflicts partly, comments, checks, history, renders, proposal panel);
**build** send-for-review (UX-01), agent conversation (UX-07), keep-mine and compare (UX-15), responsive panel
modes (UX-18), page thumbnails / format chips where the editor already models pages and sizes.

## Review portal (external)

Header (brand, shared by, expires), "Exit preview" · body: request title, revision, due, per-variant preview and
caption · comments textarea (unbound) · Approve / Request changes · footnote on revocation. No expired/revoked
states in the prototype.
Disposition: exists; **build** media preview (UX-03) and expired/revoked states (already enforced server-side).

## Cross-cutting patterns

- Selection model: master-detail keyed by id in state; `go(screen, {sel})` pseudo deep links. The app has real
  routes; keep them and add resource ids to URLs where missing.
- Filter chips single-select; no saved views, no bulk actions anywhere in the prototype. The brief asks for bulk
  actions "where designed": none are, so none are owed for R1.
- Drawers: calendar publication, asset. One modal (leave dialog). Inline forms elsewhere.
- Ids and hashes shown in monospace throughout (`rr_`, `pub_`, `as_`, `run_`, `ex_`, `mf_`, `bv_`, `ap_`, sha256
  fragments). The brief overrides this: ids go to a diagnostics disclosure, never a required input.
- Status vocabularies: publication (scheduled, dispatching, processing, published, failed, outcome_unknown,
  retry_eligible, held, cancelled), review (open, changes, approved; flags stale/revoked), asset (approved, expiring,
  restricted, missing, duplicate, retired, processing, pending_review), run (waiting, completed, budget, denied,
  recovery, cancelled, running), brand version (draft, in_review, published, retired), fact (proposed, approved,
  revoked), experiment (Running, Supported, Inconclusive, Draft), mandate (Active, Paused, Expired), evidence
  strength (Experimentally supported, Directional, Observation, Hypothesis), brief (Plan accepted, Incomplete,
  Suggested plan, Draft). The app's contracts already carry equivalents; map, do not rename.
- Decorative or toast-only in the prototype (no data behind them): set objective, extract from guidelines, new
  draft, new campaign, create brief, plan with agent, draft variants, send package for review, new mandate, invite,
  import skill, export, run analyst, start run, make variants. Several of these are real in the app already.
