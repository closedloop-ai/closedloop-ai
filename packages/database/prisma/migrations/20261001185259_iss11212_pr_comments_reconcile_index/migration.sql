-- ISS-11212 (PLN-2122 Step 2): the comment-reconcile cron's due-PR scan, which
-- PLN-2122 Step 5 orders by `comments_reconciled_at` with nulls (never
-- reconciled) first. PSL has no `nulls` argument on `@@index`, so NULLS FIRST
-- is hand-written here; the btree's default would put those PRs last. Prisma
-- cannot express a concurrent index build either. Keep this as one bare
-- statement so deployment does not block writes or accept an invalid prior
-- index.
-- CreateIndex
CREATE INDEX CONCURRENTLY "pull_request_detail_pr_state_comments_reconciled_at_idx" ON "pull_request_detail"("pr_state", "comments_reconciled_at" NULLS FIRST);
