-- AlterTable
ALTER TABLE "custom_fields" ADD COLUMN "entity_types" "CustomFieldEntityType"[] DEFAULT ARRAY[]::"CustomFieldEntityType"[];
ALTER TABLE "custom_fields" ADD COLUMN "show_in_table" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "custom_fields" ADD COLUMN "is_searchable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "custom_fields" ADD COLUMN "is_sortable" BOOLEAN NOT NULL DEFAULT false;
