-- FEA-3275: Hash OAuth authorization codes at rest (CONTRACT phase).
-- Completes the expand/contract pair opened by FEA-2775
-- (20260712120000_hash_oauth_authorization_codes), which deliberately shipped
-- only the additive half: it kept the plaintext `code` column so the
-- independently-deployed MCP server could roll without a skew outage.
--
-- WHY IT IS SAFE TO CONTRACT NOW (the precondition that migration named):
--   * apps/mcp no longer touches `code` on any path — it writes only
--     `code_fingerprint` (index.ts:834) and reads only by it (index.ts:855,
--     index.ts:2823). No `where: { code }` and no plaintext write survive.
--   * That image is live: FEA-2775 (348a90a60, #2691) is an ancestor of
--     `origin/production`, which last advanced 2026-07-15.
--   * No other consumer reads or writes `code`. The only other references to
--     this table are org-scoped deletes/counts in the seed reset script, a
--     seed integration fixture that already sets `code_fingerprint` and never
--     `code`, and an expiry-cleanup type in apps/mcp — none of which name the
--     column.
-- So the skew window FEA-2775 was protecting against has closed.
--
-- Hand-written (not `prisma migrate dev`-generated) for the same reason the
-- expand half was: the row-deletion step below is Prisma-inexpressible, and it
-- MUST precede the NOT NULL enforcement.

-- Step 1 — drop legacy plaintext-only rows.
-- These are pre-FEA-2775 rows written by the old MCP image: they carry `code`
-- and a NULL `code_fingerprint`. They must go before `code_fingerprint` can be
-- enforced NOT NULL, and deleting them is safe rather than backfilling a
-- fingerprint from `code`: authorization codes are single-use (`consumed_at`)
-- and short-TTL (`expires_at`, 10 minutes), so every such row is long expired
-- and unredeemable. Backfilling would also mean re-reading the very plaintext
-- this migration exists to destroy. A redemption attempt against a deleted row
-- fails closed — the same 'invalid code' the client already handles.
DELETE FROM "oauth_authorization_codes" WHERE "code_fingerprint" IS NULL;

-- Step 2 — drop the plaintext column. Postgres drops the dependent unique index
-- ("oauth_authorization_codes_code_key") with it, so no explicit DropIndex.
ALTER TABLE "oauth_authorization_codes" DROP COLUMN "code";

-- Step 3 — the fingerprint is now the sole addressing key, so require it. Its
-- unique index (created by the expand migration) is retained.
ALTER TABLE "oauth_authorization_codes" ALTER COLUMN "code_fingerprint" SET NOT NULL;
