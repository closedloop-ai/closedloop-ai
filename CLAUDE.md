# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Next.js monorepo built with next-forge (Turborepo template). It's a SaaS application with multiple deployable apps and shared packages.

## Common Commands

```bash
# Development
pnpm dev                                    # Start all apps (uses turbo)
pnpm turbo dev --filter=app --filter=web    # Start specific apps only

# Building
pnpm build                                  # Build all packages/apps
pnpm turbo build --filter=@repo/database    # Build specific package

# Type checking
pnpm typecheck                              # TypeScript type check

# Linting & Formatting (uses Biome via ultracite)
pnpm lint                                   # Check linting/formatting
pnpm lint:fix                               # Auto-fix issues

# Testing
pnpm test                                   # Run all tests
pnpm turbo test --filter=app                # Test specific app
```

For database commands and migration workflow, see `packages/database/CLAUDE.md`.

## Architecture

### Apps (in `/apps`)
- **app** (port 3000) - Main authenticated application
- **web** (port 3001) - Marketing/public website
- **api** (port 3002) - API server with Stripe webhook handling
- **docs** (port 3004) - Documentation (Mintlify)
- **email** (port 3003) - Email template preview (React Email)
- **storybook** (port 6006) - Component library
- **studio** (port 3005) - Prisma Studio

### Packages (in `/packages`)
Shared packages are imported as `@repo/<package-name>`:
- **api** - Shared API types between frontend and backend
- **database** - Prisma client with Neon (production) / pg (local) adapters
- **auth** - Clerk authentication
- **design-system** - Shadcn/ui components with Tailwind
- **analytics** - PostHog + Google Analytics
- **payments** - Stripe integration
- **email** - Resend email templates
- **observability** - Error tracking, logging
- **security** - Arcjet rate limiting

### Environment Variables
Each app has its own `.env.local`. Key patterns:
- Empty string `""` fails validation even for optional fields - comment out unused vars
- Keys are validated with prefixes (e.g., `sk_` for Clerk, `phc_` for PostHog)
- Validation schemas are in each package's `keys.ts`

### Database
- Schema: `packages/database/prisma/schema.prisma`
- Client generated to: `packages/database/generated/`
- See `packages/database/CLAUDE.md` for migration workflow and conventions.

### Data Access Pattern (IMPORTANT)

**Do NOT import `@repo/database` in `apps/app` (frontend).** All database access goes through the BFF API (`apps/api`): frontend hooks → API routes → services → database. See `apps/api/CLAUDE.md` for route/service conventions and `apps/app/CLAUDE.md` for TanStack Query hook patterns.

### Background Work in API Routes (CRITICAL)

**Never fire-and-forget a promise in a Vercel serverless function.** Vercel can kill the function the instant the HTTP response is sent — or mid-execution during a deployment. Any un-awaited async work (launching ECS tasks, uploading to S3, sending webhooks) will be silently terminated with zero error logs.

**Always use `waitUntil()` from `@vercel/functions`:**

```typescript
import { waitUntil } from "@vercel/functions";

// ❌ BAD - Vercel can kill this at any time after the response is sent
launchLoop(loopId, orgId).catch((err) => log.error(err));
return NextResponse.json(success(result));

// ✅ GOOD - waitUntil() keeps the function alive until the promise settles
const launchPromise = launchLoop(loopId, orgId).catch((err) => log.error(err));
waitUntil(launchPromise);
return NextResponse.json(success(result));
```

If you see a fire-and-forget `.catch()` pattern without `waitUntil()`, it's a bug.

### Type Definitions (IMPORTANT)

**Never duplicate type definitions.** If a type is used in more than one file, it must live in one canonical location and be imported everywhere else.

| Type category | Location | Example |
|---|---|---|
| **Shared API types** (used by both frontend and backend) | `packages/api/src/types/` | Entity types, request/response types, enums shared across layers |
| **Database types** | Generated from Prisma schema in `packages/database/generated/` | Prisma model types, enums |
| **Backend-only types** | Co-located in `apps/api/` (e.g., `lib/`, route `validators.ts`) | Route params, Zod schemas, service internals |
| **Frontend-only types** | Co-located in `apps/app/` (e.g., `types/`, component files) | Component props, UI state, display-only models |

**Rules:**
1. `packages/api/src/types/` is **only** for types consumed by both `apps/api` and `apps/app`. Don't put backend-only or frontend-only types here.
2. Backend-only types stay in `apps/api/`. Frontend-only types stay in `apps/app/`.
3. If a type is used in multiple files within the same app, extract it to a shared location within that app.
4. Never define the same type in multiple files.

### Engineer Feature — Architectural Exception (SECURITY CRITICAL)

The Engineer feature intentionally deviates from the standard data access pattern described above.

**Location:** `apps/app/app/api/engineer/` (frontend app, NOT `apps/api`)

