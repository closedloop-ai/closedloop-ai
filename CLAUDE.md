# CLAUDE.md

## Project Overview

Next.js monorepo (Turborepo). SaaS with multiple apps and shared packages.

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
- **api** (:3002) — REST API server + various webhooks
- **mcp** (:3010) — MCP server
- **relay** (:3020) — WebSocket relay
- **storybook** (:6006) — Component library
- **studio** (:3005) — Prisma Studio

### Packages (`/packages`, imported as `@repo/<name>`)
api (shared types) · database (Prisma, Neon/pg) · auth (Clerk) · design-system (Shadcn/Tailwind) · analytics (PostHog/GA) · email (Resend) · observability (logging) · security (Nosecone)

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
Spawns local CLI processes (Claude, git, codex) via the `closedloop-electron` gateway binary, NOT in `apps/app` or `apps/api`. The browser fetch interceptor (`apps/app/lib/engineer/engineer-fetch-interceptor.ts`) routes `/api/gateway/*` requests to either localhost (LocalElectron mode) or the `/api/gateway-relay/*` forwarder (CloudRelay mode). **Localhost-only enforcement**: proxy guard (`apps/app/proxy.ts`) rejects non-localhost `/api/gateway/*` requests with 403. The gateway binary enforces its own `isAuthorizedGatewayRequest` auth on top. `EngineerGuard` is UX-only. **Do NOT remove the proxy guard** (arbitrary command execution risk). **Do NOT reimplement gateway operations in `apps/app` or `apps/api`** — they require local filesystem access and live exclusively in the `closedloop-electron` repo under `apps/desktop/src/server/operations/`.

### System Health Check
Runs on app launch via `SystemCheckBootstrap` in the authenticated layout (`apps/app/app/(authenticated)/layout.tsx`), not just on the engineer page. Eligibility gated by `useSystemCheckEligibility` — only fires when a compute target is active (cloud relay online or local Electron detected). In cloud relay mode, the fetch interceptor rewrites `/api/gateway/health-check` to `/api/gateway-relay/health-check` and routes to the remote compute target. The health check route resolves the user's login-shell PATH via `getShellPath()` to find tools like `python3`, `git`, `claude`, `gh`.

## Self-Improving CLAUDE.md
Discover undocumented patterns during PRs → add to relevant CLAUDE.md in same PR.

## PR Response Tone
No sycophantic language. Brief, factual — state what changed.

## Key Files
`turbo.json` (tasks) · `biome.jsonc` (lint config) · `packages/*/keys.ts` (env validation)

## Code Style
- Use enum/const references, not hardcoded strings — `DocumentType.ImplementationPlan` not `"IMPLEMENTATION_PLAN"`, `EntityType.Document` not `"DOCUMENT"`. This applies everywhere: type annotations, runtime comparisons, test fixtures, and object literals. Import from `packages/api/src/types/` or `@repo/database` for Prisma enums. For type annotations use `import type` with the const object's type alias (e.g., `sourceType?: EntityType`).
- Define string enums as const objects, never arrays: `export const Foo = { Bar: "bar" } as const; export type Foo = (typeof Foo)[keyof typeof Foo];` — not `const FOOS = ["bar"] as const`.
- `RegExp.exec(str)` not `str.match(regex)` (S6594)
- `String#replaceAll()` not `.replace()` with global regex (S7781)
- `globalThis` not `window` (S7764); SSR guards: `globalThis.window === undefined` in client-only, keep `typeof` if server-possible
- `next/image` over `<img>`
- `<Link href="...">` (from `next/link`) for all in-app navigation — never `<Button onClick={() => router.push(...)}>`; `<Link>` enables middle-click, Cmd/Ctrl+click, and right-click context menu behaviors that `router.push` silently breaks
- No JSX comments between `(` and root element — JS comments above assignment
- Single `Array#push(a, b, c)` not consecutive calls (S7778)
- `String.raw` for literal backslash sequences (Sonar80)
- Cognitive Complexity < 15 — extract helpers (S3776)
- No nested ternaries — if/else or helper (S3358)
- Positive condition first in if/else (S7735)
- Double quotes, semicolons, trailing commas (ES5), 100 char width
- New functions/types/constants at bottom of file
- Never use inline imports. Imports belong first in the file.

