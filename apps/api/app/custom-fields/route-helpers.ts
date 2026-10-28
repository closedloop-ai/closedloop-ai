import type { ApiResult } from "@repo/api/src/types/common";
import type {
  CustomFieldEntityType,
  CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";
import type { NextResponse } from "next/server";
import { badRequestResponse } from "@/lib/route-utils";
import type { ArtifactCustomFieldValueError } from "./artifact-custom-field-value-contract";
import {
  type ArtifactCustomFieldEntityType,
  type ArtifactCustomFieldWriteContext,
  artifactCustomFieldValueService,
} from "./artifact-custom-field-value-service";
import { InvalidReferenceTargetError } from "./reference-targets";
import { InvalidFieldValueError } from "./utils";
import { customFieldValuesService } from "./values-service";

/**
 * Merges custom field values into an entity response.
 *
 * Fetches all custom field values for the entity and returns the entity spread
 * with a `customFields` array (always present, never undefined).
 *
 * @param entity - The entity to merge custom fields into. Must have an `id` field.
 * @param entityType - The custom field entity type (Project, Workstream, Feature, Artifact).
 * @param organizationId - The organization ID for scoping.
 * @returns The entity spread with `customFields: CustomFieldValueDetail[]`.
 */
export async function mergeCustomFieldsIntoResponse<T extends { id: string }>(
  entity: T,
  entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
  organizationId: string
): Promise<T & { customFields: CustomFieldValueDetail[] }> {
  const customFields = await customFieldValuesService.getValuesForEntity(
    entityType,
    entity.id,
    organizationId
  );

  return { ...entity, customFields };
}

/**
 * Runs every check a custom field write would run, writing nothing.
 *
 * Composite routes that update an entity AND its custom fields call this BEFORE
 * they commit the entity. Without it a single bad field value returns a 400
 * describing a write that already happened — the entity is changed, the caller
 * is told nothing was.
 *
 * Whole-batch, not per-entry: it validates every entry before the caller writes
 * any of them, so entry three being invalid cannot leave entries one and two
 * applied.
 */
export async function validateCustomFieldsFromBody(
  customFieldsInput: Record<string, string | number | string[] | null>,
  entityId: string,
  entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
  organizationId: string
): Promise<void> {
  for (const [fieldId, rawValue] of Object.entries(customFieldsInput)) {
    // A null clears the value; `clearValue` is a deleteMany that cannot fail on
    // the value's content, so there is nothing to pre-check.
    if (rawValue !== null) {
      await customFieldValuesService.validateValueForEntity(
        fieldId,
        entityType,
        entityId,
        organizationId,
        rawValue
      );
    }
  }
}

/**
 * The whole pre-commit custom-field check for a composite route, as one call.
 *
 * Returns a 400 response to hand straight back, or null to proceed with the
 * entity write. Composite routes call this INSTEAD of inlining the try/catch,
 * so the ordering guarantee — validate everything, then commit — is stated once
 * rather than re-derived per route.
 */
export async function customFieldsPreflightResponse(
  customFieldsInput:
    | Record<string, string | number | string[] | null>
    | undefined,
  entityId: string,
  entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
  organizationId: string
): Promise<NextResponse<ApiResult<never>> | null> {
  if (!customFieldsInput) {
    return null;
  }

  try {
    await validateCustomFieldsFromBody(
      customFieldsInput,
      entityId,
      entityType,
      organizationId
    );
    return null;
  } catch (error) {
    const badRequest = customFieldWriteErrorResponse(error);
    if (badRequest) {
      return badRequest;
    }
    throw error;
  }
}

/**
 * Maps a custom-field write failure the CALLER caused to a 400.
 *
 * Returns null for anything else so the route's own handler still reports it as
 * a 500. Without this an illegal reference target — a client mistake — would
 * surface as a server error, which is both wrong for the client and noise in
 * the error budget.
 */
export function customFieldWriteErrorResponse(
  error: unknown
): NextResponse<ApiResult<never>> | null {
  if (error instanceof InvalidReferenceTargetError) {
    return badRequestResponse(error.message);
  }
  // FEA-4222: naming a field that does not apply to this entity type is the
  // same class of caller mistake. `valueWriteErrorResponse` on the dedicated
  // values sub-resource already answers 400 for `InvalidFieldValueError`; this
  // composite path (Document/Project PUT bodies) reaches the same guard through
  // the in-transaction apply, and without this arm the identical request
  // would come back a 500 here and a 400 there.
  if (error instanceof InvalidFieldValueError) {
    return badRequestResponse(error.message);
  }
  if (error instanceof CustomFieldsRefusedError) {
    return badRequestResponse(error.message);
  }
  return null;
}

/**
 * ISS-12552: a custom field value refused while the entity's own write
 * transaction is open. Thrown, not returned, so the entity write rolls back
 * with it; {@link customFieldWriteErrorResponse} maps it to a 400.
 */
export class CustomFieldsRefusedError extends Error {
  constructor(error: ArtifactCustomFieldValueError) {
    super(error.message);
    this.name = "CustomFieldsRefusedError";
  }
}

/**
 * ISS-12552: applies an artifact's custom fields inside the caller's
 * transaction and returns the supplied field ids whose stored value moved.
 * Each value is compared under the artifact lock, so a write another request
 * committed first is not counted as this one's.
 */
export async function applyArtifactCustomFieldsInTransaction(
  customFieldsInput: Record<string, string | number | string[] | null>,
  entityId: string,
  entityType: ArtifactCustomFieldEntityType,
  organizationId: string,
  context: ArtifactCustomFieldWriteContext
): Promise<string[]> {
  const movedFieldIds: string[] = [];
  for (const [fieldId, rawValue] of Object.entries(customFieldsInput)) {
    const target = { fieldId, entityType, entityId, organizationId, context };
    let moved: boolean;
    if (rawValue === null) {
      moved = (await artifactCustomFieldValueService.clear(target)).changed;
    } else {
      const result = await artifactCustomFieldValueService.set({
        ...target,
        rawValue,
      });
      if (!result.ok) {
        throw new CustomFieldsRefusedError(result.error);
      }
      moved = result.value.changed;
    }
    if (moved) {
      movedFieldIds.push(fieldId);
    }
  }
  return movedFieldIds;
}

/**
 * ISS-12552 flag-off parity: main's after-commit apply for a project PUT that
 * records nothing. Each value commits on its own (an autocommit upsert, or a
 * reference write's own transaction), in body order; a value refused part way
 * leaves the values before it committed and maps to a 400, or returns null
 * when everything was written. Any other failure propagates.
 */
export async function applyCustomFieldsOrErrorResponse(
  customFieldsInput:
    | Record<string, string | number | string[] | null>
    | undefined,
  entityId: string,
  entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
  organizationId: string
): Promise<NextResponse<ApiResult<never>> | null> {
  if (!customFieldsInput) {
    return null;
  }

  try {
    await applyCustomFieldsFromBody(
      customFieldsInput,
      entityId,
      entityType,
      organizationId
    );
    return null;
  } catch (error) {
    const badRequest = customFieldWriteErrorResponse(error);
    if (badRequest) {
      return badRequest;
    }
    throw error;
  }
}

async function applyCustomFieldsFromBody(
  customFieldsInput: Record<string, string | number | string[] | null>,
  entityId: string,
  entityType: (typeof CustomFieldEntityType)[keyof typeof CustomFieldEntityType],
  organizationId: string
): Promise<void> {
  for (const [fieldId, rawValue] of Object.entries(customFieldsInput)) {
    if (rawValue === null) {
      await customFieldValuesService.clearValue(
        fieldId,
        entityType,
        entityId,
        organizationId
      );
    } else {
      await customFieldValuesService.setValueForEntity(
        fieldId,
        entityType,
        entityId,
        organizationId,
        rawValue
      );
    }
  }
}
