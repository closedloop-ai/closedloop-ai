-- DropForeignKey
-- The project_teams.team_id FK was created with ON DELETE RESTRICT while the
-- sibling project_id FK uses ON DELETE CASCADE. Deleting a team therefore
-- fails (or, worse, leaves orphan join rows) because the restrict constraint
-- blocks the delete. Align the team FK with the project FK so removing a team
-- cascades to its project_teams join rows.
ALTER TABLE "project_teams" DROP CONSTRAINT "project_teams_team_id_fkey";

-- AddForeignKey
ALTER TABLE "project_teams" ADD CONSTRAINT "project_teams_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
