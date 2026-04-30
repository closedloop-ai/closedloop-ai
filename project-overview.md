# Product Context Report

Generated: 2026-02-09
Repository: symphony-alpha (Next.js monorepo on next-forge template)

---

## Project Summaries

| Project | Purpose | Type | Tech Stack |
|---------|---------|------|------------|
| **apps/app** | Main authenticated application - dashboard, artifact editor, team/project management | Frontend SPA | Next.js 16, React 19, TanStack Query, TipTap, Tailwind CSS |
| **apps/api** | Backend-for-Frontend API server - all database operations, webhook handling, service integrations | Backend API | Next.js 16 (API routes), Prisma, Zod, Svix, adm-zip |
| **apps/web** | Marketing/public website with home, pricing, and contact pages | Marketing Site | Next.js 16, Tailwind CSS, MDX, i18n |
| **apps/docs** | Documentation site | Documentation | Mintlify |
| **apps/email** | Email template preview environment | Dev Tooling | React Email |
| **apps/storybook** | Component library development environment | Dev Tooling | Storybook |
| **apps/studio** | Prisma Studio for database browsing | Dev Tooling | Prisma Studio |
| **packages/database** | Prisma ORM client, schema, migrations (PostgreSQL) | Shared Library | Prisma 7, PostgreSQL 16, Neon (prod) |
| **packages/api** | Shared API type definitions between frontend and backend | Shared Types | TypeScript |
| **packages/auth** | Authentication wrapper (Clerk) | Shared Library | Clerk |
| **packages/ai** | AI integration - PRD generation agent with Anthropic models | Shared Library | AI SDK, Anthropic (@ai-sdk/anthropic), Claude Opus 4.5 / Sonnet 4.5 |
| **packages/github** | GitHub App integration - workflow dispatch, webhook verification, repo management | Shared Library | Octokit, GitHub App Auth |
| **packages/linear** | Linear integration - OAuth, issue sync, task extraction with LLM | Shared Library | Linear SDK, AI |
| **packages/payments** | Stripe subscription management | Shared Library | Stripe 20 |
| **packages/design-system** | UI component library (Shadcn/ui) | Shared Library | Radix UI, Tailwind CSS |
| **packages/rich-text** | Rich text editor for document artifacts | Shared Library | TipTap 3, Mermaid diagrams |
| **packages/collaboration** | Real-time collaboration on documents | Shared Library | Liveblocks, Yjs |
| **packages/analytics** | Web and product analytics | Shared Library | PostHog, Google Analytics, Vercel Analytics |
| **packages/observability** | Structured logging with agentless Datadog export | Shared Library | Custom (Datadog HTTP intake) |
| **packages/security** | Application security - security headers | Shared Library | Nosecone |
| **packages/aws** | AWS S3 operations for artifact storage | Shared Library | AWS SDK v3, S3, pre-signed URLs |
| **packages/feature-flags** | Feature flag management | Shared Library | Vercel Flags, PostHog |
| **packages/notifications** | In-app notification system | Shared Library | Knock |
| **packages/webhooks** | Inbound/outbound webhook handling | Shared Library | Svix |
| **packages/storage** | File upload and management | Shared Library | Vercel Blob |
| **packages/email** | Transactional email templates | Shared Library | Resend |
| **packages/cms** | Content management for marketing site | Shared Library | BaseHub |
| **packages/seo** | Metadata, sitemaps, JSON-LD | Shared Library | Custom |
| **packages/internationalization** | Multi-language support | Shared Library | Custom |

---

## System Overview

ClosedLoop is a human-governed, AI-centric software delivery platform built as a Next.js monorepo. The system serves the entire software delivery team -- product managers, designers, engineers, and QA -- by orchestrating AI agents to generate delivery artifacts (PRDs, implementation plans, code, test reports) while preserving human judgment through explicit approval gates at each stage.

The platform follows a three-tier architecture: a React frontend (`apps/app`) communicates exclusively through a BFF API layer (`apps/api`) which handles authentication, business logic, and database operations. AI-powered execution happens off-platform through GitHub Actions workflows dispatched from the API, with results flowing back via GitHub webhooks. This hybrid architecture ensures source code never leaves customer infrastructure while the cloud-based control plane manages workflows and approvals.

