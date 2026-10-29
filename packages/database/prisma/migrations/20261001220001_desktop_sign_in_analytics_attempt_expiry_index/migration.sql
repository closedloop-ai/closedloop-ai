-- Separate from table creation so previews can skip this perf-only index.
-- Prisma generated the index definition; CONCURRENTLY is added because Prisma
-- cannot express it and the deployment guard requires nonblocking index DDL.
CREATE INDEX CONCURRENTLY "desktop_sign_in_analytics_attempt_expires_at_idx" ON "desktop_sign_in_analytics_attempt"("expires_at");
