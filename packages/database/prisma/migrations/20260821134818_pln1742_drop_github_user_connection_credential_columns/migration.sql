-- =============================================================================
-- PLN-1742 M5, contract half: drop the four GitHubUserConnection credential
-- columns. The row survives as a token-less REGISTRY (identity, mirrored
-- `scopes`, pool health/backoff/spend, and the GitHubAccessCapability rows);
-- only the credential storage dies.
--
-- WHY IT IS SAFE TO CONTRACT NOW (the precondition the expand half named):
--   * Nothing in the repo reads these columns. The four independent readers
--     were collapsed onto one Clerk-only path in PLN-1742 M1/M2, and the last
--     stored read -- the decrypt fallback in `github-connection-credential.ts`
--     -- was deleted by #5462. No `access_token_encrypted` selector, no
--     `decryptIntegrationToken` call, and no writer remain under
--     apps/api/{lib,app}/**/github; `persistGitHubUserConnection`, the only
--     writer, went in #5404.
--   * That code is LIVE IN PRODUCTION: #5462 squash-merged as f571d47ea, which
--     is an ancestor of `origin/production` (deployed 2026-08-21T02:35Z). No
--     serving deployment reads these columns, so the FEA-3331 skew window --
--     old readers outliving the alias cutover and taking P2022 -- has closed.
--     That is what each `destructive-migration-ok` marker below asserts, and it
--     is why the read-removal had to merge AND deploy before this migration
--     could be written.
--   * `revoked_at`, `health_state`, `scopes` and `last_used_at` are NOT dropped.
--     All four are still read AND still written, by four different owners --
--     spelled out because a future cleanup that assumes one owner would be
--     wrong about three of them:
--       - scopes        -- syncClerkRegistryConnection, mirroring Clerk's grant
--                          so the tier-2 `scopes: { has: "repo" }` filters match
--       - last_used_at  -- that same registry write, AND the sync pool's draw
--                          claim, which CAS's on it to rotate the pool
--       - health_state  -- the pool's failure observer (backoff/healthy) AND
--                          markClerkRegistryUnlinked (unhealthy)
--       - revoked_at    -- markClerkRegistryUnlinked sets it; the registry
--                          refresh clears it when the link comes back
--
-- Prisma-generated (`migrate dev`) apart from this header and the markers; the
-- statement is exactly what the schema diff produced.
-- =============================================================================

-- AlterTable
-- destructive-migration-ok(github_user_connections.access_token_encrypted): the stored-token read was deleted in #5462 and is live in production (f571d47ea is an ancestor of origin/production); no serving deployment selects or decrypts this column.
-- destructive-migration-ok(github_user_connections.refresh_token_encrypted): never read on any path -- no refresh machinery was ever built for GitHub -- and its only writer, persistGitHubUserConnection, was deleted in #5404.
-- destructive-migration-ok(github_user_connections.token_expires_at): its last reader was the expiry branch of the stored-credential resolve, deleted in #5462 along with the UserOAuthGrantState.Expired state that consumed it; live in production.
-- destructive-migration-ok(github_user_connections.refresh_token_expires_at): never read on any path, same absent refresh machinery as refresh_token_encrypted; writer deleted in #5404.
ALTER TABLE "github_user_connections" DROP COLUMN "access_token_encrypted",
DROP COLUMN "refresh_token_encrypted",
DROP COLUMN "refresh_token_expires_at",
DROP COLUMN "token_expires_at";
