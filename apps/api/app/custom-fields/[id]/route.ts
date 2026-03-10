import type { CustomFieldWithOptions } from "@repo/api/src/types/custom-field";
import { isOrgAdmin } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  conflictResponse,
  deleteResponse,
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { customFieldsService, DuplicateNameError } from "../service";
import { ReservedNameError } from "../utils";
import { updateCustomFieldValidator } from "../validators";

/**
 * GET /custom-fields/:id - Get a single custom field definition by ID
 */
export const GET = withAnyAuth<CustomFieldWithOptions, "/custom-fields/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;
      const field = await customFieldsService.findById(id, user.organizationId);

      if (!field) {
        return notFoundResponse("Custom field");
      }

      return successResponse(field);
    } catch (error) {
      return errorResponse("Failed to fetch custom field", error);
    }
  }
);

/**
 * PUT /custom-fields/:id - Update a custom field definition (org admins only)
 */
export const PUT = withAnyAuth<CustomFieldWithOptions, "/custom-fields/[id]">(
  async ({ user, clerkOrgId, clerkUserId }, request, params) => {
    try {
      const adminCheck = await isOrgAdmin(clerkOrgId, clerkUserId);
      if (!adminCheck) {
        return forbiddenResponse();
      }

      const { id } = await params;
      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateCustomFieldValidator
      );
      if (parseError) {
        return parseError;
      }

      const field = await customFieldsService.findById(id, user.organizationId);
      if (!field) {
        return notFoundResponse("Custom field");
      }

      const updated = await customFieldsService.updateField(
        id,
        user.organizationId,
        body
      );

      return successResponse(updated);
    } catch (error) {
      if (error instanceof DuplicateNameError) {
        return conflictResponse("Custom field with this name already exists");
      }
      if (error instanceof ReservedNameError) {
        return conflictResponse(error.message);
      }
      return errorResponse("Failed to update custom field", error);
    }
  },
  { requiredScopes: ["write"] }
);

/**
 * DELETE /custom-fields/:id - Delete a custom field definition (org admins only)
 */
export const DELETE = withAnyAuth<{ deleted: true }, "/custom-fields/[id]">(
  async ({ user, clerkOrgId, clerkUserId }, _, params) => {
    try {
      const adminCheck = await isOrgAdmin(clerkOrgId, clerkUserId);
      if (!adminCheck) {
        return forbiddenResponse();
      }

      const { id } = await params;

      const field = await customFieldsService.findById(id, user.organizationId);
      if (!field) {
        return notFoundResponse("Custom field");
      }

      await customFieldsService.deleteField(id, user.organizationId);
      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete custom field", error);
    }
  },
  { requiredScopes: ["delete"] }
);
