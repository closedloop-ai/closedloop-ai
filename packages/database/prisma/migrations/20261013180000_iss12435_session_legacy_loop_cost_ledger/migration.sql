-- ISS-12435 (PRD-795), step 1 of 3: the nullable column that carries a
-- loop-originated session's usage cost-split ledger once `loops` is emptied.
--
-- Alone in its own migration so the ACCESS EXCLUSIVE lock an ADD COLUMN takes
-- on `session_detail` is held for the catalog change only, never across the
-- data statements of the next two migrations. A nullable column without a
-- default is a catalog-only change in Postgres (no table rewrite).

SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "session_detail" ADD COLUMN     "legacy_loop_cost_ledger" TEXT;

RESET lock_timeout;
