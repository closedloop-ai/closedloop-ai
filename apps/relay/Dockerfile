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

# Copy only the packages the relay server depends on (no database!)
COPY apps/relay/package.json apps/relay/tsconfig.json apps/relay/
COPY packages/typescript-config/ packages/typescript-config/
COPY packages/observability/ packages/observability/
COPY packages/api/ packages/api/
COPY packages/redis/ packages/redis/
# loops-api is a transitive workspace dep of @repo/api; pnpm needs it on disk
# to resolve the workspace symlink even though relay doesn't import it directly.
COPY packages/loops-api/ packages/loops-api/
# shared-platform is now a DIRECT relay dependency — FEA-1989 imports
# @closedloop-ai/shared-platform/keyless-telemetry — as well as a transitive dep
# of @repo/api. Copy the full package; its source is required at runtime for the
# keyless telemetry ingress (copied into the runtime stage).
COPY packages/shared-platform/ packages/shared-platform/

# Install dependencies (workspace mode, only for the relay app and its deps)
RUN pnpm install --frozen-lockfile --filter relay... --ignore-scripts

# Copy relay source code
COPY apps/relay/src/ apps/relay/src/

# @closedloop-ai/loops-api and @closedloop-ai/shared-platform are consumed from source (their
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
# @closedloop-ai/shared-platform/keyless-telemetry at runtime, so its source is
# copied below (alongside the manifest).
COPY packages/shared-platform/package.json packages/shared-platform/

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
# @repo/observability imports @closedloop-ai/loops-api/commands at runtime;
# its exports map resolves to ./src/commands.ts, resolved by tsx.
COPY --from=builder /app/packages/loops-api/src/ packages/loops-api/src/
# relay imports @closedloop-ai/shared-platform/keyless-telemetry at runtime;
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
