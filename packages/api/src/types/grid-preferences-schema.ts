import { z } from "zod";
import { operationReceiptSchema } from "./attribution-evidence-schema.ts";
import type { JsonObject, JsonValue } from "./common.ts";
import {
  GRID_PREFERENCE_CONTRACT_VERSION,
  GRID_PREFERENCE_REVISION_MAX,
  type GridPreference,
  GridPreferenceErrorCode,
  GridPreferenceGridKey,
  GridPreferenceKind,
  type GridPreferenceReadQuery,
  GridPreferenceReadStatus,
  type GridPreferenceResetRequest,
  type GridPreferenceResetResponse,
  GridPreferenceResetStatus,
  type GridPreferenceRevisionConflict,
  GridPreferenceScopeKey,
  type GridPreferenceSelector,
  type GridPreferenceUpsertRequest,
  type GridPreferenceUpsertResponse,
  GridPreferenceWriteStatus,
  isSupportedGridPreferenceSelector,
  PROJECT_GRID_PREFERENCE_SCOPE_KEY_RE,
  type ProjectGridPreferenceScopeKey,
} from "./grid-preferences.ts";

export const gridPreferenceGridKeySchema = z.enum([
  GridPreferenceGridKey.Sessions,
  GridPreferenceGridKey.Branches,
  GridPreferenceGridKey.Agents,
  GridPreferenceGridKey.ProjectArtifacts,
]);

export const gridPreferenceKindSchema = z.enum([GridPreferenceKind.ViewState]);

export const gridPreferenceScopeKeySchema = z.union([
  z.enum([GridPreferenceScopeKey.Default, GridPreferenceScopeKey.Approved]),
  z.custom<ProjectGridPreferenceScopeKey>(
    (value) =>
      typeof value === "string" &&
      PROJECT_GRID_PREFERENCE_SCOPE_KEY_RE.test(value)
  ),
]);

export const gridPreferenceExpectedRevisionSchema = z
  .number()
  .int()
  .min(1)
  .max(GRID_PREFERENCE_REVISION_MAX);

const EXPECTED_REVISION_QUERY_VALUE_RE = /^[1-9]\d*$/;

const expectedRevisionQueryValueSchema = z
  .string()
  .regex(EXPECTED_REVISION_QUERY_VALUE_RE)
  .transform((value) => Number(value))
  .pipe(gridPreferenceExpectedRevisionSchema);

export const gridPreferenceSelectorShape = {
  gridKey: gridPreferenceGridKeySchema,
  preferenceKind: gridPreferenceKindSchema,
  scopeKey: gridPreferenceScopeKeySchema,
} satisfies Record<keyof GridPreferenceSelector, z.ZodTypeAny>;

export const gridPreferenceSelectorSchema = z
  .object(gridPreferenceSelectorShape)
  .strict()
  .superRefine(addSupportedSelectorIssue);

export const gridPreferenceReadQuerySchema = z
  .object({
    gridKey: gridPreferenceGridKeySchema.optional(),
    preferenceKind: gridPreferenceKindSchema.optional(),
    scopeKey: gridPreferenceScopeKeySchema.optional(),
  })
  .strict()
  .superRefine(addAllOrNoSelectorFieldsIssue)
  .superRefine(addSupportedSelectorIssue)
  .transform((query): GridPreferenceReadQuery => {
    if (query.gridKey === undefined) {
      return {};
    }
    return { selector: query as GridPreferenceSelector };
  });

export const gridPreferenceResetQuerySchema = z
  .object({
    ...gridPreferenceSelectorShape,
    expectedRevision: expectedRevisionQueryValueSchema.optional(),
  })
  .strict()
  .superRefine(addSupportedSelectorIssue)
  .transform((query): GridPreferenceResetRequest => query);

export const gridPreferenceUpsertRequestEnvelopeShape = {
  ...gridPreferenceSelectorShape,
  value: z.unknown(),
  expectedRevision: gridPreferenceExpectedRevisionSchema.optional(),
} satisfies Record<keyof GridPreferenceUpsertRequest, z.ZodTypeAny>;

export const gridPreferenceUpsertRequestEnvelopeSchema = z
  .object(gridPreferenceUpsertRequestEnvelopeShape)
  .strict()
  .superRefine(addSupportedSelectorIssue);

const gridPreferenceJsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(gridPreferenceJsonValueSchema),
    z.record(z.string(), gridPreferenceJsonValueSchema),
  ])
);

const gridPreferenceJsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  gridPreferenceJsonValueSchema
);

