-- CreateIndex
CREATE INDEX CONCURRENTLY "session_mesh_messages_organization_id_reply_to_message_id_c_idx" ON "session_mesh_messages"("organization_id", "reply_to_message_id", "created_at");

-- CreateIndex
CREATE INDEX CONCURRENTLY "session_mesh_deliveries_organization_id_attempted_at_idx" ON "session_mesh_deliveries"("organization_id", "attempted_at");

-- CreateIndex
CREATE INDEX CONCURRENTLY "session_mesh_deliveries_organization_id_delivered_at_idx" ON "session_mesh_deliveries"("organization_id", "delivered_at");

-- CreateIndex
CREATE INDEX CONCURRENTLY "session_mesh_deliveries_organization_id_acknowledged_at_idx" ON "session_mesh_deliveries"("organization_id", "acknowledged_at");
