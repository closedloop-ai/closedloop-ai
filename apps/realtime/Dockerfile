# socket.io over WebSocket for web and desktop clients (PLN-2104). Narrow Docker
# context, modelled on apps/relay/Dockerfile: manifests first, a filtered
# install, then sources, so a source edit reuses the cached install layer.

FROM node:24-slim AS builder

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm resolves workspace patchedDependencies at install time even when the
# patched package is outside this filter's closure.
COPY patches/ patches/
RUN corepack prepare --activate
COPY tsconfig.json ./

# Manifests only. pnpm needs every closure member's package.json on disk to
# resolve the workspace symlinks.
COPY apps/realtime/package.json apps/realtime/tsconfig.json apps/realtime/
COPY packages/realtime-contract/package.json packages/realtime-contract/
COPY packages/http-service/package.json packages/http-service/
COPY packages/observability/package.json packages/observability/
COPY packages/redis/package.json packages/redis/
COPY packages/api/package.json packages/api/
COPY packages/loops-api/package.json packages/loops-api/
# Reached only transitively (via @repo/api and @repo/observability); nothing in
# the service's import graph resolves them, so only the manifest is copied.
COPY packages/shared-platform/package.json packages/shared-platform/
COPY packages/telemetry-contract/package.json packages/telemetry-contract/
# Test-only and tsconfig-base devDependencies of the closure.
COPY packages/realtime-client/package.json packages/realtime-client/
COPY packages/vitest-config/package.json packages/vitest-config/
COPY packages/typescript-config/package.json packages/typescript-config/

RUN pnpm install --frozen-lockfile --filter realtime... --ignore-scripts
# The COPYs below change the tree after the install; without this, pnpm's
# pre-run deps check would launch an unfiltered network install (FEA-2653).
ENV PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false

COPY packages/typescript-config/ packages/typescript-config/
COPY packages/realtime-contract/ packages/realtime-contract/
COPY packages/http-service/ packages/http-service/
COPY packages/observability/ packages/observability/
COPY packages/redis/ packages/redis/
COPY packages/api/ packages/api/
COPY packages/loops-api/ packages/loops-api/

# The LISTEN connection verifies RDS against the repo's checked-in RDS CA
# bundle, the one packages/database's pools trust. It is written out as PEM for
# NODE_EXTRA_CA_CERTS, which adds to Node's default store; the build fails if
# the PEM does not hold every certificate the bundle declares.
COPY packages/database/scripts/rds-ca-bundle.ts /tmp/rds-ca-bundle.mts
RUN node --input-type=module -e " \
  import { writeFileSync } from 'node:fs'; \
  import { X509Certificate } from 'node:crypto'; \
  const bundle = await import('/tmp/rds-ca-bundle.mts'); \
  const pems = bundle.AWS_RDS_CA_BUNDLE.match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g) ?? []; \
  for (const pem of pems) new X509Certificate(pem); \
  if (pems.length !== bundle.AWS_RDS_CA_BUNDLE_CERT_COUNT) throw new Error('RDS CA bundle: ' + pems.length + ' of ' + bundle.AWS_RDS_CA_BUNDLE_CERT_COUNT + ' certificates'); \
  writeFileSync('/app/rds-ca-bundle.pem', pems.join('\n') + '\n'); \
  " && rm /tmp/rds-ca-bundle.mts

COPY apps/realtime/src/ apps/realtime/src/

# Type-checks the service and its workspace sources as they were copied.
RUN pnpm --filter realtime build

FROM node:24-slim AS runtime

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
RUN corepack prepare --activate
COPY tsconfig.json ./

COPY apps/realtime/package.json apps/realtime/
COPY --from=builder /app/apps/realtime/tsconfig.json apps/realtime/
COPY packages/realtime-contract/package.json packages/realtime-contract/
COPY packages/http-service/package.json packages/http-service/
COPY packages/observability/package.json packages/observability/
COPY packages/redis/package.json packages/redis/
COPY packages/api/package.json packages/api/
COPY packages/loops-api/package.json packages/loops-api/
COPY packages/shared-platform/package.json packages/shared-platform/
COPY packages/telemetry-contract/package.json packages/telemetry-contract/
COPY packages/realtime-client/package.json packages/realtime-client/
COPY packages/vitest-config/package.json packages/vitest-config/

# tsconfig bases, read by tsx for .ts resolution.
COPY --from=builder /app/packages/typescript-config/ packages/typescript-config/

RUN pnpm install --frozen-lockfile --filter realtime... --prod --ignore-scripts

# tsx runs the sources: @repo/realtime-contract, @repo/http-service and @repo/loops-api export
# ./src/*.ts, and @repo/observability deep-imports @repo/api/src/types.
COPY --from=builder /app/apps/realtime/src/ apps/realtime/src/
COPY --from=builder /app/packages/realtime-contract/src/ packages/realtime-contract/src/
COPY --from=builder /app/packages/http-service/src/ packages/http-service/src/
COPY --from=builder /app/packages/observability/ packages/observability/
COPY --from=builder /app/packages/redis/src/ packages/redis/src/
COPY --from=builder /app/packages/api/src/ packages/api/src/
COPY --from=builder /app/packages/loops-api/src/ packages/loops-api/src/

COPY --from=builder /app/rds-ca-bundle.pem /app/rds-ca-bundle.pem

ENV NODE_ENV=production
ENV REALTIME_PORT=3040
ENV NODE_EXTRA_CA_CERTS=/app/rds-ca-bundle.pem

EXPOSE 3040

# Node itself is the container's main process, so SIGTERM reaches the drain
# (PLN-2104 step 9). `pnpm exec` exits on SIGTERM at once, and the tsx CLI
# SIGKILLs a child that does not acknowledge the relayed signal within 30 ms,
# which a busy event loop misses; either cuts the drain off.
WORKDIR /app/apps/realtime
CMD ["node", "--import", "tsx", "src/index.ts"]
