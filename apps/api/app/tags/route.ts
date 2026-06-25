import { isOrgAdmin } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  conflictResponse,
  errorResponse,
  forbiddenResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { DuplicateNameError, tagService } from "./service";
import { createTagValidator } from "./validators";

export const GET = withAnyAuth(async ({ user }) => {
  try {
    const tags = await tagService.findByOrg(user.organizationId);
    return successResponse(tags);
  } catch (error) {
    return errorResponse("Failed to fetch tags", error);
  }
});

export const POST = withAnyAuth(
  async ({ user, clerkOrgId, clerkUserId }, request) => {
    try {
      const adminCheck = await isOrgAdmin(clerkOrgId, clerkUserId);
      if (!adminCheck) {
        return forbiddenResponse();
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        createTagValidator
      );
      if (parseError) {
        return parseError;
      }

      const tag = await tagService.create(user.organizationId, user.id, body);
      return successResponse(tag);
    } catch (error) {
      if (error instanceof DuplicateNameError) {
        return conflictResponse("Tag with this name already exists");
      }
      return errorResponse("Failed to create tag", error);
    }
  },
  { requiredScopes: ["write"] }
);
