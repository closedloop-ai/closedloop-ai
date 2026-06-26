-- CreateTable
CREATE TABLE "preview_schemas_observations" (
    "schema_name" TEXT NOT NULL,
    "first_observed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preview_schemas_observations_pkey" PRIMARY KEY ("schema_name")
);
