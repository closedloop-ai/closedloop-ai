-- Clean up orphaned team_members rows before applying the cascade FK.
-- The prior FK was ON DELETE RESTRICT; in normal operation orphans cannot
-- exist, but this defensive delete guards against any rows left behind by
-- out-of-band/raw-SQL deletes so the new constraint can be added cleanly.
DELETE FROM "team_members"
WHERE "user_id" NOT IN (SELECT "id" FROM "users");

-- DropForeignKey
ALTER TABLE "team_members" DROP CONSTRAINT IF EXISTS "team_members_user_id_fkey";

-- AddForeignKey (ON DELETE CASCADE so deleting a user removes their memberships)
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
