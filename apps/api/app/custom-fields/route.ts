import type { CustomFieldWithOptions } from "@repo/api/src/types/custom-field";
import { isOrgAdmin } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  conflictResponse,
  errorResponse,
  forbiddenResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { customFieldsService, DuplicateNameError } from "./service";
import { ReservedNameError } from "./utils";
import { createCustomFieldValidator } from "./validators";

/**
 * GET /custom-fields - List all custom field definitions for the organization
 */
export const GET = withAnyAuth<CustomFieldWithOptions[], "/custom-fields">(
  async ({ user }) => {
    try {
      const fields = await customFieldsService.findByOrg(user.organizationId);
      return successResponse(fields);
    } catch (error) {
      return errorResponse("Failed to fetch custom fields", error);
    }
  }
);

/**
 * POST /custom-fields - Create a new custom field definition (org admins only)
 */
export const POST = withAnyAuth<CustomFieldWithOptions, "/custom-fields">(
  async ({ user, clerkOrgId, clerkUserId }, request) => {
    try {
      const adminCheck = await isOrgAdmin(clerkOrgId, clerkUserId);
      if (!adminCheck) {
        return forbiddenResponse();
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        createCustomFieldValidator
      );
      if (parseError) {
        return parseError;
      }

      const field = await customFieldsService.createField(
        user.organizationId,
        user.id,
        body
      );

      return successResponse(field);
    } catch (error) {
      if (error instanceof DuplicateNameError) {
        return conflictResponse("Custom field with this name already exists");
      }
      if (error instanceof ReservedNameError) {
        return conflictResponse(error.message);
      }
      return errorResponse("Failed to create custom field", error);
    }
  },
  { requiredScopes: ["write"] }
);
