-- CreateTable
CREATE TABLE "agent_session_events" (
    "id" UUID NOT NULL,
    "agent_session_id" UUID NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "agent_external_id" TEXT,
    "event_type" TEXT NOT NULL,
    "tool_name" TEXT,
    "summary" TEXT,
    "data" JSONB,
    "event_created_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_session_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_session_events_agent_session_id_external_event_id_key" ON "agent_session_events"("agent_session_id", "external_event_id");

-- CreateIndex
CREATE INDEX "agent_session_events_agent_session_id_event_created_at_idx" ON "agent_session_events"("agent_session_id", "event_created_at");

-- AddForeignKey
ALTER TABLE "agent_session_events" ADD CONSTRAINT "agent_session_events_agent_session_id_fkey" FOREIGN KEY ("agent_session_id") REFERENCES "agent_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- MigrateData: Copy existing JSON events into child table
INSERT INTO "agent_session_events" (
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
    s."id",
    e->>'externalEventId',
    NULLIF(e->>'agentExternalId', ''),
    COALESCE(e->>'eventType', 'unknown'),
    NULLIF(e->>'toolName', ''),
    NULLIF(e->>'summary', ''),
    CASE WHEN e->'data' IS NOT NULL AND e->>'data' != 'null' THEN e->'data' ELSE NULL END,
    COALESCE((e->>'createdAt')::timestamp, s."session_started_at")
FROM "agent_sessions" s,
     jsonb_array_elements(s."events") e
WHERE jsonb_array_length(s."events") > 0
  AND e->>'externalEventId' IS NOT NULL
  AND e->>'externalEventId' != ''
ON CONFLICT ("agent_session_id", "external_event_id") DO NOTHING;

-- DropColumn
ALTER TABLE "agent_sessions" DROP COLUMN "events";
