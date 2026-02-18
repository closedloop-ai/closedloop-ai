# Implementation Plan: MCP/API Access Keys, Bulk Operations, and Slack Bot Integration

## Summary

Expose Symphony Alpha via API keys and the MCP protocol to enable local ClaudeCode CLI connectivity, bulk artifact operations, and Slack bot integration. This involves creating an API key management system (generate, revoke, list), an MCP server with tools wrapping existing REST endpoints, bulk artifact creation and plan generation endpoints, and a Slack webhook handler for creating Ideas and querying project status.

**Scope:**
- In-scope: API key model and CRUD, API key authentication middleware, MCP server with Streamable HTTP transport, bulk create artifacts endpoint, bulk generate plans endpoint, Slack webhook handler (create Idea, get status), frontend API key management UI
- Out-of-scope: Rate limiting per API key, MCP resource/prompt primitives (tools only), Slack OAuth installation flow (existing SlackIntegration model is reused), real-time Slack event subscriptions beyond slash commands

## Acceptance Criteria

| ID | Criterion | Source |
|----|-----------|--------|
| AC-001 | Org admins and individual users can generate named access keys (API keys) scoped to their organization and identity | PRD §1 |
| AC-002 | API keys enable secure MCP connectivity for local ClaudeCode CLI sessions | PRD §1 |
| AC-003 | A PM can bulk-create new Ideas (PRDs) in a project via ClaudeCode | PRD §2 |
| AC-004 | A PM can trigger generation of implementation plans for all approved PRDs in a project via ClaudeCode | PRD §2 |
| AC-005 | A Slack bot can create a new Idea (PRD) in a specific project via slash command or message | PRD §3 |
| AC-006 | A Slack bot can query the status of a project or specific artifact | PRD §3 |
| AC-007 | MCP tools are exposed for artifact CRUD, reporting, and project status queries | PRD §1 |
| AC-008 | Access keys follow security best practices (hashing, prefix format, one-time reveal) | PRD §1 |

## Architecture Decisions

| Decision | Options | Chosen | Rationale |
|----------|---------|--------|-----------|
| MCP transport | Streamable HTTP, SSE (deprecated), stdio | Streamable HTTP | Current MCP spec (2025-03-26) recommends Streamable HTTP; SSE is deprecated. SDK `@modelcontextprotocol/sdk` supports it natively. |
| MCP server placement | Separate app (`apps/mcp`), Routes in `apps/api` | Separate app (`apps/mcp`) | Keeps API server focused on BFF duties; MCP server has different auth (API key, not Clerk), different transport (Streamable HTTP), and different clients (ClaudeCode CLI). Separate app avoids mixing Clerk middleware with API key auth. |
| API key hashing | bcrypt, SHA-256 | SHA-256 | API keys are random tokens (not passwords) - SHA-256 is sufficient and faster for lookup. Store `sha256(key)` in DB; return plaintext once on creation. |
| API key format | UUID, prefixed random | Prefixed random (`sk_live_<random>`) | Prefix enables easy identification and secret scanning. `sk_live_` prefix followed by 32-char random hex. |
| API key auth middleware | Extend `withAuth`, separate `withApiKeyAuth` | Separate `withApiKeyAuth` | Different auth flow (header-based key lookup vs Clerk JWT). Produces same `AuthContext` shape for downstream compatibility. |
| Slack integration approach | Bolt SDK app, raw webhook handler | Raw webhook handler | Follows existing webhook patterns (GitHub). Slack signature verification is straightforward. Avoids adding Bolt SDK dependency for two simple operations. |
| Admin detection for key creation | Clerk JWT `orgRole` claim, Clerk SDK call | Clerk JWT `orgRole` claim | Available in JWT without extra API call. Requires adding optional `orgRole?: string` field to `AuthContext`. |
| MCP API key verification | Direct DB from apps/mcp, Internal HTTP to apps/api | Internal HTTP to apps/api | Keeps all DB authorization logic in one place. MCP server holds no DB credentials. Internal endpoint is network-restricted. |
| CORS policy for API key routes | Relax origin check for `sk_live_*` bearer tokens, keep existing policy | Keep existing policy unchanged | Non-browser programmatic clients (CLI, MCP) are not subject to CORS — no CORS exception is needed. Browser-based requests keep their origin restriction. |

