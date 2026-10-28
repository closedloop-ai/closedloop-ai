-- ISS-10713: re-land of 20261019142013_add_invocation_duration, which merged
-- backdated (before 20261019182000). IF NOT EXISTS keeps it a no-op on any
-- database that already applied the original.
ALTER TABLE "agent_component_invocations" ADD COLUMN IF NOT EXISTS "duration_ms" BIGINT;
