-- CreateEnum
CREATE TYPE "PreferredComputeMode" AS ENUM ('LOCAL', 'CLOUD');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "preferred_compute_mode" "PreferredComputeMode";