## Architecture Fit

- **Impacted modules:** `apps/api` (new routes, auth middleware), `packages/database` (new ApiKey model), `packages/api/src/types` (new API key types), `apps/mcp` (new app), `apps/app` (settings UI for keys)
- **State/storage changes:** New `ApiKey` table in PostgreSQL via Prisma migration
- **Integration points:** `artifactsService.create()` for Slack/MCP artifact creation, `artifactsService.batchRegenerateImplementationPlans()` for plan generation, `projectsService.findById()` and `projectsService.calculateStatus()` for status queries

## Tasks

### Phase 1: API Key Data Layer and Service

- [ ] **T-1.1**: Add `ApiKey` model to `packages/database/prisma/schema.prisma` with fields: id, organizationId, userId, name, keyHash, keyPrefix (first 8 chars for display), expiresAt (nullable DateTime), lastUsedAt (nullable DateTime), createdAt, revokedAt (nullable DateTime). Add indexes on organizationId and keyHash. Create migration via `prisma migrate dev --name add_api_keys_table`. *(AC-001, AC-008)*
- [ ] **T-1.2**: Add shared API key types in `packages/api/src/types/api-key.ts`: `ApiKey` response type (without hash, with `expiresAt: Date | null`, `lastUsedAt: Date | null`, `revokedAt: Date | null` — nullable not optional), `CreateApiKeyInput` (name: string, expiresAt?: Date), `CreateApiKeyResponse` (extends ApiKey plus one-time `plaintext: string` field), `VerifiedApiKeyContext` (userId: string, organizationId: string — shared type returned by verifyKey and used by both apps/api and apps/mcp). *(AC-001, AC-008)*
- [ ] **T-1.3**: Create `apps/api/app/api-keys/service.ts` with methods: `generate(organizationId, userId, input)` (creates random key with `sk_live_` prefix followed by 32-char random hex, stores SHA-256 hash), `list(organizationId, userId, orgRole)` (returns all org keys if `orgRole === 'org:admin'`, otherwise only keys where `userId` matches), `revoke(id, organizationId)` (scopes DELETE to `WHERE id = :id AND organizationId = :organizationId`; returns not-found if no matching record, never exposes whether the id exists in another org), `verifyKey(plaintextKey)` (hashes key, looks up with `WHERE keyHash = $hash AND revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > NOW())`, returns `VerifiedApiKeyContext` or null). *(AC-001, AC-008)*
- [ ] **T-1.4**: Create `apps/api/app/api-keys/validators.ts` with Zod validator for create API key input. *(AC-001)*
- [ ] **T-1.5**: Create `apps/api/app/api-keys/route.ts` with `GET` (list keys for org — passes `user.id` and `user.orgRole` to service; admins get all org keys, regular users get only their own) and `POST` (generate new key) using `withAuth` only — this route must never accept `withApiKeyAuth`. *(AC-001)*
- [ ] **T-1.6**: Create `apps/api/app/api-keys/[id]/route.ts` with `DELETE` (revoke key) using `withAuth` only — this route must never accept `withApiKeyAuth`. The route passes `user.organizationId` to `apiKeysService.revoke(id, organizationId)`; if the service returns not-found, respond with 404 (not 403, to avoid org enumeration). *(AC-001)*

### Phase 2: API Key Authentication Middleware

