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
- **[mistake]**: When using const objects like ArtifactType (ArtifactType.Issue, ArtifactType.Prd), use `import { ArtifactType }` not `import type { ArtifactType }` - const objects are runtime values that cannot be accessed through type-only imports. (context: typescript|import-type|runtime-value)
- **[mistake]**: Adding `export { ... } from './module'` re-exports to an existing index.ts triggers Biome's `noBarrelFile` lint rule. Use direct subpath imports (e.g., `@repo/github/execution-log-parser`) instead of adding re-exports to barrels. (context: biome|noBarrelFile|subpath-imports)
- **[insight]**: In this monorepo, subpath imports like `@repo/github/execution-log-parser` resolve correctly without an explicit `exports` field in package.json. pnpm workspace resolution + TypeScript handles this directly. (context: monorepo|pnpm|subpath-imports)
- **[convention]**: ChecksStatus exists in both `@repo/api/src/types/artifact` (camelCase: .Passing, .Failing, .Pending) and `@repo/database` (UPPERCASE: .PASSING, .FAILING, .PENDING). Both produce identical string values. For webhook handlers not already importing `@repo/database` enum types, use the `@repo/api` version. (context: typescript|imports|ChecksStatus|enum-sources)
- **[convention]**: Never use inline `import()` types. Always top-level imports.

### Debugging
- **[insight]**: API errors return generic messages to clients but log real errors server-side. When debugging 500 errors, check the API server terminal (port 3002), not browser DevTools - `errorResponse()` in `apps/api/lib/route-utils.ts` and `log.error` both print to server console. (context: debugging|error-handling|api-errors)

### Prisma & Database
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
- **[insight]**: Repository.githubId is globally @unique — a GitHub repo belongs to exactly one Symphony organization. Cross-tenant isolation for webhook handlers is achieved by looking up the Repository by event.repository.id, not by installation-level filtering. (context: prisma|multi-tenant|webhooks|repository|schema-design)

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

### TanStack Query
- **[pattern]**: New hooks in `apps/app/hooks/queries/` must follow: queryKey + queryFn + enabled + `...options` spread. Export a `queryKeys` factory with `.all` and `.detail(id)`. Add cache invalidation to related mutations (e.g., `useRegenerateArtifact`, `useRequestPlanChanges`). Only `staleTime` is acceptable as a default; omit gcTime, refetchOnMount, refetchOnWindowFocus. (context: tanstack-query|hooks|patterns)

- **[pattern]**: When reviewing queryClient.clear() calls in organization switching code, verify the entire auth chain: (1) API routes use withAuth() extracting orgId from JWT, (2) service methods filter by organizationId, (3) frontend queries use authenticated API client. If all three hold, queryClient.clear() is the correct approach for org switching. (context: tanstack-query|org-switching|auth|cache-invalidation)

### Code Organization
- **[pattern]**: Check `@repo/github` (`packages/github/index.ts`) for existing GitHub API functions before implementing new ones. (context: packages/github|reuse)
- **[convention]**: Domain-specific parsers (e.g., GitHub Actions artifacts) belong in the corresponding domain package (`packages/github/`), not `apps/api/lib/`. Import via subpath. (context: code-organization|domain-packages)
- **[convention]**: New parser/utility modules in domain packages must include unit tests. PR reviewers will reject parsers without test coverage. (context: testing|code-review)
- **[convention]**: Do not assert on logging statements (`expect(log.info)`, `expect(log.warn)`, etc.) in unit tests. Log messages are implementation details — tests should assert on observable behavior (DB calls, return values, side effects), not that a particular string was logged. (context: testing|unit-tests|logging|anti-pattern)
- **[insight]**: Monorepo packages using @repo/* imports (e.g., @repo/auth/client) are internal dependencies, not cross-repo needs. Only external peer repos count as cross-repo dependencies when analyzing plan.json for cross-repo coordination. (context: monorepo|cross-repo|internal-packages)
- **[insight]**: `@repo/observability/log` exports `console` directly and does not import `server-only`, so it is safe to use in client components despite `server-only` being a package-level dependency of `@repo/observability`. (context: observability|client-components|server-only|module-resolution)
- **[pattern]**: When shared mappings (e.g., artifact subtype-to-route prefix) are needed by both server packages (`packages/collaboration`) and frontend code (`apps/app`), place them in `packages/api/src/types/` since server packages cannot import from `apps/app/lib/`. (context: monorepo|code-organization|shared-types|cross-package-dependencies)

### Testing
- **[pattern]**: In `apps/app` vitest tests, always add `afterEach(() => { cleanup(); })` at the top level when using @testing-library/react with absence assertions (queryByTestId/queryByRole) — auto-cleanup requires `globals:true` which is not set in this project's vitest.config.mts. (context: vitest|testing-library|cleanup|globals)

### React & Components
- **[pattern]**: All Clerk client components in this app (UserButton, OrganizationSwitcher) need the mounted state hydration guard pattern - check for existing mounted state variable before adding new Clerk components. (context: clerk|hydration|mounted-guard|next.js)

### Linting & Formatting
- **[convention]**: After modifying React components in `apps/app`, run `pnpm lint:fix` to auto-fix Biome ordering rules (imports, CSS classes, JSX attributes). (context: biome|lint|components)
- **[mistake]**: Biome's import order rules in this monorepo require `@repo/*` package imports before `@/*` path alias imports. Run `pnpm lint:fix` to auto-fix after adding shared package imports. (context: biome|import-order|lint|monorepo)
- **[convention]**: To lint a single file with Biome, use `npx biome check <file>` directly. The monorepo's `pnpm lint -- --filter=<file>` does not support single-file targeting. (context: biome|linting|cli|single-file)
- **[mistake]**: Biome's import sorting enforces `@repo/*` (workspace) imports before `@/*` (path alias) imports. Run `pnpm lint:fix` to auto-fix after adding new cross-package imports. (context: biome|import-order|lint|monorepo)
- **[convention]**: Biome enforces type aliases over interfaces (useConsistentTypeDefinitions) and De Morgan normalization (useSimplifiedLogicExpression). Always prefer `type Foo = { ... }` over `interface Foo { ... }` and `!(a && b)` over `!a || !b`. (context: biome|typescript|type-aliases|de-morgan)

### Domain Concepts
- **[convention]**: The 'Workflow' artifact category in Symphony represents user-defined step sequences that orchestrate execution (e.g., plan → code → test → review), NOT artifacts generated during execution or external tool integrations. Workflows let users define what steps get executed. (context: artifact-category|workflow|symphony-concepts)

### PR Responses
- **[convention]**: When drafting PR review responses, be concise and just describe the change made. Don't use filler phrases like "Good catch", "Great point", or other flattery. (context: pr-responses|tone|code-review)

### Symphony CI/CD
- **[pattern]**: run-loop.sh state: `.symphony-loop.local.md` with YAML frontmatter (active, iteration, max_iterations, etc.) — not state.json.
- **[insight]**: run-loop.sh deletes state file on success. Check output artifacts (plan.json, plan.md) for success, not file existence.
- **[convention]**: State file at `.claude/symphony-loop.local.md` (repo root), NOT inside `.claude/runs/`. Not part of artifact bundle.
- **[convention]**: closedloop-ai plugins installed from `https://github.com/closedloop-ai/claude_code.git`.
