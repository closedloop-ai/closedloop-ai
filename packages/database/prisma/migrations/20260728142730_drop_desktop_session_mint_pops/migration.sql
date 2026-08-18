-- Drop the consumed-PoP replay guard for the removed non-interactive API-key ->
-- desktop-session mint (POST /desktop/session/from-api-key). The mint is gone
-- and that route is now a 410 tombstone, so nothing reads or writes this table:
-- its only consumers -- the mint service and consumeDesktopSessionMintPop --
-- were deleted in the same change.
--
-- Safe to drop outright rather than orphan:
--   - No foreign key references it in either direction.
--   - Rows were always ephemeral. A signature hash was retained only for the PoP
--     freshness window (anything older was already rejected as stale) and reaped
--     opportunistically, so no durable record is lost and there is nothing to
--     migrate or back up.
--
-- DDL below is Prisma-generated; only this explanatory header was added.

-- DropTable
DROP TABLE "desktop_session_mint_pops";
