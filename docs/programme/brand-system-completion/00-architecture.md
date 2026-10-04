# Brand System completion: architecture (BSC)

Status: working architecture for the BSC increments, 3 October 2026. It extends D-22 (one brand system per brand,
edited in place) and reuses the existing brand, facts, assets, agents, billing, review and workflow machinery. It
supersedes the staged-job design in draft PR #31 where they differ; that note's SVG and fetching limits are adopted.

## Principles

1. **One brand system, internal versions.** Every applied change is still an immutable `brand_versions` row (D-22).
   The UI gains a read-only history with compare and restore; restore is a normal `brand.system.save` of an earlier
   document, so impact, approvals and audit behave exactly as for any save. No version management is exposed.
2. **Nothing reaches the brand system without a person.** AI output lands as _suggestions_. A person accepts, edits or
   rejects each one; accepted items are written into the pending proposal (a draft version); the proposal is applied
   with `brand.system.save` (`brand.edit_standards` + `brand.publish_version`, agents refused by `assertMayDecide`).
   Facts follow the same rule: agents and jobs can only propose; approval is a person's act.
3. **Provenance on every item.** Each guidance item and fact carries where it came from: `user` (typed by a person),
   `imported` (verbatim from a supplied document), `inferred` (a pattern drawn from supplied examples, with the
   examples cited) or `suggested` (an AI proposal with no direct source). A single example never becomes policy: an
   inferred pattern cites at least two examples or is marked low confidence.
4. **Untrusted sources.** Websites, uploaded documents and pasted text are evidence, wrapped as untrusted evidence
   blocks (`packages/ai/src/prompt.ts`). They cannot change instructions, grant permissions or call tools. Fetches go
   through the SSRF-safe, host-pinned bounded fetcher; robots.txt is honoured.
5. **Brand preference is not platform truth.** Channel guidance holds the brand's preferences. Technical limits stay in
   `ProviderCapabilityV1` and win wherever they conflict; AI advice never writes capability data.
6. **Approved guidance governs generation.** The published snapshot carries the guidance; `prompt.ts` renders it
   (bounded), the copywriting, channel-adaptation, campaign-planning and review skills cite it, and generated work
   records the brand version it used (`content_revisions.brand_version_id`, `agent_runs.context_snapshot_hash`).

## Document model (BrandSystemDocumentV1, additive)

All additions are `.optional()` with no zod defaults, so stored documents parse and hash unchanged.

- `Provenance = { origin: 'user'|'imported'|'inferred'|'suggested', evidence?: EvidenceRef[] (<=10),
confidence?: 'high'|'medium'|'low', suggestionId?: string }`, optional on every list item below.
- `voice` gains `personality[]`, `principles[]` ({statement, rationale}), `spelling` ({locale e.g. en-GB, notes}),
  `styleRules[]` (numbers, dates, capitalisation, punctuation), `claimRules[]`; `examples[]` gain optional
  `channelKey`, `contentType`, `rationale`, `rewrite`.
- `messaging`: `positioning`, `valueProposition`, `pillars[]` ({key, title, statement, proofFactIds[]}),
  `keyMessages[]`, `audiences[]` detail lives in `voice.audiences` (gains optional `needs`, `objections`).
- `vocabulary[]`: {term, definition, usage: 'preferred'|'allowed'|'avoid'|'prohibited', alternatives[], note}.
- `writingPatterns`: per part `headline|introduction|body|cta|long_form` -> {guidance, dos[], donts[], examples[]}.
- `copyTemplates[]`: {key, name, contentType (social_post|article|email|ad|landing_section|other), channelKeys[],
  purpose, structure: [{slot, guidance, maxLength?}], example, provenance}. Copy templates are not creative layout
  templates; layout templates stay in the creative module.
- `channelBaseline`: brand-wide defaults {objectives, toneAdaptation, conventions, cta, accessibility, hashtags,
  mentions, links, frequency}. `channelGuidance[]` keeps its four fields and gains the same optional fields as
  overrides plus `objectives`, `audience`, `formats`, `examples[]`. Effective guidance = baseline overlaid by the
  channel entry; the UI shows which values are inherited.
