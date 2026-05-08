-- AlterTable
ALTER TABLE "users" ADD COLUMN     "preferred_compute_target_id" UUID;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_preferred_compute_target_id_fkey" FOREIGN KEY ("preferred_compute_target_id") REFERENCES "compute_targets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
