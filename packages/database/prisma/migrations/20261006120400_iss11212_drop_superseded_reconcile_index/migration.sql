-- ISS-11212 (PLN-2120 Step 6 cleanup): drops
-- `pull_request_detail_pr_state_comments_reconciled_at_idx`
-- (20261001185259_iss11212_pr_comments_reconcile_index), superseded by
-- `pull_request_detail_comments_reconcile_due_idx`
-- (20261002161501_iss11212_pr_comments_reconcile_due_index), which carries the
-- comment-reconcile cron's due-PR scan. The cron's overdue count also filters
-- `pr_state` and `comments_reconciled_at`; it loses this index's range on
-- `comments_reconciled_at`, and the due index still leads with `pr_state`.
--
-- A plain DROP INDEX, as 20260722000001_prd536_g7_drop_redundant_org_index
-- does: check-destructive-migrations rejects DROP INDEX CONCURRENTLY in any
-- migration. The drop only unlinks catalog entries, so its ACCESS EXCLUSIVE
-- lock on `pull_request_detail` lasts for that change; `lock_timeout` bounds
-- the wait behind a long transaction, so writers do not queue behind it.
SET lock_timeout = '5s';

-- index-lock-ok(pull_request_detail): dropping an index unlinks catalog entries without scanning or rewriting the table, so the ACCESS EXCLUSIVE lock lasts only for that change, lock_timeout bounds its wait behind a long transaction, and DROP INDEX CONCURRENTLY is rejected by this gate
-- DropIndex
DROP INDEX IF EXISTS "pull_request_detail_pr_state_comments_reconciled_at_idx";

RESET lock_timeout;
