# Brand Kit Agent: architecture note

Brief (re-issued 2 October 2026): an agent that populates the existing brand system from website URLs, uploaded
artwork and a text brief, as a background job, landing a DRAFT version through the existing versioning so that
every one of the twelve sections renders and edits exactly as a manually built kit. The existing UI is the
contract (`01-existing-ui-inventory.md`); the agent is a data producer. The only new surface is the entry point.

Risk tier: critical. Agent writes into brand standards; untrusted files and pages are parsed; third-party hosts
are fetched. The controls follow the tier (sections 6 and 7).

## 1. What it is

A **job with staged progress**, not an agent tool loop. Nearly every requirement is deterministic extraction
(markup, CSS, SVG geometry, pixels, stated facts). Two steps need a model (tone of voice from copy; translating
the brief into token decisions and section prose), each a single bounded call with a strict output schema through
the shared `ModelAdapter` with the routing policy asserted first, as `brand.proposeVoice` and the comment
classifier do today. The job owns one table (progress and the report); the kit itself lives entirely in the
existing document, facts, objectives and assets.

## 2. Section mapping (source → existing field → what the agent writes)

| Section                | Existing data (inventory)                | Agent writes                                                                                                                                                                                                                                                                                                                                                                                                   | Source and precedence                                                                                         | Marked inferred when                                                                                                                                 |
| ---------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logo                   | `logoRules` on `logo` assets; four slots | the confirmed logo as a `logo` asset (provenance `imported`, source URL, `altText` = "{name} logo, from {host}") plus its derived variants as `logo` assets (provenance `derived`, `altText` names the variant); rules for `primary` (full colour), `reversed` (light-on-dark), `mono` (black), `mark_only` (symbol) with grounds = palette keys the variant passes 3:1 on, `clearSpaceRatio` and `minWidthPx` | artwork logo > website logo (the brief cannot supply a logo)                                                  | clear space and minimum width are inferred from the mark's proportions unless the artwork shows a clear-space diagram (rare); recorded in the report |
| Colour                 | `tokens.colours`, `contrastTarget`       | up to 40 colours with roles; keys lowercase-hyphen; 6-digit hex; `contrastTarget` AA                                                                                                                                                                                                                                                                                                                           | brief > artwork > website (custom properties, then rules on body/headings/links/buttons, then logo dominants) | role assignment without a naming hint; any value quantised from pixels                                                                               |
| Typography             | `typeRoles`, `spacingScale`, `radii`     | `spacingScale` and `radii` from CSS; type roles **only for fonts that exist as brand font assets**: Google Fonts families found on the site are imported through the existing `assets.fonts.importGoogle` on the requester's behalf, then assigned; self-hosted or unidentified families are reported, never guessed                                                                                           | brief (pairing style) > artwork (unidentified, flagged) > website                                             | weights and minimum sizes when the CSS does not state them                                                                                           |
| Voice and writing      | `voice`                                  | every field (summary, tone, audiences, preferred and prohibited terms, locales, examples with notes)                                                                                                                                                                                                                                                                                                           | brief > artwork copy > site copy                                                                              | audiences and terms the copy does not state                                                                                                          |
| Imagery                | pattern `reference-imagery`              | description of the photographic and illustration style; up to 24 site or artwork images ingested as `photo` assets (provenance `imported`, source URL)                                                                                                                                                                                                                                                         | artwork > website (hero, og:image, content images ≥ 600 px)                                                   | style statements are always inferred from the images                                                                                                 |
| Patterns and templates | `patterns[]` (no editor)                 | recurring devices observed: colour blocks, card radius, dividers, iconography, photo treatment; one pattern each with key and description; examples are brand assets when an image evidences it                                                                                                                                                                                                                | artwork > website                                                                                             | always inferred                                                                                                                                      |
| Channel guidance       | `channelGuidance[]` (no editor)          | one entry per channel the brand has connected or the brief names (`facebook_page`, `instagram_business`, `linkedin_page`, website) with caption style, preferred formats and CTA conventions                                                                                                                                                                                                                   | brief > observed usage (social URLs given as input)                                                           | always inferred unless the brief states it                                                                                                           |
| Guidelines             | `guidelines` (SKILL.md and references)   | a generated package: `SKILL.md` (name, description, do and don't rules synthesised from the above), `references/report.md` (the provenance, confidence, conflicts and gaps, see section 5), `references/sources.md` (every URL and asset read)                                                                                                                                                                 | all                                                                                                           | the do/don't rules name their source per line                                                                                                        |
| Facts                  | facts table                              | proposed facts (`kind` contact/product/claim/legal/statistic) with evidence `{kind: 'url', ref}` per statement, only what the source states verbatim; never approved by the agent                                                                                                                                                                                                                              | website (artwork text when legible)                                                                           | never: a statement without a source is not written                                                                                                   |
| Objectives             | objectives table                         | one objective only when the brief states a goal or the site states one explicitly, and only when the brand has **no open objective** (setting one closes the current one); the name carries "(inferred)" when derived from messaging; the metric key is chosen from the measurement dictionary groups                                                                                                          | brief > website                                                                                               | when derived from messaging                                                                                                                          |
| Versions               | `brand_versions`                         | one new draft through `versions.createDraft` (copy of the published document, else empty), then `versions.update` with the composed document; nothing else is touched                                                                                                                                                                                                                                          |                                                                                                               |                                                                                                                                                      |
| Overview               | derived                                  | nothing: it composes from the above                                                                                                                                                                                                                                                                                                                                                                            |                                                                                                               |                                                                                                                                                      |

Layout (grid, density, shadow): the brand system has no Layout section; spacing and radii are the only fields
(`tokens.spacingScale`, `tokens.radii`, read-only in the UI). Grid, density and shadows go to the report as gaps.

## 3. Pipeline stages and job model

| Stage                                | Runs on                                           | Does                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `queued`                             | api `brand.kit.start`                             | validates inputs (≥ 1 source; https URLs ≤ 10; artwork ≤ 20 assets of this brand, kinds `reference` or `logo`; brief ≤ 4000; `rightsAttested: true` stored with user and time); writes the job row; outbox `brand.kit_requested`                                                                                                                                                           |
| `fetching`                           | worker-ingest, queue `ingest-metrics`             | robots.txt honoured; the page, its same-origin stylesheets (≤ 10, ≤ 512 KB), logo candidates (≤ 12, ≤ 2 MB) and content images (≤ 8, ≤ 5 MB) fetched through `fetchBounded` (every hop through `assertSafeUrl`, DNS pinned, ≤ 3 redirects, 10 s each, 250 ms gap and a token bucket per host and tenant); bytes to the object store under the job prefix; Temporal carries keys and counts |
| `extracting`                         | worker-render, queue `media`                      | sanitise then parse: SVG through the assets sanitiser (refuses active or external content), rasters through sharp with header checks; candidate ranking and exclusion; palette, typography, spacing and radii; copy evidence; artwork palettes; the two model calls proxied to worker-core queue `agents`                                                                                  |
| `deriving`                           | worker-render `media` + the asset ingest pipeline | the top candidate is normalised (SVG) or checked (PNG alpha, ≥ 512 px; JPEG background removal, flagged `degraded`), variants generated by role remapping and contrast-validated; original, variants and reference images enter the library through the ordinary ingest (ClamAV, sanitise, dedupe, derivatives) and the job waits for acceptance                                           |
| `composing`                          | worker-core, queue `core`                         | precedence applied per field, conflicts and gaps recorded; the draft created and updated as the requesting person under `brand.edit_standards`; facts proposed; the objective set when allowed; fonts imported; the report written into the draft's guidelines and onto the job                                                                                                            |
| `completed` / `failed` / `cancelled` |                                                   | terminal; failure keeps what exists and names the reason                                                                                                                                                                                                                                                                                                                                   |

Table `brand_kit_jobs` (migration 0020): id, tenant_id, brand_id, requested_by_user_id, stage, stage_detail,
inputs (urls, artwork asset ids, brief, attested at), scope, result_version_id, candidates (≤ 12, bounded),
report, error, workflow_id, started_at, finished_at, created_at, updated_at, version. Brand-scoped with the
standard unique index and foreign key; roles regenerated. Workflow `brandKitWorkflowV1` (immutable once on
main) hosted on `ingest-metrics` with activities proxied per queue; cancel is a signal; every activity carries
`TenantContextInput` and re-loads the requester's grants. Scoped re-runs (`brand.kit.rerun` with
`scope: palette | typography | voice | logos | imagery | patterns | channels | guidelines`) write only the named
fields into the job's draft at the draft's `expectedVersion` from the re-run's start; a person's edit in between
is a CONFLICT, never overwritten.

