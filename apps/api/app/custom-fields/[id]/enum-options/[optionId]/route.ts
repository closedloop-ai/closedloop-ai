import type { CustomFieldEnumOption } from "@repo/api/src/types/custom-field";
import { isOrgAdmin } from "@/lib/auth/org-admin";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  forbiddenResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { enumOptionsService } from "../../../enum-options-service";
import { updateEnumOptionValidator } from "../../../enum-options-validators";

export const PUT = withAuth<
  CustomFieldEnumOption,
  "/custom-fields/[id]/enum-options/[optionId]"
>(async ({ user, clerkOrgId, clerkUserId }, request, params) => {
  if (!(await isOrgAdmin(clerkOrgId, clerkUserId))) {
    return forbiddenResponse();
  }

  const { id, optionId } = await params;

  const { body, errorResponse: parseError } = await parseBody(
    request,
    updateEnumOptionValidator
  );
  if (parseError) {
    return parseError;
  }

  try {
    const option = await enumOptionsService.updateEnumOption(
      optionId,
      id,
      user.organizationId,
      body
    );
    return successResponse(option);
  } catch (error) {
    return errorResponse("Failed to update enum option", error);
  }
});
