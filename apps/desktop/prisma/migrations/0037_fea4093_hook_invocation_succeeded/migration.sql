-- FEA-4093: per-invocation success fact for Hook firings.
--
-- Additive, nullable, NO default: legacy rows and every non-Hook kind stay NULL
-- ("no success fact for this kind"). A Hook invocation stores 1/0 derived from
-- the transcript `attachment` type (hook_success vs hook_error /
-- hook_non_blocking_error). SQLite has no boolean affinity, so this is an
-- INTEGER column carrying 1/0/NULL (Prisma Boolean? maps to it). The
-- agent_component_session_usage rebuild counts `succeeded = 0` as an error_count
-- so a failed hook — which anchors to a Timestamp, not an error-bearing
-- event/agent — is no longer reported with error_count 0. Metadata-only op.

-- AlterTable
ALTER TABLE "agent_component_invocations" ADD COLUMN "succeeded" BOOLEAN;
