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
RUN corepack prepare --activate
COPY tsconfig.json ./

# Copy only the packages the MCP server depends on
COPY apps/mcp/package.json apps/mcp/tsconfig.json apps/mcp/
COPY packages/api/ packages/api/
COPY packages/loops-api/ packages/loops-api/
# shared-platform is a transitive workspace dep of @repo/api (which re-exports
# its EngineerRoutingMode SSOT); pnpm needs its manifest on disk to resolve the
# workspace symlink even though mcp does not import it directly. No dist/src is
# needed until something in mcp's import graph actually resolves the module.
COPY packages/shared-platform/package.json packages/shared-platform/
COPY packages/database/ packages/database/
COPY packages/redis/ packages/redis/
COPY packages/typescript-config/ packages/typescript-config/

# Install dependencies (workspace mode, only for the MCP app and its deps)
RUN pnpm install --frozen-lockfile --filter mcp... --ignore-scripts
# Generate Prisma client in clean CI checkouts where generated/ is absent.
RUN pnpm --filter @repo/database exec prisma generate --no-hints --schema=./prisma/schema.prisma

# Copy MCP source code
COPY apps/mcp/src/ apps/mcp/src/

# Build shared packages required at runtime, then MCP itself.
RUN pnpm --filter @closedloop-ai/loops-api build
RUN pnpm --filter mcp build

# ---------------------------------------------------------------------------
# Stage 2: Runtime — minimal image with compiled output
# ---------------------------------------------------------------------------
FROM node:24-slim AS runtime

RUN corepack enable

WORKDIR /app

# Copy workspace root files (corepack reads packageManager from package.json)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
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
COPY packages/database/package.json packages/database/
COPY packages/redis/package.json packages/redis/

# Copy typescript-config (tsconfig bases) — needed by tsx for .ts resolution
COPY --from=builder /app/packages/typescript-config/ packages/typescript-config/

# Install production-only dependencies
RUN pnpm install --frozen-lockfile --filter mcp... --prod --ignore-scripts

# Copy MCP source so runtime tsx can resolve workspace deep imports consistently.
COPY --from=builder /app/apps/mcp/src/ apps/mcp/src/

# Copy shared workspace packages needed at runtime for module resolution
COPY --from=builder /app/packages/api/src/ packages/api/src/
COPY --from=builder /app/packages/loops-api/dist/ packages/loops-api/dist/
COPY --from=builder /app/packages/database/ packages/database/
COPY --from=builder /app/packages/redis/src/ packages/redis/src/

ENV NODE_ENV=production
ENV MCP_PORT=3010

EXPOSE 3010

# pnpm --filter mcp exec sets CWD to /app/apps/mcp/, so paths are relative to that.
# --require needs ./ prefix for CWD-relative resolution (not node_modules lookup).
# preload.cjs (not .ts/.js) because --require only loads CJS modules.
CMD ["pnpm", "--filter", "mcp", "exec", "tsx", "--require", "./src/preload.cjs", "src/index.ts"]