Procedures: `brand.kit.start`, `brand.kit.get`, `brand.kit.list`, `brand.kit.cancel`, `brand.kit.rerun`.
People only (`brand.edit_standards`, agents refused).

## 4. Logo pipeline against the existing Logo section

Candidates from schema.org `Organization.logo`, header and nav images and inline SVGs named logo or the site's
name, `apple-touch-icon`, manifest icons, `rel=icon`, `og:image` (lowest), and uploaded files named or shaped
like a logo. Excluded: images inside links to other hosts, images whose text carries partner, client,
certification, award, payment, app-store or social-platform words, and runs of three or more sibling images in
one container. Format priority SVG > PNG > JPEG; an SVG wrapping an `<image>` ranks as its raster.

**Confirmation uses the existing mechanism.** The Logo section's only selection control is the Select on each
slot over the brand's logo assets. The top candidate becomes the draft's `primary` and the source of the
variants; up to four further candidates are also ingested as `logo` assets (altText "Candidate n, from {host}")
so the person can switch the slot to one of them in the editor. There is no step that presents candidates for
confirmation before ingest; that is a gap listed in section 8.

SVG: sanitise (existing); classify (`raster_in_svg` flagged and treated as a raster); normalise over jsdom
(viewBox kept or derived, fixed width and height removed, metadata and editor namespaces stripped, local `<use>`
inlined, group transforms pushed to children, empty groups flattened; `<text>` kept and flagged
`text_not_outlined`, outlining needs the font file); role map (every fill and stroke, attribute, style or gradient
stop, becomes a `bk-fill-<role>` / `bk-stroke-<role>` class with one `<style>` block per file defining the
roles: `primary`, `secondary`, `accent-n`, `dark`, `light`, `knockout`); variants are new style blocks only.
Variants: full colour → slot `primary`; light-on-dark → `reversed`; monochrome black → `mono`; symbol-only →
`mark_only` when a `<text>` wordmark or a group named mark/symbol/icon separates; dark-on-light and monochrome
white are stored as derived logo assets (selectable in any slot) but have no slot of their own. Inversion is
luminance-aware per role (neutral roles flip around mid-luminance; chromatic roles keep hue and move lightness
until 3:1 on the ground; `knockout` becomes the ground). Every variant is validated against its intended ground
and the palette keys it passes on become its `allowedBackgroundColourKeys`.

