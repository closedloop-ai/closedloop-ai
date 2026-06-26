# Relay App Guidelines

## Dockerized Workspace Context
`apps/relay` builds from a narrow Docker context instead of the full monorepo. When adding or changing any `@repo/*` import or `workspace:*` dependency in this app, update `apps/relay/Dockerfile` in the same change.

- Copy every required workspace package into the builder stage before `pnpm install`, including transitive workspace dependencies needed by that package.
- Copy package manifests for those workspace packages into the runtime stage before `pnpm install --prod`.
- If runtime executes TypeScript with `tsx` or uses deep imports such as `@repo/api/src/...`, copy the needed `src/` or built `dist/` output into the runtime image so module resolution works after deploy.
- Validate both the builder target and full image, for example `docker buildx build --file apps/relay/Dockerfile --target builder .` and `docker buildx build --file apps/relay/Dockerfile .`. A local `pnpm build` or `pnpm typecheck` is not enough because it does not prove the container has the same workspace package files. Equivalent CI image-build evidence for the same head SHA is acceptable when local Docker image builds are unavailable. If local Docker or registry/base-image metadata resolution stalls or fails before repository build steps run, record the exact command and failure as an external local-environment blocker; do not treat that alone as a source-code validation failure or keep retrying image pulls indefinitely.

## Delivery Semantics
- When a shared dispatch or delivery helper normalizes results from multiple transports, preserve explicit not-delivered/no-subscriber outcomes in every transport branch. Do not report success just because the local publish call completed; add focused coverage for the fallback transport branch as well as the configured remote transport branch.

## Testing
- Relay tests that register mock sockets or workers must clean them up through the production disconnect/reset path in `afterEach` so worker maps and heartbeat/degraded timers do not leak between tests.
