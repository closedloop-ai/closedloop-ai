-- CreateEnum
CREATE TYPE "PromptType" AS ENUM ('AGENT', 'JUDGE');

-- CreateTable
CREATE TABLE "prompt_registry" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "prompt_type" "PromptType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "tools" TEXT[],
    "file_path" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sha" TEXT NOT NULL DEFAULT encode(sha256(''::bytea), 'hex'),
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_registry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prompt_registry_organization_id_name_prompt_type_idx" ON "prompt_registry"("organization_id", "name", "prompt_type");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_registry_organization_id_sha_key" ON "prompt_registry"("organization_id", "sha");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_registry_organization_id_name_prompt_type_version_key" ON "prompt_registry"("organization_id", "name", "prompt_type", "version");

-- AlterTable
ALTER TABLE "artifact_evaluations" ALTER COLUMN "report_data" DROP NOT NULL;
