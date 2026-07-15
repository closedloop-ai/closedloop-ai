-- perf (#2481): partial indexes to bound the boot-time reprice scan.
--
-- `repriceUnpricedTokenUsage` issues a `SELECT DISTINCT session_id FROM
-- token_usage WHERE cost_usd_estimated IS NULL OR baseline_input > 0 OR ...`
-- at every startup. Without an index covering those predicates the engine must
-- perform a full table scan across all token_usage rows on every boot, even
-- after all rows are correctly priced.
--
-- Two partial indexes cover the two populations the query targets:
--
--  1. idx_token_usage_unpriced — covers rows with no cost estimate yet. Once
--     the repricer fills `cost_usd_estimated` the row leaves this index and is
--     never scanned again. This is the common steady-state population after a
--     fresh session is written.
--
--  2. idx_token_usage_compacted — covers rows from compacted sessions (where
--     any baseline_* column is > 0). Pre-FEA-2879 rows in this set may carry
--     an under-counted cost; the repricer fixes them once and the convergence
--     guard (`storedCost === estimate.costUsd`) then skips them, but without
--     this index the full scan still touches every row on every boot to evaluate
--     the baseline predicate. The index restricts the scan to only the compacted
--     rows, which are a small fraction of all token_usage rows for most installs.
--
-- Both indexes are partial and narrow (session_id only), so the storage
-- overhead is minimal. `CREATE INDEX IF NOT EXISTS` makes this migration a
-- no-op when the index already exists (safe re-run).
CREATE INDEX IF NOT EXISTS "idx_token_usage_unpriced"
  ON "token_usage"("session_id")
  WHERE cost_usd_estimated IS NULL;

CREATE INDEX IF NOT EXISTS "idx_token_usage_compacted"
  ON "token_usage"("session_id")
  WHERE baseline_input > 0
     OR baseline_output > 0
     OR baseline_cache_read > 0
     OR baseline_cache_write > 0;
