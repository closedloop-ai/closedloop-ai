-- Rename the legacy enum type names to match the Prisma model names.
-- DB-level type names were carried over from the Artifact→Document rename;
-- dropping the @@map aliases requires renaming the Postgres types too.

ALTER TYPE "ArtifactStatus" RENAME TO "DocumentStatus";
ALTER TYPE "ArtifactType" RENAME TO "DocumentType";
