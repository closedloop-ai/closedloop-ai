import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  conflictResponse,
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import {
  DuplicateNameError,
  EntityNotFoundError,
  tagService,
} from "../service";
import { updateTagValidator } from "../validators";

export const PATCH = withAnyAuth(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateTagValidator
      );
      if (parseError) {
        return parseError;
      }

      const tag = await tagService.update(id, user.organizationId, body);
      return successResponse(tag);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        return notFoundResponse("Tag");
      }
      if (error instanceof DuplicateNameError) {
        return conflictResponse("Tag with this name already exists");
      }
      return errorResponse("Failed to update tag", error);
    }
  },
  { requiredScopes: ["write"] }
);

export const DELETE = withAnyAuth(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;
      await tagService.delete(id, user.organizationId);
      return deleteResponse();
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        return notFoundResponse("Tag");
      }
      return errorResponse("Failed to delete tag", error);
    }
  },
  { requiredScopes: ["delete"] }
);
