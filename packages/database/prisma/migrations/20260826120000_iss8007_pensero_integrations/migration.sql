-- ISS-8007: per-organization Pensero credential.
--
-- Replaces the deployment-wide PENSERO_API_TOKEN env var as the primary source.
-- A row here wins over the env var; the env var is retained as the
-- deployment-wide default for self-hosted installs. Additive and backward
-- compatible: with no rows, credential resolution behaves exactly as before.
--
-- `api_token_encrypted` holds a KMS ciphertext, never a plaintext token.
-- `api_token_last_four` is a display fingerprint only.

CREATE TABLE "pensero_integrations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "api_token_encrypted" TEXT NOT NULL,
    "api_token_last_four" TEXT NOT NULL,
    "base_url" TEXT,
    "set_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pensero_integrations_pkey" PRIMARY KEY ("id")
);

-- One credential per organization: the unique constraint is what makes the
-- write path a safe upsert rather than a read-then-write race.
-- index-lock-ok(pensero_integrations): table is created empty in this same migration so the one-credential-per-org unique index locks zero rows before any writer can reach it, and CONCURRENTLY cannot be mixed with the table-creation DDL Prisma wraps in one transaction
CREATE UNIQUE INDEX IF NOT EXISTS "pensero_integrations_organization_id_key" ON "pensero_integrations"("organization_id");

-- Cascade so deleting an organization cannot leave a live encrypted credential
-- behind.
ALTER TABLE "pensero_integrations" ADD CONSTRAINT "pensero_integrations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
