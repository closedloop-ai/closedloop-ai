-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "claude_api_key_encrypted" TEXT,
ADD COLUMN     "claude_api_key_last_four" TEXT,
ADD COLUMN     "claude_api_key_set_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "claude_api_key_encrypted" TEXT,
ADD COLUMN     "claude_api_key_last_four" TEXT,
ADD COLUMN     "claude_api_key_set_at" TIMESTAMP(3);
