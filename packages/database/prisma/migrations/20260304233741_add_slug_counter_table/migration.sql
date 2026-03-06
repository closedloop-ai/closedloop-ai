-- CreateTable
CREATE TABLE "slug_counters" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "type_prefix" TEXT NOT NULL,
    "current_value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "slug_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "slug_counters_organization_id_type_prefix_key" ON "slug_counters"("organization_id", "type_prefix");
