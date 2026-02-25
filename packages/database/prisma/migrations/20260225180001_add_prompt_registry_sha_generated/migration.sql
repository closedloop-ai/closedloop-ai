-- AlterTable: replace default with GENERATED ALWAYS AS expression for sha column
ALTER TABLE "prompt_registry" ALTER COLUMN "sha" DROP DEFAULT;
ALTER TABLE "prompt_registry" ALTER COLUMN "sha" SET GENERATED ALWAYS AS (encode(sha256("content"::bytea), 'hex')) STORED;