- [ ] **T-2.1**: Add optional `orgRole?: string` field to the `AuthContext` type in `apps/api/lib/auth/with-auth.ts` (optional field — existing routes remain unaffected). Populate `orgRole` from the Clerk JWT `orgRole` claim in `withAuth`. Create `apps/api/lib/auth/with-api-key-auth.ts` that reads `Authorization: Bearer sk_live_...` header, calls `apiKeysService.verifyKey()`, resolves user and org from the returned `VerifiedApiKeyContext`, and produces the same `AuthContext` shape as `withAuth` (with `orgRole` left undefined for API-key sessions). This middleware is wired only to endpoints intended for programmatic access (bulk operations, project status) — never to the API key CRUD routes (T-1.5, T-1.6) which remain Clerk-JWT-only. *(AC-002, AC-008)*

### Phase 3: Bulk Operations Endpoints

- [ ] **T-3.1**: Add `BatchCreateArtifactInput` type to `packages/api/src/types/artifact.ts`: an object with an `items` array where each item is `CreateArtifactInput` extended to require `subtype` (matching the non-nullable DB constraint). Verify that `CreateArtifactInput` already includes `subtype`; if not, add it as a required field before implementing batch create. *(AC-003)*
- [ ] **T-3.2**: Add `batchCreateArtifactsValidator` to `apps/api/app/artifacts/validators.ts` following the existing `batchMoveArtifactsValidator` pattern. Ensure the Zod schema requires `subtype` on each item, aligned with the non-nullable DB constraint. *(AC-003)*
- [ ] **T-3.3**: Add `batchCreate(organizationId, userId, inputs[])` method to `apps/api/app/artifacts/service.ts`. Extract the core per-artifact DB work from `create()` into a private helper function `createArtifactRecord(tx, organizationId, userId, input)` that accepts a Prisma transaction client and contains no `withDb.tx` call internally. Both `create()` (wraps helper in `withDb.tx`) and `batchCreate()` (iterates helper inside a single `withDb.tx`) call this shared helper. After the transaction commits, call `createArtifactRoom()` per artifact as a post-transaction side effect, same as today. *(AC-003)*
- [ ] **T-3.4**: Create `apps/api/app/artifacts/batch-create/route.ts` with `POST` handler following the `batch-move` route pattern, using `withAuth` or `withApiKeyAuth`. *(AC-003)*
- [ ] **T-3.5**: Add `batchRegenerateImplementationPlans(projectId, organizationId, userId)` method to `apps/api/app/artifacts/service.ts` that calls `findApprovedPrds(projectId, organizationId)` and iterates sequentially calling `regenerateImplementationPlan()` for each result, processing one at a time to avoid overwhelming GitHub Actions. Returns `{ triggered: number; artifactIds: string[] }`. Create `apps/api/app/projects/[id]/generate-plans/route.ts` as a thin wrapper calling this single service method, using `withAuth` or `withApiKeyAuth`. *(AC-004)*
- [ ] **T-3.6**: Add `findApprovedPrds(projectId, organizationId)` method to `apps/api/app/artifacts/service.ts` that returns `Artifact[]` — queries artifacts with `subtype = 'PRD'` (not `type = 'PRD'`, per the type/subtype split in the codebase) and `status = 'APPROVED'` for the given project and org. *(AC-004)*

### Phase 4: MCP Server

