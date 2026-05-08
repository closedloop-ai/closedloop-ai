-- AlterTable
ALTER TABLE "google_integrations" ADD COLUMN "access_token_encrypted" TEXT,
ADD COLUMN "refresh_token_encrypted" TEXT;

-- AlterTable
ALTER TABLE "linear_integrations" ADD COLUMN "access_token_encrypted" TEXT,
ADD COLUMN "refresh_token_encrypted" TEXT;
