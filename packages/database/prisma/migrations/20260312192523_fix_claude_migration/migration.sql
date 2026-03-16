-- AlterTable
ALTER TABLE "comment_attachments" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "comment_reactions" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "comment_threads" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "comments" ALTER COLUMN "id" DROP DEFAULT;
