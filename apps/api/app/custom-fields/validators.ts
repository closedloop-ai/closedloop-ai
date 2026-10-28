import {
  POSTGRES_INT4_MAX,
  POSTGRES_INT4_MIN,
} from "@closedloop-ai/loops-api/column-limits";
import {
  CustomFieldEntityType,
  CustomFieldType,
  LabelPosition,
  NumberFormat,
  ReferenceTargetSource,
} from "@repo/api/src/types/custom-field";
import { z } from "zod";
import { isReferenceFieldType } from "./reference-targets";
import { MAX_ENUM_OPTIONS_PER_FIELD } from "./utils";

const customFieldTypeEnum = z.enum(CustomFieldType);
const numberFormatEnum = z.enum(NumberFormat);
const entityTypeEnum = z.enum(CustomFieldEntityType);
const labelPositionEnum = z.enum(LabelPosition);
export const referenceTargetSourceEnum = z.enum(ReferenceTargetSource);

const CURRENCY_CODE_REGEX = /^[A-Z]{3}$/;

const enumOptionSchema = z.object({
  name: z.string().min(1).max(256),
  color: z.string().optional(),
  enabled: z.boolean().optional(),
  // Writes `CustomFieldEnumOption.sortOrder`, a Prisma `Int`, through
  // `createField`'s nested create — the same column the incremental route
  // bounds, so it needs the same bound: the column's range at both ends, not a
  // floor of `0` that would refuse a negative both paths store today.
  sortOrder: z
    .number()
    .int()
    .min(POSTGRES_INT4_MIN)
    .max(POSTGRES_INT4_MAX)
    .optional(),
});

/**
 * Max distinct sources a reference field may permit. Four exist today, so this
 * only bounds a repeated-value payload.
 *
 * Exported because the search boundary needs the SAME bound: `sources` there
 * also becomes one query `OR` branch per entry, so a second copy of the number
 * is a second place for it to drift from the enum it describes.
 */
export const MAX_REFERENCE_TARGET_SOURCES = 4;

const referenceTargetSourcesSchema = z
  .array(referenceTargetSourceEnum)
  .max(MAX_REFERENCE_TARGET_SOURCES)
  .optional();

export const createCustomFieldValidator = z
  .object({
    name: z.string().min(1).max(256),
    description: z.string().max(1024).optional(),
    fieldType: customFieldTypeEnum,
    precision: z.number().int().min(0).max(6).optional(),
    numberFormat: numberFormatEnum.optional(),
    currencyCode: z.string().length(3).regex(CURRENCY_CODE_REGEX).optional(),
    customLabel: z.string().max(256).optional(),
    customLabelPosition: labelPositionEnum.optional(),
    // The create path nested-creates every element and never consulted
    // `checkOptionLimit`, so the documented 100-option cap the incremental route
    // enforces was bypassable in a single request.
    enumOptions: z
      .array(enumOptionSchema)
      .max(MAX_ENUM_OPTIONS_PER_FIELD)
      .optional(),
    entityTypes: z.array(entityTypeEnum).optional(),
    referenceTargetSources: referenceTargetSourcesSchema,
    showInTable: z.boolean().optional(),
    isSearchable: z.boolean().optional(),
    isSortable: z.boolean().optional(),
  })
  // A reference field with no sources would accept every artifact in the org,
  // making the per-field target contract unenforceable. Requiring it at the
  // boundary is what makes `isTargetAllowed`'s fail-closed branch unreachable
  // for fields created through this API.
  .superRefine((input, ctx) => {
    const isReference = isReferenceFieldType(input.fieldType);
    const sources = input.referenceTargetSources ?? [];

    if (isReference && sources.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["referenceTargetSources"],
        message: `A ${input.fieldType} field must declare at least one target source.`,
      });
    }

    if (!isReference && sources.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["referenceTargetSources"],
        message: `referenceTargetSources is only valid for REFERENCE and REFERENCE_MULTI fields, not ${input.fieldType}.`,
      });
    }
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
  // `fieldType` is immutable, so the update path cannot re-decide whether this
  // is a reference field; an empty array would silently widen an existing
  // field to accept anything, so it is rejected rather than stored.
  referenceTargetSources: z
    .array(referenceTargetSourceEnum)
    .min(1)
    .max(MAX_REFERENCE_TARGET_SOURCES)
    .optional(),
  showInTable: z.boolean().optional(),
  isSearchable: z.boolean().optional(),
  isSortable: z.boolean().optional(),
});