The core workflow is: a user creates a PRD or Issue (optionally with AI assistance), generates an Implementation Plan via a GitHub Actions workflow (powered by Claude Code), reviews and approves it, then executes the plan which produces a Pull Request on the target repository. Throughout this lifecycle, artifacts are versioned, comments and approvals are tracked, and integrations with Linear (project management) and Slack (notifications) keep the broader team informed.

---

## Detailed Project Descriptions

### apps/app (Main Application)

**Purpose:** The primary user-facing application where teams manage projects, create and edit artifacts, review plans, and track delivery progress across workstreams.

**User-Facing Features:**
- **Dashboard** - Recent workstreams grid showing active delivery initiatives
- **PRD Editor** - Rich text editor (TipTap + Liveblocks collaboration) for creating and editing Product Requirements Documents, with AI-assisted generation via conversational agent
- **Issue/Bug Editor** - Structured document editor for issues and bug reports with template support
- **Implementation Plan Viewer** - Displays AI-generated plans with acceptance criteria, tasks, open questions, and gaps; supports plan regeneration and change requests
- **Plan Execution** - One-click execution of approved plans that triggers code generation via GitHub Actions and creates Pull Requests
- **Workstreams (Initiatives)** - State-machine-driven delivery tracking from INITIATED through COMPLETED with 17 distinct states
- **Projects** - Organize work under projects with team assignments, priority, target dates, and linked repositories
- **Teams & Members** - Multi-team structure with OWNER/ADMIN/MEMBER roles; team-to-project associations
- **Settings** - Profile management, organization settings, admin controls, and integration configuration (GitHub, Linear)
- **Search** - Cross-entity search via Fuse.js
- **Organization Switching** - Multi-org support with TanStack Query cache invalidation on switch
- **Real-time Collaboration** - Live cursors and concurrent editing on document artifacts via Liveblocks
- **Generation Status Polling** - Real-time status tracking for in-progress AI generation workflows
- **Execution Logs** - View detailed agent conversation logs from completed GitHub Actions runs
- **Judges/Evaluation Feedback** - View quality evaluation reports for generated artifacts
- **Artifact Versioning** - Full version history for all document artifacts with version navigation
- **Template Management** - Organization-level templates for PRDs, Issues, and Bug reports

**Architecture:**
- Next.js 16 App Router with server components (default) and client components (`"use client"`)
- All data access via TanStack Query hooks (`hooks/queries/use-*.ts`) calling the BFF API
- No direct database imports -- strict separation enforced by convention
- Route groups: `(authenticated)` for logged-in users, `(unauthenticated)` for sign-in/sign-up
- Clerk for authentication with mounted-state hydration guard pattern

**Frontend Routes:**
| Route | Description |
|-------|-------------|
| `/` | Dashboard with recent workstreams |
| `/prds` | PRD list view |
| `/prds/[slug]` | PRD editor (rich text + metadata panel) |
| `/implementation-plans` | Implementation plans list |
| `/implementation-plans/[slug]` | Plan viewer with regenerate/execute/request-changes |
| `/issues/[slug]` | Issue editor |
| `/workstreams` | Workstream list |
| `/workstreams/[id]` | Workstream detail with artifacts and activity |
| `/projects` | Projects list |
| `/teams/[teamId]/projects` | Team projects view |
| `/teams/[teamId]/projects/[projectId]` | Project detail |
| `/members` | Organization members |
| `/organization` | Organization settings |
| `/settings` | Settings (profile, org, admin, integrations) |
| `/search` | Global search |
| `/webhooks` | Webhook management |

---

### apps/api (BFF API Server)

**Purpose:** Backend-for-Frontend API handling all database operations, authentication, webhook processing, and external service integration. Runs on port 3002.

**API Surface:**

