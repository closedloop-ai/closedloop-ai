# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# apps/app production image for the containerized, Vercel-independent E2E
# target (FEA-2091).
#
# apps/app builds with Next `output: "standalone"` for this image (gated behind
# E2E_STANDALONE_BUILD in apps/app/next.config.ts, so Vercel deploys are
# unaffected). The runner carries only the traced standalone bundle
# (.next/standalone) + .next/static + public — not the full workspace
# node_modules/source. (FEA-2133)
#
# NEXT_PUBLIC_* are inlined by Next at BUILD time, so the api origin and Clerk
# publishable key must be passed as build args (not runtime env). The browser
# (host Playwright) reaches the api at the published port localhost:3002, which
# `getApiBaseUrl()` (e2e/helpers/api-url.ts) already agrees with.
#
# Workspace closure derived mechanically with `turbo prune app --docker`.
# Validate BOTH `--target builder` and the full image (CLAUDE.md mandate).
# ---------------------------------------------------------------------------

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

# --- Pruner: produce the app workspace closure (manifests + source) ---
FROM base AS pruner
WORKDIR /repo
COPY . .
RUN corepack prepare --activate
RUN pnpm dlx turbo@2.9.14 prune app --docker

# --- Builder: install + build (NEXT_PUBLIC_* baked here) ---
FROM base AS builder
WORKDIR /app
# Bake the api origin + Clerk publishable key into the client bundle at build.
ARG NEXT_PUBLIC_API_URL=http://localhost:3002
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
# next build's TypeScript phase is memory-hungry; lift the heap cap (mirrors the
# repo's loops-setup NODE_OPTIONS).
ENV NODE_OPTIONS=--max-old-space-size=4096
# FEA-2133: emit a standalone server (traced minimal node_modules + server.js).
ENV E2E_STANDALONE_BUILD=1
# Manifests first → cacheable install layer.
COPY --from=pruner /repo/out/json/ ./
# turbo prune emits a pruned lockfile that `pnpm install --frozen-lockfile`
# rejects on complex peer-resolved entries (e.g. vitest's peer hash). Use the
# full repo lockfile + a --filter scope instead — the proven apps/mcp /
# apps/relay pattern — so the frozen install stays deterministic.
COPY --from=pruner /repo/pnpm-lock.yaml ./pnpm-lock.yaml
RUN corepack prepare --activate
RUN pnpm install --frozen-lockfile --filter app... --ignore-scripts
# Full source closure.
COPY --from=pruner /repo/out/full/ ./
# Build the dist-backed workspace packages app resolves via their exports maps
# (tsup → dist): shared-platform, telemetry-contract, loops-api, design-system.
# All other @repo/* deps (rich-text, collaboration, navigation, …) resolve from
# src and are transpiled by Next, so they need no prebuild.
RUN pnpm --filter @closedloop-ai/shared-platform \
         --filter @closedloop-ai/telemetry-contract \
         --filter @closedloop-ai/loops-api \
         --filter @closedloop-ai/design-system build
# app build = `node scripts/build.mjs` → `next build` (apps/app/package.json).
RUN pnpm --filter app build

# --- Runner ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Standalone ships a traced minimal node_modules + server.js. `.next/static`
# and `public/` are NOT part of the trace — copy them alongside the server.
COPY --from=builder /app/apps/app/.next/standalone ./
COPY --from=builder /app/apps/app/.next/static ./apps/app/.next/static
COPY --from=builder /app/apps/app/public ./apps/app/public
EXPOSE 3000
# Standalone server entrypoint (honours PORT/HOSTNAME).
CMD ["node", "apps/app/server.js"]
