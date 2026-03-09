-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM ('TEXT', 'NUMBER', 'ENUM', 'MULTI_ENUM', 'DATE', 'PEOPLE');

-- CreateEnum
CREATE TYPE "CustomFieldEntityType" AS ENUM ('PROJECT', 'WORKSTREAM', 'ISSUE', 'ARTIFACT');

-- CreateEnum
CREATE TYPE "NumberFormat" AS ENUM ('NONE', 'CURRENCY', 'PERCENTAGE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "LabelPosition" AS ENUM ('PREFIX', 'SUFFIX');

-- CreateTable
CREATE TABLE "custom_fields" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "field_type" "CustomFieldType" NOT NULL,
    "created_by_id" UUID,
    "precision" INTEGER,
    "number_format" "NumberFormat",
    "currency_code" TEXT,
    "custom_label" TEXT,
    "custom_label_position" "LabelPosition",
    "is_global_to_org" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_enum_options" (
    "id" UUID NOT NULL,
    "custom_field_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'none',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "custom_field_enum_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_settings" (
    "id" UUID NOT NULL,
    "custom_field_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "entity_type" "CustomFieldEntityType" NOT NULL,
    "entity_id" UUID NOT NULL,
    "is_important" BOOLEAN NOT NULL DEFAULT false,
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_field_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_values" (
    "id" UUID NOT NULL,
    "custom_field_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "entity_type" "CustomFieldEntityType" NOT NULL,
    "entity_id" UUID NOT NULL,
    "text_value" TEXT,
    "number_value" DOUBLE PRECISION,
    "date_value" TIMESTAMP(3),
    "enum_value_id" UUID,
    "multi_enum_value_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "people_value_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "display_value" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "custom_field_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "custom_fields_organization_id_idx" ON "custom_fields"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_fields_organization_id_name_key" ON "custom_fields"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_enum_options_custom_field_id_name_key" ON "custom_field_enum_options"("custom_field_id", "name");

-- CreateIndex
CREATE INDEX "custom_field_enum_options_custom_field_id_sort_order_idx" ON "custom_field_enum_options"("custom_field_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_settings_custom_field_id_entity_type_entity_id_key" ON "custom_field_settings"("custom_field_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "custom_field_settings_organization_id_entity_type_entity_id_idx" ON "custom_field_settings"("organization_id", "entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_values_custom_field_id_entity_type_entity_id_key" ON "custom_field_values"("custom_field_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "custom_field_values_organization_id_entity_type_entity_id_idx" ON "custom_field_values"("organization_id", "entity_type", "entity_id");