| Endpoint | Methods | Description |
|----------|---------|-------------|
| `/health` | GET | Health check |
| `/me` | GET | Current authenticated user |
| `/artifacts` | GET, POST | List/create artifacts (filtered by type, category, project, workstream) |
| `/artifacts/[id]` | GET, PUT, DELETE | Get/update/delete artifact |
| `/artifacts/[id]/execute` | POST | Execute an approved implementation plan (triggers GitHub Actions) |
| `/artifacts/[id]/regenerate` | POST | Regenerate an implementation plan |
| `/artifacts/[id]/request-changes` | POST | Request amendments to a plan (chat workflow) |
| `/artifacts/[id]/generation-status` | GET | Poll for GitHub Actions workflow status |
| `/artifacts/[id]/execution-log` | GET | Retrieve agent execution logs |
| `/artifacts/[id]/judges` | GET | Retrieve quality evaluation feedback |
| `/artifacts/[id]/pull-request` | GET | Get associated PR info |
| `/artifacts/[id]/new-version` | POST | Create new artifact version |
| `/projects` | GET, POST | List/create projects |
| `/projects/[id]` | GET, PUT, DELETE | Get/update/delete project |
| `/projects/[id]/activity` | GET | Project activity feed |
| `/workstreams` | GET, POST | List/create workstreams (initiatives) |
| `/workstreams/[id]` | GET, PUT, DELETE | Get/update/delete workstream |
| `/workstreams/[id]/artifacts` | GET | List artifacts for a workstream |
| `/teams` | GET, POST | List/create teams |
| `/teams/[teamId]` | GET, PUT, DELETE | Get/update/delete team |
| `/teams/[teamId]/members` | GET, POST | List/add team members |
| `/teams/[teamId]/members/[userId]` | PUT, DELETE | Update/remove team member |
| `/users` | GET | List organization users |
| `/users/[id]` | GET, PUT | Get/update user |
| `/organizations/[id]` | GET, PUT | Get/update organization |
| `/templates` | GET | List templates |
| `/templates/[type]` | GET, PUT | Get/update template by type |
| `/templates/seed` | POST | Seed default templates |
| `/integrations/github` | GET, DELETE | GitHub integration status / disconnect |
| `/integrations/github/connect` | GET | GitHub OAuth callback |
| `/integrations/github/repositories` | GET | List GitHub repositories |
| `/integrations/github/repositories/[id]/branches` | GET | List repository branches |
| `/integrations/linear` | GET, DELETE | Linear integration status / disconnect |
| `/integrations/linear/connect` | POST | Linear OAuth callback |
| `/integrations/linear/export` | POST | Export plan tasks to Linear issues |
| `/ai/prd` | POST | AI-assisted PRD generation (streaming) |
| `/webhooks/auth` | POST | Clerk auth webhooks (user/org lifecycle) |
| `/webhooks/github` | POST | GitHub App webhooks (installation, workflow runs) |
| `/webhooks/payments` | POST | Stripe payment webhooks |
| `/collaboration/auth` | POST | Liveblocks authentication |
| `/cron/keep-alive` | GET | Keep-alive cron job |

**Authentication:** All routes (except webhooks and health) use `withAnyAuth()` HOF that accepts either an API key (`sk_live_*`) or Clerk JWT, extracts userId and orgId, and auto-creates user/organization records on first access. Organization-scoped queries ensure data isolation.

**Service Layer:** Business logic is separated into service modules:
- `artifactsService` - Artifact CRUD, versioning, GitHub workflow orchestration, execution logs, judge feedback
- `workstreamsService` - Workstream lifecycle management
- `projectsService` - Project management with team associations
- `teamsService` - Team CRUD with member role management
- `usersService` - User management with multi-org support
- `organizationsService` - Organization management
- `githubService` - GitHub installation management, repository operations
- `linearService` - Linear OAuth, issue sync, task export

---

### apps/web (Marketing Website)

**Purpose:** Public-facing marketing site with home page, pricing, and contact form. Supports internationalization (i18n) with locale-based routing.

**Pages:** Home, Pricing, Contact
**Live URLs (production):** app.closedloop.ai, marketing.closedloop.ai, api.closedloop.ai

---

### packages/database (Database Layer)

**Data Model (Core Entities):**

