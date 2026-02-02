# Local Development Setup Guide

This guide walks you through setting up the Symphony application locally.

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | 18+ | Required by package.json engines |
| pnpm | 10.28.2+ | Auto-managed via corepack |
| Docker | Latest | For running PostgreSQL |
| AWS CLI | v2 | For accessing Secrets Manager |

```bash
# Enable corepack (bundled with Node.js 16.13+)
corepack enable
```

---

## Setup Steps

### 1. Install Dependencies

```bash
git clone <repository-url>
cd symphony-alpha
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

Paste the secrets into each file. All three apps use the same set of variables.

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

```bash
pnpm dev
```

| App | Port | URL |
|-----|------|-----|
| **app** | 3000 | http://localhost:3000 |
| **web** | 3001 | http://localhost:3001 |
| **api** | 3002 | http://localhost:3002 |
| **email** | 3003 | http://localhost:3003 |
| **docs** | 3004 | http://localhost:3004 |
| **studio** | 3005 | http://localhost:3005 |

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
