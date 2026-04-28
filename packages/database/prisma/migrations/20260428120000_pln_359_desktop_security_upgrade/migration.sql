ALTER TABLE "compute_targets"
  ADD COLUMN "gateway_id" TEXT;

CREATE INDEX "compute_targets_organization_id_user_id_gateway_id_idx"
  ON "compute_targets"("organization_id", "user_id", "gateway_id");

ALTER TABLE "desktop_onboarding_attempts"
  ADD COLUMN "flow_type" TEXT,
  ADD COLUMN "compute_target_id" UUID,
  ADD COLUMN "gateway_id" TEXT;

CREATE INDEX "desktop_onboarding_attempts_organization_id_user_id_flow_ty_idx"
  ON "desktop_onboarding_attempts"("organization_id", "user_id", "flow_type");

CREATE INDEX "desktop_onboarding_attempts_compute_target_id_idx"
  ON "desktop_onboarding_attempts"("compute_target_id");

CREATE INDEX "desktop_onboarding_attempts_gateway_id_idx"
  ON "desktop_onboarding_attempts"("gateway_id");

CREATE TABLE "desktop_onboarding_device_sessions" (
  "id" UUID NOT NULL,
  "device_session_secret_hash" TEXT NOT NULL,
  "user_code" TEXT NOT NULL,
  "request_ip_hash" TEXT,
  "web_app_origin" TEXT NOT NULL,
  "gateway_id" TEXT NOT NULL,
  "gateway_public_key_pem" TEXT NOT NULL,
  "machine_name" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "desktop_version" TEXT NOT NULL,
  "desktop_security_upgrade_protocol_version" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "user_id" UUID,
  "organization_id" UUID,
  "onboarding_attempt_id" TEXT,
  "denied_at" TIMESTAMP(3),
  "approved_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "desktop_onboarding_device_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "desktop_onboarding_device_sessions_user_code_key"
  ON "desktop_onboarding_device_sessions"("user_code");

CREATE INDEX "desktop_onboarding_device_sessions_gateway_id_status_idx"
  ON "desktop_onboarding_device_sessions"("gateway_id", "status");

CREATE INDEX "desktop_onboarding_device_sessions_request_ip_hash_status_idx"
  ON "desktop_onboarding_device_sessions"("request_ip_hash", "status");

CREATE INDEX "desktop_onboarding_device_sessions_expires_at_idx"
  ON "desktop_onboarding_device_sessions"("expires_at");

CREATE INDEX "desktop_onboarding_device_sessions_organization_id_user_id_idx"
  ON "desktop_onboarding_device_sessions"("organization_id", "user_id");
