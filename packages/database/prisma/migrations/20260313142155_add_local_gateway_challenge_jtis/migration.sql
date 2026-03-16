-- CreateTable
CREATE TABLE "local_gateway_challenge_jtis" (
    "jti" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "local_gateway_challenge_jtis_pkey" PRIMARY KEY ("jti")
);

-- CreateIndex
CREATE INDEX "local_gateway_challenge_jtis_expires_at_idx" ON "local_gateway_challenge_jtis"("expires_at");
