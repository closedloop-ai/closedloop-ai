-- ISS-10565: the Branch analytics refresh pass's reconciled-through receive
-- cursor (`branchSessionReceivedSinceMaterializedSql`). Its own migration
-- because 20261006160000 is one bare CONCURRENTLY statement.

-- AlterTable
ALTER TABLE "branch_analytics_rollup_states" ADD COLUMN     "reconciled_through_at" TIMESTAMPTZ;
