# ADR-11: OpenRouter as the single gateway for text, image, video and audio models

**Status:** Accepted (programme owner, 25 September 2026)
**Date:** 25 September 2026
**Reversal cost:** Low for text (the `ModelAdapter` seam already exists); medium for media generation, whose job
contracts would need a second provider behind the same interfaces.

## Context

Decision D-06 asks for image generation (Nano Banana), video generation (Seedance, with other models allowed) and
audio generation, all reached through OpenRouter so that one account carries billing and model choice. OpenRouter
exposes chat models with tool use, image output through chat completions (`modalities: ["image", "text"]`), video
generation (Seedance 2.x, Veo 3.1, Wan, Sora 2), text to speech (`/api/v1/audio/speech`) and music models (Lyria 3).
Until now the agent loop called Anthropic directly (`AnthropicModelAdapter`, `ANTHROPIC_API_KEY_REF`).

## Decision

1. **One gateway.** Text, image, video and audio calls go through OpenRouter with one key (`OPENROUTER_API_KEY_REF`).
   `AnthropicModelAdapter` stays as an alternative adapter behind the same `ModelAdapter` seam; it is not the default.
2. **OreMedia chooses the model, not the gateway.** The routing policy (`MODEL_ROUTING_POLICY_REF`, per-tenant
   `agents.routingPolicy`) maps each task class (planning, copy, review, image, video, speech, music) to an explicit
   OpenRouter model id with a per-call cost ceiling. OpenRouter's automatic router is not used for agent runs:
   runs must be reproducible for evaluation (spec 19.6) and costed before they start.
3. **Media generation is a durable job.** Image, video and audio generation run as Temporal activities with the
   provider job id persisted (the existing provider-jobs pattern), so a worker restart resumes polling instead of
   paying twice. Budgets are checked before submission and charged once per job.
4. **Generated media is an asset.** Output lands in the asset pipeline with rights `ai_generated`, a provenance
   record (model id, provider, time, prompt fingerprint, cost) and the platform's AI-content label where the
   channel requires one. It follows the normal review and approval path; nothing generated publishes unreviewed.
5. **Client data controls.** Requests ask OpenRouter to exclude providers that retain or train on prompts, and each
   brand's policy can restrict which underlying providers may process its content (for example, excluding a
   provider a client objects to) without affecting other brands.
6. **Cost control in two layers.** A hard credit limit on the OpenRouter key; OreMedia's per-brand budgets and
   per-call metering (billing module) inside it.

## Consequences

- The agent worker needs `OPENROUTER_API_KEY_REF` instead of `ANTHROPIC_API_KEY_REF`.
- New adapters: `OpenRouterModelAdapter` (chat with tool use), and image, video and audio generators behind the
  existing `ImageGenerationAdapter` seam and two new sibling interfaces.
- Video and audio generation are new Release 1 scope, shipped behind feature flags; they do not sit on the critical
  path to the pilot, which is channel certification.
- One more data processor (OpenRouter) sits between OreMedia and the model providers; the data-processing terms of
  OpenRouter and of each allowed provider belong in the client agreement.
