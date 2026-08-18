-- FEA-2923: hash-at-invocation on component usage (desktop, additive).

-- AlterTable
ALTER TABLE "agent_component_session_usage" ADD COLUMN "component_version_hash" TEXT;

