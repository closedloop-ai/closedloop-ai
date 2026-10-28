-- ISS-10332 / PLN-2086 Milestone 3: the user-set priority, local half, for
-- sessions and for branch artifacts (`artifacts.kind = 'branch'`).
--
-- Written only by the local-mode priority write (never by an import path, the
-- `name_override` precedent from 0076), and carried to the cloud as an
-- additive optional sync field that the cloud adopts only when it holds none.
--
-- Nullable, no default, no backfill: NULL is "no priority", which is every
-- existing row. TEXT because the schema's `Priority` enum is stored as TEXT on
-- SQLite; only the typed write sets it, so it holds a member or NULL.
ALTER TABLE "sessions" ADD COLUMN "priority" TEXT;
ALTER TABLE "artifacts" ADD COLUMN "priority" TEXT;
