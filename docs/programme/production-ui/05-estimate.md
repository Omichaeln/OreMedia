# Estimate: work packages after Phase 0

All figures are estimates by the implementing agent, in engineering days of focused work (one engineer or one
agent session per package), based on the verified source and the reuse identified in `01-ux-verification.md`.
Assumptions: the existing modules, contracts and tests are extended, not replaced; each package ships as one or
two reviewable PRs with unit and integration tests; staging is available for browser evidence; no new framework.
Shared work is counted once. External lead times are outside engineering effort and run in parallel. Contingency
is applied per release, not per package. This estimate is refreshed after the first complete vertical slice (WP-2).

## R1 work packages

| WP  | Scope (ledger rows)                                        | Effort (days)                                         | Dependencies           | External lead time                                                                                                                                              |
| --- | ---------------------------------------------------------- | ----------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Package truth and discovery: UX-02, UX-13, UX-14, R1-A     | 6                                                     | —                      | —                                                                                                                                                               |
| 2   | Creative-to-review slice: UX-04, UX-03, UX-06, UX-01, R1-C | 9                                                     | WP-1                   | —                                                                                                                                                               |
| 3   | Assets: UX-05, R1-B                                        | 4                                                     | —                      | —                                                                                                                                                               |
| 4   | Studio: UX-15, UX-18, UX-07                                | 7                                                     | WP-5 (for UX-07)       | —                                                                                                                                                               |
| 5   | Agents and plans: UX-08, UX-09, UX-16, UX-17               | 9                                                     | —                      | —                                                                                                                                                               |
| 6   | Measurement: D-15 dictionary, UX-12, UX-11                 | 8                                                     | WP-1                   | Owner approval of the dictionary (D-14, D-15)                                                                                                                   |
| 7   | Brand impact and policy: UX-20                             | 3                                                     | —                      | Owner decision D-13                                                                                                                                             |
| 8   | Onboarding, responsive, accessibility: R1-D, R1-E, UX-19   | 5                                                     | WP-1, WP-3, WP-4       | —                                                                                                                                                               |
| 9   | Certification: UX-10 (three providers)                     | 6 (engineering: fixtures, adapter fixes, D-04 record) | operator prerequisites | Meta Business Verification and App Review: typically 1–4 weeks after submission; LinkedIn Community Management API: days to weeks; both unknown until submitted |
| 10  | Environments and release: R1-F, R1-G, R1-H, R1-I           | 6                                                     | staging credentials    | Operator staging setup (in progress)                                                                                                                            |

R1 engineering total: about 63 days. Contingency 25 % for integration and review rounds → about 79 days of
engineering. Wall-clock is bounded by the certification lead time, not by engineering: with WP-1 to WP-8
proceeding in parallel with WP-9's platform waits, R1 is realistically 8–12 weeks from the start of Phase 1,
and can slip beyond that only if platform approval does. Nothing in R1 launches without WP-9.

## R2 work packages (indicative; re-estimated after R1's first slice)

| WP  | Scope                                     | Effort (days) | External                                                                  |
| --- | ----------------------------------------- | ------------- | ------------------------------------------------------------------------- |
| 11  | Destinations and source-use policy (R2-0) | 6             | —                                                                         |
| 12  | GA4 + Search Console (R2-1)               | 12            | Google OAuth consent (existing project), property access; quota behaviour |
| 13  | Unified overview (R2-5)                   | 6             | D-15                                                                      |
| 14  | CMS articles/FAQs (R2-3)                  | 12            | Pilot CMS named, test site, integration identity                          |
| 15  | Technical SEO audit (R2-4)                | 5             | —                                                                         |
| 16  | Google Business Profile (R2-2)            | 10            | GBP API access prerequisites and data-policy approval (weeks; uncertain)  |

R2 engineering total about 51 days plus 25 % contingency. Each connector rolls out independently behind
capability and tenant flags, so a blocked connector does not hold the others.

## R3

Not estimated beyond order of magnitude: Discord announcements 4 days; each additional social channel 6–10 days
of adapter certification plus platform lead time; CRM/revenue connectors 8–15 days each depending on the source.

## What would change these numbers

- If the owner selects `flag` for D-13, add 3 days for approval binding v2 and its migration of stored hashes.
- If GBP writes are required in R2, add 6 days and a separate authorisation model.
- If the pilot CMS is not WordPress, WP-14 grows by the adapter (3–6 days) and the read-back tests.
- If bulk actions are added to the design (none exist in the prototype), add 2–4 days per screen.
