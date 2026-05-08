# Local Development Setup Guide

This guide walks you through setting up the ClosedLoop application locally.

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | 18+ | Required by package.json engines |
| pnpm | 10.28.2+ | Auto-managed via corepack |
| Docker | Latest | For running PostgreSQL |

```bash
# Enable corepack (bundled with Node.js 16.13+)
corepack enable
```

---

## Setup Steps

### 1. Install Dependencies

```bash
git clone <repository-url>
cd closedloop-ai
pnpm install
```

### 2. Start PostgreSQL (Docker Compose)

```bash
# Start the database
docker compose up -d

# Verify it's running
docker compose ps
```

This starts PostgreSQL with:
- **User**: `postgres`
- **Password**: `password`
- **Database**: `closedloop_ai`
- **Port**: `5432`

### 3. Configure Environment Variables

Running `pnpm dev` will automatically create `.env.local` files from `.env.example` templates for each app. You can also create them manually:

```bash
cp apps/app/.env.example apps/app/.env.local
cp apps/api/.env.example apps/api/.env.local
cp apps/web/.env.example apps/web/.env.local
cp apps/mcp/.env.example apps/mcp/.env.local
cp apps/relay/.env.example apps/relay/.env.local
cp packages/database/.env.example packages/database/.env
```

Then fill in your service credentials:

- **Clerk** (required): Create a Clerk application at [clerk.com](https://clerk.com) and copy the publishable key, secret key, and webhook secret
- **GitHub App** (required for execution): See [docs/github-app-setup.md](github-app-setup.md)
- **PostHog** (optional): For analytics and feature flags
- **Resend** (optional): For transactional email
- **Liveblocks** (optional): For real-time collaboration

The local `DATABASE_URL` is already set in the `.env.example` files to point at the Docker Compose PostgreSQL instance.

### 4. Configure packages/database/.env

The Prisma CLI also needs the database URL. Create or update `packages/database/.env`:

```bash
DATABASE_URL="postgresql://postgres:password@localhost:5432/closedloop_ai?schema=public"
```

### 6. Initialize the Database

```bash
# Format schema, generate Prisma client, and push schema to database
pnpm migrate
```

### 7. Start the Application

You have two options for starting the development servers:

**Option A: Core apps only (recommended for most development)**

```bash
pnpm start-apps
```

Starts only the main application and API server—sufficient for most feature development.

**Option B: All apps**

```bash
pnpm dev
```

Starts all apps in the monorepo.

#### Available Apps

| App | Port | URL | Description |
|-----|------|-----|-------------|
| **app** | 3000 | http://localhost:3000 | Main authenticated application |
| **api** | 3002 | http://localhost:3002 | API server — webhooks, service integrations |
| **web** | 3001 | http://localhost:3001 | Marketing/public website |
| **mcp** | 3010 | http://localhost:3010 | MCP server |
| **relay** | 3020 | http://localhost:3020 | WebSocket relay |
| **storybook** | 6006 | http://localhost:6006 | Component library |
| **studio** | 3005 | http://localhost:3005 | Prisma Studio (database browser) |

> **Tip:** To start a specific app individually, use `pnpm turbo dev --filter=<app-name>` (e.g., `pnpm turbo dev --filter=studio`).

---

## Troubleshooting

### Database connection errors

```
Error: P1001: Can't reach database server at `undefined:5432`
```

**Cause**: `DATABASE_URL` not set or Docker not running.

**Solution**:
1. Verify Docker is running: `docker compose ps`
2. Check that `packages/database/.env` contains the correct `DATABASE_URL`
3. Check that your app `.env.local` files have `DATABASE_URL` set

### "Cannot find module '@repo/database'"

**Cause**: Prisma client not generated.

**Solution**:
```bash
pnpm migrate
# Or specifically:
cd packages/database && pnpm prisma generate
```

### Environment variable validation failed

**Cause**: Missing or invalid environment variable.

**Solution**:
- Ensure credentials were added to `.env.local`
- **Important**: Empty strings `""` fail validation — comment out unused variables instead

```bash
# Wrong - empty string fails validation
RESEND_TOKEN=""

# Right - comment out if not used
# RESEND_TOKEN=""
```

---

## Quick Reference

### Start specific apps only

```bash
# Main app + API only
pnpm turbo dev --filter=app --filter=api
```

### Database commands

```bash
cd packages/database
pnpm prisma generate    # Regenerate TypeScript client
pnpm prisma db push     # Push schema changes
pnpm prisma studio      # Open GUI to browse data
```

### Docker commands

```bash
docker compose up -d     # Start PostgreSQL
docker compose down      # Stop PostgreSQL
docker compose logs -f   # View logs
```
