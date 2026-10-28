-- ISS-10966 (PLN-2095 Slice 1): the one-time code minted for a freshly
-- signed-up user who has NO organization yet, so a Desktop-originated signup
-- returns to Desktop instead of finishing organization setup in the browser.
--
-- Purely additive: no existing table is altered, and `desktop_authorization_codes`
-- keeps its non-null `user_id` / `organization_id` untouched. Rollback is
-- `DROP TABLE "desktop_bootstrap_codes"` and nothing else.
--
-- A SEPARATE TABLE, not nullable columns on the sibling. There is no internal
-- `user` row to point at at mint time (`apps/api/lib/auth/find-or-create-user.ts`
-- resolves users only as `(clerkUserId, clerkOrgId)` pairs), and nulling the
-- sibling's ownership columns would be a constraint-RELAXING change, which
-- `packages/database/AGENTS.md` requires be split across merges because on stage
-- the schema lags the bundle. An added table cannot be split at all and needs no
-- such window.
--
-- DARK ON PURPOSE. Nothing reads or writes these rows in this change: the mint
-- route is PLN-2095 Slice 2 and the redeem is Slice 3. The table ships ahead of
-- them so the write path lands against a schema that is already deployed.
--
-- HAND EDIT: the DDL below is Prisma-generated; only this header and the
-- `IF NOT EXISTS` plus `index-lock-ok` markers on the two CREATE INDEX
-- statements were added, because `scripts/lint/check-destructive-migrations.ts`
-- requires both for a reviewed plain (non-CONCURRENTLY) index build. The
-- matching INDEX_LOCK_ALLOWLIST entries live in
-- `scripts/lint/destructive-migrations/index-lock-allowlist.ts`.

-- CreateTable
CREATE TABLE "desktop_bootstrap_codes" (
    "id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "clerk_user_id" TEXT NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "bound_public_key" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "redeemed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "desktop_bootstrap_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- index-lock-ok(desktop_bootstrap_codes): table is created empty in this same migration so both the single-use code-hash unique and the expiry-sweep index build against zero rows with no concurrent writer, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE UNIQUE INDEX IF NOT EXISTS "desktop_bootstrap_codes_code_hash_key" ON "desktop_bootstrap_codes"("code_hash");

-- CreateIndex
-- index-lock-ok(desktop_bootstrap_codes): table is created empty in this same migration so both the single-use code-hash unique and the expiry-sweep index build against zero rows with no concurrent writer, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE INDEX IF NOT EXISTS "desktop_bootstrap_codes_expires_at_idx" ON "desktop_bootstrap_codes"("expires_at");
