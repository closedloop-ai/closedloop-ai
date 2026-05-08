-- CreateTable
CREATE TABLE "compute_target_health_checks" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "compute_target_id" UUID NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL,
    "expected_mcp_url" TEXT,
    "latest_version" TEXT,
    "result" JSONB NOT NULL,
    "all_required_passed" BOOLEAN NOT NULL,
    "required_failure_ids" JSONB NOT NULL DEFAULT '[]',
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compute_target_health_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "compute_target_health_checks_compute_target_id_key" ON "compute_target_health_checks"("compute_target_id");

-- CreateIndex
CREATE INDEX "compute_target_health_checks_organization_id_checked_at_idx" ON "compute_target_health_checks"("organization_id", "checked_at");

-- AddForeignKey
ALTER TABLE "compute_target_health_checks" ADD CONSTRAINT "compute_target_health_checks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compute_target_health_checks" ADD CONSTRAINT "compute_target_health_checks_compute_target_id_fkey" FOREIGN KEY ("compute_target_id") REFERENCES "compute_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
