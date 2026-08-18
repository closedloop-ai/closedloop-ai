-- ISS-4586: durable per-session flag synced from the desktop's `ends_with_error`.
-- The stale-session reaper reads it to declare an orphaned still-active session
-- ERROR vs INACTIVE without re-deriving from events. Nullable + additive: absent
-- for pre-ISS-4586 rows and for older desktop builds that don't sync it.

-- AlterTable
ALTER TABLE "session_detail" ADD COLUMN     "ends_with_error" BOOLEAN;