- `logoRules[]` gains variant `secondary` (keeps primary, reversed, mono, mark_only), optional `usage`
  ({backgrounds note, donts[]}) and `preferredFormat: 'svg'|'raster'`.

## Facts (migration, table `approved_facts` extended)

New columns: `category` (company, product, service, location, contact, differentiator, audience, terminology, claim,
faq, offer, price, statistic, legal), `scope` (brand-wide or channel/market note), `origin` (user, extracted,
inferred, suggested), `sources` JSON (EvidenceRef[] with excerpt), `review_due_at`, `reviewed_by_user_id`,
`reviewed_at`, `superseded_by_fact_id`, `revoke_reason`, `conflicts` JSON (fact ids / evidence that disagree),
`dedupe_key`. State machine adds `superseded` (terminal). Correcting an approved fact creates a new proposed fact that
supersedes the old one on approval; merge keeps one fact and supersedes the others; withdraw, supersede and expiry
emit `brand.fact_revoked`-equivalent events so the impact workflow holds dependent work. A daily sweep flags facts
past `review_due_at` and emits an event when an approved fact's `valid_until` passes. `suggested` facts without a
source can never be approved as-is: approval requires a source or an explicit reviewer note.

## Sources and AI jobs

- `brand_sources`: a per-brand record of supplied material (url, uploaded asset, pasted text, existing brand asset),
  its capture status (pending, captured, unsupported, inaccessible, failed), byte/char size, content hash (dedupe),
  extracted text in the object store or bounded column, and the reason when unusable.
- `brand_assist_jobs`: one table for setup imports and section requests: {kind: setup|section, sections[],
  instruction, sourceIds[], state (queued, capturing, extracting, proposing, ready, partially_ready, failed,
  cancelled), per-stage progress, budget reserved/spent, error}. Workflow `brandAssistWorkflowV1` (outbox
  `brand.assist_requested`, id `brand-assist:<jobId>`), cancel by signal, Temporal retries per activity, per-section
  partial success.
- Capture runs on the worker with the object store; HTML to text with scripts and styles removed; PDF and DOCX text
  extraction with byte, page and character caps; images and SVG are routed to the asset pipeline (logo candidates).
- Proposal generation: bounded model calls through the existing gateway and routing policy, one per section, strict
  JSON output schemas, evidence cited by source id and excerpt. Budget reserved through billing before calls.
- `brand_suggestions`: {jobId, section, path, op (add|replace|remove), payload JSON, provenance, rationale,
  uncertainty, conflicts, fingerprint, status (pending, accepted, edited, rejected, superseded), decidedBy/At}.
  Accept and edit write into the proposal draft; reject is remembered by fingerprint so a later import or
  regeneration does not re-suggest it, and never overwrites an item whose provenance is `user` (it becomes a
  suggestion against it instead). Facts suggestions become proposed facts with origin and sources.

## Increments

| Inc   | Scope                                                                                                                                                                                                                             |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BSC-1 | Guidance model: document additions, editors and read views per section, provenance display, snapshot and prompt rendering, skills cite guidance, channel baseline and overrides, generation integration                           |
| BSC-2 | SVG logos: secondary variant, usage guidance, vector preview, Studio variant choice and rule check, preview and export parity, raster derivative where a destination needs one (articles), safe download, unsafe-SVG corpus tests |
| BSC-3 | Facts workspace: migration, categories, origin, sources, review and expiry, correct (supersede), merge, conflicts, sweep, impact events, UI                                                                                       |
| BSC-4 | Sources and setup: brand_sources, capture (URL, PDF, DOCX, text, assets), assist jobs, workflow, suggestion generation, setup wizard and review by section, re-import preservation                                                |
| BSC-5 | Collaboration: section assistant and overall assistant on BSC-4 jobs, compare with current, selective accept, undo, history and restore                                                                                           |
| BSC-6 | Staging journeys and release evidence                                                                                                                                                                                             |

### BSC-1 as built

- Status: implemented on `claude/bsc-1-guidance-model` (document additions, save-time reference checks, prompt
  rendering, skills, Brand System sections, platform limits read-only).