- [ ] **T-4.1**: Create `apps/mcp/` directory with `package.json`, `tsconfig.json`, and entry point, using `@modelcontextprotocol/sdk` with Streamable HTTP transport. Register in root `turbo.json` and `pnpm-workspace.yaml`. *(AC-002, AC-007)*
- [ ] **T-4.2**: Implement API key authentication in the MCP server by making an internal HTTP call to a new network-restricted endpoint `POST /internal/api-keys/verify` in `apps/api`. The verify endpoint is not publicly routable (protected by network policy or a shared internal secret header). It accepts the plaintext key, calls `apiKeysService.verifyKey()`, and returns `VerifiedApiKeyContext` (userId, organizationId) from `packages/api/src/types/api-key.ts`. The MCP server stores the resolved context for use in all tool calls. The MCP server holds no database credentials. *(AC-002, AC-008)*
- [ ] **T-4.3**: Implement MCP tool `list-projects` that calls the projects service to list projects for the authenticated org. *(AC-007)*
- [ ] **T-4.4**: Implement MCP tool `list-artifacts` that calls the artifacts service to list artifacts, with optional filters for projectId, type, and status. *(AC-007)*
- [ ] **T-4.5**: Implement MCP tool `create-artifact` that calls the artifacts service to create a single artifact (PRD/Idea). *(AC-007)*
- [ ] **T-4.6**: Implement MCP tool `batch-create-artifacts` that calls the batch-create endpoint to create multiple artifacts at once. *(AC-003, AC-007)*
- [ ] **T-4.7**: Implement MCP tool `generate-plans` that calls the `projects/:id/generate-plans` endpoint to trigger implementation plan generation for all approved PRDs in a project. *(AC-004, AC-007)*
- [ ] **T-4.8**: Implement MCP tool `get-project-status` by calling `projectsService.findById(projectId, organizationId)` and `projectsService.calculateStatus()` and formatting the result for MCP output. Do not add new DB queries or aggregation logic in the MCP layer — reuse existing service methods. *(AC-006, AC-007)*
- [ ] **T-4.9**: Implement MCP tool `get-artifact` that returns a single artifact by ID including its latest content. *(AC-007)*

### Phase 5: Slack Webhook Handler

- [ ] **T-5.1**: Add `SLACK_SIGNING_SECRET` to `apps/api/env.ts` as an optional server environment variable (only required when Slack is configured). *(AC-005, AC-006)*
- [ ] **T-5.2**: Create `apps/api/app/webhooks/slack/route.ts` with `POST` handler. Verification order: (1) read `X-Slack-Request-Timestamp` header and reject if `abs(now - timestamp) > 300 seconds` before any expensive computation; (2) verify `X-Slack-Signature` HMAC-SHA256 against the signing secret and raw body. Implement as a `slackVerifyWebhookSignature` utility following the existing `verifyWebhookSignature` pattern in `packages/github`. Handles `url_verification` challenge and routes slash commands to handlers. *(AC-005, AC-006)*
- [ ] **T-5.3**: Create `apps/api/app/webhooks/slack/handlers.ts` with `handleCreateIdea(slackPayload)` that: (1) looks up `organizationId` via `SlackIntegration.teamId` from the payload; (2) looks up the User record by `slackId = payload.user_id AND organizationId = resolvedOrgId` — if no active user record exists, return an ephemeral Slack error message and stop; (3) validates that the target `projectId` (from slash command text) belongs to `organizationId` using `projectsService.findById(projectId, organizationId)` — if not found, return an ephemeral error; (4) calls `artifactsService.create(organizationId, userId, input)` to create the PRD. *(AC-005)*
- [ ] **T-5.4**: Add `handleGetStatus(slackPayload)` to `apps/api/app/webhooks/slack/handlers.ts` that: (1) resolves `organizationId` from `SlackIntegration.teamId`; (2) verifies the requesting Slack user is an active org member (same pattern as T-5.3); (3) validates any projectId or artifactId argument belongs to the resolved org before querying; (4) returns a formatted Slack message response. *(AC-006)*

### Phase 6: Frontend API Key Management

