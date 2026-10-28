-- ISS-10718: the cloud twin of the desktop `succeeded` column (FEA-4093).
--
-- Nullable with NO DEFAULT, deliberately. NULL is a third value meaning "this
-- kind's success is not a first-class transcript fact", not a failure and not a
-- success; a `DEFAULT false` would backfill every existing row with a verdict
-- nobody reached and make an unadjudicated hook indistinguishable from a tool
-- call that errored.
ALTER TABLE "agent_component_invocations" ADD COLUMN "succeeded" BOOLEAN;
