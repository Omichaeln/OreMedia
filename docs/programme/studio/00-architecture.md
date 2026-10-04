# Studio programme: architecture (STU)

Status: working architecture, 3 October 2026. Extends the existing creative module (CreativeDocumentV1, operations,
pure reducer, propose -> overlay -> accept, immutable revisions, render jobs, exports, review binding by hash).
Graphic documents keep schemaVersion 1 and change only additively; video is a new document kind.

## Principles

1. **One document model for people and AI.** Every change, manual or AI, is an operation batch through the same
   reducer, guards and validation, stored as an immutable revision (origin user|agent, agentRunId). AI never writes
   a flattened replacement; it emits operations against the current document.
2. **Locks are binding.** `locked` (existing field) now blocks every agent operation on the element (text, style,
   asset, transform, removal) and manual move/resize; `protected` keeps its meaning. A page or clip can be locked.
   AI requests carry a scope (selected element ids, page, clip, scene or whole document); operations outside the
   scope or on locked items are refused by the server guard, not only by the prompt.
3. **Proposals before replacement.** AI refinement produces a proposal (existing propose flow) with diff, selective
   acceptance per operation group, and accept creates a new revision; undo/redo and restore remain available.
   First generation into a brand-new document applies directly (there is nothing to replace) and is undoable.
4. **Content type, layout and destination are separate.** A document has `contentType`
   (social_post, carousel, story, video, thumbnail_banner, custom); pages/sequences carry their format (preset or
   custom WxH); channel destinations are format variants and channel variants downstream.
5. **Templates are composition structure.** A template version is a CreativeDocument (graphic) or VideoProject
   (video) with slots; generation fills and adapts slots, it does not invent a different layout. Built-in starter
   templates ship in code (like built-in skills) and are instantiated with the brand's tokens, fonts and logos;
   brand templates come from the creative module (approved versions). "Save as template" + approval UI added.
6. **Honest editability.** Text, shapes, SVG logos, image placement/crop/mask, backgrounds, layer order, groups and
   pages are structurally editable. Generated raster images are images: the UI labels them "Generated image -
   regenerate or replace to change its content".
7. **Governed generation.** Published brand snapshot (voice, facts, channel guidance, templates, logo rules) is the
   default context; budgets reserved before model or media calls; generated media get generated provenance; rights
   rules and eligibility apply to every inserted asset; approvals follow the existing invalidation rules.
8. **Provenance per revision.** Each creative revision records generation inputs (brief, template version, scope,
   asset version ids used, model call references, brand version) in a new nullable JSON column.

## Graphic (schemaVersion 1, additive)

- Document gains optional `contentType`, `title` suggestion source; pages gain optional `custom` format
  {width,height <= 4096, >= 64}, and `locked`.
- New operations (reducer, invert, rebase, guard, agent tool schema): groupElements, ungroupElement, setRotation,
  setMask, removePage, duplicatePage, reorderPage, setPageLock, alignElements, distributeElements. insertElement
  already covers text/shape/logo/background insertion; the UI exposes them.
- Editor: multi-select, rotation handles, text editing on canvas, font picker (brand fonts), alignment/distribution,
  crop/mask editing, pages add/remove/duplicate/reorder, logo insertion by variant (BSC-2).

## Video (new kind)

- `creative_documents.kind` ('graphic' default | 'video'); revisions store `VideoProjectV1`:
  {schemaVersion:1, brandVersionId, templateVersionId?, format {width,height,fps: 24|25|30}, durationMs,
  tracks: [{id, kind: video|overlay|audio|caption, locked, muted?, items[]}]}.
  Times are integer milliseconds on the timeline; source in/out in ms; renders snap to the frame grid.
  video item: {id, assetVersionId, sourceInMs, sourceOutMs, startMs, transform/crop (fit|fill + focal),
  transitionIn?: {kind: cut|crossfade|fade_black|slide, durationMs}, locked}.
  overlay item: {id, startMs, endMs, element: graphic Element (text/logo/image/shape) with optional enter/exit}.
  audio item: {id, assetVersionId, sourceInMs, sourceOutMs, startMs, gainDb, fadeInMs, fadeOutMs, muted, locked}.
  caption item: {id, startMs, endMs, text, style}.
  scenes: optional grouping [{id, title, startMs, endMs}] for storyboard and AI scope.
