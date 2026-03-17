import "server-only";

import type {
  CustomFieldEntityType,
  CustomFieldSettingWithOptions,
} from "@repo/api/src/types/custom-field";
import { z } from "zod";
import { isOrgAdmin } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { withAuth } from "@/lib/auth/with-auth";
import {
  deleteResponse,
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import {
  customFieldValuesService,
  EntityNotFoundError,
  FieldNotFoundError,
} from "./values-service";

const attachCustomFieldSettingValidator = z.object({
  customFieldId: z.uuid(),
  isImportant: z.boolean().optional(),
  isRequired: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

/**
 * Factory that returns Next.js route handlers for custom field settings endpoints.
 *
 * POST and DELETE are admin-only (withAuth + isOrgAdmin check).
 * GET uses withAnyAuth to support both API key and session clients.
 *
 * @param entityType - The entity type for the handler (Project, Workstream, Issue, Artifact).
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
      if (!(await isOrgAdmin(clerkOrgId, clerkUserId))) {
        return forbiddenResponse();
      }

      const { id } = await params;

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
      if (!(await isOrgAdmin(clerkOrgId, clerkUserId))) {
        return forbiddenResponse();
      }

      // settingId is actually the customFieldId (see JSDoc above)
      const { id, settingId } = await params;

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