- [ ] **T-6.1**: Create `apps/app/hooks/queries/use-api-keys.ts` with TanStack Query hooks: `useApiKeys()` for listing (queryKey + queryFn + `...options` spread with `queryKeys` factory), `useCreateApiKey()` mutation (result typed as `CreateApiKeyResponse` which includes the one-time `plaintext` field), `useRevokeApiKey()` mutation (wires `isPending` for confirmation dialog). Follow existing hook patterns with `queryKeys` factory. Invalidate `apiKeys.all` on create and revoke mutations. *(AC-001)*
- [ ] **T-6.2**: Implement the API Keys settings section in `apps/app/`: (1) Add a dedicated fifth **"API Keys" tab** to `apps/app/app/(authenticated)/settings/page.tsx` alongside the existing Profile/Organization/Admin/Integrations tabs, using the same `TabsTrigger` className pattern, visible to all authenticated users (not admin-gated). Enable URL-based tab activation by reading `?tab=api-keys` query parameter via `useSearchParams()` and setting `defaultValue={searchParams.get('tab') ?? 'profile'}` on the Tabs component, following the existing OAuth callback query-param pattern. (2) Create an `ApiKeysSettingsPanel` component displaying a table of API keys with columns: Name, Prefix, Created, Last Used, and a Status badge column using the `Badge` component from `@repo/design-system` with three states — Active (default variant), Revoked (destructive variant), Expired (secondary/muted variant). The Revoke button is only enabled for keys where `revokedAt === null && (expiresAt === null || expiresAt > new Date())`. (3) Create a `CreateApiKeySuccessDialog` component (not reusing `ConfirmationDialog`) that contains: the full plaintext key in a read-only `<code>` block or Input, a copy-to-clipboard Button using the browser Clipboard API with visual confirmation (icon swap), a checkbox requiring acknowledgment ("I have copied this key and understand it will not be shown again") before the Done button becomes active, and a warning banner "This key will not be shown again.". (4) Wire the Revoke button to open the existing `ConfirmationDialog` at `apps/app/components/confirmation-dialog.tsx` with title="Revoke API Key", description="This will immediately invalidate the key. Any integrations using it will stop working.", `variant="destructive"`, `confirmLabel="Revoke"`, `isPending={useRevokeApiKey().isPending}`. *(AC-001, AC-008)*

### Manual Verification

- [ ] **T-7.1** [MANUAL]: Test MCP server connectivity from a local ClaudeCode CLI session using a generated API key. Verify that tools are discoverable and functional. *(AC-002, AC-007)*
- [ ] **T-7.2** [MANUAL]: Test Slack slash commands by configuring a Slack App with the webhook URL and verifying that `/symphony create-idea` and `/symphony status` commands work correctly. *(AC-005, AC-006)*
- [ ] **T-7.3** [MANUAL]: Verify API key one-time reveal UX: after creation the plaintext key is shown once in the `CreateApiKeySuccessDialog`, subsequent views only show the prefix, and the Done button is gated behind the acknowledgment checkbox. *(AC-008)*

## API & Data Impacts

### New Database Model

- `ApiKey` table: id (UUID), organizationId (FK), userId (FK), name, keyHash (SHA-256, indexed), keyPrefix (first 8 chars), expiresAt (nullable DateTime), lastUsedAt (nullable DateTime), createdAt, revokedAt (nullable DateTime)

### New API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api-keys` | Clerk JWT only | List API keys (own keys for users; all org keys for admins) |
| POST | `/api-keys` | Clerk JWT only | Generate new API key |
| DELETE | `/api-keys/:id` | Clerk JWT only | Revoke API key (org-scoped; returns 404 if not found) |
| POST | `/internal/api-keys/verify` | Internal network only | Verify plaintext key; returns VerifiedApiKeyContext |
| POST | `/artifacts/batch-create` | Clerk JWT or API Key | Bulk create artifacts |
| POST | `/projects/:id/generate-plans` | Clerk JWT or API Key | Generate plans for approved PRDs |
| POST | `/webhooks/slack` | Slack signing secret | Slack webhook endpoint |

### New MCP Tools

| Tool | Description |
|------|-------------|
| `list-projects` | List projects for authenticated org |
| `list-artifacts` | List artifacts with optional filters |
| `create-artifact` | Create a single artifact |
| `batch-create-artifacts` | Bulk create artifacts |
| `generate-plans` | Generate plans for approved PRDs in project |
| `get-project-status` | Get project details via projectsService.findById + calculateStatus |
| `get-artifact` | Get single artifact with content |

