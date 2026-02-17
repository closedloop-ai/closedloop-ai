/*
  Warnings:

  - Made the column `comment` on table `pull_request_ratings` required. This step will fail if there are existing NULL values in that column.

*/
-- Backfill NULL comments so ALTER COLUMN can succeed
UPDATE "pull_request_ratings" SET "comment" = '' WHERE "comment" IS NULL;

-- AlterTable
ALTER TABLE "pull_request_ratings" ALTER COLUMN "comment" SET NOT NULL;
