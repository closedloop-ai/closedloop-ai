-- ISS-10721: cloud twin of the desktop `session_activity_metrics` rollup.
-- Every measure is NULLable with no default: NULL means "not computed", and a
-- zero default would state a real measurement (0% coverage, 0 segments) for
-- every session whose rollup has never run.
-- CreateTable
CREATE TABLE "agent_session_activity_metrics" (
    "agent_session_id" UUID NOT NULL,
    "autonomy_band" TEXT,
    "coverage" DOUBLE PRECISION,
    "spend_low_conf_usd" DECIMAL(14,6),
    "spend_medium_conf_usd" DECIMAL(14,6),
    "spend_high_conf_usd" DECIMAL(14,6),
    "segment_count" INTEGER,
    "covered_segment_count" INTEGER,
    "classifier_version" INTEGER,
    "metric_version" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_session_activity_metrics_pkey" PRIMARY KEY ("agent_session_id")
);

-- AddForeignKey
ALTER TABLE "agent_session_activity_metrics" ADD CONSTRAINT "agent_session_activity_metrics_agent_session_id_fkey" FOREIGN KEY ("agent_session_id") REFERENCES "session_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;
