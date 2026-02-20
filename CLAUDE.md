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

# Database (Prisma)
pnpm migrate                                # Format, generate, and db push (dev only, NOT migrations)
cd packages/database && pnpm prisma generate # Regenerate client after schema changes
cd packages/database && pnpm prisma studio   # Open Prisma Studio
cd packages/database && pnpm prisma db push  # Push schema changes (dev only, no migration)

# Database Migrations (for production-safe schema changes)
cd packages/database && pnpm prisma migrate dev --name <migration_name>  # Create migration
cd packages/database && pnpm prisma migrate deploy                       # Apply migrations (CI/prod)
cd packages/database && pnpm prisma migrate status                       # Check migration status
```

**Important:** After any change to `packages/database/prisma/schema.prisma` (new fields, enums, relations):
1. **Create a migration**: `cd packages/database && pnpm prisma migrate dev --name <descriptive_name>`
2. This automatically runs `prisma generate` to regenerate the TypeScript client in `packages/database/generated/`
3. Commit both the schema change AND the generated migration files in `prisma/migrations/`

Without migrations, production will not receive your schema changes. Without regenerating, types will be stale and cause type errors in consuming packages (`apps/api`, `packages/api`, etc.).

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
- Config: `packages/database/prisma.config.ts`
- Client generated to: `packages/database/generated/`
- Migrations: `packages/database/prisma/migrations/`
- Local dev uses `pg` adapter; production uses Neon adapter (auto-detected via URL)

**Schema changes require migrations:**
- **Development**: Use `prisma migrate dev --name <descriptive_name>` to create a migration file
- **Production**: Migrations are applied via `prisma migrate deploy` in CI/CD
- **Never use `prisma db push` for changes that will go to production** — it doesn't create migration files and can cause drift between environments
- Migration names should be descriptive: `add_user_preferences_table`, `add_index_on_artifact_status`, `rename_foo_to_bar`

### Data Access Pattern (IMPORTANT)

**Do NOT import `@repo/database` in `apps/app` (frontend).**

All database access must go through the BFF API (`apps/api`):

1. **Frontend hooks** (`apps/app/hooks/queries/`) - TanStack Query hooks for data fetching. Use `useApiClient()` hook.
2. **API routes** (`apps/api/app/*/route.ts`) - HTTP layer only: authentication, request parsing, response formatting. Delegate business logic to services.
3. **Services** (`apps/api/app/*/service.ts`) - Business logic and database operations. Import `@repo/database` here, NOT in routes.
4. **Shared types** (`packages/api/src/types/`) - Define request/response types used by both apps

```
apps/app (frontend)
    │
    ├── hooks/queries/use-*.ts (TanStack Query)
    │       ↓ useApiClient()
    │
    └──→ apps/api routes  →  services  →  @repo/database
              ↑
              └── @repo/api types
```

**Layer responsibilities:**
- **Frontend hooks**: `useQuery`/`useMutation`, cache invalidation, loading/error states
- **Route**: `withAuth()`, parse params/body, call service, return `NextResponse.json()`
- **Service**: Validation, business logic, database queries, external API calls

This separation ensures the frontend never has direct database access and keeps routes thin.

### Type Definitions (IMPORTANT)

**Never duplicate type definitions.** If a type is used in more than one file, it must live in one canonical location and be imported everywhere else.

**Where types belong:**

| Type category | Location | Example |
|---|---|---|
| **Shared API types** (used by both frontend and backend) | `packages/api/src/types/` | Entity types, request/response types, enums shared across layers |
| **Database types** | Generated from Prisma schema in `packages/database/generated/` | Prisma model types, enums |
| **Backend-only types** | Co-located in `apps/api/` (e.g., `lib/`, route `validators.ts`) | Route params, Zod schemas, service internals |
| **Frontend-only types** | Co-located in `apps/app/` (e.g., `types/`, component files) | Component props, UI state, display-only models |

**Rules:**
1. `packages/api/src/types/` is **only** for types consumed by both `apps/api` and `apps/app`. Don't put backend-only or frontend-only types here.
2. Backend-only types (route params, validation schemas, service internals) stay in `apps/api/`.
3. Frontend-only types (component props, UI state) stay in `apps/app/`.
4. If a type is used in multiple files within the same app, extract it to a shared location within that app — don't inline it in every file that needs it.
5. Never define the same type in multiple files.

```typescript
// ✅ GOOD - shared API type imported from canonical location
import type { GenerationStatus, PullRequestInfo } from "@repo/api/src/types/artifact";

