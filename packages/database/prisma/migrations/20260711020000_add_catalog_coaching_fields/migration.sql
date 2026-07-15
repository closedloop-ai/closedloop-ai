-- Migration: add_catalog_coaching_fields (T-22.1)
-- Coaching Packs sub-slice: extend CatalogItem with coaching discriminator and
-- coachingConfig payload; extend DistributionTargetStatus with overriddenLocally
-- to encode the first-seed-only / user-choice-preserved invariant.
-- All additions are additive (DEFAULT values; no existing rows affected).

-- AlterTable: catalog_items — add coaching flag and coachingConfig payload
ALTER TABLE "catalog_items"
    ADD COLUMN "coaching" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "coaching_config" JSONB;

-- AlterTable: distribution_target_status — add overriddenLocally flag
ALTER TABLE "distribution_target_status"
    ADD COLUMN "overridden_locally" BOOLEAN NOT NULL DEFAULT false;