```
Organization (multi-tenant root)
  |-- Users (one User record per Clerk user per org)
  |-- Teams
  |   |-- TeamMembers (with roles: OWNER, ADMIN, MEMBER)
  |   |-- ProjectTeams (many-to-many)
  |-- Projects (with priority, target date, codebase summary)
  |   |-- Repositories (GitHub repos linked to project)
  |   |-- Workstreams (delivery initiatives)
  |   |   |-- WorkstreamEvents (audit log)
  |   |   |-- Artifacts (versioned documents)
  |   |   |-- GitHubPullRequests
  |   |   |-- GitHubActionRuns
  |   |   |-- Comments
  |   |   |-- Conversations / Messages
  |   |-- Artifacts (also directly on project)
  |-- GitHubInstallation (one per org)
  |   |-- GitHubInstallationRepositories
  |-- LinearIntegration (one per org)
  |-- SlackIntegration (one per org)
```

**Key Design Decisions:**
- Multi-tenant with Organization as the root entity
- Multi-org user model: one User record per Clerk user per organization
- Artifact versioning via `version` + `isLatest` + `documentSlug` pattern
- Workstream state machine with 17 states tracking the full delivery lifecycle
- Artifact types cover the full delivery lifecycle: PRD, Issue, Bug, Implementation Plan, Implementation Strategy, Code Review Report, Visual QA Report, Accessibility Report, Test Report, Completion Summary, Pull Request, Template
- Artifact categories: Document, Workflow, Branch
- Templates are stored as artifacts with `type=TEMPLATE` and `templateForType` referencing the target type
- JSON fields for flexible data: `settings`, `metrics`, `triggerData`, `tokenUsage`, `reportData`
- Parent-child artifact relationships for traceability (e.g., PRD -> Implementation Plan)
- ArtifactEvaluation table for judge/quality reports linked to artifacts and action runs

**Database:**
- PostgreSQL 16 (local via Docker, production via Neon)
- Prisma 7 ORM with explicit migrations
- Prisma relation mode for cross-database compatibility
- 5 migrations as of 2026-02-09

---

## System Integration

### Inter-Project Communication

The system follows a strict BFF pattern:

```
Browser (apps/app)
    |
    | HTTP (REST JSON)
    v
API Server (apps/api, port 3002)
    |
    | Prisma Client
    v
PostgreSQL (packages/database)
```

External service communication:
```
API Server (apps/api)
    |
    |-- GitHub API (Octokit) --> GitHub App Webhooks --> API Server
    |-- Linear API (SDK) <--> Linear OAuth
    |-- Stripe API (SDK) <--> Stripe Webhooks --> API Server
    |-- Clerk API <--> Clerk Webhooks --> API Server
    |-- Liveblocks API --> Real-time collaboration
    |-- AWS S3 --> Artifact file storage
    |-- Anthropic API --> AI generation (PRD agent)
    |-- PostHog --> Analytics
    |-- Knock --> Notifications
    |-- Resend --> Email
```

### Async Execution Architecture (GitHub Actions)

The most distinctive integration pattern is the GitHub Actions-based execution pipeline:

1. **Trigger:** User clicks "Generate" or "Execute" in `apps/app`
2. **API dispatches:** `apps/api` calls `triggerWorkflowDispatch()` from `packages/github`, which dispatches to a `symphony-dispatch.yml` workflow on the `closedloop-ai/claude_code` repository
3. **Execution:** GitHub Actions runs Claude Code agents on the target repository (plan generation, code execution)
4. **Callback:** GitHub webhook (`workflow_run.completed`) hits `/webhooks/github` on `apps/api`
5. **Processing:** API downloads workflow artifacts (zip files from GitHub Actions), parses plan content, uploads to S3, updates database
6. **Notification:** Frontend polls `generation-status` endpoint and displays results

### Shared Dependencies

| Package | Used By |
|---------|---------|
| `@repo/api` (types) | `apps/app`, `apps/api`, `packages/github`, `packages/linear` |
| `@repo/auth` | `apps/app`, `apps/api`, `apps/web`, `packages/feature-flags`, `packages/webhooks` |
| `@repo/database` | `apps/api` only (enforced by convention) |
| `@repo/design-system` | `apps/app`, `apps/web`, `packages/rich-text`, `packages/feature-flags` |
| `@repo/observability` | `apps/app`, `apps/api`, `packages/github`, `packages/linear` |
| `@repo/analytics` | `apps/app`, `apps/api`, `apps/web`, `packages/feature-flags` |

