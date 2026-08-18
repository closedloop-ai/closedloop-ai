# MCP App Guidelines

## Dockerized Workspace Context
`apps/mcp` builds from a narrow Docker context, so `apps/mcp/Dockerfile` must `COPY` in the workspace packages it needs. `COPY` coverage is enforced by `scripts/deploy/dockerized-app-copy-parity.test.ts` — its failure message carries the contract and the exact lines to add.

- Stage image path filters must include `.dockerignore` (these builds use `context: .`); match filters to what the Dockerfile copies — `packages/<name>/**` only when source/dist enters the image, `packages/<name>/package.json` when only the manifest is copied for pnpm workspace resolution.
- The gate checks manifests, not runtime module resolution: if runtime executes TypeScript with `tsx` or uses deep imports such as `@repo/api/src/...`, copying the needed `src/` or built `dist/` into the runtime image is still on you.
- Validate the builder target AND the full image (`docker buildx build --file apps/mcp/Dockerfile --target builder .` and the same without `--target`); `pnpm build`/`pnpm typecheck` does not prove the container has the workspace package files. Equivalent CI image-build evidence for the same head SHA is acceptable. If local Docker or registry/base-image metadata resolution stalls before repository build steps run, record the exact command and failure as an external local-environment blocker — not a source-code validation failure — and stop retrying image pulls.

## Tool Contracts
- Use shared `@repo/api` contract constants for response, request, MCP, artifact, document, link, status, error, and other wire values. Do not alias generated Prisma enums into MCP contracts when a shared contract const exists.
- Newly added or substantially changed tools should type `ApiClient` responses and shaper inputs with shared `@repo/api` contract types or narrow local JSON-wire variants. Avoid adding new `unknown`-typed shapers when a response contract exists; keep compatibility narrowing at the boundary and add focused tests for the shaped output.
- When a tool adds derived enrichment that requires an additional API request, add an explicit `include*`/`expand*` input or document why the enrichment is always required. Tests should cover both the enriched path and the skipped/no-extra-request path when the enrichment is optional.
