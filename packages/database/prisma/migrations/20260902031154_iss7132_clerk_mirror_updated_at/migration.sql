-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "clerk_updated_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "clerk_updated_at" TIMESTAMP(3);
