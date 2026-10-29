-- ISS-8399: the provider-keyed delivery-point association store.
--
-- Holds one row per external numerator provider's own delivery record, matched
-- to our pull requests and artifacts. Additive and dark: nothing reads these
-- rows yet, and no numerator changes.
--
-- IDEMPOTENCY: `(organization_id, provider, provider_item_id)` is the upsert
-- key. Provider delivery windows overlap by design, so the same row arrives on
-- every backfill pass; every write restates the provider's measured value and
-- nothing sums, or the numerator would inflate a little on every run forever.
--
-- THREE ZEROS stay distinct: `points = 0` with `match_outcome = MATCHED` is a
-- measured zero; an unmatched row is not a zero; a pull request with no row at
-- all has not been backfilled. `match_outcome` is what keeps them apart, and it
-- also separates a TERMINAL unmatched row (UNMATCHABLE) from a PROVISIONAL one
-- whose pull-request number no window has supplied yet (PENDING_REFERENCE).

-- CreateEnum
CREATE TYPE "DeliveryPointProvider" AS ENUM ('PENSERO');

-- CreateEnum
CREATE TYPE "DeliveryItemType" AS ENUM ('PULL_REQUEST', 'PULL_REQUEST_REVIEW', 'MESSAGING', 'TICKET', 'OTHER');

-- CreateEnum
CREATE TYPE "DeliveryContributorRole" AS ENUM ('CREATOR', 'REVIEWER', 'ASSIGNEE', 'OTHER');

-- CreateEnum
CREATE TYPE "DeliveryMatchOutcome" AS ENUM ('MATCHED', 'NO_COUNTERPART', 'AMBIGUOUS', 'UNMATCHABLE', 'PENDING_REFERENCE');

-- CreateEnum
CREATE TYPE "DeliveryArtifactLinkSource" AS ENUM ('OUR_LINKS');

-- CreateTable
CREATE TABLE "delivery_points" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider" "DeliveryPointProvider" NOT NULL,
    "provider_item_id" TEXT NOT NULL,
    "provider_interaction_id" TEXT,
    "item_type" "DeliveryItemType" NOT NULL,
    "raw_item_type" TEXT NOT NULL,
    "role" "DeliveryContributorRole" NOT NULL,
    "raw_role" TEXT NOT NULL,
    "points" DECIMAL(12,4) NOT NULL,
    "delivered_on" DATE NOT NULL,
    "title" TEXT NOT NULL,
    "provider_person_id" TEXT NOT NULL,
    "person_email" TEXT NOT NULL,
    "user_id" UUID,
    "repository_full_name" TEXT,
    "pull_request_number" INTEGER,
    "pull_request_detail_id" UUID,
    "branch_artifact_id" UUID,
    "match_outcome" "DeliveryMatchOutcome" NOT NULL,
    "extracted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_point_artifacts" (
    "delivery_point_id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "source" "DeliveryArtifactLinkSource" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_point_artifacts_pkey" PRIMARY KEY ("delivery_point_id","artifact_id")
);

-- CreateIndex
-- index-lock-ok(delivery_points): table is created empty in this same migration so every index builds against zero rows with no concurrent writer, the (org, provider, provider_item_id) unique is the backfill's ON CONFLICT target and must exist before the first upsert, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "delivery_points_org_provider_delivered_idx" ON "delivery_points"("organization_id", "provider", "delivered_on");

-- CreateIndex
-- index-lock-ok(delivery_points): table is created empty in this same migration so every index builds against zero rows with no concurrent writer, the (org, provider, provider_item_id) unique is the backfill's ON CONFLICT target and must exist before the first upsert, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "delivery_points_org_provider_branch_idx" ON "delivery_points"("organization_id", "provider", "branch_artifact_id");

-- CreateIndex
-- index-lock-ok(delivery_points): table is created empty in this same migration so every index builds against zero rows with no concurrent writer, the (org, provider, provider_item_id) unique is the backfill's ON CONFLICT target and must exist before the first upsert, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "delivery_points_org_provider_interaction_idx" ON "delivery_points"("organization_id", "provider", "provider_interaction_id");

-- CreateIndex
-- index-lock-ok(delivery_points): table is created empty in this same migration so every index builds against zero rows with no concurrent writer, the (org, provider, provider_item_id) unique is the backfill's ON CONFLICT target and must exist before the first upsert, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_points_org_provider_item_key" ON "delivery_points"("organization_id", "provider", "provider_item_id");

-- CreateIndex
-- index-lock-ok(delivery_point_artifacts): table is created empty in this same migration so every index builds against zero rows with no concurrent writer, the (org, provider, provider_item_id) unique is the backfill's ON CONFLICT target and must exist before the first upsert, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "delivery_point_artifacts_org_artifact_idx" ON "delivery_point_artifacts"("organization_id", "artifact_id");

-- AddForeignKey
ALTER TABLE "delivery_points" ADD CONSTRAINT "delivery_points_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_points" ADD CONSTRAINT "delivery_points_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_points" ADD CONSTRAINT "delivery_points_pull_request_detail_id_fkey" FOREIGN KEY ("pull_request_detail_id") REFERENCES "pull_request_detail"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_points" ADD CONSTRAINT "delivery_points_branch_artifact_id_fkey" FOREIGN KEY ("branch_artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_point_artifacts" ADD CONSTRAINT "delivery_point_artifacts_delivery_point_id_fkey" FOREIGN KEY ("delivery_point_id") REFERENCES "delivery_points"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_point_artifacts" ADD CONSTRAINT "delivery_point_artifacts_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_point_artifacts" ADD CONSTRAINT "delivery_point_artifacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
