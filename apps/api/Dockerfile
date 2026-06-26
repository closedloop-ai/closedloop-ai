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
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

# --- Pruner: produce the api workspace closure (manifests + source) ---
FROM base AS pruner
WORKDIR /repo
COPY . .
RUN corepack prepare --activate
RUN pnpm dlx turbo@2.9.14 prune api --docker

# --- Builder: install + build (next build + server import-smoke) ---
FROM base AS builder
WORKDIR /app
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
RUN corepack prepare --activate
RUN pnpm install --frozen-lockfile --filter api... --ignore-scripts
# Full source closure.
COPY --from=pruner /repo/out/full/ ./
# Prisma client (clean checkout has no generated/).
RUN pnpm --filter @repo/database exec prisma generate --no-hints --schema=./prisma/schema.prisma
# Build the dist-backed workspace packages api resolves via their exports maps
# (tsup → dist): shared-platform, telemetry-contract, loops-api, design-system.
# @repo/api / @repo/observability resolve from src (no build needed), and
# @repo/database's client is generated above — its `build` is NOT run here
# because its `prebuild` runs migrate, which needs a live DB.
RUN pnpm --filter @closedloop-ai/shared-platform \
         --filter @closedloop-ai/telemetry-contract \
         --filter @closedloop-ai/loops-api \
         --filter @closedloop-ai/design-system build
# api build = `next build` + `server:import-smoke` (apps/api/package.json).
RUN pnpm --filter api build

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
