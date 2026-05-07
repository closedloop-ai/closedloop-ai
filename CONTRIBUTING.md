# Contributing to ClosedLoop.AI

We welcome contributions! This guide covers everything you need to get started.

## Getting Started

### Prerequisites

- Node.js 20+
- [pnpm](https://pnpm.io)
- Docker (for local PostgreSQL)

### Setup

```bash
# Fork on GitHub, then clone your fork
git clone git@github.com:YOUR_USERNAME/closedloop-ai.git
cd closedloop-ai
git remote add upstream git@github.com:closedloop-ai/closedloop-ai.git

# Install dependencies
pnpm install

# Start local database
docker compose up -d

# Set up environment variables
cp apps/app/.env.example apps/app/.env.local
cp apps/api/.env.example apps/api/.env.local
cp apps/web/.env.example apps/web/.env.local

# Run database migrations
cd packages/database && pnpm prisma migrate dev && cd ../..

# Start development
pnpm dev
```

See [docs/local_deployment.md](docs/local_deployment.md) for the full setup guide including service account configuration (Clerk, GitHub App, etc.).

### Verify

```bash
# Type checking
pnpm typecheck

# Linting & formatting
pnpm lint

# Run tests
pnpm test
```

## Development Workflow

All contributions come through forks. External contributors do not have push access to the main repository.

### Fork & Branch

1. [Fork](https://github.com/closedloop-ai/closedloop-ai/fork) the repository on GitHub
2. Clone your fork and add the upstream remote (see Setup above)
3. Create a feature branch from `main`:
   ```bash
   git fetch upstream
   git checkout -b feat/my-change upstream/main
   ```

### Branch Naming

- `feat/*` — New features
- `fix/*` — Bug fixes
- `docs/*` — Documentation changes
- `refactor/*` — Code restructuring

### Keeping Your Fork Up to Date

```bash
git fetch upstream
git rebase upstream/main
```

### Pull Request Process

1. Push your branch to **your fork** (not the upstream repo)
2. Open a PR from your fork's branch to `closedloop-ai/closedloop-ai:main`
3. Include a description of what changed and why
4. Address review feedback with additional commits (don't force-push during review)
5. A maintainer will squash merge to `main` after approval

## Architecture

### Monorepo Structure

```
closedloop-ai/
├── apps/           # Deployable applications
│   ├── app/        # Main application (port 3000)
│   ├── api/        # BFF API server (port 3002)
│   ├── web/        # Marketing website (port 3001)
│   ├── docs/       # Documentation (Mintlify)
│   ├── email/      # Email templates (React Email)
│   ├── storybook/  # Component library
│   └── studio/     # Prisma Studio
└── packages/       # Shared packages (@repo/*)
    ├── database/   # Prisma ORM + migrations
    ├── api/        # Shared API types
    ├── auth/       # Clerk authentication
    ├── design-system/ # Shadcn/ui components
    ├── ai/         # Anthropic AI integration
    ├── github/     # GitHub App integration
    └── ...         # 20+ shared packages
```

### Data Access Pattern

All database access goes through the BFF API — the frontend never imports `@repo/database` directly:

```
apps/app (frontend)  →  apps/api (routes → services)  →  @repo/database
```

### Key Conventions

- **Frontend hooks** (`apps/app/hooks/queries/`) use TanStack Query with `useApiClient()`
- **API routes** (`apps/api/app/*/route.ts`) handle auth and request parsing only — delegate to services
- **Services** (`apps/api/app/*/service.ts`) contain business logic and database operations
- **Shared types** (`packages/api/src/types/`) define contracts used by both frontend and backend

## Code Style

### TypeScript

- **Biome** for linting and formatting (config in `biome.jsonc`, extends ultracite)
- `@repo/*` imports before `@/*` path alias imports (Biome enforced)
- Use `RegExp.exec(str)` instead of `str.match(regex)`
- Use `String#replaceAll()` instead of `String#replace()` with global regex
- Use `globalThis` instead of `window`
- Keep function Cognitive Complexity under 15
- No nested ternary operators

### React & Next.js

- Prefer `Image` from `next/image` over `<img>` elements
- All Clerk client components need the mounted-state hydration guard pattern
- No JSX comments between `(` and root JSX element

### Database

- Schema changes require `prisma migrate dev --name <descriptive_name>`
- Never use `prisma db push` for changes going to production
- Verify Prisma enum values against `schema.prisma` — don't assume names

### Git Commits

Read `.gitmessage` and follow its format for commit messages.

## Testing Requirements

- **Services**: Unit tests for new service methods
- **Parsers/Utilities**: Unit tests required — PRs rejected without coverage
- **Components**: Update test fixtures when adding required props
- **Do not** assert on logging statements — test observable behavior instead

## PR Review Guidelines

When responding to PR review comments, be concise and factual. State what was changed, not how insightful the reviewer was. Avoid phrases like "good catch" or "great point."
