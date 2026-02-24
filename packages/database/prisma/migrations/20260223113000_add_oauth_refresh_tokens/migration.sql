-- Persist OAuth refresh tokens for silent token renewal and rotation.
CREATE TABLE "oauth_refresh_tokens" (
    "id" UUID NOT NULL,
    "token_fingerprint" TEXT NOT NULL,
    "encrypted_api_key" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "scopes" TEXT[] NOT NULL,
    "family_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "replaced_by_token_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_refresh_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "oauth_refresh_tokens_token_fingerprint_key" ON "oauth_refresh_tokens"("token_fingerprint");
CREATE INDEX "oauth_refresh_tokens_expires_at_idx" ON "oauth_refresh_tokens"("expires_at");
CREATE INDEX "oauth_refresh_tokens_family_id_revoked_at_idx" ON "oauth_refresh_tokens"("family_id", "revoked_at");
