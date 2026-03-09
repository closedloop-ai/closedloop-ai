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
FROM node:22-slim AS builder

RUN corepack enable

WORKDIR /app

# Copy workspace root files needed for pnpm install (corepack reads packageManager from package.json)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack prepare --activate
COPY tsconfig.json ./

# Copy only the packages the relay server depends on (no database!)
COPY apps/relay/package.json apps/relay/tsconfig.json apps/relay/
COPY packages/typescript-config/ packages/typescript-config/
COPY packages/observability/ packages/observability/

# Install dependencies (workspace mode, only for the relay app and its deps)
RUN pnpm install --frozen-lockfile --filter relay... --ignore-scripts

# Copy relay source code
COPY apps/relay/src/ apps/relay/src/

# Build TypeScript → JavaScript
RUN pnpm --filter relay build

# ---------------------------------------------------------------------------
# Stage 2: Runtime — minimal image with compiled output
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

RUN corepack enable

WORKDIR /app

# Copy workspace root files (corepack reads packageManager from package.json)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack prepare --activate
COPY tsconfig.json ./

# Copy package manifests for production install
COPY apps/relay/package.json apps/relay/
COPY --from=builder /app/apps/relay/tsconfig.json apps/relay/
COPY packages/observability/package.json packages/observability/

# Copy typescript-config (tsconfig bases) — needed by tsx for .ts resolution
COPY --from=builder /app/packages/typescript-config/ packages/typescript-config/

# Install production-only dependencies
RUN pnpm install --frozen-lockfile --filter relay... --prod --ignore-scripts

# Copy relay source so runtime tsx can resolve workspace deep imports consistently.
COPY --from=builder /app/apps/relay/src/ apps/relay/src/

# Copy shared workspace packages needed at runtime for module resolution
COPY --from=builder /app/packages/observability/ packages/observability/

ENV NODE_ENV=production
ENV RELAY_PORT=3020

EXPOSE 3020

CMD ["pnpm", "--filter", "relay", "exec", "tsx", "src/index.ts"]
