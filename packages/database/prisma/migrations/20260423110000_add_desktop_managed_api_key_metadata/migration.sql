-- Track whether a key was created manually or by the desktop onboarding flow.
CREATE TYPE "ApiKeySource" AS ENUM ('USER_CREATED', 'DESKTOP_MANAGED');

-- Phase A stores managed-key provenance plus optional gateway binding data.
ALTER TABLE "api_keys"
ADD COLUMN "source" "ApiKeySource" NOT NULL DEFAULT 'USER_CREATED',
ADD COLUMN "gateway_id" TEXT,
ADD COLUMN "bound_public_key" TEXT;

CREATE INDEX "api_keys_organization_id_user_id_gateway_id_idx"
ON "api_keys"("organization_id", "user_id", "gateway_id");

-- Keep a single active desktop-managed key per org/user/gateway tuple.
CREATE UNIQUE INDEX "api_keys_active_desktop_managed_gateway_key"
ON "api_keys"("organization_id", "user_id", "gateway_id")
WHERE "source" = 'DESKTOP_MANAGED'
  AND "gateway_id" IS NOT NULL
  AND "revoked_at" IS NULL;

-- Persist one-time onboarding attempts for the installer/Desktop handoff flow.
CREATE TABLE "desktop_onboarding_attempts" (
  "attempt_id" TEXT PRIMARY KEY,
  "user_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "web_app_origin" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3)
);

CREATE INDEX "desktop_onboarding_attempts_organization_id_user_id_idx"
ON "desktop_onboarding_attempts"("organization_id", "user_id");

CREATE INDEX "desktop_onboarding_attempts_expires_at_idx"
ON "desktop_onboarding_attempts"("expires_at");
