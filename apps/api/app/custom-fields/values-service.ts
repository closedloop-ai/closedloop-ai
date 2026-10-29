import type {
  AttachCustomFieldInput,
  CustomFieldSettingWithOptions,
  CustomFieldValueDetail,
  CustomFieldWithOptions,
  LabelPosition,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import type { Result } from "@repo/api/src/types/result";
import type { BasicUser } from "@repo/api/src/types/user";
import {
  ArtifactType,
  type Prisma,
  type TransactionClient,
  withDb,
} from "@repo/database";
import type { ArtifactCustomFieldValueError } from "./artifact-custom-field-value-contract";
import { artifactCustomFieldValueResult } from "./artifact-custom-field-value-result";
import { EntityNotFoundError, FieldNotFoundError } from "./custom-field-errors";
import { resolvePeopleMap } from "./people-resolution";
import { customFieldProjectCascade } from "./project-field-cascade";
import {
  isReferenceFieldType,
  normalizeReferenceIds,
  replaceReferenceRows,
  resolveAndValidateReferenceTargets,
  validateReferenceTargets,
} from "./reference-targets";
import {
  coerceCustomFieldDurationMs,
  computeDisplayValue,
  InvalidFieldValueError,
  validateValueType,
} from "./utils";
import {
  SETTING_WITH_FIELD_INCLUDE,
  toSettingWithOptions,
  toValueDetail,
  VALUE_WITH_ENUM_INCLUDE,
} from "./value-projections";

/**
 * Custom field values service - handles database operations for field settings and values.
 *
 * No auth checks here — those belong in the route layer.
 */
export const customFieldValuesService = {
  /**
   * Attach a custom field to an entity by creating a CustomFieldSetting.
   *
   * For PROJECT entities, also cascades the setting to the project's
   * feature-typed document artifacts within the same transaction.
   *
   * Verifies:
   * - The entity exists and belongs to the organization.
   * - The custom field belongs to the organization.
   *
   * Must be the outermost transaction: the cascade needs its own isolation
   * level, and `withDb.tx` fails closed rather than join an ambient
   * transaction whose level is already fixed at BEGIN.
   *
   * @throws EntityNotFoundError if the entity is not found.
   * @throws FieldNotFoundError if the field is not found in this org.
   */
  async attachField(
    fieldId: string,
    entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
    entityId: string,
    organizationId: string,
    input: AttachCustomFieldInput
  ): Promise<CustomFieldSettingWithOptions> {
    await verifyEntityExists(entityType, entityId, organizationId);
    await verifyFieldBelongsToOrg(fieldId, organizationId);

    const settingData = {
      customFieldId: fieldId,
      organizationId,
      entityType,
      entityId,
      isImportant: input.isImportant ?? false,
      isRequired: input.isRequired ?? false,
      sortOrder: input.sortOrder ?? 0,
    };

    const setting = await customFieldProjectCascade.runTransaction(
      async (tx) => {
        const created = await tx.customFieldSetting.create({
          data: settingData,
          include: SETTING_WITH_FIELD_INCLUDE,
        });

        if (entityType === CustomFieldEntityType.Project) {
          await customFieldProjectCascade.attachToChildren(tx, {
            fieldId,
            organizationId,
            projectId: entityId,
            input,
          });
        }

        return created;
      }
    );

    return toSettingWithOptions(setting);
  },

  /**
   * Detach a custom field from an entity by deleting its CustomFieldSetting.
   *
   * Verifies the entity exists and belongs to the organization before deleting.
   *
   * @throws EntityNotFoundError if the entity is not found.
   */
  async detachField(
    fieldId: string,
    entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
    entityId: string,
    organizationId: string
  ): Promise<void> {
    await verifyEntityExists(entityType, entityId, organizationId);

    await withDb((db) =>
      db.customFieldSetting.deleteMany({
        where: { customFieldId: fieldId, entityType, entityId, organizationId },
      })
    );
  },

  /**
   * List all custom field settings for a specific entity instance.
   * Filtered by entityType, entityId, and organizationId.
   * Ordered by sortOrder ascending.
   */
  listSettings(
    entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
    entityId: string,
    organizationId: string
  ): Promise<CustomFieldSettingWithOptions[]> {
    return withDb(async (db) => {
      const settings = await db.customFieldSetting.findMany({
        where: { entityType, entityId, organizationId },
        include: SETTING_WITH_FIELD_INCLUDE,
        orderBy: { sortOrder: "asc" },
      });
      return settings.map(toSettingWithOptions);
    });
  },

  /**
   * Get all custom field values for one entity or a batch of entities.
   *
   * Single entity: pass a string entityId.
   * Batch: pass an array of entityIds — the query uses `entityId: { in: entityIds }`.
   * Both variants include the resolved enumValue relation.
   *
   * PEOPLE users ARE resolved here, and must be: PEOPLE is `ResolvedOnRead`, so
   * `toValueDetail` derives the rendered `displayValue` from these records
   * rather than from the stored column (ISS-7215).
   *
   * FEA-4222 (davetho review cid 3884188153): rows whose DEFINITION does not
   * declare this entity type are excluded. `assertFieldAppliesToEntityType`
   * stops new ones being written; this is the other half — rows already stored
   * before that guard existed stay quarantined instead of becoming visible the
   * moment an admin attaches the field to this entity type. One rule enforced at
   * both ends, including its empty-`entityTypes` legacy carve-out, so the read
   * and the write cannot come to different answers about the same row.
   */
  getValuesForEntity(
    entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
    entityId: string | string[],
    organizationId: string
  ): Promise<CustomFieldValueDetail[]> {
    return withDb(async (db) => {
      const whereEntityId = Array.isArray(entityId)
        ? { in: entityId }
        : entityId;

      const rows = await db.customFieldValue.findMany({
        where: {
          entityType,
          entityId: whereEntityId,
          organizationId,
          customField: {
            OR: [
              { entityTypes: { has: entityType } },
              { entityTypes: { isEmpty: true } },
            ],
          },
        },
        include: VALUE_WITH_ENUM_INCLUDE,
      });

      // One batch across every row, not one per row.
      const allPeopleIds = [
        ...new Set(rows.flatMap((row) => row.peopleValueIds)),
      ];
      const peopleMap = await resolvePeopleMap(allPeopleIds, organizationId);

      return rows.map((row) => toValueDetail(row, peopleMap));
    });
  },

  /**
   * Set (upsert) a custom field value for a specific entity instance.
   *
   * Validation steps:
   * 1. Verify entity exists and belongs to the organization.
   * 2. Verify field belongs to the organization (and load it with enum options).
   * 3. For ENUM fields: verify the option exists and is enabled.
   * 4. For MULTI_ENUM fields: verify each option exists and is enabled.
   * 5. For PEOPLE fields: verify all user IDs belong to the organization.
   * 6. Compute the displayValue string.
   * 7. Upsert the CustomFieldValue row.
   *
   * @throws EntityNotFoundError if the entity is not found.
   * @throws FieldNotFoundError if the field is not found in this org.
   * @throws Error for invalid enum option IDs, disabled options, or unknown user IDs.
   */
  async setValueForEntity(
    fieldId: string,
    entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
    entityId: string,
    organizationId: string,
    rawValue: string | number | string[] | null
  ): Promise<CustomFieldValueDetail> {
    const { field, referenceTargetIds, upsertArgs } = await prepareValueWrite(
      fieldId,
      entityType,
      entityId,
      organizationId,
      rawValue
    );

    // Only a reference write needs a transaction, because only it spans two
    // tables. Keeping every other field type on the single-statement upsert
    // avoids paying for an interactive transaction the write does not need.
    if (referenceTargetIds === null) {
      const upserted = await withDb((db) =>
        db.customFieldValue.upsert(upsertArgs)
      );
      // Re-resolved rather than reusing `prepareValueWrite`'s validation map,
      // which is one query cheaper but is read BEFORE the upsert: a rename
      // committing in that window made a successful PUT echo a label already
      // superseded at the moment it returned, while the very next GET — now
      // live (ISS-7215) — showed the new one, with no concurrent event between
      // the two to explain it (whitlockk review cid 3911294127). This makes the
      // response equal a GET issued immediately after the write; a rename
      // landing after THAT is ordinary read-snapshot behaviour and is not
      // closable here. Free for a non-PEOPLE row — `resolvePeopleMap`
      // short-circuits an empty id list without querying.
      return toValueDetail(
        upserted,
        await resolvePeopleMap(upserted.peopleValueIds, organizationId)
      );
    }

    const upserted = await withDb.tx(async (tx) => {
      // Validating inside the transaction narrows the window between the check
      // and the write, but it does not close it: this is a `findMany`, and at
      // READ COMMITTED it takes no share lock, so a concurrent DELETE can still
      // land between the two. `replaceReferenceRows` maps the resulting FK
      // P2003 to the same 4xx — that mapping, not this ordering, is what makes
      // a deleted target a caller error rather than a 500.
      await validateReferenceTargets(
        field,
        referenceTargetIds,
        organizationId,
        entityId,
        tx
      );

      const row = await tx.customFieldValue.upsert(upsertArgs);

      await replaceReferenceRows(tx, row.id, referenceTargetIds);

      // Re-read so the returned detail carries the rows just written; the
      // upsert's own include ran before them.
      return tx.customFieldValue.findUniqueOrThrow({
        where: { id: row.id },
        include: VALUE_WITH_ENUM_INCLUDE,
      });
    });

    // Same post-write resolve as the non-transactional arm above, for the same
    // reason. A reference row carries no people ids, so this costs no query.
    return toValueDetail(
      upserted,
      await resolvePeopleMap(upserted.peopleValueIds, organizationId)
    );
  },

  /**
   * Set one value through a caller-owned transaction.
   *
   * The caller owns commit and rollback so related activity rows can be
   * persisted atomically with the value mutation. Validation remains shared
   * with the ordinary entry point; every database write, including reference
   * replacement, uses the supplied transaction client.
   */
  async setValueForEntityInTransaction(
    tx: TransactionClient,
    fieldId: string,
    entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
    entityId: string,
    organizationId: string,
    rawValue: string | number | string[] | null
  ): Promise<Result<CustomFieldValueDetail, ArtifactCustomFieldValueError>> {
    const preparedResult = await artifactCustomFieldValueResult(() =>
      prepareValueWrite(fieldId, entityType, entityId, organizationId, rawValue)
    );
    if (!preparedResult.ok) {
      return preparedResult;
    }
    const prepared = preparedResult.value;
    if (prepared.referenceTargetIds !== null) {
      const validation = await artifactCustomFieldValueResult(() =>
        validateReferenceTargets(
          prepared.field,
          prepared.referenceTargetIds ?? [],
          organizationId,
          entityId,
          tx
        )
      );
      if (!validation.ok) {
        return validation;
      }
    }
    const upserted = await tx.customFieldValue.upsert(prepared.upsertArgs);
    if (prepared.referenceTargetIds !== null) {
      await replaceReferenceRows(tx, upserted.id, prepared.referenceTargetIds);
      const reread = await tx.customFieldValue.findUniqueOrThrow({
        where: { id: upserted.id },
        include: VALUE_WITH_ENUM_INCLUDE,
      });
      return {
        ok: true,
        value: toValueDetail(
          reread,
          await resolvePeopleMap(reread.peopleValueIds, organizationId)
        ),
      };
    }
    return {
      ok: true,
      value: toValueDetail(
        upserted,
        await resolvePeopleMap(upserted.peopleValueIds, organizationId)
      ),
    };
  },

  /**
   * Runs every check {@link setValueForEntity} runs, and writes nothing.
   *
   * Exists so a composite request that updates an entity AND its custom fields
   * can reject a bad field value BEFORE it commits the entity — otherwise the
   * caller gets a 400 describing a write that already happened. It shares
   * `prepareValueWrite` with the real write rather than restating the checks,
   * so the two cannot drift apart and pass different payloads.
   *
   * Not a substitute for the write path's own validation: nothing holds a lock
   * between this call and the later write, so the write still validates.
   */
  async validateValueForEntity(
    fieldId: string,
    entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
    entityId: string,
    organizationId: string,
    rawValue: string | number | string[] | null
  ): Promise<void> {
    const { field, referenceTargetIds } = await prepareValueWrite(
      fieldId,
      entityType,
      entityId,
      organizationId,
      rawValue
    );

    if (referenceTargetIds !== null) {
      await resolveAndValidateReferenceTargets(
        field,
        referenceTargetIds,
        organizationId,
        entityId
      );
    }
  },

  /**
   * Clear (delete) a custom field value for a specific entity instance.
   * Uses deleteMany so it is a no-op if no value exists.
   */
  clearValue(
    fieldId: string,
    entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
    entityId: string,
    organizationId: string
  ): Promise<void> {
    return withDb(async (db) => {
      await db.customFieldValue.deleteMany({
        where: {
          customFieldId: fieldId,
          entityType,
          entityId,
          organizationId,
        },
      });
    });
  },

  /** Delete one value through a caller-owned transaction. */
  async clearValueInTransaction(
    tx: TransactionClient,
    fieldId: string,
    entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
    entityId: string,
    organizationId: string
  ): Promise<number> {
    const deleted = await tx.customFieldValue.deleteMany({
      where: {
        customFieldId: fieldId,
        entityType,
        entityId,
        organizationId,
      },
    });
    return deleted.count;
  },
};

/**
 * Verifies that an entity exists and belongs to the given organization.
 * Throws EntityNotFoundError if not found.
 */
async function verifyEntityExists(
  entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
  entityId: string,
  organizationId: string
): Promise<void> {
  const exists = await withDb(async (db) => {
    if (entityType === CustomFieldEntityType.Project) {
      const record = await db.project.findFirst({
        where: { id: entityId, organizationId },
        select: { id: true },
      });
      return record !== null;
    }

    const record = await db.artifact.findFirst({
      where: {
        id: entityId,
        organizationId,
        type: getArtifactTypeForEntityType(entityType),
      },
      select: { id: true },
    });
    return record !== null;
  });

  if (!exists) {
    throw new EntityNotFoundError(entityType, entityId);
  }
}

/**
 * Verifies that a custom field belongs to the given organization.
 * Throws FieldNotFoundError if not found.
 */
async function verifyFieldBelongsToOrg(
  fieldId: string,
  organizationId: string
): Promise<void> {
  const field = await withDb((db) =>
    db.customField.findFirst({
      where: { id: fieldId, organizationId },
      select: { id: true },
    })
  );

  if (!field) {
    throw new FieldNotFoundError(fieldId);
  }
}

/**
 * Column payload shape used when building the upsert create/update data.
 * Only one value column should be populated per write; the rest remain null/[].
 */
type ValueColumnPayload = {
  textValue: string | null;
  numberValue: number | null;
  dateValue: Date | null;
  enumValueId: string | null;
  multiEnumValueIds: string[];
  peopleValueIds: string[];
};

/** Returns a zeroed ValueColumnPayload (all nullable columns null, arrays empty). */
function buildEmptyPayload(): ValueColumnPayload {
  return {
    textValue: null,
    numberValue: null,
    dateValue: null,
    enumValueId: null,
    multiEnumValueIds: [],
    peopleValueIds: [],
  };
}

/**
 * Prisma type for a custom field with enum options — used inside setValueForEntity
 * to avoid repeating the inline query type.
 */
type FieldWithEnumOptions = Prisma.CustomFieldGetPayload<{
  include: { enumOptions: true };
}>;

/**
 * Validates and builds the typed column payload for a field write.
 * Dispatches to type-specific helpers to keep cognitive complexity low.
 *
 * Returns the users it resolved to validate a PEOPLE value alongside the
 * payload, so the display computation and the response projection can reuse one
 * lookup instead of repeating it (empty for every other type).
 */
async function buildValuePayload(
  fieldType: string,
  fieldId: string,
  organizationId: string,
  rawValue: string | number | string[] | null
): Promise<{
  payload: ValueColumnPayload;
  peopleById: Map<string, BasicUser>;
}> {
  const payload = buildEmptyPayload();
  let peopleById = new Map<string, BasicUser>();
  if (rawValue === null || rawValue === undefined) {
    return { payload, peopleById };
  }
  if (fieldType === CustomFieldType.Enum) {
    payload.enumValueId = await validateEnumOptionExists(
      fieldId,
      String(rawValue)
    );
  } else if (fieldType === CustomFieldType.MultiEnum) {
    payload.multiEnumValueIds = await validateMultiEnumOptions(
      fieldId,
      rawValue
    );
  } else if (fieldType === CustomFieldType.People) {
    const validated = await validatePeopleIds(organizationId, rawValue);
    payload.peopleValueIds = validated.userIds;
    peopleById = validated.peopleById;
  } else if (fieldType === CustomFieldType.Text) {
    payload.textValue = String(rawValue);
  } else if (fieldType === CustomFieldType.Number) {
    payload.numberValue = Number(rawValue);
  } else if (fieldType === CustomFieldType.Date) {
    payload.dateValue = new Date(String(rawValue));
  }
  return { payload, peopleById };
}

/**
 * Validates a single enum option ID exists for the field and is enabled.
 * Returns the option ID on success.
 */
async function validateEnumOptionExists(
  fieldId: string,
  optionId: string
): Promise<string> {
  const option = await withDb((db) =>
    db.customFieldEnumOption.findFirst({
      where: { id: optionId, customFieldId: fieldId },
      select: ENUM_OPTION_VALIDATION_SELECT,
    })
  );
  if (!option) {
    throw new InvalidFieldValueError(
      `Enum option "${optionId}" not found for field "${fieldId}".`
    );
  }
  if (!option.enabled) {
    throw new InvalidFieldValueError(
      `Enum option "${optionId}" is disabled and cannot be set.`
    );
  }
  return optionId;
}

/**
 * Validates each option ID in a MULTI_ENUM value exists and is enabled.
 * Uses a single batch query instead of sequential lookups.
 * Returns the validated array.
 */
async function validateMultiEnumOptions(
  fieldId: string,
  rawValue: string | number | string[]
): Promise<string[]> {
  const optionIds = distinctIds(rawValue);

  const options = await withDb((db) =>
    db.customFieldEnumOption.findMany({
      where: { id: { in: optionIds }, customFieldId: fieldId },
      select: ENUM_OPTION_VALIDATION_SELECT,
    })
  );

  if (options.length !== optionIds.length) {
    const foundIds = new Set(options.map((o) => o.id));
    const missing = optionIds.filter((id) => !foundIds.has(id));
    throw new InvalidFieldValueError(
      `Enum option(s) "${missing.join(", ")}" not found for field "${fieldId}".`
    );
  }

  const disabledOption = options.find((o) => !o.enabled);
  if (disabledOption) {
    throw new InvalidFieldValueError(
      `Enum option "${disabledOption.id}" is disabled and cannot be set.`
    );
  }

  return optionIds;
}

/**
 * Validates that all user IDs in a PEOPLE value belong to the organization, and
 * returns the records so the caller does not fetch them again.
 *
 * The size comparison is exact because `distinctIds` deduped first: Postgres
 * returns one row per matching id however often the caller repeated it, so
 * without that dedupe a repeated id would fail a valid request.
 */
async function validatePeopleIds(
  organizationId: string,
  rawValue: string | number | string[]
): Promise<{ userIds: string[]; peopleById: Map<string, BasicUser> }> {
  const userIds = distinctIds(rawValue);
  const peopleById = await resolvePeopleMap(userIds, organizationId);
  if (peopleById.size !== userIds.length) {
    throw new InvalidFieldValueError(
      "One or more user IDs are invalid or do not belong to this organization."
    );
  }
  return { userIds, peopleById };
}

/**
 * Maps a Prisma CustomField+enumOptions record to the CustomFieldWithOptions API shape.
 * Used to call computeDisplayValue without duplicating the mapping logic.
 */
function toFieldWithOptions(
  field: FieldWithEnumOptions
): CustomFieldWithOptions {
  return {
    id: field.id,
    organizationId: field.organizationId,
    name: field.name,
    description: field.description,
    fieldType:
      field.fieldType as (typeof CustomFieldType)[keyof typeof CustomFieldType],
    createdById: field.createdById,
    createdAt: field.createdAt,
    updatedAt: field.updatedAt,
    precision: field.precision,
    numberFormat: field.numberFormat as NumberFormat | null,
    currencyCode: field.currencyCode,
    customLabel: field.customLabel,
    customLabelPosition: field.customLabelPosition as LabelPosition | null,
    isGlobalToOrg: field.isGlobalToOrg,
    entityTypes: field.entityTypes,
    referenceTargetSources: field.referenceTargetSources,
    showInTable: field.showInTable,
    isSearchable: field.isSearchable,
    isSortable: field.isSortable,
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
 * Normalizes a multi-valued raw value into a list of distinct IDs.
 *
 * Deduplication is load-bearing, not cosmetic: the MULTI_ENUM and PEOPLE
 * validators above decide "does every requested ID exist?" by comparing this
 * length against the row count of an `id: { in: ... }` query, and Postgres
 * returns one row per matching id regardless of how often the caller repeated
 * it. Without this, a repeated id makes a valid request fail — and fail
 * describing the wrong cause, since the set difference that builds the error
 * message is empty.
 */
function distinctIds(rawValue: string | number | string[]): string[] {
  const ids = Array.isArray(rawValue) ? rawValue : [String(rawValue)];
  return [...new Set(ids)];
}

/**
 * Collapses repeats in the ID-list field types before the write is built, so
 * the stored ID columns and the computed displayValue derive from one list.
 *
 * MULTI_ENUM needs it: computeDisplayValue maps the raw value option by
 * option, so a repeat would render twice beside a single stored ID.
 *
 * The PEOPLE arm used to be defensive only, because its display path resolved
 * names through an `id: { in: ... }` query that collapsed repeats on its own.
 * ISS-7215 made it LOAD-BEARING: both the cached sort key and the rendered
 * string now walk the stored id array through a keyed lookup, so a repeat left
 * in place would render that person twice in one of them. Do not drop this arm.
 */
function normalizeIdListValue(
  fieldType: string,
  rawValue: string | number | string[] | null
): string | number | string[] | null {
  if (rawValue === null || rawValue === undefined) {
    return rawValue;
  }
  if (
    fieldType === CustomFieldType.MultiEnum ||
    fieldType === CustomFieldType.People
  ) {
    return distinctIds(rawValue);
  }
  return rawValue;
}

/**
 * Canonicalizes a raw input before both the stored columns and the displayValue
 * are derived from it, so the two can never disagree.
 *
 * The DURATION arm is what makes the round trip real: a caller may send
 * `"1h 12m"`, and it is resolved to milliseconds HERE, in the service, rather
 * than in the editor. `computeDisplayValue` therefore renders the same stored
 * number every client will read back, whatever spelling went in.
 */
function normalizeRawValue(
  fieldType: string,
  numberFormat: NumberFormat | null,
  rawValue: string | number | string[] | null
): string | number | string[] | null {
  if (rawValue === null || rawValue === undefined) {
    return rawValue;
  }
  if (
    fieldType === CustomFieldType.Number &&
    numberFormat === NumberFormat.Duration &&
    !Array.isArray(rawValue)
  ) {
    // validateValueType already rejected anything unparseable, so the coercion
    // cannot be null here; the fallback keeps the type honest rather than
    // asserting.
    return coerceCustomFieldDurationMs(rawValue) ?? rawValue;
  }
  return normalizeIdListValue(fieldType, rawValue);
}

/**
 * The `ArtifactType` each artifact-backed entity type resolves to.
 *
 * DOCUMENT, SESSION and BRANCH all address the same `artifacts` table by
 * `Artifact.id`, so an id-only lookup would happily accept a session id
 * presented as a DOCUMENT. Carrying the type into the WHERE is what makes the
 * declared entity type binding (ISS-7209).
 *
 * Exhaustive over every non-PROJECT entity type on purpose: adding DEPLOYMENT
 * to `CustomFieldEntityType` must fail typecheck here rather than silently
 * resolve to `type: undefined`, which Prisma reads as "no type filter". The
 * local annotation is what carries that, so it must not be dropped.
 *
 * Built on FIRST USE, not at module scope. `ArtifactType` is a generated Prisma
 * runtime value, so dereferencing it while this module is being imported made
 * merely importing it — even transitively, through the values-service graph —
 * require a fully-populated `@repo/database`. A suite that mocks that module
 * partially then dies at COLLECTION with an opaque error naming none of the
 * files involved, which is what happened to two unrelated suites in this repo.
 * Deferring the dereference to the one path that needs it narrows the blast
 * radius to a test that actually exercises artifact lookup, where it surfaces
 * as an ordinary assertion failure.
 */
let artifactTypeByEntityType: Record<
  Exclude<CustomFieldEntityType, typeof CustomFieldEntityType.Project>,
  ArtifactType
> | null = null;

function getArtifactTypeForEntityType(
  entityType: Exclude<
    CustomFieldEntityType,
    typeof CustomFieldEntityType.Project
  >
): ArtifactType {
  artifactTypeByEntityType ??= {
    [CustomFieldEntityType.Document]: ArtifactType.DOCUMENT,
    [CustomFieldEntityType.Session]: ArtifactType.SESSION,
    [CustomFieldEntityType.Branch]: ArtifactType.BRANCH,
  };
  return artifactTypeByEntityType[entityType];
}

/**
 * Resolves and validates everything a value write needs, without writing.
 *
 * Shared by {@link customFieldValuesService.setValueForEntity} and
 * {@link customFieldValuesService.validateValueForEntity} so the dry run and
 * the real write apply the same checks to the same normalized payload. Target
 * EXISTENCE is deliberately NOT checked here: the write path checks it inside
 * its own transaction, and the dry run checks it separately, because the two
 * have different transaction contexts to run it in.
 */
async function prepareValueWrite(
  fieldId: string,
  entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
  entityId: string,
  organizationId: string,
  rawValue: string | number | string[] | null
) {
  await verifyEntityExists(entityType, entityId, organizationId);

  const field = await withDb((db) =>
    db.customField.findFirst({
      where: { id: fieldId, organizationId },
      include: { enumOptions: { orderBy: { sortOrder: "asc" } } },
    })
  );

  if (!field) {
    throw new FieldNotFoundError(fieldId);
  }

  assertFieldAppliesToEntityType(field.entityTypes, entityType, fieldId);

  const fieldType =
    field.fieldType as (typeof CustomFieldType)[keyof typeof CustomFieldType];

  validateValueType(
    fieldType,
    rawValue,
    field.numberFormat as NumberFormat | null
  );

  const normalizedValue = normalizeRawValue(
    field.fieldType,
    field.numberFormat as NumberFormat | null,
    rawValue
  );

  // Shape and cardinality are decided up front so a malformed value never
  // opens a transaction, and so the dry run rejects it without one either.
  const referenceTargetIds = isReferenceFieldType(fieldType)
    ? normalizeReferenceIds(fieldType, normalizedValue ?? [])
    : null;

  const { payload: valuePayload, peopleById } = await buildValuePayload(
    field.fieldType,
    fieldId,
    organizationId,
    normalizedValue
  );

  const displayValue = await computeDisplayValue(
    toFieldWithOptions(field),
    normalizedValue,
    undefined,
    peopleById
  );

  const upsertData = { ...valuePayload, displayValue };

  const upsertArgs = {
    where: {
      customFieldId_entityType_entityId: {
        customFieldId: fieldId,
        entityType,
        entityId,
      },
    },
    create: {
      customFieldId: fieldId,
      organizationId,
      entityType,
      entityId,
      ...upsertData,
    },
    update: upsertData,
    include: VALUE_WITH_ENUM_INCLUDE,
  };

  // `peopleById` stays local: it is the map the CACHED `display_value` above is
  // built from, and the write path deliberately no longer renders its response
  // from it (see `setValueForEntity`).
  return { field, referenceTargetIds, upsertArgs };
}

/**
 * FEA-4222 (davetho review cid 3884188153) — a value may only be written for
 * an entity type its DEFINITION declares.
 *
 * The write path verified that the entity and the field each belong to the
 * organization and never that they belong to EACH OTHER, so a
 * `PUT /agent-sessions/{id}/custom-field-values/{fieldId}` naming a
 * Document-only field stored a Session value against it. Nothing rendered that
 * row while the field stayed Document-only, which is what made it quiet: the
 * value surfaced later, as pre-existing data, the moment an admin attached the
 * field to Sessions. Validate at the boundary and store valid-or-absent.
 *
 * An EMPTY `entityTypes` is accepted rather than rejected. The column is
 * `@default([])`, so every field created before entity scoping existed carries
 * one, and rejecting them would turn a hardening fix into a breaking change for
 * writes that work today on Documents and Projects. Empty means "unscoped
 * legacy field", not "applies to nothing" — and no UI offers one anyway, since
 * every consumer filters with `entityTypes.includes(...)`.
 */
function assertFieldAppliesToEntityType(
  entityTypes: readonly string[],
  entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
  fieldId: string
): void {
  if (entityTypes.length === 0 || entityTypes.includes(entityType)) {
    return;
  }
  throw new InvalidFieldValueError(
    `Custom field ${fieldId} does not apply to ${entityType}`
  );
}

/** The columns the enum-option validators decide on. */
type EnumOptionValidationRow = {
  id: string;
  enabled: boolean;
};

/**
 * One constant for the single-option and batch validators: "exists and is
 * enabled" is one rule, and both paths must answer it from the same columns.
 * `enabled` is the decision; `id` names the offending option in the batch
 * path's error.
 */
const ENUM_OPTION_VALIDATION_SELECT = {
  id: true,
  enabled: true,
} as const satisfies Record<keyof EnumOptionValidationRow, true>;