Raster: PNG needs alpha and ≥ 512 px on the longest side (`low_resolution` flagged; never upscaled); JPEG gets
near-uniform corner background removal, flagged `degraded`, and the report asks for a better file. Vectorisation
is not offered in this release (no tracer in the worker image; adding one is a platform decision): gap.

Placement rules: `clearSpaceRatio` 0.5 and `minWidthPx` from the mark's aspect (the width at which the mark's
height reaches 24 px, floor 96) unless the artwork states otherwise; both marked inferred in the report.

## 5. Provenance, confidence, conflicts and gaps

Recorded per field (`website | artwork | brief | inferred`, confidence `high | medium | low`, evidence refs) on
the job (`report`) and attached to the draft as `guidelines.documents["references/report.md"]`: a table per
section, the conflicts (field, chosen value and source, each alternative and its source), the gaps and the flags.
The Guidelines section renders it in full through its existing `<details>` affordance, and agents receive it with
the guidelines, which tells them which values are inferred. Inferred values are also labelled in place where the
field is prose (pattern and channel descriptions, objective names). No other section has an affordance for
per-field labels, and none is added; a per-field provenance badge is a proposed enhancement (section 8).

## 6. Security and compliance

| Requirement                                                               | Where                                                                                                                                                                               |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSRF ranges, metadata hosts, DNS before connect, re-check after redirects | `@oremedia/providers` `assertSafeUrl` + `ssrfSafeDispatcher` on every hop of `fetchBounded`                                                                                         |
| redirects, size, time                                                     | ≤ 3 hops, byte caps per kind, 10 s per fetch, 20 min per job                                                                                                                        |
| untrusted files, type by content                                          | assets `sniffType` (magic) on every fetched and uploaded file; SVG `sanitise` before any parse; refused, not cleaned                                                                |
| caps                                                                      | artwork ≤ 20 files per job within `UPLOAD_CAPS_BYTES`; candidates ≤ 12; images ≤ 8                                                                                                  |
| robots.txt, rate limit per domain, source URL                             | `robotsDisallowFor`/`robotsAllows`; token bucket keyed by host and tenant plus the 250 ms gap; `imported.externalRef` on every harvested asset and `sourceUrl` on every candidate   |
| rights attestation                                                        | `rightsAttested: true` required by `brand.kit.start`, stored with user and time; harvested website imagery stays `pending_review` with no rights recorded (the person records them) |
| never overwrite                                                           | a new draft every run; re-runs edit only that draft at a known `expectedVersion`                                                                                                    |

