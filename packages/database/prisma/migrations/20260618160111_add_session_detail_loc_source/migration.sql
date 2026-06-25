-- Provenance of the flattened lines_*/files_changed scalars. "git" marks
-- desktop-synced gitDiffStats (source-tagged git diff) so readers can rehydrate
-- gitDiffStats and distinguish git-derived LOC from agent-estimated scalars.
-- AlterTable
ALTER TABLE "session_detail" ADD COLUMN     "loc_source" TEXT;
