-- CreateTable
CREATE TABLE "generic_chats" (
    "id" UUID NOT NULL,
    "chat_key" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "session_id" TEXT,
    "session_source_id" TEXT,
    "context" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generic_chats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generic_chats_user_id_idx" ON "generic_chats"("user_id");

-- CreateIndex
CREATE INDEX "generic_chats_organization_id_user_id_idx" ON "generic_chats"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "generic_chats_user_id_chat_key_key" ON "generic_chats"("user_id", "chat_key");

-- AddForeignKey
ALTER TABLE "generic_chats" ADD CONSTRAINT "generic_chats_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generic_chats" ADD CONSTRAINT "generic_chats_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
