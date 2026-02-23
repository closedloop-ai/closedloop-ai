# Default recipe - show available commands
default:
    @just --list

# Start the main app and API
dev:
    pnpm turbo dev --filter=app --filter=api

# Start all apps (may fail if mintlify/stripe not installed)
dev-all:
    pnpm dev

# Database commands
migrate:
    pnpm migrate

db-studio:
    cd packages/database && pnpm prisma studio

db-push:
    cd packages/database && pnpm prisma db push

db-generate:
    cd packages/database && pnpm prisma generate

db-migrate name="":
    cd packages/database && pnpm prisma migrate dev {{ if name != "" { "--name " + name } else { "" } }}

db-migrate-reset:
    cd packages/database && pnpm prisma migrate reset

# Build and check
build:
    pnpm build

typecheck:
    pnpm typecheck

lint:
    pnpm lint

lint-fix:
    pnpm lint:fix

test:
    pnpm test

# Docker postgres
db-start:
    docker start postgres16 || docker run -d --name postgres16 -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16

db-stop:
    docker stop postgres16
