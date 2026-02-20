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

# Install dependencies (workspace mode, only for the MCP app and its deps)
RUN pnpm install --frozen-lockfile --filter @repo/mcp... --ignore-scripts
# Generate Prisma client in clean CI checkouts where generated/ is absent.
RUN pnpm --filter @repo/database exec prisma generate --no-hints --schema=./prisma/schema.prisma

# Copy MCP source code
COPY apps/mcp/src/ apps/mcp/src/

# Build TypeScript → JavaScript
RUN pnpm --filter @repo/mcp build

# ---------------------------------------------------------------------------
# Stage 2: Runtime — minimal image with compiled output
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

WORKDIR /app

# Copy workspace root files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy package manifests for production install
COPY apps/mcp/package.json apps/mcp/
COPY packages/api/package.json packages/api/
COPY packages/database/package.json packages/database/

# Install production-only dependencies
RUN pnpm install --frozen-lockfile --filter @repo/mcp... --prod --ignore-scripts

# Copy compiled JavaScript from builder
COPY --from=builder /app/apps/mcp/dist/ apps/mcp/dist/

# Copy shared workspace packages needed at runtime for module resolution
COPY --from=builder /app/packages/api/src/ packages/api/src/
COPY --from=builder /app/packages/database/ packages/database/

ENV NODE_ENV=production
ENV MCP_PORT=3010

EXPOSE 3010

CMD ["pnpm", "--filter", "@repo/mcp", "exec", "tsx", "apps/mcp/dist/apps/mcp/src/index.js"]
