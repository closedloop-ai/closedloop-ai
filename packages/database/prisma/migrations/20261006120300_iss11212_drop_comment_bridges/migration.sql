-- ISS-11212 (PLN-2120 Step 6 cleanup): drops the three rolling-deploy bridges
-- once no api bundle that needs them can serve. HAND-WRITTEN: Prisma does not
-- model triggers or functions.
--   - 20260930150000_iss11212_comment_contract_core: the `body_format` bridge on
--     `comments` and the trace anchor bridge on `comment_threads`, for bundles
--     built before ISS-11212.
--   - 20261001185258_iss11212_github_comment_sync: the GitHub anchor bridge on
--     `github_comment_thread_projections` and the anchor function it calls, for
--     bundles built before PLN-2122 Step 3.
-- Production serves a bundle carrying #8321, which writes `body_format`, the
-- anchor column and the GitHub anchors itself, so no serving bundle relies on
-- a bridge. Each trigger goes before the function it executes, and every
-- statement is safe to re-run after a partial apply.
SET lock_timeout = '5s';

DROP TRIGGER IF EXISTS "comments_iss11212_body_format_bridge" ON "comments";
DROP FUNCTION IF EXISTS "iss11212_comments_body_format_bridge"();

DROP TRIGGER IF EXISTS "comment_threads_iss11212_anchor_bridge" ON "comment_threads";
DROP FUNCTION IF EXISTS "iss11212_comment_threads_anchor_bridge"();

DROP TRIGGER IF EXISTS "github_comment_thread_projections_iss11212_anchor_bridge" ON "github_comment_thread_projections";
DROP FUNCTION IF EXISTS "iss11212_github_thread_anchor_bridge"();
DROP FUNCTION IF EXISTS "iss11212_github_thread_anchor"("github_comment_thread_projections", text);

RESET lock_timeout;
