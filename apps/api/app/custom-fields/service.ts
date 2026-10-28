import type {
  CreateCustomFieldInput,
  CustomFieldWithOptions,
  UpdateCustomFieldInput,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldType,
  MAX_CUSTOM_FIELDS_PER_ORG,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import { resolveServedCustomFieldFilterOperators } from "@repo/api/src/types/custom-field-capabilities";
import type { TransactionClient } from "@repo/database";
import { Prisma, withDb } from "@repo/database";
import { mapWithDbConcurrency } from "@/lib/db-fanout";
import { getPrismaErrorCode, isUnknownEnumValueError } from "@/lib/db-utils";
import { fieldsThatMoved } from "@/lib/operation-receipts/changed-fields";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import {
  CUSTOM_FIELD_UPDATE_FIELDS,
  CUSTOM_FIELD_UPDATE_SELECT,
} from "./custom-field-definition-receipt";
import { isReferenceFieldType } from "./reference-targets";
import { reportUnreadableCustomField } from "./unreadable-field-telemetry";
import {
  computeDisplayValue,
  MAX_ENUM_OPTIONS_PER_FIELD,
  validateFieldNameNotReserved,
  validateValueType,
} from "./utils";

/**
 * Thrown when a custom field with the same name already exists in the organization.
 * Caught by the route layer to return a 409 conflict response.
 */
export class DuplicateNameError extends Error {
  constructor(name: string) {
    super(
      `A custom field named "${name}" already exists in this organization.`
    );
    this.name = "DuplicateNameError";
  }
}

/**
 * Custom fields service - handles database operations for custom field definitions.
 * No auth checks here — those belong in the route layer.
 */
export const customFieldsService = {
  /**
   * Create a new custom field definition.
   * Checks the 500-field org limit inside the creation transaction to avoid TOCTOU.
   * Throws DuplicateNameError on unique name violation (P2002).
   * Creates enum options inline within the same transaction.
   */
  async createField(
    organizationId: string,
    userId: string,
    input: CreateCustomFieldInput,
    /** Runs on the creation transaction (ISS-12552). */
    recordWrite?: RecordWriteInTransaction<{ id: string }>
  ): Promise<CustomFieldWithOptions> {
    const { enumOptions, ...fieldData } = input;

    // Validate name doesn't conflict with built-in entity properties
    if (input.entityTypes && input.entityTypes.length > 0) {
      validateFieldNameNotReserved(input.name, input.entityTypes);
    }

    // The same cap the incremental enum-option route enforces, applied to the
    // create path too so one bound governs both writers. Beside the other
    // input-only precondition rather than inside the transaction: unlike the
    // org field-limit check below, this depends on nothing but the argument, so
    // there is no TOCTOU to close and a transaction would only add a
    // BEGIN/ROLLBACK to every refusal. `createField` is exported, so the guard
    // is reachable independently of the route's schema.
    if (
      input.enumOptions &&
      input.enumOptions.length > MAX_ENUM_OPTIONS_PER_FIELD
    ) {
      throw new Error(
        `Custom field has reached the maximum of ${MAX_ENUM_OPTIONS_PER_FIELD} enum options.`
      );
    }

    try {
      const field = await withDb.tx(async (tx) => {
        // Check field limit inside the transaction to avoid TOCTOU race
        const count = await tx.customField.count({
          where: { organizationId },
        });
        if (count >= MAX_CUSTOM_FIELDS_PER_ORG) {
          throw new Error(
            `Organization has reached the maximum of ${MAX_CUSTOM_FIELDS_PER_ORG} custom field definitions.`
          );
        }

        const created = await tx.customField.create({
          data: {
            ...fieldData,
            organizationId,
            createdById: userId,
            ...(enumOptions && enumOptions.length > 0
              ? {
                  enumOptions: {
                    create: enumOptions.map((opt, index) => ({
                      name: opt.name,
                      color: opt.color ?? "none",
                      enabled: opt.enabled ?? true,
                      sortOrder: opt.sortOrder ?? index,
                    })),
                  },
                }
              : {}),
          },
          include: CUSTOM_FIELD_WITH_OPTIONS_INCLUDE,
        });

        await recordWrite?.(tx, created);
        return created;
      });

      return toCustomField(field);
    } catch (error) {
      if (getPrismaErrorCode(error) === "P2002") {
        throw new DuplicateNameError(input.name);
      }
      throw error;
    }
  },

  /**
   * Find all custom field definitions for an organization.
   * Includes enum options ordered by sortOrder.
   */
  async findByOrg(organizationId: string): Promise<CustomFieldWithOptions[]> {
    try {
      const fields = await withDb((db) =>
        db.customField.findMany({
          where: { organizationId },
          include: CUSTOM_FIELD_WITH_OPTIONS_INCLUDE,
          orderBy: { createdAt: "asc" },
        })
      );
      return fields.map(toCustomField);
    } catch (error) {
      if (!isUnknownEnumValueError(error)) {
        throw error;
      }
      return await findReadableFieldsByOrg(organizationId);
    }
  },

  /**
   * Find a custom field by ID, scoped to the organization.
   * Returns null if not found or if the field belongs to a different org.
   */
  async findById(
    id: string,
    organizationId: string
  ): Promise<CustomFieldWithOptions | null> {
    const field = await withDb((db) =>
      db.customField.findFirst({
        where: { id, organizationId },
        include: CUSTOM_FIELD_WITH_OPTIONS_INCLUDE,
      })
    );
    return field ? toCustomField(field) : null;
  },

  /**
   * Update a custom field's mutable fields.
   * fieldType is immutable after creation — UpdateCustomFieldInput excludes it.
   *
   * `numberFormat` is not: a NUMBER field can be switched to DURATION (or away
   * from it) after rows already exist. Those rows carry a cached `displayValue`
   * computed under the OLD format, and were admitted by the OLD format's
   * validation — a negative number is a legal NONE value and an illegal
   * DURATION one. Changing only the definition would leave the field claiming
   * DURATION while serving stale strings and values its own write path would
   * now reject, so the transition revalidates and rewrites the whole population
   * in the same transaction, or fails and changes nothing (ISS-7210).
   */
  async updateField(
    id: string,
    organizationId: string,
    input: Omit<UpdateCustomFieldInput, "id">,
    /**
     * Runs on the update's transaction with the columns that moved
     * (ISS-12552). Supplying it always reads the previous row.
     */
    recordWrite?: RecordWriteInTransaction<{ changedFields: string[] }>
  ): Promise<CustomFieldWithOptions> {
    try {
      const field = await withDb.tx(async (tx) => {
        // Validate name doesn't conflict with built-in entity properties.
        // Read + validate + update inside a single transaction to prevent TOCTOU race.
        // Read once for every consumer, and only when one of them needs it:
        // an update that touches neither the name/entity types nor the number
        // format, and records no receipt, still costs no extra query.
        const needsExisting =
          recordWrite !== undefined ||
          Boolean(input.name || input.entityTypes) ||
          input.numberFormat !== undefined ||
          input.referenceTargetSources !== undefined;
        const existing = needsExisting
          ? await tx.customField.findFirst({
              where: { id, organizationId },
              select: CUSTOM_FIELD_UPDATE_SELECT,
            })
          : null;

        if ((input.name || input.entityTypes) && existing) {
          const nameToCheck = input.name ?? existing.name;
          const typesToCheck = input.entityTypes ?? existing.entityTypes;
          validateFieldNameNotReserved(nameToCheck, typesToCheck);
        }

        // The create validator refuses sources on a non-reference type, but it
        // can only do so because the payload carries `fieldType`. `fieldType`
        // is immutable and therefore absent from the update payload, so the
        // same check is only possible here, against the stored row.
        if (
          input.referenceTargetSources !== undefined &&
          existing &&
          !isReferenceFieldType(existing.fieldType as CustomFieldType)
        ) {
          throw new IncompatibleReferenceSourcesError(
            existing.fieldType as CustomFieldType
          );
        }
        const formatChanged =
          input.numberFormat !== undefined &&
          input.numberFormat !== existing?.numberFormat;

        const updated = await tx.customField.update({
          where: { id, organizationId },
          data: {
            name: input.name,
            description: input.description,
            precision: input.precision,
            numberFormat: input.numberFormat,
            currencyCode: input.currencyCode,
            customLabel: input.customLabel,
            customLabelPosition: input.customLabelPosition,
            entityTypes: input.entityTypes,
            referenceTargetSources: input.referenceTargetSources,
            showInTable: input.showInTable,
            isSearchable: input.isSearchable,
            isSortable: input.isSortable,
          },
          include: CUSTOM_FIELD_WITH_OPTIONS_INCLUDE,
        });

        if (formatChanged) {
          await rewriteNumberDisplayValues(tx, updated, organizationId);
        }

        await recordWrite?.(tx, {
          changedFields: fieldsThatMoved(
            CUSTOM_FIELD_UPDATE_FIELDS,
            input,
            existing ?? {},
            updated
          ),
        });
        return updated;
      }, UPDATE_FIELD_TX_OPTIONS);
      return toCustomField(field);
    } catch (error) {
      if (getPrismaErrorCode(error) === "P2002") {
        throw new DuplicateNameError(input.name ?? "");
      }
      throw error;
    }
  },

  /**
   * Delete a custom field and all dependent records.
   *
   * The dependent tables carry `ON DELETE CASCADE` foreign keys on
   * `custom_field_id` (added by the switch_to_foreign_keys migration), so the
   * database would clear them on its own; these explicit deletes state the
   * order at the application layer and run ahead of it inside the same
   * transaction.
   * Order: CustomFieldValue → CustomFieldSetting → CustomFieldEnumOption → CustomField
   *
   * On a tenant the field was cascaded across, that is one CustomFieldSetting
   * row per FEATURE document in the project, so the chain runs under
   * DELETE_FIELD_TX_OPTIONS rather than Prisma's 5s default.
   */
  deleteField(
    id: string,
    organizationId: string,
    /** Runs on the delete's transaction (ISS-12552). */
    recordWrite?: RecordWriteInTransaction<{ id: string }>
  ): Promise<void> {
    return withDb.tx(async (tx) => {
      await tx.customFieldValue.deleteMany({ where: { customFieldId: id } });
      await tx.customFieldSetting.deleteMany({ where: { customFieldId: id } });
      await tx.customFieldEnumOption.deleteMany({
        where: { customFieldId: id },
      });
      await tx.customField.delete({ where: { id, organizationId } });
      await recordWrite?.(tx, { id });
    }, DELETE_FIELD_TX_OPTIONS);
  },
};

/**
 * Transaction bounds for `deleteField`.
 *
 * Deleting a field removes every CustomFieldValue and CustomFieldSetting row
 * that references it, and on a project `attachField` cascaded the field across
 * that is one setting row per FEATURE document — 8000+ on the projects
 * `CASCADE_TX_TIMEOUT_MS` in project-field-cascade.ts was raised for. Under Prisma's
 * 5s default the chain aborts with P2028 and rolls back, so on exactly those
 * tenants the field can never be deleted, however often the delete is retried.
 *
 * Bounds follow the long-transaction convention already used across apps/api
 * (audit ledger append, catalog pack import): 30s of work, 5s to acquire a pool
 * connection — the longer the transaction holds a connection, the more a
 * contended caller needs a maxWait above Prisma's 2s default to avoid failing
 * with P2024 before it ever starts. The timeout is a ceiling, not a duration:
 * each statement stays the same set-based delete it was, so what changes is
 * only whether the chain is allowed to finish.
 */
export const DELETE_FIELD_TX_OPTIONS = {
  maxWait: 5000,
  timeout: 30_000,
} as const;

/**
 * Standard include for custom field queries that include enum options.
 * Enum options ordered by sortOrder ascending.
 */
const CUSTOM_FIELD_WITH_OPTIONS_INCLUDE = {
  enumOptions: {
    orderBy: { sortOrder: "asc" as const },
  },
} as const;

/** Type for a custom field returned from database with enum options included. */
type CustomFieldFromDb = Prisma.CustomFieldGetPayload<{
  include: typeof CUSTOM_FIELD_WITH_OPTIONS_INCLUDE;
}>;

/**
 * Transform a Prisma custom field record into the API CustomFieldWithOptions shape.
 * Follows the toProjectWithDetails pattern from projects/service.ts.
 */
function toCustomField(field: CustomFieldFromDb): CustomFieldWithOptions {
  return {
    id: field.id,
    organizationId: field.organizationId,
    name: field.name,
    description: field.description,
    fieldType: field.fieldType,
    createdById: field.createdById,
    createdAt: field.createdAt,
    updatedAt: field.updatedAt,
    precision: field.precision,
    numberFormat: field.numberFormat,
    currencyCode: field.currencyCode,
    customLabel: field.customLabel,
    customLabelPosition: field.customLabelPosition,
    isGlobalToOrg: field.isGlobalToOrg,
    entityTypes: field.entityTypes,
    referenceTargetSources: field.referenceTargetSources,
    showInTable: field.showInTable,
    isSearchable: field.isSearchable,
    isSortable: field.isSortable,
    filterOperators: resolveServedCustomFieldFilterOperators(field.fieldType),
    enumOptions: field.enumOptions.map((opt) => ({
      id: opt.id,
      customFieldId: opt.customFieldId,
      name: opt.name,
      color: opt.color,
      enabled: opt.enabled,
      sortOrder: opt.sortOrder,
    })),
  };
}

/**
 * Transaction bounds for `updateField`.
 *
 * A `numberFormat` change rewrites the cached `displayValue` of every value row
 * for the field, so the same reasoning as ENUM_OPTION_UPDATE_TX_OPTIONS applies:
 * the rewrite is a single set-based statement, but it still spans the field's
 * whole population and must be allowed to finish rather than trip Prisma's 5s
 * default.
 *
 * `withDb.tx` silently ignores `timeout`/`maxWait` when it joins an ambient
 * transaction, so `updateField` must stay the outermost transaction for these
 * bounds to apply at all.
 */
const UPDATE_FIELD_TX_OPTIONS = {
  maxWait: 5000,
  timeout: 30_000,
} as const;

/**
 * Thrown when a `numberFormat` transition would leave already-stored values
 * illegal under the new format. Caught by the route layer to return a 400.
 */
export class IncompatibleNumberFormatError extends Error {
  constructor(
    numberFormat: NumberFormat,
    invalidCount: number,
    sample: string
  ) {
    super(
      `Cannot change this field to ${numberFormat}: ${invalidCount} stored value(s) are not valid under it (for example ${sample}). Correct or clear those values first.`
    );
    this.name = "IncompatibleNumberFormatError";
  }
}

/**
 * Revalidates and rewrites every stored NUMBER value after the field's
 * `numberFormat` changed.
 *
 * Validation runs through `validateValueType` — the SAME check the write path
 * applies — so the transition can never admit a value a fresh write would
 * reject. It runs over ALL distinct values BEFORE any write, and throws on the
 * first population that fails, so an incompatible transition rolls the whole
 * transaction back rather than half-converting the field.
 *
 * `displayValue` depends only on the stored number and the field's format
 * config, so rows sharing a number share a string. The distinct read is
 * deliberately uncapped — the transition is all-or-nothing, so a `take` would
 * silently half-convert the field — and the rewrite it feeds is ONE statement
 * (see `writeNumberDisplayValues`), not one per distinct number. That matters
 * most for the format this changes: DURATION values are elapsed spans, so
 * `distinct` barely dedupes and the distinct count is effectively the row count.
 */
async function rewriteNumberDisplayValues(
  tx: TransactionClient,
  field: CustomFieldFromDb,
  organizationId: string
): Promise<void> {
  if (field.fieldType !== CustomFieldType.Number) {
    return;
  }

  const rows = await tx.customFieldValue.findMany({
    where: {
      customFieldId: field.id,
      organizationId,
      numberValue: { not: null },
    },
    select: { numberValue: true },
    distinct: ["numberValue"],
  });

  const format = field.numberFormat ?? null;
  const invalid: number[] = [];
  for (const row of rows) {
    if (row.numberValue === null) {
      continue;
    }
    try {
      validateValueType(CustomFieldType.Number, row.numberValue, format);
    } catch {
      invalid.push(row.numberValue);
    }
  }
  if (invalid.length > 0) {
    throw new IncompatibleNumberFormatError(
      format ?? NumberFormat.None,
      invalid.length,
      String(invalid[0])
    );
  }

  const fieldWithOptions = toCustomField(field);
  const pairs = await Promise.all(
    rows
      .filter(
        (row): row is { numberValue: number } =>
          typeof row.numberValue === "number"
      )
      .map(async (row) => ({
        numberValue: row.numberValue,
        displayValue: await computeDisplayValue(
          fieldWithOptions,
          row.numberValue
        ),
      }))
  );

  if (pairs.length === 0) {
    return;
  }

  await writeNumberDisplayValues(tx, field.id, organizationId, pairs);
}

/** One distinct stored number and the display string it re-renders to. */
type NumberDisplayPair = {
  numberValue: number;
  displayValue: string;
};

/**
 * Rewrites `display_value` for every value row of the field whose stored number
 * appears in `pairs`, in ONE statement.
 *
 * Same problem and same shape as `updateMultiEnumDisplayValues` and
 * `reorderEnumOptions` in enum-options-service.ts: a `display_value` rewrite
 * across a whole `custom_field_values` population, expressed as one set-based
 * UPDATE joined against caller-supplied data rather than an awaited round trip
 * per value on the transaction's single pinned connection.
 *
 * It differs from those two in how the data travels. They inline a
 * `FROM (VALUES …)` list because their cardinality is bounded by the field's
 * enum-option limit; here it is the number of DISTINCT stored numbers, which
 * for a DURATION field is effectively the row count. Two array parameters
 * expanded by `unnest` keep this at one statement and four bind parameters no
 * matter how large the population is, where a VALUES list would grow with it
 * and eventually exceed Postgres' 65535-parameter ceiling.
 *
 * The equality join on `number_value` is exactly the predicate the previous
 * per-value `updateMany` used, so which rows are rewritten is unchanged.
 */
function writeNumberDisplayValues(
  tx: TransactionClient,
  customFieldId: string,
  organizationId: string,
  pairs: NumberDisplayPair[]
): Promise<number> {
  // `now()` is the transaction's start time, so it can land *behind* a row
  // written later in that same transaction — and `customField.update` already
  // ran above. Prisma stamps `@updatedAt` from the client clock, so taking the
  // value from the same clock here keeps this write monotonic against it.
  const updatedAt = new Date();
  return tx.$executeRaw(Prisma.sql`
    UPDATE "custom_field_values" AS cfv
    SET "display_value" = data.display_value,
        -- timestamp WITHOUT time zone holding UTC, matching what Prisma writes.
        "updated_at" = ${updatedAt}::timestamp
    FROM unnest(
           ${pairs.map((pair) => pair.numberValue)}::double precision[],
           ${pairs.map((pair) => pair.displayValue)}::text[]
         ) AS data(number_value, display_value)
    WHERE cfv."custom_field_id" = ${customFieldId}::uuid
      AND cfv."organization_id" = ${organizationId}::uuid
      AND cfv."number_value" = data.number_value
  `);
}

/**
 * Thrown when an update tries to set `referenceTargetSources` on a field whose
 * type does not take reference targets. Caught by the route layer to return a
 * 400.
 */
export class IncompatibleReferenceSourcesError extends Error {
  constructor(fieldType: CustomFieldType) {
    super(
      `referenceTargetSources is only valid for REFERENCE and REFERENCE_MULTI fields, not ${fieldType}.`
    );
    this.name = "IncompatibleReferenceSourcesError";
  }
}

/**
 * ISS-11071: `findByOrg` when a row holds an enum value this build's client
 * cannot map (a rolling deploy whose migration added it). Prisma fails the whole
 * `findMany` without naming the row, so each row is read on its own and only
 * the unreadable ones are left out. Only reached on that error, so the per-row
 * reads cost nothing on the normal path.
 */
async function findReadableFieldsByOrg(
  organizationId: string
): Promise<CustomFieldWithOptions[]> {
  const rows = await withDb((db) =>
    db.customField.findMany({
      where: { organizationId },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    })
  );
  const fields = await mapWithDbConcurrency(rows, async ({ id }) => {
    try {
      const field = await withDb((db) =>
        db.customField.findFirst({
          where: { id, organizationId },
          include: CUSTOM_FIELD_WITH_OPTIONS_INCLUDE,
        })
      );
      return field ? toCustomField(field) : null;
    } catch (error) {
      if (!isUnknownEnumValueError(error)) {
        throw error;
      }
      reportUnreadableCustomField(organizationId, id, error);
      return null;
    }
  });
  return fields.filter((field) => field !== null);
}
