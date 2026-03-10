import {
  CustomFieldEntityType,
  CustomFieldType,
  LabelPosition,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import { z } from "zod";

const customFieldTypeEnum = z.enum(CustomFieldType);
const numberFormatEnum = z.enum(NumberFormat);
const entityTypeEnum = z.enum(CustomFieldEntityType);
const labelPositionEnum = z.enum(LabelPosition);

const CURRENCY_CODE_REGEX = /^[A-Z]{3}$/;

const enumOptionSchema = z.object({
  name: z.string().min(1).max(256),
  color: z.string().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const createCustomFieldValidator = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(1024).optional(),
  fieldType: customFieldTypeEnum,
  precision: z.number().int().min(0).max(6).optional(),
  numberFormat: numberFormatEnum.optional(),
  currencyCode: z.string().length(3).regex(CURRENCY_CODE_REGEX).optional(),
  customLabel: z.string().max(256).optional(),
  customLabelPosition: labelPositionEnum.optional(),
  enumOptions: z.array(enumOptionSchema).optional(),
  entityTypes: z.array(entityTypeEnum).optional(),
  showInTable: z.boolean().optional(),
  isSearchable: z.boolean().optional(),
  isSortable: z.boolean().optional(),
});

export const updateCustomFieldValidator = z.object({
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(1024).optional(),
  precision: z.number().int().min(0).max(6).optional(),
  numberFormat: numberFormatEnum.optional(),
  currencyCode: z.string().length(3).regex(CURRENCY_CODE_REGEX).optional(),
  customLabel: z.string().max(256).optional(),
  customLabelPosition: labelPositionEnum.optional(),
  entityTypes: z.array(entityTypeEnum).optional(),
  showInTable: z.boolean().optional(),
  isSearchable: z.boolean().optional(),
  isSortable: z.boolean().optional(),
});