---

## Security Considerations

### Authentication & Authorization

- **Authentication:** Clerk (SSO, social login, email/password, MFA supported via Clerk)
- **Session management:** Clerk JWT tokens, validated server-side in API via `auth()` from `@repo/auth/server`
- **Organization isolation:** All database queries are scoped by `organizationId`. The `withAnyAuth()` wrapper extracts orgId from either API key or JWT and enforces this on every API route.
- **Role-based access:** Clerk organization roles (`org:admin`, `org:member`) gate admin-only features in the frontend (Settings > Admin tab uses `<Protect role="org:admin">`). Backend does not yet enforce granular role-based permissions beyond org membership.
- **Team roles:** OWNER, ADMIN, MEMBER at the team level (stored in database, used for display; enforcement is a TODO)
- **Approver roles:** PM, Designer, Tech Lead, Engineer, Stakeholder (used in approval workflows)

### Application Security

- **Nosecone** - Security headers (via `@nosecone/next`)
- **Webhook verification:** GitHub webhook signatures verified with HMAC SHA-256 (timing-safe comparison). Clerk webhooks verified via Svix. Stripe webhooks verified via Stripe SDK.
- **Environment variable validation:** All env vars validated with Zod schemas via `@t3-oss/env-nextjs` at startup
- **Server-only code:** Critical packages use `import "server-only"` to prevent accidental client-side inclusion

### Data Handling

- **Multi-tenant isolation:** Organization-scoped queries throughout
- **API key storage:** Customer-provided Claude API keys are stored encrypted at rest on `Organization.claudeApiKeyEncrypted` and `User.claudeApiKeyEncrypted` (KMS-encrypted via `apiKeyService`).
- **OAuth tokens:** Linear and Slack access tokens stored in database; refresh token rotation implemented for Linear
- **GitHub App credentials:** Private key and secrets stored as environment variables, not in database
- **S3 artifact storage:** Plan artifacts and generated files stored in AWS S3 with presigned URLs for access

### Security Gaps & Technical Debt

- **TODO:** "Eventually we'll need to update the user's role and permissions here" (auth-hooks.ts line 243) - Role sync from Clerk to local DB is incomplete
- **No granular backend authorization:** Beyond org-scoping, there is no role-based permission enforcement on API routes. Admin vs. member access is enforced only in the frontend UI.
- **Team role enforcement:** Team roles (OWNER/ADMIN/MEMBER) are stored but not enforced in API routes
- **No explicit PII/GDPR handling:** No data retention policies, deletion workflows, or geographic restrictions documented in code
- **Cascading deletion:** TODO on team deletion service (teams/service.ts line 150)

### Product Constraints from Security

- Organization switching requires full cache invalidation (TanStack Query `queryClient.clear()`)
- GitHub webhook processing must validate environment prefix on correlation IDs to prevent cross-environment interference (stage vs prod)
- Approval workflows currently rely on artifact status enum rather than cryptographic signatures

---

## Third-Party Services

### Service Inventory

