# acceptance (docs/runbooks/staging-acceptance.md): the staging acceptance job, run INSIDE the staging Railway
# project as a one-off service so no credential ever leaves it. The image is the repository checkout with its
# development dependencies (vitest drives the browser suites in apps/web/e2e), the api bundle (whose
# acceptance-run entrypoint provisions the fixtures through the application services and runs every check),
# Chromium as the CI job installs it for Playwright, and the k6 binary for tooling/load/top-of-hour.js. It has no
# port and exits after each run; it must never be deployed in the production project (it creates companies,
# content and, with LOAD_ENABLED=1, publications).
# syntax=docker/dockerfile:1.7
FROM node:22.22.2-bookworm-slim AS base
# OS security updates at build time so the container scan (spec 2.1.12) judges the patched image, not the tag's snapshot.
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*

# The k6 binary from Grafana's release image: one static executable, no runtime dependencies.
FROM grafana/k6:1.8.1 AS k6

FROM base AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
# pnpm is installed from the registry (npm verifies integrity); corepack in this Node image carries a rotated-out signing key.
RUN npm install -g pnpm@10.6.1 && npm cache clean --force
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc turbo.json tsconfig.base.json tsconfig.json vitest.config.ts ./
COPY apps ./apps
COPY packages ./packages
COPY tooling ./tooling
# The full install, development dependencies included (the job runs vitest and the browser suites from this tree),
# as one flat node_modules: the api bundle inlines the workspace packages and resolves their third-party imports
# from the tree it sits in, exactly as the api image's production install does (infra/railway/Dockerfile).
RUN pnpm install --frozen-lockfile --config.node-linker=hoisted
# The api bundle carries the acceptance-run entrypoint next to main, migrate and bootstrap-owner (apps/api/tsup.config.ts).
RUN pnpm --filter @oremedia/api build

FROM base AS runtime
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true OREMEDIA_SERVICE=oremedia-acceptance \
  PLAYWRIGHT_BROWSERS_PATH=/ms-playwright ACCEPTANCE_REPO_DIR=/src
RUN npm install -g pnpm@10.6.1 && npm cache clean --force \
  && groupadd -r oremedia && useradd -r -g oremedia -d /home/oremedia -m oremedia
WORKDIR /src
COPY --from=build --chown=oremedia:oremedia /src /src
COPY --from=k6 /usr/bin/k6 /usr/local/bin/k6
# Chromium exactly as .github/workflows/ci.yml installs it (the pinned Playwright release of worker-render), with
# its system libraries, into a path the job's user can read.
RUN pnpm --filter @oremedia/worker-render exec playwright install --with-deps chromium \
  && chmod -R a+rX /ms-playwright && rm -rf /var/lib/apt/lists/*
USER oremedia
ENV OREMEDIA_MIGRATIONS_DIR=/src/apps/api/dist/migrations
ENV OREMEDIA_BUILTIN_SKILLS_DIR=/src/apps/api/dist/builtin-skills
CMD ["node", "apps/api/dist/acceptance-run.js"]
