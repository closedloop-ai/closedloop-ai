-- CreateTable
CREATE TABLE "user_public_keys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "public_key_base64" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_public_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_public_keys_organization_id_idx" ON "user_public_keys"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_public_keys_user_id_fingerprint_key" ON "user_public_keys"("user_id", "fingerprint");

-- AddForeignKey
ALTER TABLE "user_public_keys" ADD CONSTRAINT "user_public_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_public_keys" ADD CONSTRAINT "user_public_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
