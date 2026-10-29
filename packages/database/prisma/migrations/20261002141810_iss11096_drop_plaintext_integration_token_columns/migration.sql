-- =============================================================================
-- ISS-11096 (ISS-5081 PR 3), drop half: remove the legacy plaintext OAuth
-- token columns from google_integrations and linear_integrations.
--
-- WHY IT IS SAFE TO DROP NOW (the precondition ISS-11096 names):
--   * No reader or writer remains. The contract PR, #8184, marked all four
--     fields `@ignore`, so the generated Prisma client neither selects,
--     returns nor writes them. It also moved Google and Linear onto
--     ciphertext-only reads (`resolveEncryptedIntegrationToken`) and cut the
--     backfill script down to its Slack half.
--   * No marker excuses these drops, so both destructive-migration gates hold
--     the order. `check-destructive-migrations` passes only once the base
--     branch declares the four fields as `@ignore` (#8184 merged).
--     `check-deployed-destructive-migrations` refuses the production promotion
--     while the production tip or any api deployment in the Edge Config pin
--     store still declares them without `@ignore` (PRD-746 skew).
--   * Nothing is lost. A read-only production count on 2026-09-29T19:45:25Z
--     found 0 rows with a plaintext access or refresh token in either table.
--     Every row there holds both ciphertexts (google 1/1, linear 1/1). So the
--     dropped columns hold only NULL in production, and the ciphertext columns
--     hold every credential.
--   * `slack_integrations.access_token` is NOT dropped: it is NOT NULL and
--     still read (ISS-11096 scopes Slack out).
--
-- ROLLBACK: the reverse is lossless while the dropped columns held only NULL:
--   ALTER TABLE "google_integrations" ADD COLUMN "access_token" TEXT,
--   ADD COLUMN "refresh_token" TEXT;
--   ALTER TABLE "linear_integrations" ADD COLUMN "access_token" TEXT,
--   ADD COLUMN "refresh_token" TEXT;
--
-- Prisma-generated (`migrate diff`) apart from this header; the statements are
-- exactly what the schema diff produced.
-- =============================================================================

-- AlterTable
ALTER TABLE "linear_integrations" DROP COLUMN "access_token",
DROP COLUMN "refresh_token";

-- AlterTable
ALTER TABLE "google_integrations" DROP COLUMN "access_token",
DROP COLUMN "refresh_token";
