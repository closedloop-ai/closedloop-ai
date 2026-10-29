-- CreateTable
CREATE TABLE "desktop_sign_in_analytics_attempt" (
    "challenge_hash" TEXT NOT NULL,
    "flow_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "desktop_sign_in_analytics_attempt_pkey" PRIMARY KEY ("challenge_hash")
);
