-- PLN-634: pinned during OAuth callback when a different-account reconnect is
-- detected. The confirm-reset endpoint uses this server-side value instead of
-- a user-controllable body field, so a phished admin cannot be tricked into
-- binding their org to an attacker's installation.

-- AlterTable
ALTER TABLE "github_installations" ADD COLUMN "pending_new_installation_id" TEXT;
