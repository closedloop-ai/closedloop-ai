-- Restore the partial unique index that was incorrectly dropped by 20260309141628_schema_drift.
-- This index is intentionally managed via raw SQL because Prisma cannot express
-- partial unique indexes (WHERE clause). It enforces idempotency for desktop commands:
-- application code in desktop-command-store.ts relies on P2002 violations from this
-- index to safely handle concurrent duplicate command creation.
CREATE UNIQUE INDEX "desktop_commands_compute_target_id_idempotency_key_key" ON "desktop_commands"("compute_target_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
