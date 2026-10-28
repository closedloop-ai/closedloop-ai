-- ISS-12709 (2 of 2): drop the unwritten `artifacts`, `pull_requests` and `sessions`
-- columns. The two partial indexes and the trigger that named them are dropped by
-- the previous migration; SQLite requires that before a column can go.
--
-- destructive-migration-ok(artifacts.head_sha): This is the desktop-local SQLite
-- store: the forward-only migration runner refuses to boot a downgraded app
-- against a store migrated by a newer build, so no stale reader sees the dropped
-- column. The value was a copy of the PR head from the removed GitHub
-- projection (ISS-12594); readers are removed in the same change.
-- destructive-migration-ok(artifacts.merge_commit_sha): Same reasoning; the
-- merge commit of the removed projection, no consumer outside it.
-- destructive-migration-ok(artifacts.pr_state): Same reasoning. No writer since
-- ISS-12594; the Sessions and Branches state comes from the cloud overlay.
-- destructive-migration-ok(artifacts.lines_added): Same reasoning; PR size from
-- the removed projection.
-- destructive-migration-ok(artifacts.lines_removed): Same reasoning.
-- destructive-migration-ok(artifacts.files_changed): Same reasoning.
-- destructive-migration-ok(artifacts.github_head_branch): Same reasoning; the PR
-- head GitHub confirmed (ISS-12344), written only by the removed projection.
ALTER TABLE "artifacts" DROP COLUMN "head_sha";
ALTER TABLE "artifacts" DROP COLUMN "merge_commit_sha";
ALTER TABLE "artifacts" DROP COLUMN "pr_state";
ALTER TABLE "artifacts" DROP COLUMN "lines_added";
ALTER TABLE "artifacts" DROP COLUMN "lines_removed";
ALTER TABLE "artifacts" DROP COLUMN "files_changed";
ALTER TABLE "artifacts" DROP COLUMN "github_head_branch";
-- destructive-migration-ok(pull_requests.state): No caller supplies a value: the
-- importer passes none and the enrichment runner that filled it is deleted, so
-- only values frozen from that era remain. Operator ruling 2026-10-19 drops it
-- with its readers and the `pr-store.ts` plumbing. Same downgrade protection as
-- above; not in a wire or cloud contract.
-- destructive-migration-ok(pull_requests.merged_at): Same ruling and reasoning.
ALTER TABLE "pull_requests" DROP COLUMN "state";
ALTER TABLE "pull_requests" DROP COLUMN "merged_at";
-- destructive-migration-ok(sessions.trace_phase_sources): No writer exists in
-- this build and the only desktop code naming it was a read list; the cloud
-- `session_detail` table carries its own copy.
-- destructive-migration-ok(sessions.throttle_sources): Same.
-- destructive-migration-ok(sessions.correction_sources): Same.
ALTER TABLE "sessions" DROP COLUMN "trace_phase_sources";
ALTER TABLE "sessions" DROP COLUMN "throttle_sources";
ALTER TABLE "sessions" DROP COLUMN "correction_sources";
