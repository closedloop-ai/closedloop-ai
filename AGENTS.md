# Repository Guidelines

## Project Structure & Module Organization
`apps/` contains deployable surfaces: `app` (product UI, port 3000), `api` (BFF/server, 3002), `web` (marketing, 3001), plus `docs`, `email`, `storybook`, `mcp`, `relay`, and `studio`. Shared code lives in `packages/*` and is imported as `@repo/<name>`; database schema and migrations live in `packages/database`. Repo documentation is in `docs/`, and CI/workflow automation is in `.github/`. `apps/api` is deployed on Vercel serverless functions, so route code must not rely on process-local memory, singleton state, or long-lived in-process caches for correctness. Keep data flow layered: `apps/app` should call `apps/api`, and only the API should touch `@repo/database`.

## Cross-Repo Compatibility Requirements
Changes in this repo must not assume another repo (for example `closedloop-electron`) is upgraded at the same time.

- Treat all cross-repo contracts (desktop gateway payloads, relay events, error reasons, callback semantics) as version-skewed.
- New fields must be additive and optional; missing/unknown values must degrade gracefully to safe defaults.
- When external payload fields are renamed, keep the previous field accepted as a compatibility alias until a human explicitly approves removing the shim, as long as the server can map it to the new behavior safely.
- Never crash, throw unhandled errors, or block core flows solely because a peer repo is on an older/newer version.
- For behavior/classification changes, include a backward-compatible fallback path (for example, map unknown reasons to generic `launch_failed`).
- Update tests to cover both:
  - new/expected contract shape
  - old or unknown contract shape (graceful fallback)

## Build, Test, and Development Commands
Use Node 20+ with `pnpm`.

- `pnpm install` installs workspace dependencies and generates the Prisma client.
- `docker compose up -d` starts local PostgreSQL; `just db-start` is the lightweight alternative.
- `pnpm dev` runs the Turborepo dev graph; `just dev` starts the main local stack (`app`, `api`, `mcp`).
- `pnpm turbo dev --filter=app --filter=api` focuses on the primary product surfaces.
- `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` run workspace-wide checks.
- `pnpm migrate` or `just db-migrate name=my_change` creates/applies Prisma migrations.
- For Prisma schema changes, generate migrations with `prisma migrate dev` or `prisma migrate dev --create-only`; only hand-edit the generated SQL for constructs Prisma cannot express, such as partial unique indexes.

## Dockerized Workspace Apps
Some apps, including `apps/mcp` and `apps/relay`, build from narrow Docker contexts instead of the full monorepo. When adding or changing any `@repo/*` import or `workspace:*` dependency in a Dockerized app, update that app's Dockerfile in the same change.

- Copy every required workspace package into the builder stage before `pnpm install`, including transitive workspace dependencies needed by that package.
- Copy package manifests for those workspace packages into the runtime stage before `pnpm install --prod`.
- If runtime executes TypeScript with `tsx` or uses deep imports such as `@repo/api/src/...`, copy the needed `src/` or built `dist/` output into the runtime image so module resolution works after deploy.
- Validate both the builder target and full image for the changed app, for example `docker buildx build --file apps/relay/Dockerfile --target builder .` and `docker buildx build --file apps/relay/Dockerfile .`. A local `pnpm build` or `pnpm typecheck` is not enough for these Dockerized apps because it does not prove the container has the same workspace package files.

## Coding Style & Naming Conventions
TypeScript and ESM are standard across the repo. Formatting and linting are enforced by Biome with Ultracite presets; run `pnpm lint:fix` before opening a PR. Follow the existing 2-space indentation, prefer `type` aliases when practical, and keep `@repo/*` imports ahead of local alias imports. File names are typically kebab-case (`pull-request-status-badge.tsx`), while exported React components and types use PascalCase. In `apps/api`, keep route handlers thin and move business logic into nearby `service.ts` modules.

For API routes with fixed request/response/error contracts, wrap auth/session and other precondition helpers that can throw so the route still returns the declared contract shape instead of leaking a generic 500.
- Prefer generated Prisma enums from `@repo/database` over duplicated string literals when a model field already has an enum type.
- When multiple desktop route files share the same wire-contract types, define those types in `apps/api/app/desktop/contract.ts` instead of duplicating route-local copies.
- Keep backend-only API metadata types in `apps/api`; `packages/api` should expose transport contracts and cross-process constants, not database provenance or auth-policy internals.
- For wire contracts crossing apps, packages, repos, or processes, define header names, reason strings, modes, and response-shape constants in one shared module and import them instead of duplicating literals.
- When route handlers, middleware, or internal routes enforce the same policy, extract a shared helper or add focused parity tests so their behavior cannot drift silently.
- In `apps/api` serverless routes, do not fire-and-forget promises for response-path side effects. Await the work, pass the promise to `waitUntil`, or persist it for later processing.
- Define regex literals as module-level constants instead of inline inside functions or tests so Ultracite's `useTopLevelRegex` rule stays satisfied.

## Compatibility Guardrail
Compatibility shims and backward-compatibility code paths (for example legacy namespace adapters, re-export shims, or migration fallbacks) must not be removed without explicit human approval in the current task. If there is no explicit approval, preserve the compatibility layer and raise the cleanup as a separate follow-up.

## Testing Guidelines
Vitest is the default test runner across `apps/api`, `apps/app`, `apps/mcp`, `apps/relay`, and several packages. Name tests `*.test.ts` or `*.test.tsx`; place them beside the source or under `__tests__/`. No global coverage percentage is enforced, but new services, parsers, and utilities are expected to ship with focused tests. Use `pnpm test` before pushing, or a package-local command such as `pnpm -C apps/api test` while iterating.

## Commit & Pull Request Guidelines
Recent commits use ticket-prefixed, imperative subjects such as `FEAT-55: Add client-side auth bridge`. The repository’s `.gitmessage` template expects a short subject, bullet summary, and explicit `Testing:` and `Risks:` sections. Prefer branch names like `feat/*`, `fix/*`, `docs/*`, and `refactor/*`. PRs should follow `.github/pull_request_template.md`: summarize the change, link the related issue, confirm self-review and local test coverage, and attach screenshots for UI changes. Avoid force-pushing after review starts.
