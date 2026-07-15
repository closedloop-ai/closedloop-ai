-- FEA-2775: Hash OAuth authorization codes at rest (EXPAND phase).
-- Introduce a SHA-256 `code_fingerprint` column mirroring
-- oauth_refresh_tokens.token_fingerprint and desktop_authorization_codes.code_hash
-- so a DB read no longer needs the raw code to look a row up.
--
-- ROLLOUT SAFETY (Prisma-inexpressible; hand-written for this reason): the MCP
-- server is deployed as a separate Dockerized app (build-mcp-server.yml) that
-- rolls independently of the Vercel API deploy whose `packages/database`
-- prebuild applies this migration. During that skew window the still-live *old*
-- MCP code reads/writes the plaintext `code` column while the new MCP code
-- reads/writes `code_fingerprint`. So this is an ADDITIVE, backward-compatible
-- expand phase:
--   * `code` is KEPT but made NULLABLE (new-code inserts omit it -> NULL is OK).
--   * `code_fingerprint` is added NULLABLE (old-code inserts omit it -> NULL is OK).
--   * existing in-flight rows are NOT deleted; both code paths keep working.
-- A follow-up CONTRACT migration (after the new MCP image is fully rolled out)
-- drops `code` and enforces `code_fingerprint NOT NULL`. Postgres unique indexes
-- permit multiple NULLs, so both unique constraints coexist during the skew.

-- AlterTable: relax `code` NOT NULL so new-code inserts that only set
-- `code_fingerprint` succeed. The existing unique index on `code` is retained
-- so old MCP `findUnique({ where: { code } })` still resolves.
ALTER TABLE "oauth_authorization_codes" ALTER COLUMN "code" DROP NOT NULL;

-- AlterTable: add the nullable fingerprint column.
ALTER TABLE "oauth_authorization_codes" ADD COLUMN "code_fingerprint" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "oauth_authorization_codes_code_fingerprint_key" ON "oauth_authorization_codes"("code_fingerprint");
