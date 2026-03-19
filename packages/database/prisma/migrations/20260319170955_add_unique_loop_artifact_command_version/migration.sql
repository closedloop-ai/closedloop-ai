/*
  Warnings:

  - A unique constraint covering the columns `[artifact_id,command,artifact_version]` on the table `loops` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "loops_artifact_id_command_artifact_version_key" ON "loops"("artifact_id", "command", "artifact_version");
