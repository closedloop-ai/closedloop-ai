# @repo/api — Shared API Contract Package

> **Agents:** also read `AGENTS.md` in this directory for coding patterns, security rules, and domain conventions.

This package is the single source of truth for types used by **both** `apps/app` (frontend) and `apps/api` (backend). It has no runtime server-only dependencies so it is safe to import in client components.

## Domain Glossary

### Team
A group of users with a shared pool of GitHub repositories. Defined in `src/types/teams.ts`. Each Team has a `TeamRole` (OWNER, ADMIN, MEMBER). Teams own repository pools (`TeamRepository`) which Projects inherit for job defaults. A Team can belong to multiple Projects and vice-versa.

### Project
A top-level organizational container for Workstreams, Artifacts (Documents, PRs, Deployments), and Repositories. Defined in `src/types/project.ts`. Has `ProjectStatus` (NOT_STARTED, IN_PROGRESS, COMPLETED, ARCHIVED) and optional repository override settings stored in the `settings` JSON column (`ProjectSettings`). Repository defaults are resolved via `resolveProjectRepoDefaults()` — single-team inheritance, project overrides, and legacy fallbacks.

### Workstream
A unit of AI-driven delivery work inside a Project (feature delivery, bug fix, tech debt, or spike). Defined in `src/types/workstream.ts`. Has an explicit lifecycle of `WorkstreamState` values (e.g., INITIATED → REQUIREMENTS_GENERATING → … → COMPLETED/CANCELLED). State transitions are recorded as `WorkstreamEvent` rows. A Workstream groups related Documents and Artifacts.

### Loop
A single AI agent execution run. Defined in `src/types/loop.ts`. A Loop runs a `LoopCommand` (e.g., plan, execute, chat, evaluate_prd) against an Artifact (typically a Document) on a `ComputeTarget`. Status flows through `LoopStatus` values sourced from `@closedloop-ai/loops-api/commands`. Loops emit typed `LoopEvent` objects (started, progress, output, completed, error, cancelled) consumed by the frontend SSE stream.

`LoopSummary` provides aggregated active/completed/failed state for a Document across its PRODUCES-linked descendants. `LoopUsageSummary` and `LoopUsageByCommand`/`LoopUsageByUser` power cost/usage dashboards.

### Workflow
A user-defined sequence of steps that orchestrates Loops and human approval gates. **Not the same as generated artifacts.** Workflows are stored separately from Documents; `@repo/api` does not define Workflow types — they live in `apps/api/` as backend-only entities. Do not confuse "workflow" with AI-generated output.

### Document
A primary artifact type with structured content (PRD, Implementation Plan, Feature spec, Template). Defined in `src/types/document.ts`. Key enums:

- `DocumentType`: PRD, IMPLEMENTATION_PLAN, FEATURE, TEMPLATE
- `DocumentStatus` (Documents: PRD, IMPLEMENTATION_PLAN, TEMPLATE): DRAFT, IN_REVIEW, CHANGES_REQUESTED, APPROVED, EXECUTED, OBSOLETE
- `FeatureStatus` (Features, subtype = FEATURE): TRIAGE, BACKLOG, TODO, IN_PROGRESS, IN_REVIEW, BLOCKED, DONE, CANCELED

Both vocabularies persist into the same freeform `Artifact.status` String column; the correct set is selected by the artifact's `subtype` via `statusOptionsForSubtype(subtype)` (SSOT in `@closedloop-ai/loops-api/document`). `TERMINAL_DOCUMENT_STATUSES` = {APPROVED, EXECUTED, OBSOLETE}; `TERMINAL_FEATURE_STATUSES` = {DONE, CANCELED}. See PRD-495.

`DocumentDetail` includes the latest `DocumentVersion` with full content. `GenerationStatus` tracks the current AI generation run (from a Loop) for a Document. Route prefixes for navigable document types are canonically defined in `TYPE_ROUTE_PREFIX` — do not duplicate this mapping elsewhere.

### Artifact
The parent concept covering Documents, Branches, and Deployments. Defined in `src/types/artifact.ts` using class-table-inheritance: one `Artifact` parent row with `type`-specific detail (`DocumentDetail`, `BranchDetail`, `PullRequestDetail`, `DeploymentDetail`). New branch-first surfaces should use `BranchDetail`; `PullRequestDetail` is optional nested GitHub PR state for a branch. Use the discriminated union `ArtifactWithDetail` and narrow on `type` to access detail fields. Type guards: `isDocumentArtifact()`, `isBranchArtifact()`, `isDeploymentArtifact()`.

`ArtifactLink` records directional relationships between Artifacts (`PRODUCES`, `BLOCKS`, `RELATES_TO`). Batch operations use `BatchMoveArtifactsInput`.

### Engineer Feature
The AI coding feature that spawns local CLI processes (Claude, git, codex) on a user's machine. The frontend routes `/api/gateway/*` requests through either the LocalElectron path or the CloudRelay path, selected by `EngineerRoutingMode` (defined in `src/types/relay.ts`). `@repo/api` exposes the routing mode enum and the desktop API namespace helpers (`src/desktop-api-namespace.ts`) that recognize only the current `/api/gateway/*` path prefix.

**Security**: the proxy guard in `apps/app/proxy.ts` rejects non-localhost gateway requests with 403. Do not reimplement gateway operations in `apps/app` or `apps/api`.

### Desktop Gateway
The Desktop gateway in `apps/desktop` runs locally and executes gateway operations (file I/O, git, CLI spawning). Identified by a `gatewayId` on the `ComputeTarget` record. The API contract for registering, heartbeating, and dispatching commands to the gateway is in `src/types/compute-target.ts`. Desktop API path recognition is in `src/desktop-api-namespace.ts`. The supported namespace is `gateway` (`/api/gateway/`); the stale `engineer` namespace (`/api/engineer/`) is intentionally unsupported.

### Relay
The cloud compute path for the Engineer feature. When the Desktop Gateway is unavailable, the fetch interceptor routes requests to `/api/gateway-relay/*` which forwards them to the remote compute target. The `EngineerRoutingMode` enum in `src/types/relay.ts` discriminates between `LocalElectron` and `CloudRelay` routing. Relay operation dispatch and result ingestion shapes are in `src/types/compute-target.ts` (`RelayOperationDispatchRequest`, `RelayResultIngestRequest`).

### MCP
Model Context Protocol — the local server interface used by AI agents (Claude, Codex) to communicate with the Closedloop platform during a Loop run. Health check results (`HealthCheckResponse`, `CheckResult`, `McpProviderAvailability`) in `src/types/compute-target.ts` report whether MCP servers are accessible. The `NeutralMcpProviderAvailability` shape covers both Claude and Codex MCP providers.
