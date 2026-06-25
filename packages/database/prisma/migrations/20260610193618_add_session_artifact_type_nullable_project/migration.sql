-- AlterEnum
ALTER TYPE "ArtifactType" ADD VALUE 'SESSION';

-- AlterTable
ALTER TABLE "artifacts" ALTER COLUMN "project_id" DROP NOT NULL;