- Operations: insertClip, moveClip, trimClip, splitClip, duplicateClip, removeClip, replaceClipSource,
  setClipFrame, setTransition, setAudio, upsertCaption, removeCaption, setOverlay, setTrackLock, setDuration,
  reorderScenes. Pure reducer with invariants (no overlap within a video/audio track, in < out <= source duration,
  durationMs <= 180000, locked items immutable, transitions <= min adjacent clip length / 2).
- Limits (v1): source video <= 1 GiB and <= 10 min, H.264/H.265/VP9/ProRes/AV1-decodable by ffmpeg 6.1; audio
  <= 200 MiB; output H.264 High + AAC 48 kHz MP4 (faststart), max 1920 on the long edge, 24/25/30 fps,
  project <= 180 s; captions burnt in plus a WebVTT sidecar.
- Media processing (queue `video`, ffmpeg 6.1 + ffprobe added to the render image; streaming object-store I/O, temp
  disk with caps): ffprobe inspection (codec, fps, rotation, audio streams, duration), poster + thumbnail strip,
  720p H.264 editing proxy, audio waveform peaks JSON; user video/audio uploads become processable.
- Render: timeline -> ffmpeg filter graph (trim/scale/crop/xfade/overlay/amix/volume/afade); overlays and captions
  rendered as transparent PNGs by the existing Chromium scene renderer (font and colour parity with the editor)
  and composited with enable windows. Export rows gain mime video/mp4, durationMs, fps, posterKey. Deduped by a
  content hash of (project snapshot, renderer version, asset hashes); progress via heartbeat details + job row;
  cancel signal; idempotent store.
- Preview: browser plays proxies with an overlay canvas using the same scene renderer; exact-parity preview
  renders available as low-res worker renders.

## Generation

- Generate panel (graphic and video): objective, audience, key message, content type, destination(s), format,
  template or custom layout, copy/CTA, approved facts (picked by statement), assets include/exclude/prioritise,
  visual direction + reference assets, variations (1-4), and for video duration, pacing, captions, audio.
  Defaults from template and published Brand System; preflight shows inputs, constraints (capabilities, logo rules,
  rights), missing requirements, unsupported combinations and estimated cost; then a durable generation job
  (`studio_generation_jobs`, workflow, progress, cancel, retry) that writes revisions and finishes only after the
  revision is saved.
- Graphic: bounded model call returns slot fills and adaptation operations (strict schema) -> operations batch
  validated by guards and brand validation; image slots filled from eligible assets or, when asked and permitted,
  images.generate output (generated provenance; labelled raster).
- Video: storyboard step (script + scenes + shot list mapped to eligible clips/images, gaps listed with supported
  alternatives: stills with motion, generated clip if enabled, ask for footage) -> user refines -> assembly into a
  VideoProject via operations. Recut requests compile to validated timeline operations with conflict reporting
  (e.g. locked material exceeds target duration).

## Integration

- Studio "Send to review": renders, creates or updates the content package, attaches exports to channel variants
  by matching format to channel, validates against capabilities (durationMs included), requests review; reviewers
  see the exact frozen export (inline <video> for video). Publishing uses the existing release path with video
  exports.
- Campaign plan items gain "Create in Studio" carrying brief, channel and format.

## Stages

| Stage  | Scope                                                                                                                                                                                                                                                                                        |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| STU-1a | Creation screen (content types, template gallery with previews and filters, blank, duplicate, brand templates, custom layout with validation, suggested editable title), built-in starter templates, save-as-template + approval UI, editor completeness and new graphic ops, lock semantics |
| STU-1b | Generate panel + preflight + durable generation job for graphics, targeted AI refinement with scope and locks, proposals with selective accept, adapt to another channel/format without destroying the original, revision generation inputs                                                  |
| STU-2a | Video media foundation: streaming storage, ffmpeg in render image, video/audio ingest (probe, poster, strip, proxy, waveform), queue `video`, video exports, review inline video, variant video media + duration validation                                                                  |
| STU-2b | VideoProject model, ops, reducer, timeline editor UI, preview, ffmpeg compositor render, video templates                                                                                                                                                                                     |
| STU-3  | AI storyboard, assembly, recut and targeted timeline edits, captions from script, audio options                                                                                                                                                                                              |
| STU-4  | Studio -> review -> publish path for both kinds, campaign links, deployed acceptance journeys                                                                                                                                                                                                |

## STU-1a as built (notes for later stages)

