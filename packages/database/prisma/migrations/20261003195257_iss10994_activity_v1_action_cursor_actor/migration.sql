-- Prisma cannot express CONCURRENTLY; avoid blocking activity receipt writes.
CREATE INDEX CONCURRENTLY "artifact_activity_v1_action_cursor_actor_idx" ON "artifact_activity_events"("organization_id", "artifact_id", "action", "created_at" DESC, "id" DESC, "actor_type");
