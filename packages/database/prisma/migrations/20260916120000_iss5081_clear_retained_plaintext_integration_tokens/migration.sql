-- =============================================================================
-- ISS-5081: clear the legacy plaintext OAuth token columns on rows that already
-- hold a usable ciphertext for the same credential.
--
-- HAND-WRITTEN BECAUSE IT IS A DATA MIGRATION, not schema DDL: there is nothing
-- in `schema.prisma` for `prisma migrate dev` to diff. It alters no column and
-- drops nothing.
--
-- ORDERING: this must not reach an environment before the read-path change that
-- removes the plaintext fallback (ISS-5081, the `apps/api` half). Until that
-- ships, `ensureValidAccessToken` still answers a KMS DECRYPT failure by
-- serving the plaintext column beside the ciphertext — so clearing the
-- plaintext first turns a transient KMS failure into "Please reconnect" for a
-- row that would otherwise have kept working. After it ships, no code path
-- reads these columns while a ciphertext is present.
--
-- WHY EACH HALF IS ITS OWN STATEMENT, PREDICATED ON ITS OWN CIPHERTEXT. The
-- access and refresh credentials migrate independently: a row can hold access
-- ciphertext while its refresh token is still only plaintext (a reconnect where
-- the provider reissued no refresh token did exactly that before ISS-7781).
-- Clearing both halves on one row-level predicate would delete that refresh
-- token -- the organization's ONLY means of refreshing -- and lock it out at
-- the next expiry. Each statement clears a column only where THAT column's
-- ciphertext is present, so a credential whose only copy is plaintext is never
-- touched.
--
-- WHY `<> ''` AND NOT JUST `IS NOT NULL`. The reader decides on JS truthiness
-- (`if (encrypted)` in `resolveIntegrationToken`), so an empty-string
-- ciphertext is NOT a credential to it and the plaintext beside it is what
-- serves. `'' IS NOT NULL` is true in SQL, so the looser predicate would delete
-- the only working copy. The two tests must agree or this migration destroys
-- exactly the rows it cannot see.
--
-- WHAT THIS DELIBERATELY CANNOT DO. A credential whose only copy is plaintext
-- needs KMS to migrate, and the migrator has none -- `prisma migrate deploy`
-- speaks to Postgres and nothing else. Those halves are left exactly as they
-- are and keep serving through the instrumented plaintext read.
--
-- THEY DO NOT ALL DRAIN THE SAME WAY, and the difference decides an operator's
-- remedy. `apps/api/scripts/backfill-integration-tokens.ts` selects on
-- `accessTokenEncrypted: null`, so it migrates a row holding NO ciphertext and
-- skips a HALF-migrated one whole -- access ciphertext, refresh plaintext-only,
-- the shape described above. It can never encrypt that refresh token; only that
-- organization's next connect or refresh does. Such a row keeps counting in
-- `data.invariant.integration_tokens_plaintext_retained`, whose predicate ORs on
-- `refresh_token`, so a level that will not fall there is NOT necessarily work
-- the backfill can do -- re-running the script moves nothing. The script cannot
-- replace this migration and this migration cannot replace it: the population it
-- selects is the complement of the one cleared here.
--
-- Both tables are one row per organization, so this is a few rows: no batching,
-- no ceiling. Row counts per environment belong in ISS-5081, not in a file
-- whose checksum freezes them.
--
-- Dropping the columns is a SEPARATE, later, human-approved step, and only once
-- no plaintext remains for these two owners.
-- =============================================================================

UPDATE "google_integrations" SET "access_token" = NULL
WHERE "access_token" IS NOT NULL AND "access_token_encrypted" IS NOT NULL AND "access_token_encrypted" <> '';

UPDATE "google_integrations" SET "refresh_token" = NULL
WHERE "refresh_token" IS NOT NULL AND "refresh_token_encrypted" IS NOT NULL AND "refresh_token_encrypted" <> '';

UPDATE "linear_integrations" SET "access_token" = NULL
WHERE "access_token" IS NOT NULL AND "access_token_encrypted" IS NOT NULL AND "access_token_encrypted" <> '';

UPDATE "linear_integrations" SET "refresh_token" = NULL
WHERE "refresh_token" IS NOT NULL AND "refresh_token_encrypted" IS NOT NULL AND "refresh_token_encrypted" <> '';