- A channel entry's original `captionStyle` and `ctaConventions` are its `toneAdaptation` and `cta` overrides (blank
  inherits the baseline), so entries do not carry two fields for the same thing; `effectiveChannelGuidance`
  (packages/domain) and `channelOverride` (contracts) encode the mapping.
- Platform limits reach the UI through `publishing.channels.limits` (certified providers' capability values, gated by
  `brand.read`); the UI never writes them.
- The prompt renders guidance within a 12,000-character budget in a fixed order, the run's channel only, and cites a
  pillar's proof facts only while they are effective facts of the snapshot (BSC-3: approved, in their validity
  window, not superseded); a save refuses newly cited facts that are not in effect.

### BSC-4 / BSC-5 as built

- Tables (migration 0024, created only): `brand_sources`, `brand_assist_jobs`, `brand_suggestions`. Extracted text is
  kept in a bounded column (400,000 characters); an uploaded document is deleted from the object store once read
  (quarantine prefix, never served); an asset's original is read in place and never deleted.
- `brandAssistWorkflowV1` (`brand-assist:<jobId>`, queue `agents`) spans three workers: websites on
  `ingest-metrics` (worker-ingest: outbound fetch), documents on `media` (worker-render: untrusted parsers, object
  store), budget, model calls and suggestions on `agents` (worker-core). Cancel is a signal relayed by
  `brandAssistSignalRelayV1` from `brand.assist_cancel_requested`. Activities run as the requester (grants reloaded);
  closing the job and settling the reservation run tenant-wide.
- Robots and sitemap rules moved to `packages/providers/src/site-rules.ts` (shared with the SEO audit). PDF text
  through unpdf (MIT, pinned 1.8.1, loaded only on worker-render); `.docx` through a bounded zip reader rather than a
  library, so a zip bomb stops at a hard inflate cap.
- Suggestion paths and document comparison live in `packages/domain/src/brand-suggestions.ts`; model output is
  checked against strict per-section schemas (`contracts/brand-assist.ts`) and never repaired. A fact suggestion
  becomes a proposed fact only when a person accepts it.
- History is a read over applied versions; restore calls `brand.system.save` with the earlier document.
- Untrusted markup is read with a linear-time scanner (`packages/contracts/src/markup.ts`), never with regular
  expressions over the markup; robots rules are matched without building a regular expression. Pages and documents
  are parsed in a worker thread (`capture/isolate.ts`, bundled as `capture-worker.js` next to worker-ingest and
  worker-render) with a memory ceiling (resourceLimits, plus heap sampling because a process-wide
  `--max-old-space-size` overrides worker limits) and a hard timer (10 s a page, 90 s a document); a stopped parse is
  the `processing_limit` refusal. A page that fails past the start page is skipped, never the whole source.
- An upload's size is read from the store before anything is downloaded and the download is ranged at the limit;
  the presigned PUT signs the declared Content-Length. Websites are read on the standard https port only, robots.txt
  in its first 512 KiB, and every fetch gets no more than the crawl's remaining time.
- A suggestion records what its item was when it was made (`brand_suggestions.based_on`); accept and edit refuse
  with `changed_since` when the item changed or a person wrote it since. A proposal in review takes no suggestions
  (`proposal_in_review`). Undo walks its batch in reverse and re-runs the document reference checks.
- A fact counts as stated only when its cited passage says it (at least 30 characters, every figure and name
  verbatim, 60% of its content words); otherwise it is a suggestion that says why.
- Section calls heartbeat through the model call (heartbeat timeout 1 minute) and insert their suggestions only
  while the section is still running, under the job's lock: an attempt that outlived its timeout adds nothing; each
  attempt is charged once (`brand-assist:<job>:<section>:a<attempt>`). A cancelled workflow ends the job cancelled.
- Retention: captured source text follows the tenant's `agent_transcripts` class (90 days by default) through the
  retention sweep (`brand.source_text`, retention role: SELECT and UPDATE on `brand_sources`). A website or asset
  goes back to pending and is read again when next used; uploaded or pasted text becomes `expired`.
