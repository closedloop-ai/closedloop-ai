import "server-only";

import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type {
  CustomFieldEntityType,
  CustomFieldEntityType as CustomFieldEntityTypeValue,
  CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";
import { z } from "zod";
import { createArtifactFieldEditAnalyticsContext } from "@/lib/artifact-field-edit-analytics-context";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  badRequestResponse,
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import {
  optionalSingleArtifactEditSurface,
  SINGLE_ARTIFACT_EDIT_SURFACE_ERROR,
} from "@/lib/single-artifact-edit-surface";
import {
  type ArtifactCustomFieldValueError,
  ArtifactCustomFieldValueErrorKind,
} from "./artifact-custom-field-value-contract";
import { artifactCustomFieldValueService } from "./artifact-custom-field-value-service";
import { recordCustomFieldValueWrite } from "./custom-field-value-receipt";
import { customFieldValuesService } from "./values-service";

const setCustomFieldValueValidator = z.object({
  value: z.union([z.string(), z.number(), z.array(z.string()), z.null()]),
  surface: optionalSingleArtifactEditSurface,
});

/**
 * Route handlers for reading and writing custom field VALUES on one entity.
 *
 * Projects and Documents carry their values in their own PUT body, applied
 * on that write's transaction, because they have a mutable representation to
 * hang them off. Sessions and Branches do not — their detail routes are reads —
 * so ISS-7209 gives them the values as their own sub-resource rather than
 * inventing a general-purpose session/branch mutation surface. The write is
 * scoped to `custom_field_values`, a cloud-only table the desktop does not
 * model, so it cannot collide with the desktop sync lane that owns every other
 * field on those artifacts.
 *
 * Writing a VALUE is `write`-scoped for any authenticated caller, matching the
 * document PATCH path. Deciding which fields an entity type carries stays
 * admin-only — that is `makeCustomFieldSettingsHandlers`, not this.
 */
export function makeCustomFieldValuesHandlers(
  entityType: Exclude<
    CustomFieldEntityTypeValue,
    typeof CustomFieldEntityType.Project
  >
) {
  /**
   * GET /{entity}/:id/custom-field-values
   * List every custom field value set on the entity.
   */
  const GET = withAnyAuth<CustomFieldValueDetail[]>(
    async ({ user }, _request, params) => {
      const { id } = await params;

      try {
        const values = await customFieldValuesService.getValuesForEntity(
          entityType,
          id,
          user.organizationId
        );
        return successResponse(values);
      } catch (error) {
        return errorResponse("Failed to list custom field values", error);
      }
    }
  );

  /**
   * PUT /{entity}/:id/custom-field-values/:fieldId
   * Set (upsert) one custom field value. A null `value` clears it.
   */
  const PUT = withAnyAuth(
    withOperationReceipts<CustomFieldValueDetail | { deleted: true }, string>(
      OperationKind.UpdateFields,
      async ({ user, authMethod }, request, params, receipts) => {
        const { id, fieldId } = await params;

        const { body, errorResponse: parseError } = await parseBody(
          request,
          setCustomFieldValueValidator
        );
        if (parseError) {
          return parseError;
        }
        const analytics = createArtifactFieldEditAnalyticsContext({
          organizationId: user.organizationId,
          userId: user.id,
          authMethod,
          surface: body.surface,
        });
        const recordWrite = recordCustomFieldValueWrite(receipts, id, fieldId);

        try {
          if (body.value === null) {
            await artifactCustomFieldValueService.clear(
              {
                fieldId,
                entityType,
                entityId: id,
                organizationId: user.organizationId,
                context: {
                  actor: { userId: user.id, authMethod },
                  receipt: analytics.receiptContext,
                },
              },
              recordWrite
            );
            return deleteResponse(receipts.receipt);
          }

          const result = await artifactCustomFieldValueService.set(
            {
              fieldId,
              entityType,
              entityId: id,
              organizationId: user.organizationId,
              rawValue: body.value,
              context: {
                actor: { userId: user.id, authMethod },
                receipt: analytics.receiptContext,
              },
            },
            recordWrite
          );
          if (!result.ok) {
            if (
              result.error.kind ===
              ArtifactCustomFieldValueErrorKind.InvalidValue
            ) {
              analytics.capture({
                field: ArtifactFieldEditField.CustomField,
                result: ArtifactFieldEditOutcome.ValidationFailed,
                artifactCount: 1,
              });
            }
            return valueWriteErrorResponse(result.error, entityType);
          }
          return successResponse(
            withOperationReceipt(result.value.value, receipts)
          );
        } catch (error) {
          return errorResponse("Failed to set custom field value", error);
        }
      }
    ),
    { requiredScopes: ["write"] }
  );

  /**
   * DELETE /{entity}/:id/custom-field-values/:fieldId
   * Clear one custom field value. Idempotent.
   */
  const DELETE = withAnyAuth(
    withOperationReceipts<{ deleted: true }, string>(
      OperationKind.UpdateFields,
      async ({ user, authMethod }, request, params, receipts) => {
        const { id, fieldId } = await params;

        try {
          const claimedSurface = new URL(request.url).searchParams.get(
            "surface"
          );
          const parsedSurface = optionalSingleArtifactEditSurface.safeParse(
            claimedSurface ?? undefined
          );
          if (!parsedSurface.success) {
            return badRequestResponse(SINGLE_ARTIFACT_EDIT_SURFACE_ERROR);
          }
          const analytics = createArtifactFieldEditAnalyticsContext({
            organizationId: user.organizationId,
            userId: user.id,
            authMethod,
            surface: parsedSurface.data,
          });
          await artifactCustomFieldValueService.clear(
            {
              fieldId,
              entityType,
              entityId: id,
              organizationId: user.organizationId,
              context: {
                actor: { userId: user.id, authMethod },
                receipt: analytics.receiptContext,
              },
            },
            recordCustomFieldValueWrite(receipts, id, fieldId)
          );
          return deleteResponse(receipts.receipt);
        } catch (error) {
          return errorResponse("Failed to clear custom field value", error);
        }
      }
    ),
    { requiredScopes: ["delete"] }
  );

  return { GET, PUT, DELETE };
}

/**
 * Maps a value-write failure onto a status.
 *
 * Expected refusals arrive as a typed result. Infrastructure and transaction
 * failures still throw into the handler's generic 500 path.
 */
function valueWriteErrorResponse(
  error: ArtifactCustomFieldValueError,
  entityType: string
) {
  if (error.kind === ArtifactCustomFieldValueErrorKind.EntityNotFound) {
    return notFoundResponse(entityType);
  }
  if (error.kind === ArtifactCustomFieldValueErrorKind.FieldNotFound) {
    return notFoundResponse("Custom field");
  }
  if (error.kind === ArtifactCustomFieldValueErrorKind.InvalidValue) {
    return badRequestResponse(error.message);
  }
  return errorResponse(
    "Failed to set custom field value",
    new Error(error.message)
  );
}
