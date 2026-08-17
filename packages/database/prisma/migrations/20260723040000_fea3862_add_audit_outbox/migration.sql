-- CreateTable
CREATE TABLE "audit_outbox" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "object_type" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_outbox_organization_id_created_at_idx" ON "audit_outbox"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "audit_outbox" ADD CONSTRAINT "audit_outbox_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
