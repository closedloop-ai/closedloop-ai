-- CreateEnum
CREATE TYPE "SessionOrigin" AS ENUM ('DESKTOP_SYNC', 'LOOP');
-- AlterTable
ALTER TABLE "loops" ADD COLUMN     "session_artifact_id" UUID;
-- AlterTable
ALTER TABLE "session_detail" ADD COLUMN     "origin" "SessionOrigin" NOT NULL DEFAULT 'DESKTOP_SYNC';
-- CreateIndex
CREATE UNIQUE INDEX "loops_session_artifact_id_key" ON "loops"("session_artifact_id");
-- AddForeignKey
ALTER TABLE "loops" ADD CONSTRAINT "loops_session_artifact_id_fkey" FOREIGN KEY ("session_artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
