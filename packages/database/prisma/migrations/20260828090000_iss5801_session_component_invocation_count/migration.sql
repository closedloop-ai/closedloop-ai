-- ISS-5801: denormalized count of the active invocation generation's rows, so the
-- substantive/idle session classification can count component invocations.
ALTER TABLE "session_detail" ADD COLUMN "component_invocation_count" INTEGER NOT NULL DEFAULT 0;

-- Backfill from the currently-active generation per session (at most one active
-- generation exists per session; inactive/stale generations are not visible truth).
UPDATE "session_detail" sd
SET "component_invocation_count" = sub.cnt
FROM (
  SELECT g."agent_session_id" AS session_id, COUNT(i."id")::int AS cnt
  FROM "agent_component_invocation_generations" g
  JOIN "agent_component_invocations" i ON i."generation_id" = g."id"
  WHERE g."active_at" IS NOT NULL
  GROUP BY g."agent_session_id"
) sub
WHERE sd."artifact_id" = sub.session_id;
