-- CreateTable
CREATE TABLE "compute_targets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "machine_name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "supported_operations" JSONB NOT NULL DEFAULT '[]',
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_online" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compute_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "compute_targets_user_id_machine_name_key" ON "compute_targets"("user_id", "machine_name");

-- CreateIndex
CREATE INDEX "compute_targets_organization_id_user_id_idx" ON "compute_targets"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "compute_targets_user_id_is_online_idx" ON "compute_targets"("user_id", "is_online");
