# Relay App Guidelines

## Dockerized Workspace Context
`apps/relay` builds from a narrow Docker context, so `apps/relay/Dockerfile` must `COPY` in the workspace packages it needs. `COPY` coverage is enforced by `scripts/deploy/dockerized-app-copy-parity.test.ts` — its failure message carries the contract and the exact lines to add.

- Stage image path filters must include `.dockerignore` (these builds use `context: .`); match filters to what the Dockerfile copies — `packages/<name>/**` only when source/dist enters the image, `packages/<name>/package.json` when only the manifest is copied for pnpm workspace resolution.
- The gate checks manifests, not runtime module resolution: if runtime executes TypeScript with `tsx` or uses deep imports such as `@repo/api/src/...`, copying the needed `src/` or built `dist/` into the runtime image is still on you.
- Validate the builder target AND the full image (`docker buildx build --file apps/relay/Dockerfile --target builder .` and the same without `--target`); `pnpm build`/`pnpm typecheck` does not prove the container has the workspace package files. Equivalent CI image-build evidence for the same head SHA is acceptable. If local Docker or registry/base-image metadata resolution stalls before repository build steps run, record the exact command and failure as an external local-environment blocker — not a source-code validation failure — and stop retrying image pulls.

## Delivery Semantics
- When a shared dispatch or delivery helper normalizes results from multiple transports, preserve explicit not-delivered/no-subscriber outcomes in every transport branch. Do not report success just because the local publish call completed; add focused coverage for the fallback transport branch as well as the configured remote transport branch.

## Testing
- Relay tests that register mock sockets or workers must clean them up through the production disconnect/reset path in `afterEach` so worker maps and heartbeat/degraded timers do not leak between tests.
