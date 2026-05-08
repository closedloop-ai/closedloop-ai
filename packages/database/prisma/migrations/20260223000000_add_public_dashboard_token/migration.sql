-- AlterTable
ALTER TABLE "organizations" ADD COLUMN "public_dashboard_token" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "organizations_public_dashboard_token_key" ON "organizations"("public_dashboard_token");
