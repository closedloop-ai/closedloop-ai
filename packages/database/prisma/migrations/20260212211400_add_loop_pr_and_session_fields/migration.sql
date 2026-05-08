-- AlterTable
ALTER TABLE "loops" ADD COLUMN     "branch_name" TEXT,
ADD COLUMN     "pr_number" INTEGER,
ADD COLUMN     "pr_url" TEXT,
ADD COLUMN     "session_id" TEXT;