**Why it's different:** These routes spawn local CLI processes (Claude CLI, git, codex), access the
local filesystem, and execute shell commands. This requires the server process to be running on the
same machine as the developer's tools — impossible in a deployed environment.

**Security boundary:** The feature is **localhost-only**. Two independent guards enforce this:

1. **`EngineerGuard` component** (`apps/app/app/(authenticated)/engineer/engineer-guard.tsx`) — blocks the UI when `appEnvironment !== "local"`. This is a UX guard, NOT a security boundary.
2. **Next.js middleware** (`apps/app/middleware.ts`) — rejects all `/api/engineer/*` requests with HTTP 403 when the `Host` header is not `localhost` or `127.0.0.1`. This is the actual security enforcement.

**CRITICAL:** Do NOT remove or weaken the middleware guard. Exposing these routes in a deployed
environment would allow arbitrary command execution on the server.

**Do NOT "fix" this to conform to the standard `apps/api` pattern.** The filesystem and process
spawning requirements make that impossible — the `apps/api` server runs separately and has no
access to the developer's local CLI tools.

### Sub-directory CLAUDE.md Files

Domain-specific patterns and conventions are documented closest to the code they describe:
- `packages/database/CLAUDE.md` — Migration workflow, Prisma patterns, schema conventions
- `apps/api/CLAUDE.md` — Route/service architecture, auth wrappers, response helpers
- `apps/app/CLAUDE.md` — Server/client components, TanStack Query, React patterns, engineer feature

## Self-Improving CLAUDE.md

When working on a PR and you discover a pattern, convention, or gotcha that isn't documented here, **add it to the relevant CLAUDE.md as part of the same PR.** Place domain-specific patterns in the appropriate sub-directory CLAUDE.md rather than the root file.

## PR Response Tone

When responding to PR review comments, never use phrases like "you're right", "good catch", or other sycophantic language. Keep responses brief and factual — state what was changed, not how insightful the reviewer was.

## Key Files
- `turbo.json` - Turborepo task configuration
- `biome.jsonc` - Linting/formatting config (extends ultracite)
- `packages/*/keys.ts` - Environment variable validation schemas (t3-env)

## Code Style

- Use `RegExp.exec(str)` instead of `str.match(regex)` (SonarQube S6594)
- Use `String#replaceAll()` instead of `String#replace()` with global regex (SonarQube S7781)
- Use `globalThis` instead of `window` (SonarQube S7764). For SSR guards (`typeof window === "undefined"`), replace with `globalThis.window === undefined` — but first verify the function is only called from `"use client"` components. If it could run in a server context (API routes, RSC, middleware), keep the `typeof` check since `globalThis.window` may not exist.
- Prefer `Image` from `next/image` over `<img>` elements
- Never place JSX comments (`{/* */}`) between `(` and the root JSX element — use regular JS comments above the assignment instead
- Use a single `Array#push()` call with multiple arguments instead of consecutive calls — `parts.push(a, b, c)` not `parts.push(a); parts.push(b); parts.push(c)` (SonarQube S7778)
- Use `String.raw` for literal backslash sequences — `` String.raw`\n` `` not `"\\n"` (Sonar80)
- Keep function Cognitive Complexity under 15 (SonarQube S3776). Extract helper functions to flatten deeply nested if/else or loop branches rather than inlining everything.
- Do not use nested ternary operators (SonarQube S3358). Use `if/else if/else` or extract a helper function instead.
- In if/else blocks, put the positive condition first — `if (x === null)` not `if (x !== null)` (SonarQube S7735)
- Double quotes, semicolons, trailing commas (ES5), 100 char print width (see `.prettierrc.json`)
- Add new functions, types, constants, and helpers at the bottom of the file, not the top

### Linting & Formatting (Biome)
- After modifying React components in `apps/app`, run `pnpm lint:fix` to auto-fix Biome ordering rules (imports, CSS classes, JSX attributes).
- Biome's import order rules require `@repo/*` package imports before `@/*` path alias imports. Run `pnpm lint:fix` to auto-fix.
- To lint a single file, use `npx biome check <file>` directly. The monorepo's `pnpm lint -- --filter=<file>` does not support single-file targeting.
- Do not mark service methods as `async` if they only `return withDb(...)` without any `await` in the body. Biome's `useAwait` rule flags this.
- When importing multiple named exports, Biome requires alphabetical order: constants/types first (UPPERCASE), then functions (camelCase).
- Biome's `useBlockStatements` rule requires braces on ALL `if` bodies, including single-line early-returns. Use `npx biome check --write --unsafe <file>` for auto-fix (flagged as unsafe).

## Git Commits

When creating a git commit, read `.gitmessage` first and follow its format for the commit message.

## Background

Symphony is a human-governed, AI-centric software delivery platform. AI agents produce all delivery artifacts (PRDs, designs, plans, code, tests, release evidence) while humans review and approve at structured milestones. Unlike developer-only AI tools, it serves product managers, designers, and engineers through role-appropriate experiences. The architecture is hybrid: source code stays on customer infrastructure while a cloud control plane orchestrates workflows and integrates with GitHub, Linear, and Slack. The 'Workflow' artifact category represents user-defined step sequences that orchestrate execution (e.g., plan → code → test → review), NOT artifacts generated during execution.

