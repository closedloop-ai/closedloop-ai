import type { CustomFieldEnumOption } from "@repo/api/src/types/custom-field";
import { isOrgAdmin } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { enumOptionsService } from "../../enum-options-service";
import { createEnumOptionValidator } from "../../enum-options-validators";
import { customFieldsService } from "../../service";

/**
 * GET /custom-fields/:id/enum-options - List enum options for a custom field
 */
export const GET = withAnyAuth<
  CustomFieldEnumOption[],
  "/custom-fields/[id]/enum-options"
>(async ({ user }, _, params) => {
  try {
    const { id } = await params;
    const field = await customFieldsService.findById(id, user.organizationId);

    if (!field) {
      return notFoundResponse("Custom field");
    }

    return successResponse(field.enumOptions);
  } catch (error) {
    return errorResponse("Failed to fetch enum options", error);
  }
});

export const POST = withAuth<
  CustomFieldEnumOption,
  "/custom-fields/[id]/enum-options"
>(async ({ user, clerkOrgId, clerkUserId }, request, params) => {
  if (!(await isOrgAdmin(clerkOrgId, clerkUserId))) {
    return forbiddenResponse();
  }

  const { id } = await params;

  const { body, errorResponse: parseError } = await parseBody(
    request,
    createEnumOptionValidator
  );
  if (parseError) {
    return parseError;
  }

  try {
    const option = await enumOptionsService.createEnumOption(
      id,
      user.organizationId,
      body
    );
    return successResponse(option);
  } catch (error) {
    return errorResponse("Failed to create enum option", error);
  }
});
