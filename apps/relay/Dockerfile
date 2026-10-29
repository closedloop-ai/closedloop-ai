# ---------------------------------------------------------------------------
# Relay Server Dockerfile
#
# The relay is a stateless Socket.IO ↔ HTTP bridge. It holds WebSocket
# connections for desktop workers and forwards events to Vercel's API.
# No database access — Vercel is the source of truth.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Stage 1: Builder — install deps & compile TypeScript
# ---------------------------------------------------------------------------
FROM node:24-slim AS builder

RUN corepack enable

WORKDIR /app

# Copy workspace root files needed for pnpm install (corepack reads packageManager from package.json)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm-workspace.yaml declares workspace patchedDependencies (e.g. the
# desktop-only @libsql/client patch); pnpm resolves the patch files at install
# time even when the patched package is outside this filter's closure.
COPY patches/ patches/
RUN corepack prepare --activate
COPY tsconfig.json ./

# Manifests only (no database!). pnpm needs every closure member's package.json
# on disk to resolve the workspace symlinks; keeping source out of this layer is
# what lets an edit to a workspace package reuse the cached install (FEA-1560).
COPY apps/relay/package.json apps/relay/tsconfig.json apps/relay/
COPY packages/observability/package.json packages/observability/
COPY packages/api/package.json packages/api/
COPY packages/redis/package.json packages/redis/
COPY packages/loops-api/package.json packages/loops-api/
COPY packages/shared-platform/package.json packages/shared-platform/
# telemetry-contract reaches relay only transitively (via @repo/observability).
# Nothing in relay's import graph resolves it, so its source is never copied —
# here or below; the manifest alone is what pnpm needs to resolve the symlink
# (FEA-4118).
COPY packages/telemetry-contract/package.json packages/telemetry-contract/
# vitest-config is a test-only devDependency (the reporter pin every vitest.config
# imports). The builder's install is not `--prod`, so pnpm needs its manifest on
# disk to resolve the workspace symlink; nothing in relay's runtime import graph
# ever resolves it, so no dist/src is copied.
COPY packages/vitest-config/package.json packages/vitest-config/
COPY packages/typescript-config/package.json packages/typescript-config/

# Install dependencies (workspace mode, only for the relay app and its deps)
RUN pnpm install --frozen-lockfile --filter relay... --ignore-scripts
# The COPYs below mutate the tree between this install and the `pnpm run` step
# that follows, which is what makes pnpm's pre-run deps check decide node_modules
# is stale and launch an unfiltered network install — the FEA-2653 mechanism,
# here in the builder rather than at boot.
ENV PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false

# Workspace sources and tsconfig bases, after the install. None is an input to
# `pnpm install`, which resolves from manifests alone, so keeping them below it is
# what lets an edit to any of them reuse the cached install layer. shared-platform
# is also a DIRECT relay dependency — FEA-1989 imports its keyless-telemetry entry.
COPY packages/typescript-config/ packages/typescript-config/
COPY packages/observability/ packages/observability/
COPY packages/api/ packages/api/
COPY packages/redis/ packages/redis/
COPY packages/loops-api/ packages/loops-api/
COPY packages/shared-platform/ packages/shared-platform/

# Copy relay source code
COPY apps/relay/src/ apps/relay/src/

# @repo/loops-api and @repo/shared-platform are consumed from source (their
# exports resolve to ./src/*.ts), so there is nothing to pre-build — runtime tsx
# resolves them directly. Build relay itself.
RUN pnpm --filter relay build

# ---------------------------------------------------------------------------
# Stage 2: Runtime — minimal image with compiled output
# ---------------------------------------------------------------------------
FROM node:24-slim AS runtime

RUN corepack enable

WORKDIR /app

# Copy workspace root files (corepack reads packageManager from package.json)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Workspace patchedDependencies patch files — required by pnpm install (see builder stage).
COPY patches/ patches/
RUN corepack prepare --activate
COPY tsconfig.json ./

# Copy package manifests for production install
COPY apps/relay/package.json apps/relay/
COPY --from=builder /app/apps/relay/tsconfig.json apps/relay/
COPY packages/observability/package.json packages/observability/
COPY packages/api/package.json packages/api/
COPY packages/redis/package.json packages/redis/
COPY packages/loops-api/package.json packages/loops-api/
# shared-platform manifest for prod workspace-symlink resolution; relay imports
# @repo/shared-platform/keyless-telemetry at runtime, so its source is
# copied below (alongside the manifest).
COPY packages/shared-platform/package.json packages/shared-platform/
# telemetry-contract manifest — transitive workspace dep of @repo/observability;
# needed for prod symlink resolution. Never resolved at runtime, so no dist/src.
COPY packages/telemetry-contract/package.json packages/telemetry-contract/
# vitest-config manifest for the prod workspace-symlink resolution (see builder
# stage); it is a test-only devDependency, so no dist/src is copied.
COPY packages/vitest-config/package.json packages/vitest-config/

# Copy typescript-config (tsconfig bases) — needed by tsx for .ts resolution
COPY --from=builder /app/packages/typescript-config/ packages/typescript-config/

# Install production-only dependencies
RUN pnpm install --frozen-lockfile --filter relay... --prod --ignore-scripts

# Copy relay source so runtime tsx can resolve workspace deep imports consistently.
COPY --from=builder /app/apps/relay/src/ apps/relay/src/

# Copy shared workspace packages needed at runtime for module resolution
COPY --from=builder /app/packages/observability/ packages/observability/
# tsx resolves @repo/api deep imports (e.g. @repo/api/src/types/api-key) at runtime.
COPY --from=builder /app/packages/api/src/ packages/api/src/
# @repo/redis source for tsx resolution
COPY --from=builder /app/packages/redis/src/ packages/redis/src/
# @repo/observability/log imports @repo/loops-api/secret-value-pattern at
# runtime (through redact.ts); its exports map resolves to
# ./src/secret-value-pattern.ts, resolved by tsx.
COPY --from=builder /app/packages/loops-api/src/ packages/loops-api/src/
# relay imports @repo/shared-platform/keyless-telemetry at runtime;
# its exports map resolves to ./src/keyless-telemetry.ts, resolved by tsx.
COPY --from=builder /app/packages/shared-platform/src/ packages/shared-platform/src/

ENV NODE_ENV=production
ENV RELAY_PORT=3020
# Disable pnpm's pre-run deps-status check — deps are fully baked at build time,
# so the `pnpm exec` CMD below must not trigger a network `pnpm install` at boot.
# Same failure mode that rolled back the mcp prod deploy (FEA-2653): the check
# evaluates all workspace projects at container start and can OOM-kill the task
# before it becomes healthy. A production container must never install at boot.
ENV PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false

EXPOSE 3020

CMD ["pnpm", "--filter", "relay", "exec", "tsx", "src/index.ts"]
