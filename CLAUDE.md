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
pnpm migrate                                # Format, generate, and push schema
cd packages/database && pnpm prisma studio  # Open Prisma Studio
cd packages/database && pnpm prisma db push # Push schema changes
```

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
- **observability** - Sentry, BetterStack logging
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
- Local dev uses `pg` adapter; production uses Neon adapter (auto-detected via URL)

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

**Single source of truth for types.** Never duplicate type definitions across files.

- **API types** → `packages/api/src/types/` - Request/response types, enums, shared interfaces
- **Database types** → Generated from Prisma schema in `packages/database/generated/`

When creating a new type:
1. Check if it already exists in `packages/api/src/types/`
2. If not, add it there and import from `@repo/api/src/types/<file>`
3. Never define the same type in multiple files

```typescript
// ✅ GOOD - import from shared types
import type { GenerationStatus, PullRequestInfo } from "@repo/api/src/types/artifact";

// ❌ BAD - duplicating types locally
type GenerationStatus = {
  status: "NONE" | "PENDING" | ...
};
```

## Self-Improving CLAUDE.md

When working on a PR and you discover a pattern, convention, or gotcha that isn't documented here, **add it to the relevant CLAUDE.md as part of the same PR.** Examples:

- A code review catches a repeated mistake (e.g., duplicating types, wrong import path) → add a rule so it doesn't happen again
- You hit a non-obvious framework behavior (e.g., MDXEditor requiring `setMarkdown` ref) → document it
- A build/lint/test failure reveals a convention not captured here → add it
- You notice an architectural pattern being followed but not written down → write it down

The goal is that every PR makes future sessions smarter. CLAUDE.md files are living documents — treat them like code.

## Key Files
- `turbo.json` - Turborepo task configuration
- `biome.jsonc` - Linting/formatting config (extends ultracite)
- `packages/*/keys.ts` - Environment variable validation schemas (t3-env)

## Background

The following sections provide the business perspective for what this repository is meant to deliver.

### Vision Statement
To create a human-governed, AI-centric software delivery platform that transforms intent into high-quality software—by automating execution, preserving human judgment, and making decisions, artifacts, and outcomes traceable across the entire delivery lifecycle.

### Abstract
We are building a new software delivery platform where AI is the execution engine, not the decision maker. The platform translates human intent—captured from product, design, engineering, and QA—into all of the artifacts required to deliver software, including requirements, designs, plans, code, tests, and release evidence. Each step of the process is structured around familiar delivery milestones and gated by explicit human review and approval, ensuring quality, accountability, and trust. Rather than forcing teams into chatbots, CLIs, or IDE-centric workflows, the platform provides a modern, role-appropriate experience for the entire team, while publishing clean outputs to existing systems of record. The result is faster delivery, higher consistency, and a durable system of organizational memory that scales with both teams and products.

Unlike developer-focused AI tools that only assist with coding, Symphony serves every stakeholder: product managers converse with AI to produce comprehensive PRDs, designers generate specifications grounded in the actual codebase, and engineers implement features with full context of upstream decisions. The platform operates on a hybrid architecture where source code never leaves customer infrastructure, while a cloud-based control plane orchestrates workflows, manages approvals, and integrates with tools teams already use—GitHub, Linear, and Slack.

### The Opportunity
**The problem:** Software delivery remains bottlenecked by artifact creation. Engineers wait on PRDs. PRDs lack technical grounding. Designs don’t account for existing code. Reviews happen too late. Every handoff loses context.

**The insight:** AI can now generate high-quality first drafts of every artifact in the software delivery process—but only if it has deep context about the codebase, the product, and the decisions already made. And it should only act with human approval at critical junctures.

**The product:** A platform where AI agents produce artifacts, humans approve and refine them, and the entire workflow is orchestrated toward shipping software faster—with better quality and more alignment across the team.