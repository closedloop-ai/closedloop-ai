import "server-only";

import {
  POSTGRES_INT4_MAX,
  POSTGRES_INT4_MIN,
} from "@closedloop-ai/loops-api/column-limits";
import type {
  CustomFieldEntityType,
  CustomFieldSettingWithOptions,
} from "@repo/api/src/types/custom-field";
import { z } from "zod";
import { requireOrgAdmin } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { withAuth } from "@/lib/auth/with-auth";
import { isUuid } from "@/lib/is-uuid";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { EntityNotFoundError, FieldNotFoundError } from "./custom-field-errors";
import { customFieldValuesService } from "./values-service";

const attachCustomFieldSettingValidator = z.object({
  customFieldId: z.uuid(),
  isImportant: z.boolean().optional(),
  isRequired: z.boolean().optional(),
  // `CustomFieldSetting.sortOrder` is a Prisma `Int`, bounded at that column's
  // range at both ends — a floor of `0` would refuse a negative this endpoint
  // stores today.
  sortOrder: z
    .number()
    .int()
    .min(POSTGRES_INT4_MIN)
    .max(POSTGRES_INT4_MAX)
    .optional(),
});

/**
 * Factory that returns Next.js route handlers for custom field settings endpoints.
 *
 * POST and DELETE are admin-only (withAuth + `requireOrgAdmin` check).
 * GET uses withAnyAuth to support both API key and session clients.
 *
 * @param entityType - The entity type for the handler (Project, Workstream, Feature, Artifact).
 */
export function makeCustomFieldSettingsHandlers(
  entityType: CustomFieldEntityType
) {
  /**
   * POST /{entity}/:id/custom-field-settings
   * Attach a custom field to the entity (admin-only).
   */
  const POST = withAuth<CustomFieldSettingWithOptions>(
    async ({ user, clerkOrgId, clerkUserId }, request, params) => {
      const denial = await requireOrgAdmin(clerkOrgId, clerkUserId);
      if (denial) {
        return denial;
      }

      const { id } = await params;
      // The path segment is untrusted and the entity's id column is `@db.Uuid`,
      // so a malformed one is a driver-level P2023 that the catch below would
      // have reported as a 500 — a caller's typo dressed up as a server fault.
      if (!isUuid(id)) {
        return notFoundResponse(entityType);
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        attachCustomFieldSettingValidator
      );
      if (parseError) {
        return parseError;
      }

      try {
        const setting = await customFieldValuesService.attachField(
          body.customFieldId,
          entityType,
          id,
          user.organizationId,
          {
            customFieldId: body.customFieldId,
            isImportant: body.isImportant,
            isRequired: body.isRequired,
            sortOrder: body.sortOrder,
          }
        );
        return successResponse(setting);
      } catch (error) {
        if (error instanceof EntityNotFoundError) {
          return notFoundResponse(entityType);
        }
        if (error instanceof FieldNotFoundError) {
          return notFoundResponse("Custom field");
        }
        return errorResponse("Failed to attach custom field", error);
      }
    }
  );

  /**
   * GET /{entity}/:id/custom-field-settings
   * List all custom field settings for the entity (any authenticated user).
   */
  const GET = withAnyAuth<CustomFieldSettingWithOptions[]>(
    async ({ user }, _request, params) => {
      const { id } = await params;
      if (!isUuid(id)) {
        return notFoundResponse(entityType);
      }

      try {
        const settings = await customFieldValuesService.listSettings(
          entityType,
          id,
          user.organizationId
        );
        return successResponse(settings);
      } catch (error) {
        return errorResponse("Failed to list custom field settings", error);
      }
    }
  );

  /**
   * DELETE /{entity}/:id/custom-field-settings/:settingId
   * Detach a custom field from the entity (admin-only).
   *
   * Note: Despite the route param being named `:settingId`, it is actually the
   * custom field ID (customFieldId) used to identify which field to detach.
   * This matches the route shape but the value is a customFieldId, not a setting record ID.
   */
  const DELETE = withAuth<{ deleted: true }>(
    async ({ user, clerkOrgId, clerkUserId }, _request, params) => {
      const denial = await requireOrgAdmin(clerkOrgId, clerkUserId);
      if (denial) {
        return denial;
      }

      // settingId is actually the customFieldId (see JSDoc above)
      const { id, settingId } = await params;
      // Both segments key `@db.Uuid` columns, so both need the guard — a valid
      // entity id does not make a malformed customFieldId safe. They get
      // DIFFERENT labels: `settingId` is a customFieldId (see the JSDoc above),
      // so naming the entity for it would report the wrong missing thing. The
      // field label matches the POST handler's `FieldNotFoundError` arm.
      if (!isUuid(id)) {
        return notFoundResponse(entityType);
      }
      if (!isUuid(settingId)) {
        return notFoundResponse("Custom field");
      }

      try {
        await customFieldValuesService.detachField(
          settingId,
          entityType,
          id,
          user.organizationId
        );
        return deleteResponse();
      } catch (error) {
        if (error instanceof EntityNotFoundError) {
          return notFoundResponse(entityType);
        }
        return errorResponse("Failed to detach custom field", error);
      }
    }
  );

  return { POST, GET, DELETE };
}
