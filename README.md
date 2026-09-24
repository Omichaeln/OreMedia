# Oremedia

Multi-tenant platform for brand standards, creative production, bounded AI agents, review and approval, and
publication to social channels, with measurement and first intelligence. Built to the specification in
[`docs/spec/BUILD_PROMPT.md`](docs/spec/BUILD_PROMPT.md).

## Stack

pnpm workspaces and Turborepo · TypeScript (strict) · Express 4 and tRPC 11 · Zod · Drizzle ORM on MySQL 8 ·
Temporal 1.24 · React 19, Vite, React Router 7, TanStack Query, Tailwind 4 · Konva · Playwright (Chromium) ·
Vitest. Deployed on Railway (see [`docs/runbooks/deploy-railway.md`](docs/runbooks/deploy-railway.md)).

## Layout

| Path                 | What lives there                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `apps/api`           | tRPC API, public REST `/v1`, MCP `/mcp`                                                              |
| `apps/web`           | Studio and workspace web app, reviewer portal                                                        |
| `apps/worker-core`   | Temporal worker: agents, publishing, operations                                                      |
| `apps/worker-render` | Temporal worker: Chromium rendering                                                                  |
| `apps/worker-ingest` | Temporal worker: asset ingest, metrics and comment collection                                        |
| `apps/redirector`    | Tracked-link redirector                                                                              |
| `packages/*`         | contracts, domain, db (schema, migrations, roles), modules, workflows, activities, providers, ai, ui |
| `infra/railway`      | Dockerfiles and per-service `railway.json`                                                           |
| `docs`               | specification, ADRs, decisions, runbooks, operations, progress ledger                                |

## Local development

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm format && pnpm typecheck
pnpm test                                   # unit
TEST_DATABASE_URL=mysql://root:pass@127.0.0.1:3306/mysql pnpm test:integration
TEST_DATABASE_URL=mysql://root:pass@127.0.0.1:3306/mysql pnpm test:cross-tenant
```

Variable names for every service are in [`.env.example`](.env.example). Open decisions are in
[`docs/decisions/DECISIONS.md`](docs/decisions/DECISIONS.md); build progress is in
[`docs/progress/progress.json`](docs/progress/progress.json).
