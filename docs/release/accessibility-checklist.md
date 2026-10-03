# Accessibility checklist (manual, Release 1)

The automated half is `apps/web/e2e/a11y.e2e.test.ts` (`apps/web/e2e/a11y.ts`: the WCAG 2.2 AA rules of spec
21.3 on every screen in both themes at 390 px and 1280 px, the keyboard path of every pointer action, dialog focus
traps and toasts), run in CI on every change against the mock transport and, by the staging acceptance job
(`docs/runbooks/staging-acceptance.md`), against the deployed origin on the public screens and the real brand home
and brand system. This checklist is the half a person walks on staging before Release 1, with a keyboard only, a
screen reader, and the deployment's brand pack. Record the walk in `docs/release/r1-evidence.md` ("UAT") with the
date, the browser and assistive technology used, and each item's result.

Tools: a keyboard with the mouse unplugged; VoiceOver (Safari, macOS) or NVDA (Firefox, Windows); the browser's
reduced-motion setting (macOS: Accessibility → Display → Reduce motion; Windows: Settings → Accessibility → Visual
effects → Animation effects off); the browser's accessibility tree inspector for names and roles.

## 1. Keyboard-only paths for the eight UAT journeys

Every step is reached with Tab / Shift+Tab, activated with Enter or Space, and left with Escape; the focused control
is always visible (a 2 px ring in the deployment's `--ring` colour) and never under the header, a drawer or a toast.
Journey numbers are `docs/runbooks/uat-journeys.md`.

| #   | Journey                                                          | Keyboard path to confirm                                                                                                                                                                                                                                                                                                            | Done |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| U1  | Sign in, portfolio, open the company and the brand               | `/sign-in`: Tab reaches "Skip to content", "Continue with Google", Email, Password, "Sign in" in that order; a wrong password announces its message in the Password field's error; the portfolio's "Companies" list, each company's "Open" link, the "Brands" list and the brand's "Open" link are all Tab stops                    |      |
| U2  | Brand set-up: brand system saved, a channel connected or skipped | Brand system: the "Brand system sections" navigation, each section's "Edit" button (named with the section), every field of the editor, "Cancel", "Save" and the "Save and apply" confirmation; the proposed update's "Review" and "Discard" and the discard confirmation (D-22); the setup checklist's "Skip" and "Finish" buttons |      |
| U3  | Upload, scan, approve, rights                                    | Assets: the file input is reachable and opens the picker with Enter; the uploaded asset's row; "Approve"; the rights form's dates and "Save"; the "Needs attention" row links back to the asset                                                                                                                                     |      |
| U4  | Brief → package with copy and variants for two channels          | Campaigns: the brief, "Create package", the title and copy fields, the channel checkboxes (`Space` toggles; each has the channel's name), "Generate variants"; each variant's text is reachable and editable                                                                                                                        |      |
| U5  | Review request, external reviewer decides once, approval binds   | "Planned publish time", "Request review", "Open in the review inbox"; in the inbox the request, "Approve", "Request changes"; the external reviewer link's "Copy"; on the portal (`/review-portal`) the frozen manifest, "Approve", and the "already decided" state on a second visit                                               |      |
| U6  | Schedule and publish on two channels at the brand's time         | Calendar: the day, "Schedule", the approval chooser (`option`s, arrow keys), the time, "Schedule"; the publication's per-channel outcomes are reachable rows; "Cancel" opens a named dialog that traps focus and returns it to "Cancel" on Escape                                                                                   |      |
| U7  | Remote change reconciled; a post-approval edit holds the release | The remote-change banner's "Reconcile" opens the "Reconcile the outcome" dialog (named, trapped, Escape closes, focus returns); "Edit" on an approved revision, then the hold notice and its "Open the request" link                                                                                                                |      |
| U8  | Performance and next steps; a recommendation becomes a brief     | Overview and performance: the period buttons, the per-post rows (a row is a link), the trend's table alternative; Intelligence: a recommendation's "Accept" and the resulting brief link                                                                                                                                            |      |

Also, on every screen: the Menu button at phone width opens a drawer that traps focus and closes on Escape; "Sign
out" is a button reachable from the drawer and the sidebar; no control needs a hover to be seen.

## 2. Screen reader names of the main landmarks

With the screen reader's landmark list (VoiceOver rotor → Landmarks; NVDA `D` / Insert+F7):

| Landmark                | Expected name / role                                                                                                                    | Done |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Skip link               | "Skip to content" is the first Tab stop on every page and moves focus to the main region                                                |      |
| Header                  | one `banner` (the top bar) naming the current screen; at brand level it carries the company (labelled "Company") and the brand switcher |      |
| Brand navigation        | `navigation` named "Brand sections" with the section links and their "n need you" counts read as text, not colour                       |      |
| Brand system navigation | `navigation` named "Brand system sections"                                                                                              |      |
| Main                    | exactly one `main` region per page (`#main`), with exactly one level-1 heading                                                          |      |
| Portfolio lists         | lists named "Companies" and "Brands"; each company and brand is a `region` named after it                                               |      |
| Members                 | a list named "Members"                                                                                                                  |      |
| Dialogs                 | every `dialog` / `alertdialog` has an accessible name (its title), e.g. "Reconcile the outcome"                                         |      |
| Status                  | toasts and save state are announced (`status` / `alert`) and never only shown by colour                                                 |      |
| Forms                   | every field announces its label, and an error is read with the field (`aria-describedby`)                                               |      |

## 3. Contrast of the deployment brand tokens

The chrome's colours are the semantic tokens of `packages/ui/src/tokens.css`; a deployment brand pack
(`apps/web/deployment-brands/<pack>/theme.css`, `OREMEDIA_DEPLOYMENT_BRAND`) may override them. Check with the
browser's contrast inspector, in both themes, that every text pair meets 4.5:1 (3:1 for large text and the focus
ring against its background):

| Pair                                                    | Light | Dark | Done |
| ------------------------------------------------------- | ----- | ---- | ---- |
| `--foreground` on `--background` (body text)            |       |      |      |
| `--muted-foreground` on `--background` and on `--muted` |       |      |      |
| `--primary-foreground` on `--primary` (primary buttons) |       |      |      |
| `--accent-foreground` on `--accent`                     |       |      |      |
| `--secondary-foreground` on `--secondary`               |       |      |      |
| `--ring` against `--background` (focus ring, ≥ 3:1)     |       |      |      |
| status colours (`text-status-*`) on their backgrounds   |       |      |      |
| link text on `--background`                             |       |      |      |

The Ore & Tar pack notes its own trap: the brand's teal (`#2a9d8f`) reaches only 3.3:1 under white text, so its
light accent is a deeper teal of the same hue; a new pack must be checked the same way before it is set.

## 4. Reduced motion

With the operating system's reduce-motion setting on (`apps/web/src/styles/app.css` honours
`prefers-reduced-motion: reduce` by shortening every animation and transition to 0.01 ms):

| Check                                                                                | Done |
| ------------------------------------------------------------------------------------ | ---- |
| Drawers, dialogs and toasts appear and disappear without a slide or fade             |      |
| The calendar's day change and the studio's selection do not animate                  |      |
| Skeletons and progress indicators do not pulse (a static placeholder is acceptable)  |      |
| Nothing auto-plays or loops (no decorative motion on the sign-in or portfolio pages) |      |
| Focus changes are immediate: no smooth scrolling that hides where focus went         |      |