### Biome
- Run `pnpm lint:fix` after modifying React components (auto-fixes import/CSS/JSX ordering)
- `@repo/*` imports before `@/*` path alias imports
- Single file: `npx biome check <file>` (monorepo `pnpm lint --filter` doesn't support single-file)
- Don't mark methods `async` if only `return withDb(...)` without `await` (useAwait)
- Multiple named imports: alphabetical (UPPERCASE then camelCase)
- `useBlockStatements`: braces on ALL `if` bodies; auto-fix: `npx biome check --write --unsafe <file>`

## Git Commits
Use conventional commit style. Brief, factual — state what changed.

## Background
ClosedLoop: human-governed, AI-centric software delivery platform. AI produces artifacts (documents, features, etc.); humans review at milestones. Hybrid: source on customer infra, cloud control plane orchestrates. 'Workflow' = user-defined step sequences, NOT generated artifacts. 'Document' = a specific artifact type (PRD, Implementation Plan, Template) stored in the `document` table. 'Artifact' = the broader concept encompassing documents, features, and other primary records.

## Learned Patterns

### Planning & Verification
- **[mistake]**: New document types — check existing support in: useDocumentUIState type union, isNavigableDocument, getDocumentRoute switch, DOCUMENT_SECTIONS. Mark existing as verification, not implementation.
- **[convention]**: Check `plan.json` architectureDecisions before implementing entity types or schema changes.
- **[mistake]**: Check investigation-log.md for already-imported components before writing import tasks. Mark as verification when already present.

### TypeScript & Imports
- **[mistake]**: Const objects like DocumentType need `import { DocumentType }` not `import type` — runtime values can't use type-only imports.
- **[mistake]**: Adding re-exports to index.ts triggers Biome's `noBarrelFile`. Use direct subpath imports (`@repo/github/execution-log-parser`).
- **[insight]**: Subpath imports (`@repo/github/execution-log-parser`) resolve without explicit `exports` in package.json — pnpm workspace + TS handles it.
- **[convention]**: Never use inline `import()` types. Always top-level imports.
- **[pattern]**: DocumentStatus has 4 synchronized layers — when adding values, update Prisma schema + TypeScript const (packages/api/src/types/document.ts); the Zod validator and status dropdown auto-derive from the const, but exhaustive Record<DocumentStatus, string> maps in status-badge.tsx and project-constants.ts require manual updates. (context: typescript|enum|DocumentStatus|record)
- **[convention]**: use zod validators to validate object shape. do not "manually" validate unknown objects using `typeof` and other related checks. zod can be used to validate any object, not just in route handlers.

### React Query & Mutations
- **[convention]**: Do not add `.catch()` error toasts when calling `mutateAsync`. The global `QueryClient` in `apps/app/lib/query-client.tsx` has a default `mutations.onError` handler that toasts the error message. Only catch rejections to suppress unhandled promise warnings or reset local state.
- **[convention]**: Avoid reflexive on-mount data fetching. Adding a new `useQuery` hook to a component is cheap individually, but editor pages and project pages already mount many components at once and can balloon to 10-20 parallel requests on first paint. Before adding a query that runs on mount, ask: is this data needed for the initial render, or only when the user opens a panel/tab/menu/dialog? If the latter, gate it (`enabled: isOpen`, fetch in an event handler, or lazy-load the component). Prefer deferring fetches until a user action makes the data necessary; reserve on-mount fetches for data the page cannot render without.

### Code Organization
- **[pattern]**: Check `@repo/github` (`packages/github/index.ts`) before implementing new GitHub API functions.
- **[convention]**: Domain-specific parsers → domain package (`packages/github/`), not `apps/api/lib/`. Import via subpath.
- **[convention]**: New parser/utility modules in domain packages must include unit tests.
- **[convention]**: Don't assert on logging statements in unit tests. Assert on observable behavior.
- **[insight]**: @repo/* imports are internal monorepo dependencies, not cross-repo needs.
- **[insight]**: `@repo/observability/log` exports `console` directly, no `server-only` — safe in client components.
- **[pattern]**: Shared mappings for both server packages and frontend → `packages/api/src/types/` (server packages can't import from `apps/app/lib/`).
