CREATE TABLE IF NOT EXISTS "session_list_trace_projection" (
  "session_id" TEXT NOT NULL PRIMARY KEY,
  "revision" INTEGER NOT NULL,
  "payload" JSONB NOT NULL,
  "updated_at" TEXT NOT NULL,
  CONSTRAINT "session_list_trace_projection_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "sessions" ("id")
    ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "idx_events_session_created_id"
  ON "events"("session_id", "created_at", "id");

CREATE INDEX IF NOT EXISTS "idx_token_events_session_created_model_transport"
  ON "token_events"("session_id", "created_at", "model", "transport_id");

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_session_update"
AFTER UPDATE OF "started_at", "updated_at", "ended_at", "metadata" ON "sessions"
WHEN OLD."started_at" IS NOT NEW."started_at"
  OR OLD."updated_at" IS NOT NEW."updated_at"
  OR OLD."ended_at" IS NOT NEW."ended_at"
  OR OLD."metadata" IS NOT NEW."metadata"
BEGIN
  DELETE FROM "session_list_trace_projection" WHERE "session_id" = NEW."id";
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_event_insert"
AFTER INSERT ON "events"
BEGIN
  DELETE FROM "session_list_trace_projection" WHERE "session_id" = NEW."session_id";
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_event_update"
AFTER UPDATE ON "events"
BEGIN
  DELETE FROM "session_list_trace_projection"
  WHERE "session_id" IN (OLD."session_id", NEW."session_id");
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_event_delete"
AFTER DELETE ON "events"
BEGIN
  DELETE FROM "session_list_trace_projection" WHERE "session_id" = OLD."session_id";
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_token_event_insert"
AFTER INSERT ON "token_events"
BEGIN
  DELETE FROM "session_list_trace_projection" WHERE "session_id" = NEW."session_id";
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_token_event_update"
AFTER UPDATE ON "token_events"
BEGIN
  DELETE FROM "session_list_trace_projection"
  WHERE "session_id" IN (OLD."session_id", NEW."session_id");
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_token_event_delete"
AFTER DELETE ON "token_events"
BEGIN
  DELETE FROM "session_list_trace_projection" WHERE "session_id" = OLD."session_id";
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_token_usage_insert"
AFTER INSERT ON "token_usage"
BEGIN
  DELETE FROM "session_list_trace_projection" WHERE "session_id" = NEW."session_id";
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_token_usage_update"
AFTER UPDATE ON "token_usage"
BEGIN
  DELETE FROM "session_list_trace_projection"
  WHERE "session_id" IN (OLD."session_id", NEW."session_id");
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_token_usage_delete"
AFTER DELETE ON "token_usage"
BEGIN
  DELETE FROM "session_list_trace_projection" WHERE "session_id" = OLD."session_id";
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_viewership_insert"
AFTER INSERT ON "session_viewership"
BEGIN
  DELETE FROM "session_list_trace_projection" WHERE "session_id" = NEW."session_id";
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_viewership_update"
AFTER UPDATE ON "session_viewership"
BEGIN
  DELETE FROM "session_list_trace_projection"
  WHERE "session_id" IN (OLD."session_id", NEW."session_id");
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_viewership_delete"
AFTER DELETE ON "session_viewership"
BEGIN
  DELETE FROM "session_list_trace_projection" WHERE "session_id" = OLD."session_id";
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_agent_insert"
AFTER INSERT ON "agents"
BEGIN
  DELETE FROM "session_list_trace_projection" WHERE "session_id" = NEW."session_id";
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_agent_update"
AFTER UPDATE ON "agents"
BEGIN
  DELETE FROM "session_list_trace_projection"
  WHERE "session_id" IN (OLD."session_id", NEW."session_id");
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_agent_delete"
AFTER DELETE ON "agents"
BEGIN
  DELETE FROM "session_list_trace_projection" WHERE "session_id" = OLD."session_id";
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_component_insert"
AFTER INSERT ON "agent_component_invocations"
BEGIN
  DELETE FROM "session_list_trace_projection" WHERE "session_id" = NEW."session_id";
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_component_update"
AFTER UPDATE ON "agent_component_invocations"
BEGIN
  DELETE FROM "session_list_trace_projection"
  WHERE "session_id" IN (OLD."session_id", NEW."session_id");
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_component_delete"
AFTER DELETE ON "agent_component_invocations"
BEGIN
  DELETE FROM "session_list_trace_projection" WHERE "session_id" = OLD."session_id";
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_link_insert"
AFTER INSERT ON "session_artifact_links"
BEGIN
  DELETE FROM "session_list_trace_projection" WHERE "session_id" = NEW."session_id";
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_link_update"
AFTER UPDATE ON "session_artifact_links"
BEGIN
  DELETE FROM "session_list_trace_projection"
  WHERE "session_id" IN (OLD."session_id", NEW."session_id");
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_link_delete"
AFTER DELETE ON "session_artifact_links"
BEGIN
  DELETE FROM "session_list_trace_projection" WHERE "session_id" = OLD."session_id";
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_artifact_update"
AFTER UPDATE OF
  "kind",
  "slug",
  "repo_full_name",
  "pr_number",
  "url",
  "title",
  "committed_at",
  "observed_at",
  "sha",
  "branch_name",
  "pr_state",
  "base_ref",
  "lines_added",
  "lines_removed",
  "files_changed",
  "priority"
ON "artifacts"
WHEN OLD."kind" IS NOT NEW."kind"
  OR OLD."slug" IS NOT NEW."slug"
  OR OLD."repo_full_name" IS NOT NEW."repo_full_name"
  OR OLD."pr_number" IS NOT NEW."pr_number"
  OR OLD."url" IS NOT NEW."url"
  OR OLD."title" IS NOT NEW."title"
  OR OLD."committed_at" IS NOT NEW."committed_at"
  OR OLD."observed_at" IS NOT NEW."observed_at"
  OR OLD."sha" IS NOT NEW."sha"
  OR OLD."branch_name" IS NOT NEW."branch_name"
  OR OLD."pr_state" IS NOT NEW."pr_state"
  OR OLD."base_ref" IS NOT NEW."base_ref"
  OR OLD."lines_added" IS NOT NEW."lines_added"
  OR OLD."lines_removed" IS NOT NEW."lines_removed"
  OR OLD."files_changed" IS NOT NEW."files_changed"
  OR OLD."priority" IS NOT NEW."priority"
BEGIN
  DELETE FROM "session_list_trace_projection"
  WHERE "session_id" IN (
    SELECT "session_id" FROM "session_artifact_links"
    WHERE "artifact_id" IN (OLD."id", NEW."id")
  );
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_pr_insert"
AFTER INSERT ON "pull_requests"
BEGIN
  DELETE FROM "session_list_trace_projection"
  WHERE "session_id" IN (
    SELECT "session_id" FROM "pull_requests"
    WHERE "repo_full_name" = NEW."repo_full_name" AND "pr_number" = NEW."pr_number"
  ) OR "session_id" IN (
    SELECT sal."session_id"
    FROM "session_artifact_links" sal
    JOIN "artifacts" a ON a."id" = sal."artifact_id"
    WHERE a."repo_full_name" = NEW."repo_full_name" AND a."pr_number" = NEW."pr_number"
  );
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_pr_update"
AFTER UPDATE ON "pull_requests"
BEGIN
  DELETE FROM "session_list_trace_projection"
  WHERE "session_id" IN (OLD."session_id", NEW."session_id")
     OR "session_id" IN (
       SELECT "session_id" FROM "pull_requests"
       WHERE ("repo_full_name" = OLD."repo_full_name" AND "pr_number" = OLD."pr_number")
          OR ("repo_full_name" = NEW."repo_full_name" AND "pr_number" = NEW."pr_number")
     ) OR "session_id" IN (
       SELECT sal."session_id"
       FROM "session_artifact_links" sal
       JOIN "artifacts" a ON a."id" = sal."artifact_id"
       WHERE (a."repo_full_name" = OLD."repo_full_name" AND a."pr_number" = OLD."pr_number")
          OR (a."repo_full_name" = NEW."repo_full_name" AND a."pr_number" = NEW."pr_number")
     );
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_pr_delete"
AFTER DELETE ON "pull_requests"
BEGIN
  DELETE FROM "session_list_trace_projection"
  WHERE "session_id" = OLD."session_id"
     OR "session_id" IN (
       SELECT "session_id" FROM "pull_requests"
       WHERE "repo_full_name" = OLD."repo_full_name" AND "pr_number" = OLD."pr_number"
     ) OR "session_id" IN (
       SELECT sal."session_id"
       FROM "session_artifact_links" sal
       JOIN "artifacts" a ON a."id" = sal."artifact_id"
       WHERE a."repo_full_name" = OLD."repo_full_name" AND a."pr_number" = OLD."pr_number"
     );
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_pr_status_insert"
AFTER INSERT ON "pull_request_status_observations"
BEGIN
  DELETE FROM "session_list_trace_projection"
  WHERE "session_id" IN (
    SELECT "session_id" FROM "pull_requests"
    WHERE "repo_full_name" = NEW."repo_full_name" AND "pr_number" = NEW."pr_number"
  );
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_pr_status_update"
AFTER UPDATE ON "pull_request_status_observations"
BEGIN
  DELETE FROM "session_list_trace_projection"
  WHERE "session_id" IN (
    SELECT "session_id" FROM "pull_requests"
    WHERE ("repo_full_name" = OLD."repo_full_name" AND "pr_number" = OLD."pr_number")
       OR ("repo_full_name" = NEW."repo_full_name" AND "pr_number" = NEW."pr_number")
  );
END;

CREATE TRIGGER IF NOT EXISTS "invalidate_session_list_trace_projection_pr_status_delete"
AFTER DELETE ON "pull_request_status_observations"
BEGIN
  DELETE FROM "session_list_trace_projection"
  WHERE "session_id" IN (
    SELECT "session_id" FROM "pull_requests"
    WHERE "repo_full_name" = OLD."repo_full_name" AND "pr_number" = OLD."pr_number"
  );
END;
