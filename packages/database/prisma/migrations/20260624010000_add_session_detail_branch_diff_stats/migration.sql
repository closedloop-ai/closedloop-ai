-- Branch-level LOC (working-branch changes vs the author's contributed lines):
-- a distinct metric from the authored gitDiffStats scalars, persisted in its own
-- columns so the two never collide. branch_loc_source records provenance ("git")
-- independently of loc_source, letting readers rehydrate branchDiffStats.
-- AlterTable
ALTER TABLE "session_detail" ADD COLUMN     "branch_lines_added" INTEGER,
ADD COLUMN     "branch_lines_removed" INTEGER,
ADD COLUMN     "branch_files_changed" INTEGER,
ADD COLUMN     "branch_loc_source" TEXT;