## Learned Patterns

### Planning & Verification
- **[mistake]**: When creating plans for new artifact types, check if support already exists in: (1) useArtifactUIState hook type union, (2) isNavigableArtifact function, (3) getArtifactRoute switch cases, (4) ARTIFACT_SECTIONS dual placement. Mark existing support as verification tasks, not new implementation. (context: artifact-types|plan-writer|verification-vs-implementation)
- **[convention]**: Before implementing new entity types or schema changes, check `plan.json` architectureDecisions array - schema design choices are documented there. (context: plan-adherence|architecture|implementation)
- **[mistake]**: When planning changes to existing files, check investigation-log.md for already-imported components before writing import tasks. Mark as verification when component already exists. (context: plan-writer|investigation-log|import-verification)

### TypeScript & Imports
- **[mistake]**: When using const objects like ArtifactType (ArtifactType.Issue, ArtifactType.Prd), use `import { ArtifactType }` not `import type { ArtifactType }` - const objects are runtime values that cannot be accessed through type-only imports. (context: typescript|import-type|runtime-value)
- **[mistake]**: Adding `export { ... } from './module'` re-exports to an existing index.ts triggers Biome's `noBarrelFile` lint rule. Use direct subpath imports (e.g., `@repo/github/execution-log-parser`) instead of adding re-exports to barrels. (context: biome|noBarrelFile|subpath-imports)
- **[insight]**: In this monorepo, subpath imports like `@repo/github/execution-log-parser` resolve correctly without an explicit `exports` field in package.json. pnpm workspace resolution + TypeScript handles this directly. (context: monorepo|pnpm|subpath-imports)
- **[convention]**: Never use inline `import()` types (e.g., `import("vitest").Mock`). Always use top-level import statements instead. Inline imports hurt readability and bypass Biome's import ordering. (context: typescript|imports|inline-imports|code-style)

### Code Organization
- **[pattern]**: Check `@repo/github` (`packages/github/index.ts`) for existing GitHub API functions before implementing new ones. (context: packages/github|reuse)
- **[convention]**: Domain-specific parsers (e.g., GitHub Actions artifacts) belong in the corresponding domain package (`packages/github/`), not `apps/api/lib/`. Import via subpath. (context: code-organization|domain-packages)
- **[convention]**: New parser/utility modules in domain packages must include unit tests. PR reviewers will reject parsers without test coverage. (context: testing|code-review)
- **[convention]**: Do not assert on logging statements (`expect(log.info)`, `expect(log.warn)`, etc.) in unit tests. Tests should assert on observable behavior, not logged strings. (context: testing|unit-tests|logging|anti-pattern)
- **[insight]**: Monorepo packages using @repo/* imports are internal dependencies, not cross-repo needs. Only external peer repos count as cross-repo dependencies. (context: monorepo|cross-repo|internal-packages)
- **[insight]**: `@repo/observability/log` exports `console` directly and does not import `server-only`, so it is safe to use in client components. (context: observability|client-components|server-only)
- **[pattern]**: When shared mappings are needed by both server packages and frontend code, place them in `packages/api/src/types/` since server packages cannot import from `apps/app/lib/`. (context: monorepo|code-organization|shared-types|cross-package-dependencies)
- **[mistake]**: After rebasing or updating dependencies, the hardcoded Stripe apiVersion in `packages/payments/index.ts` may need to be updated to match the installed stripe package's expected version. (context: stripe|api-version|rebase|dependency-updates)

### Symphony CI/CD
- **[pattern]**: run-loop.sh stores state in `.symphony-loop.local.md` with YAML frontmatter (active, iteration, max_iterations, completion_promise, workdir, prd_file, run_id, start_sha, started_at) - not in state.json. Resume behavior reads this file at line 564. (context: run-loop|state-management|symphony|CI-workflow)
- **[insight]**: run-loop.sh deletes `.claude/symphony-loop.local.md` on successful completion (lines 663, 726). State file existence cannot be used as success indicator - verify success by checking for output artifacts (plan.json, plan.md, implementation-plan.md) instead. (context: run-loop|state-management|symphony|verification)
- **[convention]**: run-loop.sh creates state file at `.claude/symphony-loop.local.md` (repo root), NOT inside the run directory (`.claude/runs/YYYYMMDD-HHMMSS/`). Artifact uploads only include `.claude/runs/`, so state file is not part of the artifact bundle. (context: run-loop|state-management|symphony|artifacts)
- **[convention]**: The closedloop-ai plugins (symphony-core, experimental) are installed from `https://github.com/closedloop-ai/claude_code.git`. Custom/private Claude Code plugins should use their Git repository URL for installation in CI environments. (context: github-actions|claude-cli|plugins|ci-cd)
