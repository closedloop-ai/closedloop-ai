# ---------------------------------------------------------------------------
# MCP Server Dockerfile
#
# Multi-stage build that compiles TypeScript in a builder stage and copies
# only the compiled JS + production dependencies to a slim runtime image.
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

# Copy only the packages the MCP server depends on
COPY apps/mcp/package.json apps/mcp/tsconfig.json apps/mcp/
COPY packages/api/ packages/api/
COPY packages/loops-api/ packages/loops-api/
# @repo/observability — mcp routes logging and bounded shutdown flushing through
# @repo/observability/log and @repo/observability/shutdown. Consumed from source
# (no exports map → root .ts files, resolved by tsx at runtime), so copy the
# full package like relay does.
COPY packages/observability/ packages/observability/
# telemetry-contract is a transitive workspace dep declared by @repo/observability;
# pnpm needs its manifest on disk to resolve the workspace symlink. mcp's log.ts
# import graph never resolves it at runtime, so no dist/src is copied.
COPY packages/telemetry-contract/package.json packages/telemetry-contract/
# shared-platform is a transitive workspace dep of @repo/api (which re-exports
# its EngineerRoutingMode SSOT); pnpm needs its manifest on disk to resolve the
# workspace symlink even though mcp does not import it directly. No dist/src is
# needed until something in mcp's import graph actually resolves the module.
COPY packages/shared-platform/package.json packages/shared-platform/
# crewd is a transitive workspace dep of @repo/api (its harness-conversion
# contract imports @repo/crewd/model); pnpm needs its manifest on disk to resolve
# the workspace symlink even though mcp does not import it directly. No dist/src
# is needed until something in mcp's import graph actually resolves the module.
COPY packages/crewd/package.json packages/crewd/
COPY packages/database/ packages/database/
COPY packages/redis/ packages/redis/
COPY packages/typescript-config/ packages/typescript-config/

# Install dependencies (workspace mode, only for the MCP app and its deps)
RUN pnpm install --frozen-lockfile --filter mcp... --ignore-scripts
# Generate Prisma client in clean CI checkouts where generated/ is absent.
RUN pnpm --filter @repo/database exec prisma generate --no-hints --schema=./prisma/schema.prisma

# Copy MCP source code
COPY apps/mcp/src/ apps/mcp/src/

# @closedloop-ai/loops-api is consumed from source (its exports resolve to ./src/*.ts),
# so there is nothing to pre-build; runtime tsx resolves it directly. Build MCP itself.
RUN pnpm --filter mcp build

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
COPY apps/mcp/package.json apps/mcp/
COPY --from=builder /app/apps/mcp/tsconfig.json apps/mcp/
COPY packages/api/package.json packages/api/
COPY packages/loops-api/package.json packages/loops-api/
# shared-platform manifest needed for the prod workspace-symlink resolution of
# @repo/api (see builder stage); mcp does not import it, so no dist is copied.
COPY packages/shared-platform/package.json packages/shared-platform/
# crewd manifest for the prod workspace-symlink resolution of @repo/api (see
# builder stage); mcp does not import it, so no dist/src is copied.
COPY packages/crewd/package.json packages/crewd/
COPY packages/database/package.json packages/database/
COPY packages/redis/package.json packages/redis/
# @repo/observability manifest for the prod workspace-symlink resolution; its
# source is copied below (mcp resolves @repo/observability/* from source via tsx).
COPY packages/observability/package.json packages/observability/
# telemetry-contract manifest — transitive workspace dep of @repo/observability;
# needed for prod symlink resolution. Never resolved at runtime, so no dist/src.
COPY packages/telemetry-contract/package.json packages/telemetry-contract/

# Copy typescript-config (tsconfig bases) — needed by tsx for .ts resolution
COPY --from=builder /app/packages/typescript-config/ packages/typescript-config/

# Install production-only dependencies
RUN pnpm install --frozen-lockfile --filter mcp... --prod --ignore-scripts

# Copy MCP source so runtime tsx can resolve workspace deep imports consistently.
COPY --from=builder /app/apps/mcp/src/ apps/mcp/src/

# Copy shared workspace packages needed at runtime for module resolution.
# loops-api is consumed from source (exports -> ./src/*.ts), resolved by tsx.
COPY --from=builder /app/packages/api/src/ packages/api/src/
COPY --from=builder /app/packages/loops-api/src/ packages/loops-api/src/
COPY --from=builder /app/packages/database/ packages/database/
COPY --from=builder /app/packages/redis/src/ packages/redis/src/
# @repo/observability is consumed from source (no exports map → root .ts files),
# so copy the full package for tsx to resolve @repo/observability/* at runtime.
COPY --from=builder /app/packages/observability/ packages/observability/

ENV NODE_ENV=production
ENV MCP_PORT=3010
# Emit structured single-line JSON to stdout so @repo/observability/log runs its
# meta through redactLogValue on the console path too (util.inspect on a plain
# console line would print meta unredacted), and so a stdout drain parses fields
# into first-class facets. The agentless Datadog intake (DD_API_KEY) already
# redacts; this covers the CloudWatch/console path for the OAuth-table reader.
ENV DD_LOGS_JSON=1
# Disable pnpm's pre-run deps-status check. Deps are fully baked into this image
# at build time (stage 2 `pnpm install --frozen-lockfile --filter mcp... --prod`),
# so the check is pointless at runtime — and harmful: the `pnpm exec` CMD below
# triggers `verify-deps-before-run`, which evaluated all workspace projects at
# container start, decided node_modules was stale, and launched a network
# `pnpm install --production` inside the running task. In prod that install was
# OOM-killed (SIGKILL) before the health check passed, so ECS never stabilized
# and rolled the deploy back (FEA-2653). A production container must never
# install dependencies at boot.
ENV PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false

EXPOSE 3010

# pnpm --filter mcp exec sets CWD to /app/apps/mcp/, so paths are relative to that.
# --require needs ./ prefix for CWD-relative resolution (not node_modules lookup).
# preload.cjs (not .ts/.js) because --require only loads CJS modules.
CMD ["pnpm", "--filter", "mcp", "exec", "tsx", "--require", "./src/preload.cjs", "src/index.ts"]