- Custom page sizes are format keys `custom_<width>x<height>` (64..4096 px, long edge at most 8 × the short edge),
  parsed by `formatFor` into a definition with a 5 % safe area; renders, variants, template formats and checks treat
  them like presets, so no separate `custom` field was needed on pages. Presets `yt_thumbnail_1280x720` and
  `li_banner_1584x396` were added.
- `contentType` (optional, no default) lives on the CreativeDocumentV1 snapshot; pages have an optional `locked`
  (unlocking removes the key). Stored snapshots parse and hash unchanged; no migration.
- Built-in starters live in `packages/editor/src/starters` and are instantiated in the browser with the published
  brand system (`instantiateStarter`); `documents.create` takes `source` (blank | custom | starter | template) and
  `contentType`, records both in the audit, and resolves a brand template version itself. New procedures:
  `creative.documents.duplicate`, `creative.documents.rename`, `creative.templates.retire`.
- Locks: `guardLocks` (packages/editor/src/guard.ts) runs in `evaluateBatch` for agent batches; the reducer refuses
  manual move/resize/rotate/align/distribute of locked elements and on locked pages.
- The content type model of the creation screen is `apps/web/src/features/studio/create/content-types.ts`; the
  `video` entry is where STU-2b wires the video document kind.
- Generated raster images are detected from the asset version's provenance kind, now returned by
  `assets.media.signedUrl` (`origin`).

## STU-1b as built (notes for later stages)

- Contracts: `packages/contracts/src/generation.ts` (brief, refine request with explicit scope and action
  `edit | alternatives | adapt`, preflight, job DTO states, the model's strict output `ModelGenerationOutput`, proposal
  groups, `GenerationInputs`, workflow input and activity interfaces). Job ids use the prefix `sgj`.
- Migration `0025_studio_generation` (self-contained drizzle-kit output, after BSC-4's `0024_brand_assist`): table `studio_generation_jobs` (one row per document, base revision and inputs hash; attempts update it
  in place) and nullable `creative_revisions.generation_inputs`. Rows written before it read as null.
- Pure parts in `packages/editor/src/generation.ts`: slots of a page (template slots or the element's role; locked,
  protected, logo, hidden, locked-page and out-of-scope elements listed as fixed), the structural operations a request
  implies (applyTemplate with role-bound slots, duplicatePage for alternatives, createFormatVariant for adapt), the
  compiler from slot fills to operations (text within the slot limit with effective fact ids, eligible assets only,
  palette tokens only, boxes inside the page, type size/weight/align; anything else refused with a reason), proposal
  grouping for selective accept, and the preflight rules. `guardScope` (packages/editor/src/guard.ts) is ancestor-aware
  and runs in `evaluateBatch` whenever a batch carries a scope (the job's batches and the accept of its proposal).
- Service: `generationService` (module-creative) preflight/start/get/active/cancel/retry; start needs creative.edit
  and agent.start_run; the outbox starts `studioGenerationWorkflowV1` on queue `agents` (workflow id
  `studio-gen:<jobId>:<attempt>`), cancel moves the row first, releases the reservation and is relayed as a signal.
  The model call lives in module-agents (`createStudioGenerationRuntime`, the worker's adapter and price list); the
  prompt (`packages/ai/src/generation-prompt.ts`) renders BSC-1 guidance for the destination channel and copy type,
  facts by id, palette, logo rules and asset descriptions as untrusted evidence, and forces one tool with a strict
  JSON schema.
- Revision model and variations: revisions are a linear head, so a proposal set of alternatives on one document would
  fight the head. Variation 1 goes into the document itself; each further variation is a duplicate of the base
  revision with its own generated revision (`resultDocumentIds`). A document whose revisions after the first are all
  generated is "fresh" and receives the revision directly (undoable: the studio adopts it as a history entry); a
  document a person edited, and every refinement, gets a proposal. Accept sends exactly the chosen groups' operations
  to `operations.applyBatch` with `generation: { jobId, groupIds }`; the server checks them against the stored
  proposal and its scope and records the inputs with `acceptedGroupIds`. A proposal with blocking findings (e.g. a
  reflowed logo outside a story's safe area: agents may not move logos) can only be taken as the person's own edit.
- Image generation for empty image areas: preflight and the panel gate it on `registerGenerationImageAvailability`,
  which no deployment registers yet, because a generated image is a pending asset (rights unknown) that the
  eligibility rule refuses to place. Wiring generation through the asset approval path is left for a later stage.
