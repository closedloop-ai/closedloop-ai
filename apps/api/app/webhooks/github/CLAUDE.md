# GitHub Webhook Handler

This directory contains the GitHub webhook handler for Symphony's GitHub App integration. The handler processes incoming webhook events from GitHub, including installation management and workflow run events.

## Architecture Overview

The webhook handler follows a **route → service → handler** pattern:

```
POST /webhooks/github (route.ts)
    ↓ validates signature
    ↓ routes by event type
    ↓
webhook-service.ts (validation utilities)
    ↓
handlers/ (event-specific logic)
    ├── installation-handler.ts
    ├── installation-repositories-handler.ts
    ├── workflow-run-handler.ts (orchestrator)
    ├── workflow-status-handler.ts
    ├── workflow-completion-handler.ts
    └── workflow-artifacts.ts (S3 upload logic)
    ↓
zip-parser.ts (artifact extraction)
```

## File Structure

### Core Files

- **`route.ts`** - HTTP entry point. Handles:
  - Signature verification via `verifyWebhookSignature()`
  - Event type routing (installation, installation_repositories, workflow_run)
  - Configuration checks (`isGitHubConfigured()`, `isS3Configured()`)
  - Response formatting

- **`types.ts`** - Shared type definitions:
  - `WorkflowContext` - Extracted context from correlation ID and workflow data
  - `WorkflowRunEvent` - Union type for workflow_run events we process

- **`webhook-service.ts`** - Shared validation utilities:
  - `isGitHubConfigured()` - Check required env vars
  - `isS3Configured()` - Check S3 credentials
  - `validateRequest()` - Extract body, signature, event type from request
  - `findActionRunByCorrelationId()` - Query GitHubActionRun by correlation ID

- **`zip-parser.ts`** - Generic zip extraction engine:
  - `findContentInZip()` - Iterates zip entries through the extractor registry, returns a `ZipContentBag`
  - Priority system: when two extractors share a key (e.g. `plan.json` vs `implementation-plan.md`), higher priority wins regardless of zip entry order

