# Production UI and integrated digital performance programme

Brief received 30 September 2026 (owner). Baseline `f51e207` on `main`. This directory is the programme's working
record; the progress ledger (`docs/progress/progress.json`) stays the single status source and points here.

| File                                                                 | Contents                                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [00-current-state-map.md](00-current-state-map.md)                   | Route → read model → mutation → worker/provider → read-back, per screen, classified I / D / A / U |
| [01-ux-verification.md](01-ux-verification.md)                       | UX-01 to UX-20 re-verified against `f51e207`: evidence, what is reusable, what is missing         |
| [02-prototype-parity-inventory.md](02-prototype-parity-inventory.md) | Every interactive element of the v3 prototype, with data-backed vs decorative marked              |
| [03-implementation-ledger.md](03-implementation-ledger.md)           | Requirement ledger: severity, dependency, work by layer, verification mode, status, evidence      |
| [04-decision-log.md](04-decision-log.md)                             | Decisions taken with working defaults (Appendix B of the brief) and what confirms each            |
| [05-estimate.md](05-estimate.md)                                     | Work packages, effort, external lead times, dependencies, contingency; refreshed after slice 1    |

Evidence modes used throughout, in the brief's terms: **source-reviewed**, **fixture/unit**, **local db/workflow**,
**staging browser**, **real provider**, **production observation**. A row is never complete because its UI exists.

Phase 0 verdict (30 September 2026): the toolchain is consistent and reproducible on the declared runtime; all
twenty UX findings stand at `f51e207` (UX-14 partially); R1 is blocked on provider certification regardless of UI
work, so certification prerequisites run in parallel with Phases 1–3.
