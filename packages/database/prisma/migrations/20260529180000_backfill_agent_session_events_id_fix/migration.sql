-- Corrective backfill for FEA-1380 (normalize_agent_session_events).
--
-- Why this exists: the original migration 20260526000000 backfilled
-- `agent_session_events` with an INSERT that omitted the `id` primary key.
-- `id` (uuid) has no database-level default — the Prisma client supplies
-- uuid(7) at runtime — so the raw-SQL backfill produced NULL ids and failed
-- with Postgres 23502 (not-null violation) on any database that actually had
-- `agent_sessions.events` rows to migrate. It only "succeeded" where there
-- were zero events (the 0-row backfill never reached the constraint), which is
-- why stage/CI passed while production wedged on ~873k events.
--
-- This migration re-runs the backfill correctly, supplying a generated id.
--
-- Idempotent / cross-environment safe:
--   * Guarded on the existence of `agent_sessions.events`, so it is a no-op on
--     environments where 20260526000000 already completed and dropped the
--     column (stage, fresh installs). It only does work where the column still
--     exists (production, after the wedged record is cleared via
--     `prisma migrate resolve --applied 20260526000000_normalize_agent_session_events`).
--   * ON CONFLICT DO NOTHING on the (agent_session_id, external_event_id)
--     unique key, so re-entry never duplicates rows.
--
-- The `agent_sessions.events` column is intentionally NOT dropped here. It is
-- removed in a separate later migration (expand/contract) once the FEA-1380
-- application code is live everywhere, so we never drop a column that
-- in-flight (pre-FEA-1380) code still reads.
--
-- Hand-written because this is a data migration (Prisma-inexpressible), per
-- packages/database/CLAUDE.md.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agent_sessions'
      AND column_name = 'events'
  ) THEN
    EXECUTE $backfill$
      INSERT INTO "agent_session_events" (
        "id",
        "agent_session_id",
        "external_event_id",
        "agent_external_id",
        "event_type",
        "tool_name",
        "summary",
        "data",
        "event_created_at"
      )
      SELECT
        gen_random_uuid(),
        s."id",
        e->>'externalEventId',
        NULLIF(e->>'agentExternalId', ''),
        COALESCE(e->>'eventType', 'unknown'),
        NULLIF(e->>'toolName', ''),
        NULLIF(e->>'summary', ''),
        CASE
          WHEN e->'data' IS NOT NULL AND e->>'data' != 'null' THEN e->'data'
          ELSE NULL
        END,
        COALESCE((e->>'createdAt')::timestamp, s."session_started_at")
      FROM "agent_sessions" s,
           jsonb_array_elements(s."events") e
      WHERE jsonb_array_length(s."events") > 0
        AND e->>'externalEventId' IS NOT NULL
        AND e->>'externalEventId' != ''
      ON CONFLICT ("agent_session_id", "external_event_id") DO NOTHING;
    $backfill$;
  END IF;
END $$;
