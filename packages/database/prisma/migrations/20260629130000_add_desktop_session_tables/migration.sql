-- CreateTable
CREATE TABLE "desktop_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "bound_public_key" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "desktop_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "desktop_refresh_tokens" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "replaced_by_token_id" UUID,
    "rotated_from_token_id" UUID,

    CONSTRAINT "desktop_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "desktop_sessions_user_id_idx" ON "desktop_sessions"("user_id");

-- CreateIndex
CREATE INDEX "desktop_sessions_organization_id_idx" ON "desktop_sessions"("organization_id");

-- CreateIndex
CREATE INDEX "desktop_sessions_expires_at_idx" ON "desktop_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "desktop_refresh_tokens_token_hash_key" ON "desktop_refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "desktop_refresh_tokens_session_id_revoked_at_idx" ON "desktop_refresh_tokens"("session_id", "revoked_at");

-- CreateIndex
CREATE INDEX "desktop_refresh_tokens_family_id_revoked_at_idx" ON "desktop_refresh_tokens"("family_id", "revoked_at");

-- CreateIndex
CREATE INDEX "desktop_refresh_tokens_expires_at_idx" ON "desktop_refresh_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "desktop_sessions" ADD CONSTRAINT "desktop_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "desktop_sessions" ADD CONSTRAINT "desktop_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "desktop_refresh_tokens" ADD CONSTRAINT "desktop_refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "desktop_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