// ✅ GOOD - backend-only type stays in the API app
// apps/api/lib/route-utils.ts
export type IdRouteParams<T extends string = "id"> = { params: Promise<Record<T, string>> };

// ✅ GOOD - frontend-only type stays in the app
// apps/app/types/teams.ts
export type ArtifactDisplayStatus = "active" | "archived";

// ❌ BAD - duplicating a shared type locally instead of importing
type GenerationStatus = { status: "NONE" | "PENDING" | ... };

// ❌ BAD - putting a backend-only type in packages/api/src/types/
// (Zod validators and route params don't belong in the shared package)
```

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

## Self-Improving CLAUDE.md

When working on a PR and you discover a pattern, convention, or gotcha that isn't documented here, **add it to the relevant CLAUDE.md as part of the same PR.** Examples:

- A code review catches a repeated mistake (e.g., duplicating types, wrong import path) → add a rule so it doesn't happen again
- You hit a non-obvious framework behavior (e.g., MDXEditor requiring `setMarkdown` ref) → document it
- A build/lint/test failure reveals a convention not captured here → add it
- You notice an architectural pattern being followed but not written down → write it down

The goal is that every PR makes future sessions smarter. CLAUDE.md files are living documents — treat them like code.

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

## Git Commits

When creating a git commit, read `.gitmessage` first and follow its format for the commit message.

## Background

The following sections provide the business perspective for what this repository is meant to deliver.

### Vision Statement
To create a human-governed, AI-centric software delivery platform that transforms intent into high-quality software—by automating execution, preserving human judgment, and making decisions, artifacts, and outcomes traceable across the entire delivery lifecycle.

### Abstract
We are building a new software delivery platform where AI is the execution engine, not the decision maker. The platform translates human intent—captured from product, design, engineering, and QA—into all of the artifacts required to deliver software, including requirements, designs, plans, code, tests, and release evidence. Each step of the process is structured around familiar delivery milestones and gated by explicit human review and approval, ensuring quality, accountability, and trust. Rather than forcing teams into chatbots, CLIs, or IDE-centric workflows, the platform provides a modern, role-appropriate experience for the entire team, while publishing clean outputs to existing systems of record. The result is faster delivery, higher consistency, and a durable system of organizational memory that scales with both teams and products.

Unlike developer-focused AI tools that only assist with coding, Symphony serves every stakeholder: product managers converse with AI to produce comprehensive PRDs, designers generate specifications grounded in the actual codebase, and engineers implement features with full context of upstream decisions. The platform operates on a hybrid architecture where source code never leaves customer infrastructure, while a cloud-based control plane orchestrates workflows, manages approvals, and integrates with tools teams already use—GitHub, Linear, and Slack.

### The Opportunity
**The problem:** Software delivery remains bottlenecked by artifact creation. Engineers wait on PRDs. PRDs lack technical grounding. Designs don't account for existing code. Reviews happen too late. Every handoff loses context.

**The insight:** AI can now generate high-quality first drafts of every artifact in the software delivery process—but only if it has deep context about the codebase, the product, and the decisions already made. And it should only act with human approval at critical junctures.

**The product:** A platform where AI agents produce artifacts, humans approve and refine them, and the entire workflow is orchestrated toward shipping software faster—with better quality and more alignment across the team.
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

### Debugging
- **[insight]**: API errors return generic messages to clients but log real errors server-side. When debugging 500 errors, check the API server terminal (port 3002), not browser DevTools - `errorResponse()` in `apps/api/lib/route-utils.ts` and `log.error` both print to server console. (context: debugging|error-handling|api-errors)
- **[insight]**: `codex review` outputs a `session id:` in its startup banner. Capture it and save to `codex-chat.json` so `codex exec resume` can continue the review session in chat. The review route parses the session ID from plain-text stdout (not JSON events like Claude). (context: codex|session-management|review-vs-exec)

### Prisma & Database
- **[mistake]**: When `pnpm typecheck` fails with "Property does not exist on type" for Prisma model fields or `TransactionClient`, do NOT dismiss these as "pre-existing" without checking. Run: (1) `pnpm install` (missing dependencies like `jose`, `@aws-sdk/*`), (2) `just db-generate` or `cd packages/database && pnpm prisma generate` (stale generated client). These two commands fix the vast majority of typecheck failures after rebasing or pulling new code. Verify the fields exist in `schema.prisma` first — if they do, the generated client is just stale. (context: prisma|typecheck|generated-client|stale-types|debugging)
- **[convention]**: When using Prisma enums, always verify valid values in `packages/database/prisma/schema.prisma` - don't assume names (e.g., GitHubActionStatus uses `SUCCESS` not `COMPLETED`). (context: prisma|enums|schema)
- **[pattern]**: To filter Prisma `Json` fields by nested property, use `{ path: ['key'], equals: value }` syntax - not dot notation or direct equality. (context: prisma|json-filter)
- **[pattern]**: When filtering Prisma `Json` fields, always scope through indexed fields first (e.g., workstreamId + status) before applying JSON path filters. JSON path filters cause sequential scans without index narrowing. (context: prisma|json-filter|performance|indexes)
- **[pattern]**: When adding a taxonomy layer to an existing enum (e.g., type/subtype), prefer adding a new category field with a default value rather than renaming - avoids touching every reference site. (context: prisma|schema-design|enum-evolution)
- **[pattern]**: When checking artifact categories (Document vs Workflow vs Branch), use `artifact.type === ArtifactType.DOCUMENT` instead of enumerating subtypes. The `type` field is the canonical categorization mechanism after the type/subtype split - more maintainable when new subtypes are added. (context: artifact|schema-design|type-system|categorization)
- **[convention]**: All database schema changes must use `prisma migrate dev --name <name>` to create migration files. Never use `prisma db push` for changes going to production — it doesn't create migrations and causes environment drift. Migrations are applied in prod via `prisma migrate deploy`. (context: prisma|migrations|schema-changes|production|db-push)
- **[mistake]**: After rebasing or updating dependencies, the hardcoded Stripe apiVersion in packages/payments/index.ts may need to be updated to match the installed stripe package's expected version. The SDK enforces strict API version compatibility. (context: stripe|api-version|rebase|dependency-updates|type-errors|packages/payments)
- **[pattern]**: For collapsible sections in artifact editor sidebar, use PropertiesPanel pattern: CollapsibleTrigger with 'rounded-lg p-3 font-medium text-sm hover:bg-accent' styling, ChevronUp/Down icons, and CollapsibleContent with 'space-y-4 px-3 pb-3' spacing. Default to collapsed (useState(false)). (context: react|components|collapsible|artifact-editor|ui-patterns)
- **[pattern]**: When converting metadata panels from tabs to collapsible sections: (1) Replace TabbedMetadataPanel with MetadataPanel, (2) Wrap sections in space-y-6 container, (3) Use separate useState(bool) for each section's open/close state, (4) Import Collapsible/CollapsibleTrigger/CollapsibleContent and ChevronUp/ChevronDown icons, (5) Follow existing pattern from PropertiesPanel and CommentsSection components. (context: react|refactoring|metadata-panel|collapsible|ui-patterns)
- **[pattern]**: Artifact metadata panels (PRD, Issue, Plan) follow identical TabbedMetadataPanel structure in apps/app/app/(authenticated)/{artifact}/[slug]/components/*-metadata-panel.tsx - only difference is artifact-specific fields in Details tab content. (context: architecture|metadata-panel|artifact-editor|code-structure)
- **[pattern]**: When renaming Prisma enums, `@repo/database` re-exports Prisma-generated types via `export *` in `packages/database/index.ts`. Files importing enum types from `@repo/database` (like `artifact-utils.ts`) need separate treatment from files importing from `@repo/api/src/types/`. Both sources must be updated in sync. (context: prisma|enum|rename|database-reexport|shared-types)
- **[pattern]**: `validateOwnerInOrg` uses `withDb` (non-transactional) but is called from inside `withDb.tx` callbacks. The `withDb.tx` implementation does NOT store the transaction in AsyncLocalStorage, so nested `withDb` calls open separate connections instead of reusing the transaction. (context: database|transactions|withDb|connection-pool|prisma)
- **[pattern]**: In this project's multi-org architecture (one User record per Clerk user per org), service methods that update profile data (name, avatar, email) should use `updateMany({ where: { clerkId } })` to sync across all organizations. Document this intentional broad-update behavior in docstrings. (context: multi-org|prisma|service-layer|user-profile|clerk-webhooks)

- **[convention]**: `Artifact.subtype` is non-nullable in both the DB schema and API type. All creation paths require a subtype — don't make it nullable for speculative forward-compatibility. (context: prisma|schema-design|api-contract|artifact)
- **[pattern]**: When checking if an artifact is a document (or other category), use `artifact.type === ArtifactType.DOCUMENT` instead of enumerating subtypes (PRD, IMPLEMENTATION_PLAN, ISSUE). The `type` field is the canonical categorization after the type/subtype split. (context: artifact-types|schema-design|categorization|type-subtype)
- **[mistake]**: When looking up route prefixes or navigation paths, use `artifact.subtype` not `artifact.type`. Type is the broad category (DOCUMENT/WORKFLOW/BRANCH), subtype is specific (PRD/ISSUE/etc). Route maps like `ARTIFACT_TYPE_ROUTES` are keyed by subtype values. (context: artifact|routing|type-subtype|navigation)

### API & Service Layer
- **[pattern]**: For artifact routes in `apps/api/app/artifacts/[id]/`, use `findById(artifactId, user.organizationId)` not `validateOwnerInOrg()` - the org-scoped query ensures authorization. (context: auth|artifacts|org-scoping)
- **[pattern]**: When service functions exceed ~30 lines or have complex parsing, extract to `apps/api/lib/{feature}-parser.ts` with pure functions. Service orchestrates, parser implements. (context: service-layer|code-organization)
- **[convention]**: API routes must not set Cache-Control headers manually. Caching is handled by TanStack Query on the frontend. Server-side caching goes in the service layer (in-memory or Redis), not HTTP headers. (context: api-routes|caching)
- **[convention]**: For Prisma-to-API type conversions in the service layer, use a centralized mapping function (e.g., `toArtifact()`, `toArtifactWithWorkstream()`) that validates required fields and throws on contract violations, rather than scattering `as Type` casts across call sites. (context: service-layer|type-mapping|prisma|api-types|validation)
- **[convention]**: When catching expected errors in webhook handlers (e.g., Prisma P2025 for record-not-found), catch only the specific error code and re-throw everything else. Do not use generic catch blocks that swallow all errors. See `handleOrganizationMembershipDeleted` pattern in `auth-hooks.ts:238-255`. (context: webhooks|error-handling|prisma|expected-errors|api-routes)
- **[mistake]**: When implementing Liveblocks auth with global tokens (no roomId), must pass organizationId as tenantId. Without tenant scoping, inbox notifications are broken. The Liveblocks auth route already has `user.organizationId` available - pass it through to `authenticate()`. (context: liveblocks|auth|multi-tenant|global-tokens|tenant-scoping|inbox)
- **[pattern]**: When extracting tenant ID from a room ID in Liveblocks auth, use fallback chain: `extractTenantId(roomId) ?? organizationId`. This provides defense-in-depth if room ID parsing fails (malformed input) - still get tenant scoping from the explicit organizationId. (context: liveblocks|auth|multi-tenant|defensive-programming|fallback-chain)
- **[pattern]**: API routes in apps/api/app should use parseBody(request, validator) from @/lib/route-utils instead of manual parsing and validation. This provides consistent error responses and follows established codebase patterns. (context: api-routes|request-parsing|route-utils|validation)
- **[mistake]**: When calling artifactsService.create, pass organizationId and userId as separate arguments BEFORE the CreateArtifactInput object. The service method signature is: create(organizationId: string, userId: string, input: CreateArtifactInput). (context: service-layer|artifacts|api-signature|method-calls)
- **[pattern]**: Routes must transform service Result types to API contract types. Service layer returns Result types with success/connected discriminants, but API contract types need flat structure. Check Linear vs Google integration routes - transformation may be explicit or match naturally. (context: service-layer|api-contract|result-pattern|type-transformation)
- **[mistake]**: When implementing OAuth connect routes, verify service method signature before copying parameter destructuring from reference implementation - not all integrations need userId. (context: oauth|service-signature|parameter-destructuring|implementation-patterns)
- **[mistake]**: When throttling periodic operations (cleanup, sync) via localStorage timestamps, write the timestamp AFTER the operation succeeds (in `.then()`), not before. Writing before prevents retry on failure for the entire throttle duration. (context: throttling|async|error-recovery|side-effects)

### TanStack Query
- **[pattern]**: New hooks in `apps/app/hooks/queries/` must follow: queryKey + queryFn + enabled + `...options` spread. Export a `queryKeys` factory with `.all` and `.detail(id)`. Add cache invalidation to related mutations (e.g., `useRegenerateArtifact`, `useRequestPlanChanges`). Only `staleTime` is acceptable as a default; omit gcTime, refetchOnMount, refetchOnWindowFocus. (context: tanstack-query|hooks|patterns)

- **[pattern]**: When reviewing queryClient.clear() calls in organization switching code, verify the entire auth chain: (1) API routes use withAuth() extracting orgId from JWT, (2) service methods filter by organizationId, (3) frontend queries use authenticated API client. If all three hold, queryClient.clear() is the correct approach for org switching. (context: tanstack-query|org-switching|auth|cache-invalidation)

### Tables & Sorting
- **[pattern]**: When sorting by nested object fields using SortConfig in this codebase, use the accessor function to extract the comparable value (e.g., `accessor: (p) => p.owner ? getUserDisplayName(p.owner) : null`). The `sortItems()` utility handles nulls with nulls-last policy automatically. (context: tables|sorting|SortConfig|accessor|nested-objects)
- **[pattern]**: When rendering multiple sortable tables on the same page, each `useSortParams` call must use a unique `paramPrefix` to prevent URL sort param collision. Derive the prefix from a unique identifier (e.g., artifact type or section name). (context: tables|sorting|useSortParams|paramPrefix|url-params)

### Code Organization
- **[pattern]**: Check `@repo/github` (`packages/github/index.ts`) for existing GitHub API functions before implementing new ones. (context: packages/github|reuse)
- **[convention]**: Domain-specific parsers (e.g., GitHub Actions artifacts) belong in the corresponding domain package (`packages/github/`), not `apps/api/lib/`. Import via subpath. (context: code-organization|domain-packages)
- **[convention]**: New parser/utility modules in domain packages must include unit tests. PR reviewers will reject parsers without test coverage. (context: testing|code-review)
- **[convention]**: Do not assert on logging statements (`expect(log.info)`, `expect(log.warn)`, etc.) in unit tests. Log messages are implementation details — tests should assert on observable behavior (DB calls, return values, side effects), not that a particular string was logged. (context: testing|unit-tests|logging|anti-pattern)
- **[insight]**: Monorepo packages using @repo/* imports (e.g., @repo/auth/client) are internal dependencies, not cross-repo needs. Only external peer repos count as cross-repo dependencies when analyzing plan.json for cross-repo coordination. (context: monorepo|cross-repo|internal-packages)
- **[insight]**: `@repo/observability/log` exports `console` directly and does not import `server-only`, so it is safe to use in client components despite `server-only` being a package-level dependency of `@repo/observability`. (context: observability|client-components|server-only|module-resolution)
- **[pattern]**: When shared mappings (e.g., artifact subtype-to-route prefix) are needed by both server packages (`packages/collaboration`) and frontend code (`apps/app`), place them in `packages/api/src/types/` since server packages cannot import from `apps/app/lib/`. (context: monorepo|code-organization|shared-types|cross-package-dependencies)

### React & Components
- **[pattern]**: All Clerk client components in this app (UserButton, OrganizationSwitcher) need the mounted state hydration guard pattern - check for existing mounted state variable before adding new Clerk components. (context: clerk|hydration|mounted-guard|next.js)
- **[insight]**: Before adding new props to existing components, check what's already available. Components often already receive props that contain the data you need - e.g., plan-metadata-panel.tsx receives a `plan` prop that already has `plan.id` and `plan.version`, no need to modify plan-editor.tsx to pass these separately. (context: react-props|component-api|over-engineering|plan-metadata-panel)
- **[pattern]**: Radix Dialog with `modal={false}` still fires `onInteractOutside`/`onPointerDownOutside` on outside clicks. Non-modal floating panels must call `e.preventDefault()` on both events to stay open. (context: radix-ui|dialog|modal|floating-panels)
- **[pattern]**: When a component supports multiple AI providers (e.g., Claude vs Codex), context injection must be provider-aware. Client-side prompt formatting designed for one provider should be skipped for others — use server-side injection that reads the provider's own output instead. (context: multi-provider|context-injection|provider-routing)
- **[convention]**: The established pattern for async cancellation in useEffect is `let cancelled = false` + cleanup return, NOT AbortController or useRef. When one effect in a component uses this pattern correctly, check other effects in the same file for the same async-without-cleanup anti-pattern. (context: react|useEffect|cancelled-flag|code-review|consistency)
- **[convention]**: This codebase uses `let cancelled = false` flag pattern for async cancellation in useEffect (not AbortController). When one effect in a file follows this convention, check all other effects for consistent usage. (context: react|useEffect|cancelled-flag|cleanup|code-consistency)

### Testing
- **[pattern]**: After adding required props to a component, run typecheck to find test files with outdated mock/defaultProps objects. Test fixtures must be kept in sync with component prop types. Run lint:fix after making prop changes to ensure consistent formatting. (context: testing|react|component-props|test-fixtures|typecheck)
- **[mistake]**: When mocking `next/navigation` in Vitest, always provide all three navigation hooks: `useRouter`, `usePathname`, and `useSearchParams`. Missing any one causes failures when utility hooks depending on multiple navigation APIs are introduced. (context: testing|vitest|next/navigation|mocking|hooks)

### Linting & Formatting
- **[convention]**: After modifying React components in `apps/app`, run `pnpm lint:fix` to auto-fix Biome ordering rules (imports, CSS classes, JSX attributes). (context: biome|lint|components)
- **[mistake]**: Biome's import order rules in this monorepo require `@repo/*` package imports before `@/*` path alias imports. Run `pnpm lint:fix` to auto-fix after adding shared package imports. (context: biome|import-order|lint|monorepo)
- **[convention]**: To lint a single file with Biome, use `npx biome check <file>` directly. The monorepo's `pnpm lint -- --filter=<file>` does not support single-file targeting. (context: biome|linting|cli|single-file)
- **[mistake]**: Biome's import sorting enforces `@repo/*` (workspace) imports before `@/*` (path alias) imports. Run `pnpm lint:fix` to auto-fix after adding new cross-package imports. (context: biome|import-order|lint|monorepo)
- **[mistake]**: Do not mark service methods as `async` if they only `return withDb(...)` or `return withDb.tx(...)` without any `await` in the function body. Biome's `useAwait` rule flags `async` functions that lack `await` expressions. Only use `async` when the function body itself needs to `await` something before returning. (context: biome|useAwait|async|service-layer|withDb)
- **[pattern]**: When importing multiple named exports in Next.js App Router routes, Biome requires alphabetical order: constants/types first (UPPERCASE), then functions (camelCase). Run pnpm lint:fix to auto-fix import ordering. (context: biome|import-order|next.js|api-routes)
- **[mistake]**: Biome's `useBlockStatements` rule requires braces on ALL `if` statement bodies, including single-line early-returns like `if (closed) return;`. Write `if (closed) { return; }` instead. These are flagged as "unsafe fixes" by Biome so `pnpm lint:fix` won't auto-fix them — run `npx biome check --write --unsafe <file>` to apply. (context: biome|useBlockStatements|if-statements|early-return)

### CSS & Animations
- **[mistake]**: Tailwind v4 compiles `translate-x-[-50%]` / `translate-y-[-50%]` to the individual CSS `translate` property, NOT the `transform` shorthand. The individual `translate`, `rotate`, `scale` properties compose with `transform` (translate applies first, then transform on top). When animating with the Web Animations API, do NOT put translate values in the `transform` keyframes — they will double-up with the existing `translate` property. Instead, compute pixel deltas via `getBoundingClientRect()` and use `transform: translate(${dx}px, ${dy}px) scale(...)` so the animation is relative to the current position. (context: tailwind-v4|css-transforms|waapi|individual-properties|translate)
- **[pattern]**: When targeting a specific on-screen element as an animation destination (e.g., genie minimize to a button), query the target element with `document.querySelector` and use `getBoundingClientRect()` for its position — never hardcode pixel offsets from viewport edges. (context: css-animations|waapi|dom-position|robust-targeting)

### OAuth Integrations
- **[pattern]**: OAuth integrations in this Next.js app follow a consistent three-part architecture: (1) Frontend OAuth routes in apps/app/app/api/integrations/{provider}/ handle PKCE generation, state cookies, and provider redirect, (2) Callback route validates state with timing-safe comparison and calls API endpoint for token storage, (3) TanStack Query hooks provide status/disconnect/action mutations with proper cache invalidation. Always follow the Linear integration as the reference implementation. (context: oauth|architecture|integration-patterns|pkce|state-validation)

### Domain Concepts
- **[convention]**: The 'Workflow' artifact category in Symphony represents user-defined step sequences that orchestrate execution (e.g., plan → code → test → review), NOT artifacts generated during execution or external tool integrations. Workflows let users define what steps get executed. (context: artifact-category|workflow|symphony-concepts)

### PR Responses
- **[convention]**: When drafting PR review responses, be concise and just describe the change made. Don't use filler phrases like "Good catch", "Great point", or other flattery. (context: pr-responses|tone|code-review)

### Symphony CI/CD
- **[pattern]**: run-loop.sh stores state in `.symphony-loop.local.md` with YAML frontmatter (active, iteration, max_iterations, completion_promise, workdir, prd_file, run_id, start_sha, started_at) - not in state.json. Resume behavior reads this file at line 564. (context: run-loop|state-management|symphony|CI-workflow)
- **[insight]**: run-loop.sh deletes `.claude/symphony-loop.local.md` on successful completion (lines 663, 726). State file existence cannot be used as success indicator - verify success by checking for output artifacts (plan.json, plan.md, implementation-plan.md) instead. (context: run-loop|state-management|symphony|verification)
- **[convention]**: run-loop.sh creates state file at `.claude/symphony-loop.local.md` (repo root), NOT inside the run directory (`.claude/runs/YYYYMMDD-HHMMSS/`). Artifact uploads only include `.claude/runs/`, so state file is not part of the artifact bundle. (context: run-loop|state-management|symphony|artifacts)
- **[convention]**: The closedloop-ai plugins (symphony-core, experimental) are installed from `https://github.com/closedloop-ai/claude_code.git`. Custom/private Claude Code plugins should use their Git repository URL for installation in CI environments. (context: github-actions|claude-cli|plugins|ci-cd)

### Liveblocks
- **[mistake]**: RoomProvider requires a LiveblocksProvider ancestor. When LiveblocksProvider is conditionally mounted based on user data loading, and artifact data resolves first, RoomProvider descendants crash. Always mount at least a minimal LiveblocksProvider (auth endpoint only) during loading states. (context: liveblocks|RoomProvider|react-providers|loading-state|race-condition)
- **[mistake]**: When mounting LiveblocksProvider in loading/bootstrap branches, must include LiveblocksErrorBoundary to contain auth/runtime errors. Without it, Liveblocks errors during bootstrap bubble up and crash the app before the full provider mounts. (context: liveblocks|error-boundary|bootstrap|error-handling|react)
- **[pattern]**: When nesting LiveblocksErrorBoundary with a manual LiveblocksAvailabilityContext.Provider, place the manual override inside the error boundary. The inner provider wins, ensuring isAvailable=false during loading regardless of auth errors. (context: react-context|error-boundaries|liveblocks|context-nesting)
- **[mistake]**: When reading Liveblocks room metadata, must use the same key that was stored at room creation. Room creation stores `artifactSubtype` in `room-utils.ts` but room resolution was reading `artifactType` in `room-metadata.ts`, causing fallback to generic URLs. Always verify read keys match write keys. (context: liveblocks|room-metadata|metadata-keys|consistency|read-write-mismatch)
