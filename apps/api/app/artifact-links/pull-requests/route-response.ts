import { Status } from "@repo/api/src/types/result";
import {
  badRequestResponse,
  conflictResponse,
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
} from "@/lib/route-utils";
import type { CreatePullRequestArtifactError } from "./pull-request-artifact-service";

const NOT_FOUND_SUFFIX_REGEX = / not found$/;

/**
 * Translate selected-PR service results to the legacy route response contract.
 */
export function createPullRequestArtifactErrorResponse(
  error: CreatePullRequestArtifactError
) {
  switch (error.status) {
    case Status.BadRequest:
      return badRequestResponse(error.message, error.metadata);
    case Status.Forbidden:
      return forbiddenResponse(error.metadata);
    case Status.Conflict:
      return conflictResponse(error.message, error.metadata);
    case Status.NotFound:
      return notFoundResponse(
        error.message.replace(NOT_FOUND_SUFFIX_REGEX, "")
      );
    default:
      return errorResponse(
        "Failed to create pull request artifact",
        new Error(error.cause ?? error.message),
        error.status,
        error.metadata
      );
  }
}
