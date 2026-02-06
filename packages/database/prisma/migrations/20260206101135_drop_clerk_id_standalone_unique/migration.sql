/*
  Warnings:

  - The `@unique` constraint on the column `clerk_id` on the table `users` will be removed. The composite unique constraint on `[clerk_id, organization_id]` remains.

*/
-- DropIndex
DROP INDEX "users_clerk_id_key";
