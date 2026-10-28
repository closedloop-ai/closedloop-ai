-- AlterTable
ALTER TABLE "branch_activity_atoms" ADD COLUMN     "after_sha" VARCHAR(64),
ADD COLUMN     "before_sha" VARCHAR(64),
ADD COLUMN     "lines_added" INTEGER,
ADD COLUMN     "lines_removed" INTEGER;
