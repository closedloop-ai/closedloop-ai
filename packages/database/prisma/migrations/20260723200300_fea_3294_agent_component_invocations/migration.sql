-- CreateTable
CREATE TABLE "agent_component_invocation_generations" (
    "id" UUID NOT NULL,
    "agent_session_id" UUID NOT NULL,
    "external_generation_id" TEXT NOT NULL,
    "source_updated_at" TIMESTAMP(3) NOT NULL,
    "data_revision" INTEGER NOT NULL,
    "source_sequence" INTEGER NOT NULL,
    "expected_part_count" INTEGER NOT NULL,
    "active_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_component_invocation_generations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_component_invocation_parts" (
    "id" UUID NOT NULL,
    "generation_id" UUID NOT NULL,
    "part_index" INTEGER NOT NULL,
    "part_hash" TEXT NOT NULL,
    "item_count" INTEGER NOT NULL,
    "payload_bytes" INTEGER NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_component_invocation_parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_component_invocations" (
    "id" UUID NOT NULL,
    "generation_id" UUID NOT NULL,
    "part_id" UUID NOT NULL,
    "external_invocation_id" TEXT NOT NULL,
    "source_session_id" TEXT NOT NULL,
    "child_session_id" TEXT,
    "parent_external_invocation_id" TEXT,
    "external_agent_id" TEXT,
    "component_kind" TEXT NOT NULL,
    "component_key" TEXT NOT NULL,
    "raw_name" TEXT,
    "normalized_name" TEXT,
    "relationship" TEXT NOT NULL,
    "invoked_at" TIMESTAMP(3),
    "sequence" INTEGER NOT NULL,
    "anchor" JSONB NOT NULL,
    "provider_invocation_id" TEXT,
    "attribution_status" TEXT NOT NULL,
    "evidence_class" TEXT NOT NULL,
    "definition_hash" TEXT,
    "normalizer_contract_version" INTEGER,
    "definition_content" TEXT,
    "definition_format" TEXT,
    "source_path" TEXT,
    "source_modified_at" TIMESTAMP(3),
    "captured_at" TIMESTAMP(3),
    "repository_full_name" TEXT,
    "repository_commit" TEXT,
    "pack_id" TEXT,
    "branch_name" TEXT,
    "agent_component_id" UUID,
    "definition_version_id" UUID,
    "source_occurrence_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_component_invocations_pkey" PRIMARY KEY ("id")
);

-- FEA-3290's compound Prisma unique index cannot deduplicate repository/pack
-- provenance because PostgreSQL treats a NULL compute_target_id as distinct.
-- Preserve the freshest row, merge its observation window, and enforce the
-- null-target natural key before invocation ingestion can reference it.
WITH ranked AS (
    SELECT
        "id",
        FIRST_VALUE("id") OVER (
            PARTITION BY
                "definition_version_id",
                "occurrence_type",
                COALESCE("repo_full_name", ''),
                COALESCE("repo_path", ''),
                COALESCE("repo_commit", ''),
                COALESCE("local_path", ''),
                COALESCE("pack_id", '')
            ORDER BY "last_seen_at" DESC, "id"
        ) AS "keeper_id",
        MIN("first_seen_at") OVER (
            PARTITION BY
                "definition_version_id",
                "occurrence_type",
                COALESCE("repo_full_name", ''),
                COALESCE("repo_path", ''),
                COALESCE("repo_commit", ''),
                COALESCE("local_path", ''),
                COALESCE("pack_id", '')
        ) AS "earliest_first_seen_at",
        MAX("last_seen_at") OVER (
            PARTITION BY
                "definition_version_id",
                "occurrence_type",
                COALESCE("repo_full_name", ''),
                COALESCE("repo_path", ''),
                COALESCE("repo_commit", ''),
                COALESCE("local_path", ''),
                COALESCE("pack_id", '')
        ) AS "latest_last_seen_at"
    FROM "source_occurrences"
    WHERE "compute_target_id" IS NULL
), merged AS (
    UPDATE "source_occurrences" AS "keeper"
    SET
        "first_seen_at" = "bounds"."earliest_first_seen_at",
        "last_seen_at" = "bounds"."latest_last_seen_at",
        "updated_at" = CURRENT_TIMESTAMP
    FROM (
        SELECT DISTINCT
            "keeper_id",
            "earliest_first_seen_at",
            "latest_last_seen_at"
        FROM ranked
    ) AS "bounds"
    WHERE "keeper"."id" = "bounds"."keeper_id"
    RETURNING "keeper"."id"
)
DELETE FROM "source_occurrences" AS "duplicate"
USING ranked
WHERE "duplicate"."id" = ranked."id"
  AND ranked."id" <> ranked."keeper_id";

-- Prisma cannot express a partial expression index. COALESCE also protects
-- legacy rows whose non-participating evidence columns predate writer
-- normalization to empty strings.
CREATE UNIQUE INDEX "idx_source_occurrence_null_target_natural_key"
ON "source_occurrences" (
    "definition_version_id",
    "occurrence_type",
    (COALESCE("repo_full_name", '')),
    (COALESCE("repo_path", '')),
    (COALESCE("repo_commit", '')),
    (COALESCE("local_path", '')),
    (COALESCE("pack_id", ''))
)
WHERE "compute_target_id" IS NULL;

-- CreateIndex
CREATE INDEX "idx_acig_session_active" ON "agent_component_invocation_generations"("agent_session_id", "active_at");

-- CreateIndex
CREATE INDEX "idx_acig_session_source_freshness" ON "agent_component_invocation_generations"("agent_session_id", "source_updated_at", "data_revision", "source_sequence");

-- CreateIndex
CREATE UNIQUE INDEX "idx_acig_session_external_generation_freshness" ON "agent_component_invocation_generations"("agent_session_id", "external_generation_id", "source_updated_at", "data_revision", "source_sequence");

-- Prisma cannot express partial unique indexes. This is the database-level
-- finalization guard: at most one generation may be active for a session.
CREATE UNIQUE INDEX "idx_acig_one_active_per_session" ON "agent_component_invocation_generations"("agent_session_id") WHERE "active_at" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "idx_acip_generation_part" ON "agent_component_invocation_parts"("generation_id", "part_index");

-- CreateIndex
CREATE INDEX "idx_aci_generation_sequence" ON "agent_component_invocations"("generation_id", "sequence");

-- CreateIndex
CREATE INDEX "idx_aci_component_invoked_at" ON "agent_component_invocations"("agent_component_id", "invoked_at");

-- CreateIndex
CREATE INDEX "idx_aci_component_branch_invoked_at" ON "agent_component_invocations"("agent_component_id", "branch_name", "invoked_at");

-- CreateIndex
CREATE INDEX "idx_aci_definition_version_invoked_at" ON "agent_component_invocations"("definition_version_id", "invoked_at");

-- CreateIndex
CREATE INDEX "idx_aci_status_invoked_at" ON "agent_component_invocations"("attribution_status", "invoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "idx_aci_generation_external_invocation" ON "agent_component_invocations"("generation_id", "external_invocation_id");

-- AddForeignKey
ALTER TABLE "agent_component_invocation_generations" ADD CONSTRAINT "fk_acig_session" FOREIGN KEY ("agent_session_id") REFERENCES "session_detail"("artifact_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_component_invocation_parts" ADD CONSTRAINT "fk_acip_generation" FOREIGN KEY ("generation_id") REFERENCES "agent_component_invocation_generations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_component_invocations" ADD CONSTRAINT "fk_aci_generation" FOREIGN KEY ("generation_id") REFERENCES "agent_component_invocation_generations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_component_invocations" ADD CONSTRAINT "fk_aci_part" FOREIGN KEY ("part_id") REFERENCES "agent_component_invocation_parts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_component_invocations" ADD CONSTRAINT "fk_aci_component" FOREIGN KEY ("agent_component_id") REFERENCES "agent_components"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_component_invocations" ADD CONSTRAINT "fk_aci_definition_version" FOREIGN KEY ("definition_version_id") REFERENCES "definition_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_component_invocations" ADD CONSTRAINT "fk_aci_source_occurrence" FOREIGN KEY ("source_occurrence_id") REFERENCES "source_occurrences"("id") ON DELETE SET NULL ON UPDATE CASCADE;