- **`extractors/`** - Open-Closed extractor registry (see [Adding a New Report Type](#adding-a-new-report-type)):
  - `types.ts` - `ZipContentExtractor<T>` protocol, `ContentKey<T>` branded type, `ZipContentBag` class
  - `keys.ts` - `CONTENT_KEYS` constant — typed keys for all known content slots
  - `registry.ts` - `ZIP_CONTENT_EXTRACTORS` static array — the single place to register extractors
  - One file per extractor: `plan-extractor.ts`, `questions-extractor.ts`, `execution-result-extractor.ts`, `judges-report-extractor.ts`, `code-judges-report-extractor.ts`, `perf-summary-extractor.ts`

### Handler Directory (`handlers/`)

Event-specific handlers that implement business logic:

#### Installation Events

- **`installation-handler.ts`** - Handles GitHub App installation lifecycle:
  - `handleInstallationCreated()` - Upserts installation, preserves org link if not UNINSTALLED
  - `handleInstallationDeleted()` - Marks installation as UNINSTALLED, clears organizationId
  - `handleInstallationSuspended()` - Sets SUSPENDED status, records suspendedAt/suspendedBy
  - `handleInstallationUnsuspended()` - Restores status (ACTIVE/PENDING_CLAIM/UNINSTALLED)
  - `toRepositoryInput()` - Utility to convert webhook repo data to RepositoryInput format

- **`installation-repositories-handler.ts`** - Handles repository changes:
  - `handleInstallationRepositoriesAdded()` - Syncs newly added repositories
  - `handleInstallationRepositoriesRemoved()` - Removes repositories by githubRepoId

#### Workflow Events

- **`workflow-run-handler.ts`** - Main orchestrator for workflow_run events:
  - Validates workflow path (only processes `symphony-dispatch`)
  - Extracts correlation ID from workflow run name
  - Checks environment via `isCurrentEnvironment()`
  - Routes by action: `requested` / `in_progress` → status handler, `completed` → completion handler

- **`workflow-status-handler.ts`** - Handles status updates (requested, in_progress):
  - Maps `requested` → QUEUED status
  - Maps `in_progress` → RUNNING status (sets startedAt)
  - Updates GitHubActionRun record with runId, status, htmlUrl

- **`workflow-completion-handler.ts`** - Handles completed workflows:
  - **`processWorkflowCompletion()`** - Entry point, finds GitHubActionRun by correlation ID
  - **`handleWorkflowSuccess()`** - Downloads artifacts, updates Artifact record:
    - For `execute` command: delegates to `handleExecutionSuccess()`
    - For other commands: updates artifact content/status, creates workstream event
    - Persists judges report if available (via `ArtifactEvaluation` table)
  - **`handleWorkflowFailure()`** - Creates workstream event (NEVER overwrites artifact content)
  - **`handleExecutionSuccess()`** - Creates GitHubPullRequest and Artifact (type: PullRequest) records
  - Uses `withDb.tx()` transaction to ensure artifact content and status update atomically

- **`workflow-artifacts.ts`** - Pure parsing + S3 upload logic (extracted from completion handler):
  - **`processArtifactUploads()`** - Downloads artifacts from GitHub, orchestrates parsing, returns `{ bag: ZipContentBag, artifactKeys }`
  - **`processArtifactZip()`** - Handles nested zips (GitHub wraps artifacts, Symphony may also zip), merges bags via `bag.mergeFrom()`
  - **`uploadEntriesToS3()`** - Uploads extracted files to S3 with `plans/{correlationId}/` prefix

## Event Flow

### Installation Flow

```
GitHub App installed/modified
    ↓
POST /webhooks/github
    ↓ signature verification
    ↓ parse event type: "installation"
    ↓
handlers/installation-handler.ts → handleInstallation()
    ├── created   → upsertInstallation(), syncRepositories()
    ├── deleted   → mark UNINSTALLED, clear organizationId
    ├── suspend   → set SUSPENDED status
    └── unsuspend → restore status based on current state
```

### Workflow Run Flow

```
Symphony workflow triggered (symphony-dispatch)
    ↓
POST /webhooks/github
    ↓ signature verification
    ↓ parse event type: "workflow_run"
    ↓
route.ts → handleWorkflowRun()
    ↓ validate workflow path (symphony-dispatch only)
    ↓ extract correlation ID from run name
    ↓ check environment
    ↓
Route by action:
    ├── requested   → workflow-status-handler.ts (QUEUED)
    ├── in_progress → workflow-status-handler.ts (RUNNING)
    └── completed   → processWorkflowCompletion()
                         ├── Download artifacts via GitHub API
                         ├── Extract content via zip-parser.ts
                         ├── success → handleWorkflowSuccess()
                         │              ├── execute → handleExecutionSuccess()
                         │              └── other   → update Artifact content/status
                         └── failure → handleWorkflowFailure()
```

## Key Patterns

### Correlation ID

The **correlation ID** is the primary identifier for tracking Symphony workflow executions. It:
- Is stored in `GitHubActionRun.triggerData.correlationId` (JSON field)
- Encodes: environment, artifactId, workstreamId, timestamp
- Is extracted from `workflow_run.name` (GitHub workflow YAML sets `run-name: ${{ inputs.correlation_id }}`)
- Is parsed via `parseCorrelationId()` from `@repo/github`

**Finding action runs:**
```typescript
const actionRuns = await withDb((db) =>
  db.gitHubActionRun.findMany({
    where: { workflowName: "symphony-dispatch", status: { in: ["PENDING", "QUEUED", "RUNNING"] } },
    orderBy: { createdAt: "desc" },
    take: 50,
  })
);

// Manual JSON filter since Prisma doesn't support Json path indexes
const actionRun = actionRuns.find((run) => {
  const data = run.triggerData as { correlationId?: string } | null;
  return data?.correlationId === correlationId;
});
```

### Artifact Content Updates

**IMPORTANT:** Webhook handlers NEVER overwrite artifact content with error messages. On failure:
- GitHubActionRun status is set to FAILURE
- Workstream event is created with error details
- UI shows failure via status banner
- Artifact content remains unchanged (preserves user's work)

On success:
- Artifact content is updated from downloaded workflow artifacts
- Status is set to DRAFT
- Transaction ensures content and status update atomically

### Transaction Usage

The completion handler uses `withDb.tx()` to ensure atomic updates:
```typescript
await withDb.tx(async (tx) => {
  // 1. Process result (updates artifact content)
  await handleWorkflowSuccess(ctx, s3Configured);

  // 2. Update GitHubActionRun status (done last so frontend sees content first)
  await tx.gitHubActionRun.update({ ... });
});
```

This prevents race conditions where the frontend sees SUCCESS status before content is ready.

### Zip Extraction: Extractor Registry Pattern

The zip extraction pipeline follows the **Open-Closed Principle** — new content types are added by creating an extractor and registering it, without modifying the engine.

**Core concepts:**

- `ZipContentExtractor<T>` — protocol with `key`, `priority`, `matches(entryName)`, `parse(data, entryName)`
- `ZipContentBag` — typed heterogeneous result container; use `bag.get(CONTENT_KEYS.xxx)` to retrieve results
- `ContentKey<T>` — branded string token that carries the result type at compile time

**How extraction works:**

```typescript
// findContentInZip iterates entries through the registry
const { bag, entries } = findContentInZip(zip);

// Access results with full type safety
const plan: string | null = bag.get(CONTENT_KEYS.planContent);
const judges: JudgesReport | null = bag.get(CONTENT_KEYS.judgesReport);
```

**Priority system:** When two extractors share the same key (e.g. `plan.json` priority 10 vs `implementation-plan.md` priority 5), the higher priority wins regardless of zip entry order. This is an improvement over a first-match approach.

**Double-zip handling:** GitHub artifacts are double-zipped (GitHub wraps, Symphony may also zip). `processArtifactZip` in `workflow-artifacts.ts` handles both layers, merging bags via `bag.mergeFrom()` (highest priority wins per key across inner zips).

## Testing

**Test Location:** `apps/api/__tests__/unit/`

Unit tests exist for all webhook handlers, using mocked database and external dependencies:

| Test File | Covers |
|-----------|--------|
| `webhook-service.test.ts` | Validation utilities (config checks, request parsing) |
| `webhook-installation.test.ts` | Installation lifecycle (created, deleted, suspended, unsuspended) |
| `webhook-installation-repositories.test.ts` | Repository sync (added, removed) |
| `webhook-workflow-run.test.ts` | Workflow run routing and validation |
| `webhook-workflow-status.test.ts` | Status updates (requested → QUEUED, in_progress → RUNNING) |
| `webhook-workflow-completion.test.ts` | Completion handling (success/failure, artifact download, PR creation) |
| `webhook-zip-parsing.test.ts` | ZIP parsing (plan extraction, judges report, nested zips) |

Run webhook tests:
```bash
pnpm turbo test --filter=api -- --grep webhook
```

## Adding a New Report Type

Steps 1, 2, 4 are purely additive (new files only). Steps 3 and 5 touch existing files (`types.ts` and `registry.ts` respectively). Step 6 is the persistence wiring in the handler.

### 1. Define the TypeScript type

```typescript
// packages/api/src/types/coverage.ts
export type CoverageReport = {
  totalCoverage: number;
  fileCoverage: { file: string; coverage: number }[];
};
```

### 2. Add a typed key

```typescript
// apps/api/app/webhooks/github/extractors/keys.ts
import type { CoverageReport } from "@repo/api/src/types/coverage";

export const CONTENT_KEYS = {
  // ... existing keys
  coverageReport: contentKey<CoverageReport>("coverageReport"),
} as const;
```

### 3. Extend `ExtractorOutputType` and `AnyZipContentExtractor`

```typescript
// apps/api/app/webhooks/github/extractors/types.ts
export const ExtractorOutputType = {
  // ... existing entries
  CoverageReport: "CoverageReport",
} as const;

// Add to AnyZipContentExtractor union:
export type AnyZipContentExtractor =
  | ZipContentExtractor<CoverageReport, typeof ExtractorOutputType.CoverageReport>
  | /* ... existing members */;
```

### 4. Create an extractor file

```typescript
// apps/api/app/webhooks/github/extractors/coverage-extractor.ts
import type { CoverageReport } from "@repo/api/src/types/coverage";
import { log } from "@repo/observability/log";
import { CONTENT_KEYS } from "./keys";
import { ExtractorOutputType } from "./types";
import type { ZipContentExtractor } from "./types";

export const coverageExtractor: ZipContentExtractor<CoverageReport, typeof ExtractorOutputType.CoverageReport> = {
  key: CONTENT_KEYS.coverageReport,
  outputType: ExtractorOutputType.CoverageReport,
  priority: 0,

  matches(entryName: string): boolean {
    return entryName.endsWith("coverage-report.json");
  },

  parse(data: Buffer, entryName: string): CoverageReport | null {
    try {
      const result = JSON.parse(data.toString("utf-8")) as CoverageReport;
      log.info(`Found coverage report: ${entryName}`);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      log.error(`Failed to parse coverage-report.json: ${message}`);
      return null;
    }
  },
};
```

### 5. Register the extractor

```typescript
// apps/api/app/webhooks/github/extractors/registry.ts
import { coverageExtractor } from "./coverage-extractor";

export const ZIP_CONTENT_EXTRACTORS: AnyZipContentExtractor[] = [
  // ... existing extractors
  coverageExtractor,
];
```

### 6. Consume in handleWorkflowSuccess

```typescript
// apps/api/app/webhooks/github/handlers/workflow-completion-handler.ts

const coverageReport = bag.get(CONTENT_KEYS.coverageReport);

if (coverageReport && ctx.actionRunId) {
  await tx.artifactCoverage.upsert({ ... });
}
```

---

## Adding a New Event Handler

Follow this checklist when adding support for a new GitHub webhook event:

### 1. Create Handler File

```bash
touch apps/api/app/webhooks/github/handlers/new-event-handler.ts
```

Structure:
```typescript
import type { NewEventType } from "@octokit/webhooks-types";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";

/**
 * Handle GitHub [event name] event.
 * [Brief description of what this handler does]
 */
export async function handleNewEvent(event: NewEventType): Promise<void> {
  const { /* extract relevant fields */ } = event;

  log.info("[handleNewEvent] Processing event", {
    // log key identifiers
  });

  // Business logic here (database operations, external API calls)
  await withDb((db) => {
    // ...
  });

  log.info("[handleNewEvent] Successfully processed event");
}
```

### 2. Add Event Type to Route

Edit `route.ts` to import and call your handler:

```typescript
// Add import
import { handleNewEvent } from "./handlers/new-event-handler";

// Add case to switch statement
case "new_event": {
  const event = parsedBody as NewEventType;
  await handleNewEvent(event);
  return NextResponse.json({
    message: "Event processed successfully",
    ok: true,
  });
}
```

### 3. Update Types (if needed)

If the event requires shared context:

```typescript
// types.ts
export type NewEventContext = {
  eventId: string;
  // other fields
};
```

### 4. Add Tests

Create corresponding test file in `apps/api/__tests__/unit/`:

```bash
touch apps/api/__tests__/unit/webhook-new-event.test.ts
```

Follow the existing test patterns (mock `@repo/database`, `@repo/github`, etc.):
```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("@repo/database", () => ({ withDb: vi.fn() }));

import { handleNewEvent } from "../../app/webhooks/github/handlers/new-event-handler";

describe("handleNewEvent", () => {
  it("should process valid event", async () => {
    const event = { /* mock event data - include ALL required fields */ };
    await handleNewEvent(event);
    // assertions
  });

  it("should handle missing data gracefully", async () => {
    // test error cases
  });
});
```

### 5. Update Webhook Configuration

Ensure the GitHub App is configured to send the new event:
1. Go to GitHub App settings
2. Navigate to "Webhook" section
3. Check the box for the new event type
4. Save configuration

### 6. Test Locally

Use ngrok to test webhooks locally (see `~/Workspace/symphony-alpha-AI-248/CLAUDE.md` for setup):

```bash
# Start ngrok
ngrok http 3002

# Configure repo-level webhook with ngrok URL
# Trigger event in GitHub
# Verify logs in API server terminal
```

## Environment Variables

Required environment variables (validated in `webhook-service.ts`):

```bash
# GitHub App Configuration
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
GITHUB_APP_WEBHOOK_SECRET="your-webhook-secret"
GITHUB_APP_DISPATCH_REPO="owner/repo"

# Optional: S3 Storage (for artifact uploads)
AWS_ACCESS_KEY_ID="AKIA..."
AWS_SECRET_ACCESS_KEY="..."
S3_BUCKET_NAME="bucket-name"
```

If GitHub is not configured, the webhook endpoint returns early with `{ ok: false, message: "GitHub not configured" }`.

If S3 is not configured, artifacts are still processed (content extracted and stored in database), but files are not uploaded to S3.

## Debugging

### Check Server Logs

Webhook errors are logged server-side, not returned to client. Always check the API server terminal (port 3002) for detailed error information:

```typescript
// webhook-service.ts logs configuration
log.info("[webhook/github] Received webhook request");
log.warn("[webhook/github] GitHub not configured, rejecting request");

// Handler logs include correlation IDs and identifiers
log.info("[handleWorkflowRun] Processing workflow", {
  runId: event.workflow_run.id,
  correlationId,
  conclusion: event.workflow_run.conclusion,
});
```

### Common Issues

**Signature verification fails:**
- Check `GITHUB_APP_WEBHOOK_SECRET` matches GitHub App settings
- Ensure request body is passed as raw string (not parsed JSON)

**GitHubActionRun not found:**
- Verify correlation ID format via `parseCorrelationId()`
- Check environment prefix in correlation ID matches `WEBAPP_ENV`
- Ensure GitHubActionRun was created before workflow triggered

**Artifact content not updating:**
- Check workflow artifacts were uploaded successfully in GitHub Actions
- Verify S3 bucket permissions if `uploadToS3=true`
- Inspect zip-parser logs for extraction issues

**Transaction errors:**
- The `withDb.tx()` implementation does NOT store transactions in AsyncLocalStorage
- Nested `withDb()` calls inside a transaction open separate connections
- Avoid calling service methods that use `withDb()` from within transaction callbacks

## Related Documentation

- **Parent directory CLAUDE.md:** `/apps/api/CLAUDE.md` (API route conventions)
- **GitHub integration service:** `/apps/api/app/integrations/github/service.ts`
- **GitHub utilities package:** `/packages/github/`
- **Artifact types:** `/packages/api/src/types/artifact.ts`
- **Prisma schema:** `/packages/database/prisma/schema.prisma` (GitHubActionRun, GitHubPullRequest models)
