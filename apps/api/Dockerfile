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
# (no hand-maintained COPY list), satisfying the AGENTS.md "Dockerized Workspace
# Apps" rule that every required @repo/* package + transitive dep is present.
# Validate BOTH `--target builder` and the full image (AGENTS.md mandate).
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
# ISS-12198: node_modules stays exactly what the install above wrote. Without
# this, the first `pnpm --filter`/`pnpm exec` below sees the newer out/full/
# manifests, re-resolves the whole closure against the registry (35 s median
# over 92 post-merge image builds, 2026-09-30..10-07) and rewrites the
# lastValidatedTimestamp in node_modules/.pnpm-workspace-state-v1.json, so the
# runner's node_modules layer would differ on every build.
ENV PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false
# Keep lifecycle scripts suppressed for every later pnpm command: this pruned
# api context owns its Prisma generation explicitly instead of relying on the
# root postinstall.
RUN pnpm config set ignore-scripts true
# Full source closure.
COPY --from=pruner /repo/out/full/ ./
# ISS-8775: `@repo/api`'s build routes tsc through the repo-root wrapper, which
# `turbo prune` does not emit — out/full/ carries workspace packages only. The
# `--only` below currently keeps `@repo/api#build` out of this graph, so this
# image is not broken today; carrying the two files anyway means dropping that
# one flag cannot reintroduce a MODULE_NOT_FOUND in the e2e stack build.
# Guarded by scripts/lint/build-tracer-immunity.test.ts.
COPY --from=pruner /repo/scripts/run-untraced.mjs /repo/scripts/tracer-preload-tokens.mjs ./scripts/
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
# node_modules + built .next + source. Carry the built workspace wholesale, in
# two layers (ISS-12198): first the root node_modules, which only the install
# step writes, so on a source-only change BuildKit reuses that layer from the
# cache instead of recompressing and pushing it again; then everything else.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder --exclude=node_modules /app/ ./
# Disable pnpm's pre-run deps-status check. Deps are fully baked into this image
# by the builder stage, so the check is pointless at runtime — and harmful: the
# `pnpm --filter api start` CMD below triggers `verify-deps-before-run`, which
# evaluates every workspace project at container start and, if it decides
# node_modules is stale versus the lockfile, launches a network `pnpm install`
# inside the running task. That is what OOM-killed the mcp prod deploy before
# its health check passed (FEA-2653). A runtime container must never install
# dependencies at boot (ISS-6482).
ENV PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false
EXPOSE 3002
# api `start` = `NODE_ENV=production tsx server.ts` (cwd = apps/api).
CMD ["pnpm", "--filter", "api", "start"]
