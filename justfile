# Default recipe - show available commands
default:
    @just --list

# Start the main app, API, and relay
# Install all workspace dependencies
install:
    pnpm install

dev:
    pnpm --filter @closedloop-ai/loops-api build
    RELAY_API_URL=http://localhost:3020 pnpm turbo dev --filter=app --filter=api --filter=mcp --filter=relay

# Start all apps (may fail if mintlify/stripe not installed)
dev-all:
    pnpm dev

# Start the design-system prototype sandbox on http://localhost:3030
prototypes:
    pnpm --filter prototypes dev

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

# Desktop app (Electron)

# Run the desktop app in development against the hosted *.closedloop.ai stack
desktop-dev:
    cd apps/desktop && pnpm run dev

# Run desktop against a local stack on localhost, gateway auth off
desktop-local:
    cd apps/desktop && \
    CL_WEB_APP_ORIGIN=http://localhost:3000 \
    CL_AUTH_API_ORIGIN=http://localhost:3002 \
    CL_RELAY_ORIGIN=http://localhost:3020 \
    CL_LOCAL_GATEWAY_NO_AUTH=1 pnpm run dev

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

# Docker postgres -- explicit POSTGRES_USER avoids auth failures on fresh containers,
# and the closedloop_ai DB must exist before Prisma migrations can run.
db-start:
    docker start postgres16 || docker run -d --name postgres16 -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=closedloop_ai -p 5432:5432 postgres:16
    docker exec postgres16 psql -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='closedloop_ai'" | grep -q 1 || docker exec postgres16 createdb -U postgres closedloop_ai

db-stop:
    docker stop postgres16
