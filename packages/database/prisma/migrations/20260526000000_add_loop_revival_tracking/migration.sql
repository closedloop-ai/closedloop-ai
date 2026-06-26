-- AlterTable
ALTER TABLE "loops" ADD COLUMN "revival_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "loops" ADD COLUMN "last_revival_at" TIMESTAMP(3);
