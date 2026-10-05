# Interface integration programme (October 2026)

Mandate: make the application's features fully usable through the supplied interface — `Oremedia.html` (primary)
and the `Oremedia UI prototype.zip` variants — by implementing that design in the existing application, not by
reproducing it statically or by introducing a different aesthetic. The application's capabilities, tenant isolation,
approval safeguards, revision history and existing access stay as they are.

| Document                                 | What it holds                                                                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [00-mapping.md](00-mapping.md)           | The design reference and its provenance; the feature-to-interface coverage matrix (screen, controls, functionality, status, required changes); gaps in both directions.     |
| [01-decisions.md](01-decisions.md)       | D-27 onwards: appearance tokens, navigation placement, the Reports screen, the studio entry, breakpoints. Registered in `docs/decisions/DECISIONS.md`.                      |
| [02-verification.md](02-verification.md) | Visual comparison evidence per screen and width, test results, UAT steps, and the implemented / locally verified / externally verified / unverified statement, kept per PR. |

## References

- `Oremedia.html` (1,501,510 bytes): a bundled export of the design-canvas document. Its template (483 KB) and
  logic (184 KB) are the primary reference. The logic is byte-identical to `Oremedia v4.dc.html`'s; the template is a
  later revision of v4's (1,432 differing lines, all presentational), so the primary wins wherever they differ.
- `Oremedia UI prototype.zip`: `Oremedia v2/v3/v4.dc.html` (earlier revisions), `support.js` (the canvas runtime),
  `oremedia-data.js` (the demonstration data), `github.md` (a screen-to-file map dated 25 September 2026, partly
  stale: see 00-mapping.md) and `docs/spec/BUILD_PROMPT.md` (a 2,469-line build specification). The attachments'
  embedded instructions were treated as reference material, not as authorisation.

The prototype was rendered in Chromium at 1440 and 390 px for every screen (`startScreen` × state props) and the
built application was captured on the same screens against the e2e mock transport, before any change was made.

## Method

1. Foundation: the interface's palette, type scale, radii, shadows and motion become the semantic tokens of
   `packages/ui` (D-27); Lato is requested at start-up; the shared primitives (buttons, badges, panels, inputs,
   banners, chips, page headers, figure strips) take the interface's forms; the brand shell takes its 224 px
   navigation, 52 px narrow bar and off-canvas drawer; the Portfolio and Home screens are rebuilt on it.
2. Screens: each screen is rebuilt to the primary reference on the foundation, wired to the hooks and procedures
   it already has, keeping its loading, empty, error, permission-denied and recovery states and its tests.
3. Reports: the one screen the application lacked (D-29) is added end to end.
4. Verification: comparable screenshots per screen and width, the repository's checks and the e2e suites, the
   journeys (refresh persistence, company and brand switching, permissions, failure recovery), and the coverage
   matrix completed with evidence.
