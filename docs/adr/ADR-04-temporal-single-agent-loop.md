# ADR-04: Temporal for durable work; one agent loop inside activities; no second agent framework

**Status:** Proposed
**Date:** 23 September 2026
**Reversal cost:** Medium.

## Decision

Temporal (TypeScript SDK 1.x) owns durable state and waits. The model loop is bounded inside activities. Roles
(planner, copywriter, designer, reviewer, analyst) are skill + tool-allowlist configurations, not services.
The reference codebase's three AI stacks are not replicated; its generation pipeline's decomposition is a
skill-decomposition reference only. Temporal persistence never shares the application database.
