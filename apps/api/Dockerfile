# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# apps/api production image for the containerized, Vercel-independent E2E
# target (FEA-2091).
#
# apps/api does NOT use Next `output: "standalone"`; it serves via a custom
# `tsx server.ts` (node:http + Next request handler + desktop-gateway socket
# server), so the runtime image carries the built `.next` + the installed
# workspace `node_modules` + source rather than a traced standalone bundle.
#
# The workspace closure is derived mechanically with `turbo prune api --docker`
# (no hand-maintained COPY list), satisfying the CLAUDE.md "Dockerized Workspace
# Apps" rule that every required @repo/* package + transitive dep is present.
# Validate BOTH `--target builder` and the full image (CLAUDE.md mandate).
# ---------------------------------------------------------------------------

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV PNPM_STORE_PATH=/pnpm/store
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

# --- Pruner: produce the api workspace closure (manifests + source) ---
# `turbo prune` runs before install, so turbo is fetched with `pnpm dlx`. Derive
# its version from the workspace package.json (not a hard pin) so the prune-time
# turbo always tracks main's turbo and can't drift out of sync.
FROM base AS pruner
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=cl-e2e-pnpm-store,target=/pnpm/store,sharing=locked \
    corepack prepare --activate && \
    pnpm config set store-dir "${PNPM_STORE_PATH}" && \
    pnpm config set fetch-retries 5 && \
    pnpm config set fetch-retry-mintimeout 20000 && \
    pnpm config set fetch-retry-maxtimeout 120000 && \
    pnpm config set fetch-timeout 600000 && \
    turbo_version="$(node -p "require('./package.json').devDependencies.turbo.match(/[0-9.]+/)[0]")" && \
    pnpm dlx "turbo@${turbo_version}" prune api --docker

# --- Builder: install + build (next build + server import-smoke) ---
FROM base AS builder
WORKDIR /app
ARG TURBO_TEAM=""
ARG TURBO_API=""
# next build's TypeScript phase is memory-hungry; lift the heap cap (mirrors the
# repo's loops-setup NODE_OPTIONS).
ENV NODE_OPTIONS=--max-old-space-size=4096
# Manifests first → cacheable install layer.
COPY --from=pruner /repo/out/json/ ./
# turbo prune emits a pruned lockfile that `pnpm install --frozen-lockfile`
# rejects on complex peer-resolved entries (e.g. vitest's peer hash). Use the
# full repo lockfile + a --filter scope instead — the proven apps/mcp /
# apps/relay pattern — so the frozen install stays deterministic.
COPY --from=pruner /repo/pnpm-lock.yaml ./pnpm-lock.yaml
# The full lockfile records the workspace patchedDependencies, but turbo prune
# strips entries outside the api closure (e.g. the desktop-only @libsql/client
# patch) from its pruned pnpm-workspace.yaml — pnpm then rejects the frozen
# install with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH. Carry the full workspace
# manifest + patches/ so config and lockfile agree.
COPY --from=pruner /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=pruner /repo/patches/ ./patches/
RUN corepack prepare --activate
RUN --mount=type=cache,id=cl-e2e-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm config set store-dir "${PNPM_STORE_PATH}" && \
    pnpm config set fetch-retries 5 && \
    pnpm config set fetch-retry-mintimeout 20000 && \
    pnpm config set fetch-retry-maxtimeout 120000 && \
    pnpm config set fetch-timeout 600000 && \
    pnpm install --frozen-lockfile --filter api... --ignore-scripts --prefer-offline
# Later filtered build commands can trigger pnpm's dependency-status install;
# keep lifecycle scripts suppressed because this pruned api context owns its
# Prisma generation explicitly instead of relying on the root postinstall.
RUN pnpm config set ignore-scripts true
# Full source closure.
COPY --from=pruner /repo/out/full/ ./
# Prisma client (clean checkout has no generated/).
RUN pnpm --filter @repo/database exec prisma generate --no-hints --schema=./prisma/schema.prisma
# Build @closedloop-ai/telemetry-contract, the one dist-backed workspace package
# api resolves via its exports map (tsup → dist). shared-platform, loops-api,
# design-system, @repo/api, and @repo/observability are all consumed from source
# (their exports resolve to ./src), so none needs a prebuild. @repo/database's
# client is generated above — its `build` is NOT run here because its `prebuild`
# runs migrate, which needs a live DB.
RUN pnpm --filter @closedloop-ai/telemetry-contract build
# api build = `next build` + `server:import-smoke` (apps/api/package.json).
RUN --mount=type=secret,id=turbo_token,required=false \
    if [ -s /run/secrets/turbo_token ]; then export TURBO_TOKEN="$(cat /run/secrets/turbo_token)"; fi && \
    if [ -n "${TURBO_TEAM}" ]; then export TURBO_TEAM; fi && \
    if [ -n "${TURBO_API}" ]; then export TURBO_API; fi && \
    pnpm exec turbo run build --filter=api --only

# --- Runner ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3002
# These apps are not standalone, so `tsx server.ts` needs the runtime
# node_modules + built .next + source. Carry the built workspace wholesale.
COPY --from=builder /app/ ./
EXPOSE 3002
# api `start` = `NODE_ENV=production tsx server.ts` (cwd = apps/api).
CMD ["pnpm", "--filter", "api", "start"]