## Risks & Constraints

| Risk | Mitigation |
|------|------------|
| API key leakage in logs | Never log plaintext keys; only log keyPrefix for debugging |
| MCP SDK is relatively new | Use official `@modelcontextprotocol/sdk` with Streamable HTTP (stable since v1.10.0) |
| Slack webhook replay attacks | Check timestamp freshness (abs(now - X-Slack-Request-Timestamp) > 300s) before HMAC verification; verified in slackVerifyWebhookSignature utility |
| Bulk plan generation load | Process sequentially (not in parallel) inside artifactsService.batchRegenerateImplementationPlans() to avoid overwhelming GitHub Actions dispatch |
| Transaction nesting in batchCreate | Solved by extracting createArtifactRecord(tx, ...) private helper that both create() and batchCreate() call — no nested withDb.tx calls |

## Test Plan

- [ ] Unit: API key service (generate, hash, verify with revoked/expired key rejection, revoke with org scoping) with mocked database
- [ ] Unit: Slack webhook signature verification (timestamp check + HMAC) and handler routing
- [ ] Unit: Batch create artifacts validator (subtype required) and service method (transaction helper)
- [ ] Integration: MCP tool execution with mocked services
- [ ] E2E: Full flow from API key creation through MCP tool invocation (manual)


## Rollback

If the implementation causes issues, rollback steps are:

1. **API keys**: Drop the `ApiKey` table migration and remove the `withApiKeyAuth` middleware
2. **MCP server**: Delete `apps/mcp/` directory and remove from `turbo.json`
3. **Bulk endpoints**: Remove `/artifacts/batch-create` and `/projects/:id/generate-plans` routes
4. **Slack bot**: Remove Slack webhook routes and uninstall from workspace via Slack app settings
5. **Database migration**: Run `prisma migrate deploy` to roll back using Prisma's down migration if available, or manually drop new tables

## Open Questions

- [ ] Q-001: Should API keys have configurable expiry, or default to no-expiry with manual revocation? **[Recommended: Default to no-expiry; add optional expiresAt field for future use. Revocation is the primary lifecycle mechanism.]**
- [ ] Q-002: Should the MCP server be a standalone deployable (its own port) or embedded as routes within `apps/api`? **[Recommended: Standalone app at `apps/mcp` with its own port. This avoids mixing Clerk auth middleware with API key auth, and MCP Streamable HTTP has specific transport requirements.]** (BLOCKING T-4.1)
- [ ] Q-003: For Slack, should we support both slash commands and message-based interactions, or slash commands only for MVP? **[Recommended: Slash commands only for MVP. Two commands: `/symphony create-idea <project> <title>` and `/symphony status <project-or-artifact>`. Message-based interactions can be added later.]** (BLOCKING T-5.2)

## Gaps

- [ ] **GAP-001**: PRD does not specify which MCP tools should be exposed beyond "bulk operations on artifacts, reporting, and hooks." The plan assumes a reasonable set of CRUD + status tools based on the described use cases.
- [ ] **GAP-002**: PRD says "access keys... generated for an org by an admin OR for an individual" but does not clarify whether these are two distinct key scopes (org-wide service keys vs user-scoped keys) or just about who can create them. Plan assumes all keys are user-scoped (tied to the creating user's identity and org) and any authenticated user can create their own keys; admins can view all org keys.
- [ ] **GAP-003**: PRD does not specify the Slack slash command format or how the bot maps Slack users/workspaces to Symphony organizations. Plan assumes mapping via the existing `SlackIntegration.teamId` field and `User.slackId`.
- [ ] **GAP-004**: PRD mentions "reporting" via MCP but does not define what reports are available. Plan includes `get-project-status` as the primary reporting tool, which returns artifact counts by status.

## Visual References

No visual references attached.