## 7. Reuse, and where the existing system fails the brief

- `brand.onboarding.start` refuses website URLs by design (voice only): unchanged; the job is the website path.
- `assetService.uploadGenerated` accepts photo/illustration/video/audio with `generated` provenance only: a sibling
  for `logo` and `photo` with `imported`/`derived` provenance is added under `asset.upload`.
- `fetchPageBounded` returns text: refactored over a byte-level `fetchBounded` (one policy, one place).
- Object store on worker-ingest: not configured today; the fetch stage needs it (Railway variable references).
- Computed styles: no browser is run on untrusted pages; CSS is read statically; the report says so.
- Objectives close the open one: the agent sets one only when none is open.
- Patterns and Channels have no editor: the person can read what the agent wrote but not edit it in the UI
  (existing limitation, unchanged).

## 8. The single new surface, and proposed enhancements for approval

**Entry point (built only after approval).** One panel, "Generate a brand kit", mounted in the Versions section
directly above the existing "Import a brand skill" panel, using the same `Panel`, `Field`, `Input`, `Textarea`,
`Button` and `StatusBanner` components and the same mutation and banner patterns as that panel. Contents, top to
bottom: "Website URLs" (one per line, ≤ 10), "Artwork" (the existing upload hook, kind `reference`, one file at a
time as every upload in the app, with the accepted list and the running total), "Brief" (textarea ≤ 4000), the
attestation checkbox ("I hold the rights to the supplied brand assets", a plain checkbox in a label as the editor's
grounds checkboxes are), and "Generate". While a job runs, the panel shows the stage as a busy `StatusBanner`
("Fetching 2 of 3 pages", "Extracting", "Deriving logo variants", "Composing the draft") polled every 5 s like an
agent run, with "Cancel". On completion the same banner pattern as the import: "Draft version N created from
{sources}: {n} colours, {m} logo variants, {k} facts proposed. Review it, then publish it." with the gaps count and
a link to the draft. Route change: one line in `route.tsx` mounting the panel. No other screen, component, style or
interaction changes.

**Proposed enhancements (not built; for approval):**

1. A candidate confirmation step before the top candidate is ingested (today the Select on the Primary slot is
   the only selection, after ingest).
2. Per-field provenance and confidence badges in the read views and editor (today only the report document).
3. Slots for dark-on-light and monochrome-white variants in the Logo section (today stored as assets without a
   slot).
4. Rendering fact evidence in the Facts list (stored today, not shown).
5. A drawn placement view for logos (clear space and minimum width on each allowed ground).

## 9. Tests

Unit: SVG with embedded raster; SVG with script payload (refused before parse); partner and social logos in a
header (excluded); multi-colour logo inversion (role remapping, luminance per role, contrast); PNG without alpha;
JPEG-only site (degraded flag, prompt); conflicting sources (brief wins, conflict recorded); SSRF attempts (private,
loopback, link-local, metadata hosts, redirect to a private address, DNS to a private address). Integration:
the job from a loopback fixture site to a draft; cross-tenant fixtures for every procedure and activity; migration
0020 roll-forward. Regression: a kit composed by the agent and a kit built by hand through the same procedures
render the same DOM structure in every section of the existing UI (e2e against the mock transport, structural
snapshot per section).

## 10. Increments

1. Documents (this note, the inventory) for approval of the entry point.
2. Contracts, migration, module `packages/modules/brand-kit` (extraction, colour, SVG, compose) with unit tests.
3. Workflow, activities, outbox route, service, procedures, fixtures, integration and roll-forward tests, roles.
4. The entry point and the regression suite.