| Service | Provider | Purpose | Integration Type | Criticality |
|---------|----------|---------|-----------------|-------------|
| **Clerk** | Clerk | Authentication, user management, org management, SSO | SDK + Webhooks | Critical |
| **PostgreSQL / Neon** | Neon (prod), Docker (dev) | Primary database | Prisma ORM | Critical |
| **GitHub App** | GitHub | Workflow dispatch, PR creation, repo access, webhook events | REST API + App Auth + Webhooks | Critical |
| **Anthropic (Claude)** | Anthropic | AI-powered PRD generation, LLM for task extraction | AI SDK | Critical |
| **AWS S3** | AWS | Artifact storage (plan files, execution logs) | AWS SDK v3 | Critical |
| **Stripe** | Stripe | Subscription/payment management | SDK + Webhooks | Important |
| **Linear** | Linear | Project management integration - issue sync, task export | SDK + OAuth | Important |
| **Liveblocks** | Liveblocks | Real-time document collaboration, live cursors | SDK (Client + Server) | Important |
| **PostHog** | PostHog | Product analytics, feature flag evaluation | SDK (Client + Server) | Important |
| **Knock** | Knock | In-app notifications | SDK (Client + Server) | Important |
| **Resend** | Resend | Transactional email delivery | SDK | Nice-to-have |
| **Vercel** | Vercel | Hosting, deployment, edge functions | Platform | Critical |
| **Datadog** | Datadog | Structured log ingestion and observability | HTTP intake API (agentless) | Important |
| **Google Analytics** | Google | Web analytics | Script tag | Nice-to-have |
| **Vercel Analytics** | Vercel | Web vitals and analytics | SDK | Nice-to-have |
| **BaseHub** | BaseHub | CMS for marketing site blog/docs | SDK | Nice-to-have |
| **Slack** | Slack | Deploy notifications, integration status | Bot API | Nice-to-have |
| **Svix** | Svix | Outbound webhook delivery infrastructure | SDK | Nice-to-have |

### Detailed Service Analysis

**Cloud Infrastructure:**
- **AWS S3** - Used for storing plan artifacts, execution logs, and screenshots. Accessed via presigned URLs. Region: us-east-1 (default). Failure impact: Plan generation artifacts would not be retrievable; users would see empty execution logs.
- **Vercel** - Deployment platform for all three web apps (app, api, web). Production deploys via GitHub merge to `production` branch with automated health checks. Failure impact: Complete application outage.

**AI/ML Services:**
- **Anthropic (Claude Opus 4.5 / Sonnet 4.5)** - Powers the PRD generation agent with web search and web fetch tool use. Also used indirectly via Claude Code in GitHub Actions for plan generation and code execution. Failure impact: PRD AI assistant unavailable; plan generation/execution workflows would fail.

**Payment & Financial:**
- **Stripe** - Subscription management with webhook handling for payment events. Uses Stripe Agent Toolkit. Failure impact: Users cannot subscribe or manage billing.

**Authentication:**
- **Clerk** - Central identity provider. Handles user registration, login, MFA, organization management, SSO. Webhooks sync user/org lifecycle events to local database. Failure impact: Complete authentication failure; no user can access the platform.

**Communication:**
- **Resend** - Transactional emails (invitations, notifications). Templates built with React Email.
- **Knock** - In-app notification feed. Server-side SDK for triggering, client-side SDK for display.
- **Slack** - Deployment notifications via bot token (not user-facing integration from the app itself, but SlackIntegration table exists in schema).

**Analytics & Monitoring:**
- **PostHog** - Product analytics and feature flag evaluation. Used both client-side and server-side. Feature flags currently have only one flag defined (`showBetaFeature`).
- **Datadog** - Server-side structured logging via agentless HTTP intake (`packages/observability/log.ts`). Batched and shipped when `DD_API_KEY` + `DD_SITE` are set.
- **Google Analytics** - Web analytics via `@next/third-parties`.

### Dependency Risks

1. **GitHub Actions as execution engine (HIGH):** The entire plan generation and code execution pipeline depends on GitHub Actions. If GitHub Actions is unavailable, down, or rate-limited, core product functionality (plan generation, execution) stops. The system has a fallback (placeholder content) when GitHub is not configured, but no fallback for GitHub outages.

2. **Clerk for all authentication (HIGH):** Single point of failure for authentication. All user identity, org membership, and session management flows through Clerk. No local authentication fallback exists.

3. **Anthropic for AI capabilities (MEDIUM):** AI-assisted PRD generation and the Claude Code agents used in GitHub Actions both depend on Anthropic. Alternative model providers are partially supported via AI SDK abstraction but not configured.

4. **Neon for production database (HIGH):** Standard cloud database dependency. Neon-specific adapter used in production; local development uses standard `pg` adapter.

5. **Vendor lock-in concerns:**
   - Clerk: Deep integration (webhooks, org management, UI components) would require significant effort to replace
   - Liveblocks: Real-time collaboration tightly integrated with TipTap editor and Yjs
   - Vercel: Next.js deployment with Vercel-specific features (edge, analytics, blob storage)
   - GitHub App: Entire execution pipeline built around GitHub Actions dispatch model

