-- CreateEnum
CREATE TYPE "ApiKeySource" AS ENUM ('USER_CREATED', 'DESKTOP_MANAGED');

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "bound_public_key" TEXT,
ADD COLUMN     "gateway_id" TEXT,
ADD COLUMN     "source" "ApiKeySource" NOT NULL DEFAULT 'USER_CREATED';

-- Explicitly classify all rows that existed before this migration as manual keys.
-- Prisma cannot express this data backfill; it keeps future PoP phases from
-- mistaking existing bearer keys for desktop-managed credentials.
UPDATE "api_keys"
SET "source" = 'USER_CREATED',
    "gateway_id" = NULL,
    "bound_public_key" = NULL;

-- CreateTable
CREATE TABLE "desktop_onboarding_attempts" (
    "attempt_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "web_app_origin" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "desktop_onboarding_attempts_pkey" PRIMARY KEY ("attempt_id")
);

-- CreateIndex
CREATE INDEX "desktop_onboarding_attempts_organization_id_user_id_idx" ON "desktop_onboarding_attempts"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "desktop_onboarding_attempts_expires_at_idx" ON "desktop_onboarding_attempts"("expires_at");

-- CreateIndex
CREATE INDEX "api_keys_organization_id_user_id_gateway_id_idx" ON "api_keys"("organization_id", "user_id", "gateway_id");

-- Keep a single active desktop-managed key per org/user/gateway tuple.
CREATE UNIQUE INDEX "api_keys_active_desktop_managed_gateway_key"
ON "api_keys"("organization_id", "user_id", "gateway_id")
WHERE "source" = 'DESKTOP_MANAGED'
  AND "gateway_id" IS NOT NULL
  AND "revoked_at" IS NULL;
