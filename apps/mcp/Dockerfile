# ---------------------------------------------------------------------------
# MCP Server Dockerfile
#
# Multi-stage build that compiles TypeScript in a builder stage and copies
# only the compiled JS + production dependencies to a slim runtime image.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Stage 1: Builder — install deps & compile TypeScript
# ---------------------------------------------------------------------------
FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

WORKDIR /app

# Copy workspace root files needed for pnpm install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.json ./

# Copy only the packages the MCP server depends on
COPY apps/mcp/package.json apps/mcp/tsconfig.json apps/mcp/
COPY packages/api/ packages/api/
COPY packages/database/ packages/database/
COPY packages/typescript-config/ packages/typescript-config/

# Install dependencies (workspace mode, only for the MCP app and its deps)
RUN pnpm install --frozen-lockfile --filter mcp... --ignore-scripts
# Generate Prisma client in clean CI checkouts where generated/ is absent.
RUN pnpm --filter @repo/database exec prisma generate --no-hints --schema=./prisma/schema.prisma

# Copy MCP source code
COPY apps/mcp/src/ apps/mcp/src/

# Build TypeScript → JavaScript
RUN pnpm --filter mcp build

# ---------------------------------------------------------------------------
# Stage 2: Runtime — minimal image with compiled output
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

WORKDIR /app

# Copy workspace root files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.json ./

# Copy package manifests for production install
COPY apps/mcp/package.json apps/mcp/
COPY --from=builder /app/apps/mcp/tsconfig.json apps/mcp/
COPY packages/api/package.json packages/api/
COPY packages/database/package.json packages/database/

# Copy typescript-config (tsconfig bases) — needed by tsx for .ts resolution
COPY --from=builder /app/packages/typescript-config/ packages/typescript-config/

# Install production-only dependencies
RUN pnpm install --frozen-lockfile --filter mcp... --prod --ignore-scripts

# Copy compiled JavaScript from builder
COPY --from=builder /app/apps/mcp/dist/ apps/mcp/dist/

# Copy CJS preload scripts (not compiled by tsc, used via --require)
COPY --from=builder /app/apps/mcp/src/preload.cjs apps/mcp/src/preload.cjs
COPY --from=builder /app/apps/mcp/src/server-only-noop.cjs apps/mcp/src/server-only-noop.cjs

# Copy shared workspace packages needed at runtime for module resolution
COPY --from=builder /app/packages/api/src/ packages/api/src/
COPY --from=builder /app/packages/database/ packages/database/

ENV NODE_ENV=production
ENV MCP_PORT=3010

EXPOSE 3010

# pnpm --filter mcp exec sets CWD to /app/apps/mcp/, so paths are relative to that.
# --require needs ./ prefix for CWD-relative resolution (not node_modules lookup).
# preload.cjs (not .ts/.js) because --require only loads CJS modules.
CMD ["pnpm", "--filter", "mcp", "exec", "tsx", "--require", "./src/preload.cjs", "dist/apps/mcp/src/index.js"]