6. **Cost implications:** PostHog, Liveblocks, Clerk, Neon, and Anthropic are usage-based. AI model costs (Anthropic Claude Opus 4.5) for plan generation could be significant at scale, especially with token usage tracked per artifact.

---

## Technical Constraints Summary

These constraints should inform product decisions:

| Constraint | Impact on Product |
|------------|-------------------|
| **GitHub Actions execution model** | Plan generation and code execution are async (seconds to minutes). UX must accommodate polling/waiting. Cannot provide real-time streaming of execution progress. |
| **Source code never leaves customer infra** | Core differentiator but limits what the control plane can analyze or display. Codebase summaries must be pre-indexed. |
| **Multi-org user model (1 User record per org)** | Profile updates must sync across all orgs. Role assignments are per-org. |
| **Artifact versioning via documentSlug** | All versions share a slug; only one is `isLatest`. Deleting an artifact deletes all versions. Version-specific collaboration rooms (Liveblocks) are created per version. |
| **No granular backend permissions** | Any org member can currently perform any operation via API. Frontend-only role gating is not secure. Admin features need backend enforcement before expanding. |
| **Workstream state machine (17 states)** | Complex state transitions need careful handling. Adding new states requires schema migration. |
| **Template system is per-org** | Templates are stored as artifacts with unique constraint on (organizationId, templateForType). Only one template per type per org. |
| **No offline support** | Application requires network connectivity for all operations. |
| **Single repository per project (current)** | Only first repository is used for execution. Multi-repo orchestration is documented as a future PRD. |
| **PostgreSQL JSON fields** | Settings, metrics, and trigger data use untyped JSON. Path queries on JSON fields require index narrowing for performance. |
| **Real-time collaboration requires Liveblocks** | Each document artifact version gets its own Liveblocks room. Room creation/deletion is fire-and-forget. |
| **Feature flags minimal** | Only `showBetaFeature` flag exists. Feature flag infrastructure is in place but underutilized. |
| **Testing coverage** | Unit and integration tests exist for core services (artifacts, teams, workstreams, webhooks) but coverage is not comprehensive across all routes and components. |

---

## Appendix: File References

Key files analyzed during this report:

| File | Description |
|------|-------------|
| `CLAUDE.md` | Project-level development conventions and architecture documentation |
| `README.md` | Project overview and setup instructions |
| `package.json` | Root monorepo configuration |
| `turbo.json` | Turborepo task configuration |
| `docker-compose.yml` | Local PostgreSQL setup |
| `packages/database/prisma/schema.prisma` | Complete database schema (703 lines, 30+ models) |
| `packages/api/src/types/artifact.ts` | Artifact type definitions and category mapping |
| `packages/api/src/types/workstream.ts` | Workstream state machine and type definitions |
| `apps/api/app/artifacts/service.ts` | Artifact service (1526 lines) - core business logic |
| `apps/api/lib/auth/with-auth.ts` | Authentication wrapper for all API routes |
| `packages/github/index.ts` | GitHub App integration (workflow dispatch, webhook verification) |
| `packages/ai/lib/agents.ts` | AI agent configuration (PRD generation with Claude Opus 4.5) |
| `packages/ai/lib/models.ts` | AI model configuration |
| `packages/security/index.ts` | Arcjet security configuration |
| `apps/api/.env.example` | API environment variables (reveals service dependencies) |
| `apps/app/.env.example` | Frontend environment variables |
| `apps/app/app/(authenticated)/settings/page.tsx` | Settings page with integration management |
| `apps/api/app/integrations/linear/service.ts` | Linear integration service |
| `.github/workflows/deploy-production.yml` | Production deployment workflow with health checks |
| `apps/api/app/webhooks/github/route.ts` | GitHub webhook handler (installation events, workflow completions) |
| `apps/api/app/webhooks/auth/auth-hooks.ts` | Clerk webhook handlers (user/org lifecycle) |
| `docs/local_deployment.md` | Local development setup guide |
