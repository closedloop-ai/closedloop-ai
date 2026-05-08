-- CreateTable
CREATE TABLE "oauth_revoked_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "token_fingerprint" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_revoked_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_rate_limits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "bucket" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "window_started_at" TIMESTAMP(3) NOT NULL,
    "window_expires_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_rate_limits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_revoked_tokens_token_fingerprint_key" ON "oauth_revoked_tokens"("token_fingerprint");

-- CreateIndex
CREATE INDEX "oauth_revoked_tokens_expires_at_idx" ON "oauth_revoked_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_rate_limits_bucket_subject_key" ON "oauth_rate_limits"("bucket", "subject");

-- CreateIndex
CREATE INDEX "oauth_rate_limits_window_expires_at_idx" ON "oauth_rate_limits"("window_expires_at");
