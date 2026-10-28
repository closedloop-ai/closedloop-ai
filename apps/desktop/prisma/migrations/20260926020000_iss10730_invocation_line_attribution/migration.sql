-- ISS-10730 — per-invocation LINE attribution.
--
-- Additive and nullable with NO default: a legacy row stays NULL, which means
-- "no per-invocation line delta was computed", never a measured zero. A tool
-- call that changed no file also leaves them NULL, because the producer only
-- writes a value the transcript actually carried a `diffDelta` for.
--
-- Only the kinds built from a single transcript tool call (tool / mcp /
-- orchestration) may carry these — see LINE_BEARING_INVOCATION_KINDS. That set
-- is DISJOINT from the usage-bearing kinds, which is the cohort divergence that
-- forces a per-component LOC/$ ratio through resolveInvocationLocPerDollar
-- rather than a direct division.
--
-- INTEGER (Prisma Int) rather than BIGINT: a line count is bounded by the file
-- sizes a single edit can touch, orders of magnitude below the token counts.

-- AlterTable
ALTER TABLE "agent_component_invocations" ADD COLUMN "lines_added" INTEGER;
ALTER TABLE "agent_component_invocations" ADD COLUMN "lines_removed" INTEGER;
