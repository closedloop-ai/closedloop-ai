-- Consumed-PoP replay guard for the non-interactive API-key -> desktop-session
-- mint (POST /desktop/session/from-api-key). Additive new table with no deployed
-- readers until the mint's replay check ships. Generated offline via
-- `prisma migrate diff` (no DB reachable in the authoring sandbox); applied by
-- `prisma migrate deploy` in CI/prod.

-- CreateTable
CREATE TABLE "desktop_session_mint_pops" (
    "id" UUID NOT NULL,
    "signature_hash" TEXT NOT NULL,
    "api_key_id" UUID NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "desktop_session_mint_pops_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "desktop_session_mint_pops_signature_hash_key" ON "desktop_session_mint_pops"("signature_hash");

-- CreateIndex
CREATE INDEX "desktop_session_mint_pops_expires_at_idx" ON "desktop_session_mint_pops"("expires_at");
