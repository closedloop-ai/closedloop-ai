import type {
  DeletePublicRepositoryResponse,
  PublicRepositoryResponse,
} from "@repo/api/src/types/github";
import { Status } from "@repo/api/src/types/result";
import { z } from "zod";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  conflictResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { publicRepositoryService } from "./service";

const addPublicRepositoryValidator = z.object({
  url: z.string().min(1),
});

/**
 * POST /integrations/github/public-repositories
 *
 * Add a public GitHub repository to the organization by URL.
 * Validates that the repository is publicly accessible on GitHub before creating the record.
 */
export const POST = withAnyAuth<
  PublicRepositoryResponse,
  "/integrations/github/public-repositories"
>(async ({ user }, request) => {
  const { body, errorResponse: parseError } = await parseBody(
    request,
    addPublicRepositoryValidator
  );
  if (parseError) {
    return parseError;
  }

  const result = await publicRepositoryService.addPublicRepository(
    user.organizationId,
    body.url
  );

  if (result.ok) {
    return successResponse({
      id: result.value.id,
      url: result.value.htmlUrl,
      fullName: result.value.fullName,
      name: result.value.name,
      owner: result.value.owner,
      private: false,
      lastPushedAt: null,
    });
  }

  if (result.error === Status.NotFound) {
    return notFoundResponse("GitHub repository");
  }

  if (result.error === Status.Error) {
    return errorResponse(
      "GitHub API error",
      new Error("GitHub API request failed")
    );
  }

  if (result.error === Status.Conflict) {
    return conflictResponse("Repository already added to this organization");
  }

  return badRequestResponse("Invalid GitHub repository URL");
});

/**
 * DELETE /integrations/github/public-repositories
 *
 * Remove a public repository from the organization by id (passed as a query parameter).
 */
export const DELETE = withAnyAuth<
  DeletePublicRepositoryResponse,
  "/integrations/github/public-repositories"
>(async ({ user }, request) => {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return badRequestResponse("id query parameter is required");
  }

  await publicRepositoryService.removePublicRepository(user.organizationId, id);

  return successResponse({ deleted: true });
});
