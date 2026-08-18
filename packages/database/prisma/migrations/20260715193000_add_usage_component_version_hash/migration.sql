-- FEA-2923: hash-at-invocation on component usage (additive, nullable).
-- Generated offline via prisma migrate diff.

-- AlterTable
ALTER TABLE "agent_component_session_usage" ADD COLUMN     "component_version_hash" TEXT;

