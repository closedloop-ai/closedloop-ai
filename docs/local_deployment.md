# Local Development Setup Guide

This guide walks you through setting up the ClosedLoop application locally.

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | 18+ | Required by package.json engines |
| pnpm | 10.28.2+ | Auto-managed via corepack |
| Docker | Latest | For running PostgreSQL |
| AWS CLI | v2 | For accessing Secrets Manager |
| Stripe CLI | Latest | **Optional** — only needed for testing payment webhooks |

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
- **Database**: `symphony`
- **Port**: `5432`

### 3. Copy Environment Variables from AWS Secrets Manager

All environment variables (Clerk, Stripe, PostHog, GitHub App, AI keys, etc.) are stored in AWS Secrets Manager.

1. Log in to AWS Console and navigate to **Secrets Manager**
2. Find the `localhost/env-secrets` secret
3. Copy all key-value pairs to your `.env.local` files:

```bash
# Create the env files
touch apps/app/.env.local
touch apps/api/.env.local
touch apps/web/.env.local
```

Paste the secrets from `localhost/env-secrets` into these files. The secrets are organized by file—look for the `# apps/app/.env.local` and `# apps/api/.env.local` comment headers to identify which secrets belong in each file.

### 4. Update DATABASE_URL for Local PostgreSQL

The secrets from AWS contain a production/cloud database URL. You need to override it for local development.

In **each** of the three `.env.local` files (`apps/app/.env.local`, `apps/api/.env.local`, `apps/web/.env.local`), update the `DATABASE_URL`:

```bash
DATABASE_URL="postgresql://postgres:password@localhost:5432/symphony?schema=public"
```

### 5. Configure packages/database/.env

The Prisma CLI also needs the database URL. Create or update `packages/database/.env`:

```bash
DATABASE_URL="postgresql://postgres:password@localhost:5432/symphony?schema=public"
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

Starts all apps in the monorepo, including marketing site, email preview, docs, and Prisma Studio.

#### Available Apps

| App | Port | URL | Description |
|-----|------|-----|-------------|
| **app** | 3000 | http://localhost:3000 | Main authenticated application |
| **api** | 3002 | http://localhost:3002 | API server (Stripe webhooks, etc.) |
| **web** | 3001 | http://localhost:3001 | Marketing/public website |
| **email** | 3003 | http://localhost:3003 | Email template preview (React Email) |
| **docs** | 3004 | http://localhost:3004 | Documentation (Mintlify) |
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

**Cause**: Missing or invalid environment variable from AWS Secrets Manager.

**Solution**:
- Ensure all secrets were copied correctly
- **Important**: Empty strings `""` fail validation — comment out unused variables instead

```bash
# Wrong - empty string fails validation
STRIPE_WEBHOOK_SECRET=""

# Right - comment out if not used
# STRIPE_WEBHOOK_SECRET=""
```

### Stripe CLI errors on startup

```
error: spawn stripe ENOENT
```

or

```
stripe: command not found
```

**Cause**: The Stripe CLI is not installed or not logged in. The `apps/api` dev script runs `stripe listen` to forward payment webhooks to your local server.

**Impact**: This error is **not critical**. The API server and main app will continue to run normally. Only Stripe webhook forwarding is affected.

**Solution**:
- If you don't need to test payment webhooks locally, you can safely ignore this error
- To enable webhook forwarding, install and configure the Stripe CLI:

```bash
# macOS
brew install stripe/stripe-cli/stripe

# Login to Stripe
stripe login
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
