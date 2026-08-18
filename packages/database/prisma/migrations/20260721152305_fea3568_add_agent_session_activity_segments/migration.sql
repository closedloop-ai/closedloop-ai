-- CreateTable
CREATE TABLE "agent_session_activity_segments" (
    "id" UUID NOT NULL,
    "agent_session_id" UUID NOT NULL,
    "phase" TEXT NOT NULL,
    "start_ms" BIGINT NOT NULL,
    "end_ms" BIGINT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidence_layers" JSONB NOT NULL,
    "classifier_version" INTEGER NOT NULL,
    "work_item_ref" TEXT,
    "subagent_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_session_activity_segments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_session_activity_segments_agent_session_id_idx" ON "agent_session_activity_segments"("agent_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_session_activity_segments_agent_session_id_start_ms_key" ON "agent_session_activity_segments"("agent_session_id", "start_ms");

-- AddForeignKey
ALTER TABLE "agent_session_activity_segments" ADD CONSTRAINT "agent_session_activity_segments_agent_session_id_fkey" FOREIGN KEY ("agent_session_id") REFERENCES "session_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;
