import { isOrgAdmin } from "@/lib/auth/org-admin";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  forbiddenResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { enumOptionsService } from "../../../enum-options-service";
import { reorderEnumOptionsValidator } from "../../../enum-options-validators";

export const POST = withAuth<
  { reordered: true },
  "/custom-fields/[id]/enum-options/reorder"
>(async ({ user, clerkOrgId, clerkUserId }, request, params) => {
  if (!(await isOrgAdmin(clerkOrgId, clerkUserId))) {
    return forbiddenResponse();
  }

  const { id } = await params;

  const { body, errorResponse: parseError } = await parseBody(
    request,
    reorderEnumOptionsValidator
  );
  if (parseError) {
    return parseError;
  }

  try {
    await enumOptionsService.reorderEnumOptions(
      id,
      user.organizationId,
      body.optionIds
    );
    return successResponse({ reordered: true as const });
  } catch (error) {
    return errorResponse("Failed to reorder enum options", error);
  }
});
