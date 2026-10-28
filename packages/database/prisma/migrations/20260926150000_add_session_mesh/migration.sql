-- CreateTable
CREATE TABLE "session_mesh_presences" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "agent_id" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "dirty_state_hash" TEXT,
    "configuration_hash" TEXT,
    "harness" TEXT NOT NULL DEFAULT 'unknown',
    "capabilities" JSONB NOT NULL DEFAULT '[]',
    "lineage" JSONB NOT NULL DEFAULT '{}',
    "context" JSONB NOT NULL DEFAULT '{}',
    "paths" JSONB NOT NULL DEFAULT '[]',
    "symbols" JSONB NOT NULL DEFAULT '[]',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_mesh_presences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_mesh_messages" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "author_agent_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "recipient_agent_ids" JSONB NOT NULL DEFAULT '[]',
    "reply_to_message_id" UUID,
    "kind" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "dirty_state_hash" TEXT,
    "configuration_hash" TEXT,
    "lineage" JSONB NOT NULL DEFAULT '{}',
    "paths" JSONB NOT NULL DEFAULT '[]',
    "symbols" JSONB NOT NULL DEFAULT '[]',
    "summary" TEXT NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "sensitivity" TEXT NOT NULL DEFAULT 'normal',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_mesh_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_mesh_deliveries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "recipient_agent_id" TEXT NOT NULL,
    "relevance" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "attempted_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "held_at" TIMESTAMP(3),
    "refused_at" TIMESTAMP(3),
    "dismissed_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),
    "acknowledged_at" TIMESTAMP(3),

    CONSTRAINT "session_mesh_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_mesh_metric_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID,
    "agent_id" TEXT,
    "event_type" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "message_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_mesh_metric_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_mesh_subscriptions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "repository" TEXT NOT NULL,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "digest_only" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_mesh_subscriptions_pkey" PRIMARY KEY ("id")
);

-- index-lock-ok(session_mesh_presences): new table is created empty in this migration; its indexes must exist before normal reads and writes, and CONCURRENTLY cannot share the table-creation DDL Prisma wraps in one transaction
-- CreateIndex
CREATE INDEX IF NOT EXISTS "session_mesh_presences_organization_id_repository_expires_a_idx" ON "session_mesh_presences"("organization_id", "repository", "expires_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "session_mesh_presences_expires_at_idx" ON "session_mesh_presences"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "session_mesh_presences_organization_id_agent_id_key" ON "session_mesh_presences"("organization_id", "agent_id");

-- index-lock-ok(session_mesh_messages): new table is created empty in this migration; its indexes must exist before normal reads and writes, and CONCURRENTLY cannot share the table-creation DDL Prisma wraps in one transaction
-- CreateIndex
CREATE INDEX IF NOT EXISTS "session_mesh_messages_organization_id_repository_revision_c_idx" ON "session_mesh_messages"("organization_id", "repository", "revision", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "session_mesh_messages_organization_id_created_at_idx" ON "session_mesh_messages"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "session_mesh_messages_expires_at_idx" ON "session_mesh_messages"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "session_mesh_messages_organization_id_idempotency_key_key" ON "session_mesh_messages"("organization_id", "idempotency_key");

-- index-lock-ok(session_mesh_deliveries): new table is created empty in this migration; its indexes must exist before normal reads and writes, and CONCURRENTLY cannot share the table-creation DDL Prisma wraps in one transaction
-- CreateIndex
CREATE INDEX IF NOT EXISTS "session_mesh_deliveries_organization_id_recipient_user_id_r_idx" ON "session_mesh_deliveries"("organization_id", "recipient_user_id", "recipient_agent_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "session_mesh_deliveries_organization_id_queued_at_idx" ON "session_mesh_deliveries"("organization_id", "queued_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "session_mesh_deliveries_message_id_recipient_agent_id_key" ON "session_mesh_deliveries"("message_id", "recipient_agent_id");

-- index-lock-ok(session_mesh_metric_events): new table is created empty in this migration; its indexes must exist before normal reads and writes, and CONCURRENTLY cannot share the table-creation DDL Prisma wraps in one transaction
-- CreateIndex
CREATE INDEX IF NOT EXISTS "session_mesh_metric_events_organization_id_created_at_idx" ON "session_mesh_metric_events"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "session_mesh_metric_events_organization_id_event_type_creat_idx" ON "session_mesh_metric_events"("organization_id", "event_type", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "session_mesh_metric_events_created_at_idx" ON "session_mesh_metric_events"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "session_mesh_metric_events_organization_id_idempotency_key_key" ON "session_mesh_metric_events"("organization_id", "idempotency_key");

-- index-lock-ok(session_mesh_subscriptions): new table is created empty in this migration; its indexes must exist before normal reads and writes, and CONCURRENTLY cannot share the table-creation DDL Prisma wraps in one transaction
-- CreateIndex
CREATE INDEX IF NOT EXISTS "session_mesh_subscriptions_organization_id_user_id_muted_idx" ON "session_mesh_subscriptions"("organization_id", "user_id", "muted");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "session_mesh_subscriptions_organization_id_user_id_reposito_key" ON "session_mesh_subscriptions"("organization_id", "user_id", "repository");

-- AddForeignKey
ALTER TABLE "session_mesh_presences" ADD CONSTRAINT "session_mesh_presences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_mesh_presences" ADD CONSTRAINT "session_mesh_presences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_mesh_messages" ADD CONSTRAINT "session_mesh_messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_mesh_messages" ADD CONSTRAINT "session_mesh_messages_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_mesh_deliveries" ADD CONSTRAINT "session_mesh_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_mesh_deliveries" ADD CONSTRAINT "session_mesh_deliveries_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "session_mesh_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_mesh_deliveries" ADD CONSTRAINT "session_mesh_deliveries_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_mesh_metric_events" ADD CONSTRAINT "session_mesh_metric_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_mesh_metric_events" ADD CONSTRAINT "session_mesh_metric_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_mesh_subscriptions" ADD CONSTRAINT "session_mesh_subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_mesh_subscriptions" ADD CONSTRAINT "session_mesh_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
