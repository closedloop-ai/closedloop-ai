/*
  Warnings:

  - Made the column `project_id` on table `external_links` required. This step will fail if there are existing NULL values in that column.
  - Made the column `project_id` on table `issues` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "external_links" ALTER COLUMN "project_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "issues" ALTER COLUMN "project_id" SET NOT NULL;
