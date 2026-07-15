-- CreateTable
CREATE TABLE "desktop_authorization_codes" (
    "id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "bound_public_key" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "redeemed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "desktop_authorization_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "desktop_authorization_codes_code_hash_key" ON "desktop_authorization_codes"("code_hash");

-- CreateIndex
CREATE INDEX "desktop_authorization_codes_expires_at_idx" ON "desktop_authorization_codes"("expires_at");