export const gridPreferenceSchema: z.ZodType<GridPreference> = z
  .object({
    ...gridPreferenceSelectorShape,
    value: gridPreferenceJsonObjectSchema,
    revision: gridPreferenceExpectedRevisionSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    contractVersion: z.literal(GRID_PREFERENCE_CONTRACT_VERSION),
  })
  .strict()
  .superRefine(addSupportedSelectorIssue);

export const gridPreferenceRevisionConflictSchema: z.ZodType<GridPreferenceRevisionConflict> =
  z
    .object({
      code: z.literal(GridPreferenceErrorCode.StaleRevision),
      selector: gridPreferenceSelectorSchema,
      expectedRevision: gridPreferenceExpectedRevisionSchema,
      currentRevision: gridPreferenceExpectedRevisionSchema.optional(),
      current: gridPreferenceSchema.optional(),
      contractVersion: z.literal(GRID_PREFERENCE_CONTRACT_VERSION),
    })
    .strict();

/**
 * Keys-covered guard for the strict write responses below: a field the route
 * starts emitting must be taught here, or every client still parsing with this
 * schema reads a stored write as failed. ISS-12552 added `operationReceipt`,
 * which an API-key write carries.
 */
const gridPreferenceUpsertResponseShape = {
  status: z.literal(GridPreferenceWriteStatus.Stored),
  preference: gridPreferenceSchema,
  contractVersion: z.literal(GRID_PREFERENCE_CONTRACT_VERSION),
  operationReceipt: operationReceiptSchema.optional(),
} satisfies Record<keyof GridPreferenceUpsertResponse, z.ZodTypeAny>;

export const gridPreferenceUpsertResponseSchema = z
  .object(gridPreferenceUpsertResponseShape)
  .strict();

export const gridPreferenceReadResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal(GridPreferenceReadStatus.List),
      preferences: z.array(gridPreferenceSchema),
      contractVersion: z.literal(GRID_PREFERENCE_CONTRACT_VERSION),
    })
    .strict(),
  z
    .object({
      status: z.literal(GridPreferenceReadStatus.Found),
      preference: gridPreferenceSchema,
      contractVersion: z.literal(GRID_PREFERENCE_CONTRACT_VERSION),
    })
    .strict(),
  z
    .object({
      status: z.literal(GridPreferenceReadStatus.Missing),
      selector: gridPreferenceSelectorSchema,
      contractVersion: z.literal(GRID_PREFERENCE_CONTRACT_VERSION),
    })
    .strict(),
]);

const gridPreferenceResetDeletedShape = {
  status: z.literal(GridPreferenceResetStatus.Deleted),
  selector: gridPreferenceSelectorSchema,
  previousRevision: gridPreferenceExpectedRevisionSchema,
  contractVersion: z.literal(GRID_PREFERENCE_CONTRACT_VERSION),
  operationReceipt: operationReceiptSchema.optional(),
} satisfies Record<
  keyof Extract<
    GridPreferenceResetResponse,
    { status: typeof GridPreferenceResetStatus.Deleted }
  >,
  z.ZodTypeAny
>;

const gridPreferenceResetMissingShape = {
  status: z.literal(GridPreferenceResetStatus.Missing),
  selector: gridPreferenceSelectorSchema,
  contractVersion: z.literal(GRID_PREFERENCE_CONTRACT_VERSION),
  operationReceipt: operationReceiptSchema.optional(),
} satisfies Record<
  keyof Extract<
    GridPreferenceResetResponse,
    { status: typeof GridPreferenceResetStatus.Missing }
  >,
  z.ZodTypeAny
>;

export const gridPreferenceResetResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.object(gridPreferenceResetDeletedShape).strict(),
    z.object(gridPreferenceResetMissingShape).strict(),
  ]
);

function addAllOrNoSelectorFieldsIssue(
  query: Partial<GridPreferenceSelector>,
  ctx: z.core.$RefinementCtx
): void {
  const selectorFieldCount = [
    query.gridKey,
    query.preferenceKind,
    query.scopeKey,
  ].filter((value) => value !== undefined).length;
  if (selectorFieldCount === 0 || selectorFieldCount === 3) {
    return;
  }
  ctx.addIssue({
    code: "custom",
    message:
      "gridKey, preferenceKind, and scopeKey must be provided together or omitted together",
  });
}

function addSupportedSelectorIssue(
  selector: Partial<GridPreferenceSelector>,
  ctx: z.core.$RefinementCtx
): void {
  if (
    selector.gridKey === undefined ||
    selector.preferenceKind === undefined ||
    selector.scopeKey === undefined ||
    isSupportedGridPreferenceSelector(selector as GridPreferenceSelector)
  ) {
    return;
  }
  ctx.addIssue({
    code: "custom",
    message: "scopeKey approved is only supported for the branches grid",
    path: ["scopeKey"],
  });
}
