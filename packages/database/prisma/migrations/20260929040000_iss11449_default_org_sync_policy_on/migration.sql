-- ISS-11449: the org session-sync policy defaults ON and stops gating anyone.
--
-- FEA-4169 shipped this column `NOT NULL DEFAULT false` as an OUTER gate above
-- the per-device election. That made "the user chose full sync" and "this device
-- uploads nothing" indistinguishable to the user: the desktop reported the level
-- its owner picked while the server refused every lane, with nothing on screen
-- to say why. Only the internal Closedloop org was ever enabled.
--
-- Two statements, and BOTH are required. The default alone governs only rows
-- created after it; every organization that already exists still carries the
-- persisted `false` that is doing the blocking today.
ALTER TABLE "organizations"
  ALTER COLUMN "session_sync_policy_enabled" SET DEFAULT true;

UPDATE "organizations"
  SET "session_sync_policy_enabled" = true
  WHERE "session_sync_policy_enabled" = false;
