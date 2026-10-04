# Runbook: turn an engineering flag on or off

**When:** a pilot company opts in to a gated feature, a gated feature goes to every company, or a gated feature must
be withdrawn. **Owner:** platform on-call under a support session (two operators: one opens, a second escalates).
Tenant owners, admins, API keys and agents cannot change flags. **Exercised:** locally by
`apps/api/src/feature-flags.integration.test.ts` (members, API keys and agents refused and audited; read-only session
refused; tenant and global changes; stale version; idempotent replay; a session on company A cannot target company
B) and `packages/ai/src/tools/generation-flags.integration.test.ts`. **Needs a live environment for:** the support
sessions themselves (there is no operator screen in the web app).

## The flags

Every flag is off by default (`packages/modules/operations/src/feature-flags.ts`). Each one is read by the code it
gates (`feature-flags.test.ts` fails for a flag nobody reads):

| Flag                           | Gates                                                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `mandates.managed_autopublish` | creating a publishing mandate (managed autopublish), with the entitlement                                                              |
| `intelligence.brand_analyst`   | `intelligence.analyst.run` and the scheduled brand-analyst activity                                                                    |
| `experiments.randomised`       | starting a randomised experiment                                                                                                       |
| `creative.preview_render`      | worker preview renders for proposals. Turn on only once every worker-render runs the preview-aware build ([deploy](deploy-railway.md)) |
| `creative.video_generation`    | the `videos.generate` agent tool                                                                                                       |
| `creative.audio_generation`    | the `speech.generate` agent tool                                                                                                       |

`studio.agent_proposals` and the five `publishing.channel.*` flags were removed: nothing read them (agent
proposals shipped ungated; channel connect is gated by certification). Rows left in `feature_flags` for those keys
are ignored by every read and need no clean-up.

## Targeting model

A flag is one `feature_flags` row. A flag is on for a company when the company id is in `targeting.tenantIds`, when
the company falls inside `targeting.percentage`, or when `enabled_default` is true. So:

- `target: { kind: 'tenant', tenantId }` adds or removes that one company in `targeting.tenantIds`. A support session
  is bound to one company and can only target that company (`tenant_mismatch` otherwise); repeat per company.
- `target: { kind: 'global' }` sets `enabled_default`: every company.
- A company entry only ever turns a flag **on**. While the global default is on, removing a company does not turn the
  flag off for it; turn the global default off first.
- Percentage targeting is not changed by this procedure.

## Procedure

1. Open a support session on the company ([platform on-call access](README.md#platform-on-call-access-spec-57)):
   reason, ticket, consent flag, time box. A second operator escalates it with `access.supportSessions.escalate`.
2. Read the current state and version (allowed in a read-only session):

   ```sh
   curl -s "https://<api domain>/trpc/operations.flags.list" \
     -H "Authorization: Bearer sup_<sessionToken>.<supportSessionId>" \
     -H "X-Oremedia-Tenant: <tenantId>"
   ```

   Each entry has `globalEnabled`, `tenantTargeted`, `targetedTenantCount` (other companies' ids are never shown),
   `percentage`, `enabledForTenant` and `version` (`null` when the flag has no row yet).

3. Change the flag, quoting that version as `expectedVersion`:

   ```sh
   curl -s -X POST "https://<api domain>/trpc/operations.flags.set" \
     -H "Authorization: Bearer sup_<sessionToken>.<supportSessionId>" \
     -H "X-Oremedia-Tenant: <tenantId>" \
     -H "Idempotency-Key: $(uuidgen)" \
     -H "Content-Type: application/json" \
     -d '{"json":{"key":"experiments.randomised","target":{"kind":"tenant","tenantId":"<tenantId>"},"enabled":true,"expectedVersion":null,"reason":"pilot opt-in, OPS-77"}}'
   ```

   - `CONFLICT`: someone changed the flag since you read it. Read again (step 2) and repeat with the new version.
   - `FORBIDDEN`: the session is not escalated, has expired, or targets another company.
   - Retrying with the same `Idempotency-Key` returns the first answer without writing again. Setting the state the
     flag is already in returns `changed: false` and keeps the version.

4. Verify: `operations.flags.list` shows the new state, and `operations.audit.query` with
   `{ resourceType: 'feature_flag' }` shows `feature_flag.set` with the flag, scope, from/to state, reason and the
   session id. Refusals are audited as `denied` with their reason.
5. Close both support sessions.

To withdraw, repeat with `"enabled": false`. A gated behaviour already running (a scheduled analyst run, a render
already queued) finishes; nothing new starts.
