import type { Document } from "@repo/api/src/types/document";
import { Status } from "@repo/api/src/types/result";
import { documentMergeService } from "@/app/documents/merge-service";
import { withAuth } from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { mergeDocumentsValidator } from "../validators";

/**
 * Platform function time budget (seconds). Declared explicitly rather than
 * inheriting the platform default so the ceiling is intentional and stays above
 * `MERGE_REQUEST_TIMEOUT_MS`: the merge generation's `abortSignal` must fire
 * first, so a hung Anthropic call surfaces as this route's JSON error envelope
 * instead of an opaque platform 504. The client pairs it with
 * `LONG_RUNNING_API_TIMEOUT_MS` (5 minutes), which declaring the same ceiling
 * here is what makes meaningful (PR #4321 review).
 */
export const maxDuration = 300;

const SAME_PROJECT_ERROR_RE = /same project/i;
const TEMPLATE_ERROR_RE = /TEMPLATE/i;
const TOO_LARGE_ERROR_RE = /too large to merge/i;

/**
 * POST /documents/merge
 * Merge two artifacts into one: combines content via LLM, saves to primary,
 * and deletes the secondary artifact.
 *
 * Session-only (`withAuth`), so an API key or a Desktop token gets 401 before
 * the handler runs: the merge is a server-side Anthropic generation billed to
 * ClosedLoop's own key, and API callers must not spend that budget (ISS-11795).
 * The `withAuth` use is declared, with this reason, in `SESSION_ONLY_HANDLERS`
 * (scripts/lint/rules/no-unpaved-api-route-handler.ts); moving the route back
 * to `withAnyAuth` needs a new ruling, not just removing that entry.
 */
export const POST = withAuth<Document, "/documents/merge">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        mergeDocumentsValidator
      );
      if (parseError) {
        return parseError;
      }

      const result = await documentMergeService.merge(
        body.primaryDocumentId,
        body.secondaryDocumentId,
        user.organizationId,
        user.id
      );

      if (!result.ok) {
        if (result.error === Status.NotFound) {
          return notFoundResponse("Artifact");
        }
        return errorResponse("Failed to merge artifacts", result.error);
      }

      return successResponse(result.value);
    } catch (error) {
      if (
        error instanceof Error &&
        (SAME_PROJECT_ERROR_RE.test(error.message) ||
          TEMPLATE_ERROR_RE.test(error.message) ||
          TOO_LARGE_ERROR_RE.test(error.message))
      ) {
        return badRequestResponse(error.message);
      }
      return errorResponse("Failed to merge artifacts", error);
    }
  }
);
