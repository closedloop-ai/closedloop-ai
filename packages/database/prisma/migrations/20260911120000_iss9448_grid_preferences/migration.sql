-- ISS-9448 (PRD-716): authenticated server-backed grid preferences foundation.
--
-- Purely additive: the table is empty at creation, no mounted UI reads it in
-- this ticket, and existing localStorage-backed grid state remains untouched.
-- Rollback is `DROP TABLE "grid_preferences"` and nothing else.
--
-- The identity index is the selector the API upsert arbitrates on:
-- organization, user, grid, preference kind, and scope. Revision checks happen
-- inside the service's write path. Reset stores a tombstone in the same selector
-- row so revisions cannot restart after recreation.

-- CreateTable
CREATE TABLE "grid_preferences" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "grid_key" TEXT NOT NULL,
    "preference_kind" TEXT NOT NULL,
    "scope_key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "grid_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- index-lock-ok(grid_preferences): table is created empty in this same migration so the selector unique and user cascade-support indexes lock zero rows before any writer can reach them, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE UNIQUE INDEX IF NOT EXISTS "grid_preferences_identity_key" ON "grid_preferences"("organization_id", "user_id", "grid_key", "preference_kind", "scope_key");

-- CreateIndex
-- index-lock-ok(grid_preferences): table is created empty in this same migration so the selector unique and user cascade-support indexes lock zero rows before any writer can reach them, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "grid_preferences_user_id_idx" ON "grid_preferences"("user_id");

-- AddForeignKey
ALTER TABLE "grid_preferences" ADD CONSTRAINT "grid_preferences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grid_preferences" ADD CONSTRAINT "grid_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
