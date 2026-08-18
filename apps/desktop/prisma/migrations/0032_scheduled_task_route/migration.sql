-- FEA-3816 (PRD-553 M4): add the capability broker's per-task `route` column to
-- `scheduled_tasks`. It mirrors the crewd `taskRouteSchema` value
-- (local-cascade | claude-routine): `local-cascade` runs the task through the
-- local daemon cascade (how every task ran before M4), `claude-routine` hands it
-- to a Claude cloud routine. Additive with a `local-cascade` default so existing
-- rows and older-build stores keep their current behavior; DDL is byte-equivalent
-- to what Prisma emits from schema.prisma (prisma-migrations-agreement guard).

-- AlterTable
ALTER TABLE "scheduled_tasks" ADD COLUMN "route" TEXT NOT NULL DEFAULT 'local-cascade';
