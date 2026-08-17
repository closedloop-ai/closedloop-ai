-- FEA-4169: server-owned ORG POLICY for local desktop session-data sync.
--
-- Adds `session_sync_policy_enabled` to organizations: the OUTER privacy gate
-- ABOVE per-device sync consent (PRD-542/FEA-4103). When false, NO local session
-- data (metadata or transcripts) may egress to the cloud from any of the org's
-- desktops, regardless of the sync-observability tier a user picked locally.
--
-- Default false (privacy-safe / fail-closed): an org must be explicitly enabled
-- before session data leaves the machine. Additive column with a NOT NULL default
-- so existing rows backfill to false without a rewrite lock issue on new inserts.
ALTER TABLE "organizations"
  ADD COLUMN "session_sync_policy_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Enable the policy for the internal Closedloop org as the seeded v1 config.
-- Targeted by the org's own immutable unique `slug` ("closedloop"), NOT by a
-- member's email domain: the schema permits one Clerk identity to have a user
-- row in multiple organizations (`schema.prisma` @@unique([clerk_id,
-- organization_id])), so a Closedloop staffer invited into a customer tenant
-- gives that tenant a @closedloop.ai member — an email-domain EXISTS predicate
-- would then enable session sync for the ENTIRE customer org (including its
-- non-staff users), defeating the default-off / privacy-safe intent above. The
-- slug is org-scoped and immutable, so it targets exactly the internal org and
-- cannot leak into a customer tenant. Idempotent, and a no-op in any environment
-- whose org set does not include that slug.
UPDATE "organizations"
SET "session_sync_policy_enabled" = true
WHERE "slug" = 'closedloop';
