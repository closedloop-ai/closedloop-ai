# CLAUDE.md

## Project Overview

Next.js monorepo (next-forge/Turborepo). SaaS with multiple apps and shared packages.

## Common Commands

```bash
pnpm dev                                    # Start all apps
pnpm turbo dev --filter=app --filter=web    # Start specific apps
pnpm build                                  # Build all
pnpm typecheck                              # TypeScript check
pnpm lint                                   # Biome lint/format check
pnpm lint:fix                               # Auto-fix
pnpm test                                   # Run all tests
pnpm turbo test --filter=app                # Test specific app
```

For database commands, see `packages/database/CLAUDE.md`.

## Architecture

### Apps (`/apps`)
- **app** (:3000) — Main authenticated app
- **web** (:3001) — Marketing site
- **api** (:3002) — API server + Stripe webhooks
- **docs** (:3004) — Mintlify docs
- **email** (:3003) — Email preview (React Email)
- **storybook** (:6006) — Component library
- **studio** (:3005) — Prisma Studio

### Packages (`/packages`, imported as `@repo/<name>`)
api (shared types) · database (Prisma, Neon/pg) · auth (Clerk) · design-system (Shadcn/Tailwind) · analytics (PostHog/GA) · payments (Stripe) · email (Resend) · observability (logging) · security (Arcjet)

### Environment Variables
Each app has `.env.local`. Empty `""` fails validation for optional fields — comment out unused. Keys validated with prefixes (`sk_`, `phc_`). Schemas in `packages/*/keys.ts`.

### Database
Schema: `packages/database/prisma/schema.prisma`. Client: `packages/database/generated/`. See `packages/database/CLAUDE.md`.

### Data Access Pattern (IMPORTANT)
**Do NOT import `@repo/database` in `apps/app`.** All DB access: frontend hooks → `apps/api` routes → services → database.

### Background Work in API Routes (CRITICAL)
**Never fire-and-forget promises in Vercel serverless.** Always wrap background work with `waitUntil()` from `@vercel/functions`. A `.catch()` without `waitUntil()` is a bug.

### Type Definitions (IMPORTANT)
**Never duplicate types.** One canonical location, imported everywhere:
- **Shared API types** (both frontend+backend) → `packages/api/src/types/`
- **Database types** → `packages/database/generated/` (Prisma)
- **Backend-only** → co-located in `apps/api/`
- **Frontend-only** → co-located in `apps/app/`

`packages/api/src/types/` only for types used by BOTH apps. Never define same type in multiple files.

### Engineer Feature (SECURITY CRITICAL)
Located in `apps/app/app/api/engineer/` — spawns local CLI processes (Claude, git, codex). **Localhost-only**: proxy guard (`apps/app/proxy.ts`) rejects non-localhost with 403. `EngineerGuard` is UX-only. **Do NOT remove the proxy guard** (arbitrary command execution). **Do NOT move to `apps/api`** — requires local filesystem access.

## Self-Improving CLAUDE.md
Discover undocumented patterns during PRs → add to relevant CLAUDE.md in same PR.

## PR Response Tone
No sycophantic language. Brief, factual — state what changed.

## Key Files
`turbo.json` (tasks) · `biome.jsonc` (lint config) · `packages/*/keys.ts` (env validation)

## Code Style
- Use enum/const references, not hardcoded strings — `ArtifactType.IMPLEMENTATION_PLAN` not `"IMPLEMENTATION_PLAN"`. Import from `packages/api/src/types/` or `@repo/database` for Prisma enums.
- `RegExp.exec(str)` not `str.match(regex)` (S6594)
- `String#replaceAll()` not `.replace()` with global regex (S7781)
- `globalThis` not `window` (S7764); SSR guards: `globalThis.window === undefined` in client-only, keep `typeof` if server-possible
- `next/image` over `<img>`
- No JSX comments between `(` and root element — JS comments above assignment
- Single `Array#push(a, b, c)` not consecutive calls (S7778)
- `String.raw` for literal backslash sequences (Sonar80)
- Cognitive Complexity < 15 — extract helpers (S3776)
- No nested ternaries — if/else or helper (S3358)
- Positive condition first in if/else (S7735)
- Double quotes, semicolons, trailing commas (ES5), 100 char width
- New functions/types/constants at bottom of file

### Biome
- Run `pnpm lint:fix` after modifying React components (auto-fixes import/CSS/JSX ordering)
- `@repo/*` imports before `@/*` path alias imports
- Single file: `npx biome check <file>` (monorepo `pnpm lint --filter` doesn't support single-file)
- Don't mark methods `async` if only `return withDb(...)` without `await` (useAwait)
- Multiple named imports: alphabetical (UPPERCASE then camelCase)
- `useBlockStatements`: braces on ALL `if` bodies; auto-fix: `npx biome check --write --unsafe <file>`

## Git Commits
Read `.gitmessage` first and follow its format.

## Background
Symphony: human-governed, AI-centric software delivery platform. AI produces artifacts; humans review at milestones. Hybrid: source on customer infra, cloud control plane orchestrates. 'Workflow' = user-defined step sequences, NOT generated artifacts.

## Learned Patterns

### Planning & Verification
- **[mistake]**: New artifact types — check existing support in: useArtifactUIState type union, isNavigableArtifact, getArtifactRoute switch, ARTIFACT_SECTIONS. Mark existing as verification, not implementation.
- **[convention]**: Check `plan.json` architectureDecisions before implementing entity types or schema changes.
- **[mistake]**: Check investigation-log.md for already-imported components before writing import tasks. Mark as verification when already present.

### TypeScript & Imports
- **[mistake]**: Const objects like ArtifactType need `import { ArtifactType }` not `import type` — runtime values can't use type-only imports.
- **[mistake]**: Adding re-exports to index.ts triggers Biome's `noBarrelFile`. Use direct subpath imports (`@repo/github/execution-log-parser`).
- **[insight]**: Subpath imports (`@repo/github/execution-log-parser`) resolve without explicit `exports` in package.json — pnpm workspace + TS handles it.
- **[convention]**: Never use inline `import()` types. Always top-level imports.

### Code Organization
- **[pattern]**: Check `@repo/github` (`packages/github/index.ts`) before implementing new GitHub API functions.
- **[convention]**: Domain-specific parsers → domain package (`packages/github/`), not `apps/api/lib/`. Import via subpath.
- **[convention]**: New parser/utility modules in domain packages must include unit tests.
- **[convention]**: Don't assert on logging statements in unit tests. Assert on observable behavior.
- **[insight]**: @repo/* imports are internal monorepo dependencies, not cross-repo needs.
- **[insight]**: `@repo/observability/log` exports `console` directly, no `server-only` — safe in client components.
- **[pattern]**: Shared mappings for both server packages and frontend → `packages/api/src/types/` (server packages can't import from `apps/app/lib/`).
- **[mistake]**: After rebase/dep updates, check Stripe apiVersion in `packages/payments/index.ts` matches installed stripe package.

### Symphony CI/CD
- **[pattern]**: run-loop.sh state: `.symphony-loop.local.md` with YAML frontmatter (active, iteration, max_iterations, etc.) — not state.json.
- **[insight]**: run-loop.sh deletes state file on success. Check output artifacts (plan.json, plan.md) for success, not file existence.
- **[convention]**: State file at `.claude/symphony-loop.local.md` (repo root), NOT inside `.claude/runs/`. Not part of artifact bundle.
- **[convention]**: closedloop-ai plugins installed from `https://github.com/closedloop-ai/claude_code.git`.
