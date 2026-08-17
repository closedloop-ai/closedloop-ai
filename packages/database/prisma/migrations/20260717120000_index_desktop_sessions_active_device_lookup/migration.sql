-- PRD-532 (PR-K / M8): findActiveDeviceSession looks up the newest non-revoked,
-- unexpired desktop session for a given user/org/gateway during DESKTOP_MANAGED
-- key provisioning. The existing single-column indexes (user_id, organization_id,
-- expires_at) do not serve this equality-heavy access pattern, forcing a scan on
-- each provision request. This additive composite index covers the leading
-- equality columns (user_id, organization_id, gateway_id) plus revoked_at to
-- narrow to live sessions before the expires_at range filter / created_at sort.
-- Purely additive (index-only, no data mutation); generated offline via
-- `prisma migrate diff` (no local DB in this env), applied by
-- `prisma migrate deploy` in CI/prod.

-- CreateIndex
CREATE INDEX "desktop_sessions_user_id_organization_id_gateway_id_revoked_idx" ON "desktop_sessions"("user_id", "organization_id", "gateway_id", "revoked_at");
