-- ISS-7820: `session_analytics.est_cost` becomes NULLABLE.
--
-- The column is one of TWO derivations of a session's total cost. Its sibling
-- `sessions.cost_usd_estimated` is nullable and writes NULL for "nobody priced
-- this"; this one was `NOT NULL DEFAULT 0` and therefore had no way to say it,
-- so an unpriced or partially-priced token_usage window landed here as a
-- confident dollar figure that is simply wrong -- $0.00 when nothing was priced
-- and no web search ran, or the web-search line item ALONE (measured at $0.03
-- for a session that actually cost $0.04753625) when one did. A reader could not
-- tell that from a session that genuinely cost nothing.
--
-- ISS-7776 made the two columns agree on the refresh path and scoped this half
-- out precisely because it changes the column's contract. This is that change.
--
-- SQLite cannot DROP NOT NULL in place, so the table is rebuilt. Nothing
-- references `session_analytics` by foreign key (session_id carries no FK, by
-- the same choice `session_tool_analytics` and `session_activity_metrics` make),
-- so no deferral pragma is needed -- and one would be ignored anyway, the
-- migration runner having already opened a transaction.
--
-- NO ROW IS REINTERPRETED. Every existing value is copied across verbatim: a
-- stored 0 stays 0, because this migration cannot know which zeros were real.
-- Rows converge on the new distinction the next time any analytics rollup runs
-- for them, which is the same pass that produced the wrong value.

-- RedefineTable
CREATE TABLE "new_session_analytics" (
    "session_id" TEXT NOT NULL PRIMARY KEY,
    "started_at" TEXT,
    "started_day" TEXT,
    "status" TEXT,
    "harness" TEXT,
    "is_human" INTEGER NOT NULL DEFAULT 0,
    "human_turns" INTEGER NOT NULL DEFAULT 0,
    "agent_turns" INTEGER NOT NULL DEFAULT 0,
    "event_count" INTEGER NOT NULL DEFAULT 0,
    "tool_invocations" INTEGER NOT NULL DEFAULT 0,
    "error_events" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
    "est_cost" REAL,
    "runtime_ms" INTEGER,
    "updated_at" TEXT
);

INSERT INTO "new_session_analytics" (
  "session_id", "started_at", "started_day", "status", "harness",
  "is_human", "human_turns", "agent_turns", "event_count", "tool_invocations",
  "error_events", "input_tokens", "output_tokens", "cache_read_tokens",
  "cache_write_tokens", "est_cost", "runtime_ms", "updated_at"
)
SELECT
  "session_id", "started_at", "started_day", "status", "harness",
  "is_human", "human_turns", "agent_turns", "event_count", "tool_invocations",
  "error_events", "input_tokens", "output_tokens", "cache_read_tokens",
  "cache_write_tokens", "est_cost", "runtime_ms", "updated_at"
FROM "session_analytics";

DROP TABLE "session_analytics";

ALTER TABLE "new_session_analytics" RENAME TO "session_analytics";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_session_analytics_started_day" ON "session_analytics"("started_day");
