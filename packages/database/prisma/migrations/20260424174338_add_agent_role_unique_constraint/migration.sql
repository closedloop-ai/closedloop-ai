/*
  Warnings:

  - A unique constraint covering the columns `[organization_id,role]` on the table `agents` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "agents_organization_id_role_key" ON "agents"("organization_id", "role");
