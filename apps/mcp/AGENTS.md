# MCP App Guidelines

## Dockerized Workspace Context
`apps/mcp` builds from a narrow Docker context instead of the full monorepo. When adding or changing any `@repo/*` import or `workspace:*` dependency in this app, update `apps/mcp/Dockerfile` in the same change.

- Copy every required workspace package into the builder stage before `pnpm install`, including transitive workspace dependencies needed by that package.
- Copy package manifests for those workspace packages into the runtime stage before `pnpm install --prod`.
- If runtime executes TypeScript with `tsx` or uses deep imports such as `@repo/api/src/...`, copy the needed `src/` or built `dist/` output into the runtime image so module resolution works after deploy.
- Validate both the builder target and full image, for example `docker buildx build --file apps/mcp/Dockerfile --target builder .` and `docker buildx build --file apps/mcp/Dockerfile .`. A local `pnpm build` or `pnpm typecheck` is not enough because it does not prove the container has the same workspace package files. Equivalent CI image-build evidence for the same head SHA is acceptable when local Docker image builds are unavailable. If local Docker or registry/base-image metadata resolution stalls or fails before repository build steps run, record the exact command and failure as an external local-environment blocker; do not treat that alone as a source-code validation failure or keep retrying image pulls indefinitely.

## Tool Contracts
- Use shared `@repo/api` contract constants for response, request, MCP, artifact, document, link, status, error, and other wire values. Do not alias generated Prisma enums into MCP contracts when a shared contract const exists.
- Newly added or substantially changed tools should type `ApiClient` responses and shaper inputs with shared `@repo/api` contract types or narrow local JSON-wire variants. Avoid adding new `unknown`-typed shapers when a response contract exists; keep compatibility narrowing at the boundary and add focused tests for the shaped output.
- When a tool adds derived enrichment that requires an additional API request, add an explicit `include*`/`expand*` input or document why the enrichment is always required. Tests should cover both the enriched path and the skipped/no-extra-request path when the enrichment is optional.
