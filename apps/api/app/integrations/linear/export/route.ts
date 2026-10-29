import { failure } from "@repo/api/src/types/common";
import type { ExportToLinearResult } from "@repo/api/src/types/linear";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { linearService } from "../service";
import { exportToLinearValidator } from "../validators";

/**
 * Platform function time budget (seconds). Declared explicitly rather than
 * inheriting the platform default so the ceiling is intentional and stays above
 * `TASK_EXTRACTION_TIMEOUT_MS`: the extraction's `abortSignal` must fire first,
 * so a hung Anthropic call surfaces as this route's JSON error envelope instead
 * of an opaque platform 504. The client pairs it with
 * `LONG_RUNNING_API_TIMEOUT_MS` (5 minutes), which declaring the same ceiling
 * here is what makes meaningful (PR #4321 review).
 *
 * Extraction is deliberately given well under half of this, leaving the rest of
 * the budget for the non-idempotent Linear issue fan-out that follows it. That
 * is a budget SPLIT, not a bound on the rest of the request: the `getTeams`
 * check before the extraction and the sequential `createIssues` after it (one
 * round trip per task, and the local `linearSubtask` mirror is only written
 * once the whole fan-out returns) are both unbounded, so a plan with enough
 * tasks can outlive this ceiling on its own. Bounding them needs a
 * resume/dedup answer for issues already created in Linear, which is separate
 * work from ISS-6774 — that is about the LLM call in front of them.
 */
export const maxDuration = 300;

/**
 * POST /integrations/linear/export
 *
 * Export an approved implementation plan to Linear as individual issues.
 *
 * Session-only (`withAuth`), so an API key or a Desktop token gets 401 before
 * the handler runs: the export first extracts tasks with a server-side
 * Anthropic call billed to ClosedLoop's own key (`extractTasksWithLLM`), and
 * API callers must not spend that budget (ISS-11795). The `withAuth` use is
 * declared, with this reason, in `SESSION_ONLY_HANDLERS`
 * (scripts/lint/rules/no-unpaved-api-route-handler.ts); moving the route back
 * to `withAnyAuth` needs a new ruling, not just removing that entry.
 */
export const POST = withAuth<
  ExportToLinearResult,
  "/integrations/linear/export"
>(async ({ user }, request) => {
  try {
    const { body, errorResponse: parseError } = await parseBody(
      request,
      exportToLinearValidator
    );
    if (parseError) {
      return parseError;
    }

    const { documentId, teamId } = body;

    const result = await linearService.exportImplementationPlan(
      documentId,
      teamId,
      user.organizationId,
      user.id
    );

    if (!result.success) {
      // The service reports 400 | 403 | 404 | 500 | 502. Every one of those but
      // 400 used to fall through to `default` and reach the caller as HTTP 400
      // Bad Request — telling them to fix a request that was fine (ISS-6774,
      // reached via the timed-out extraction's 500). Each is mapped explicitly
      // now, forwarding the service's own message so the caller is told what to
      // do about it.
      switch (result.status) {
        case 404:
          return notFoundResponse("Artifact");
        // Upstream Linear failure (expired token, refused call). Passed
        // explicitly because `errorResponse` otherwise defaults to 500.
        case 502:
          return errorResponse(result.error, new Error(result.error), 502);
        // Server-side failure, including a failed or timed-out extraction.
        case 500:
          return errorResponse(result.error, new Error(result.error));
        // Not caller misuse and not a server failure: the caller named a team
        // that is not in their Linear workspace. `forbiddenResponse` is not
        // used because it replaces the message with a bare "Forbidden", and
        // which team was rejected is the whole content of this answer.
        case 403:
          return NextResponse.json(failure(result.error), { status: 403 });
        default:
          return badRequestResponse(result.error);
      }
    }

    return successResponse(result);
  } catch (error) {
    return errorResponse("Failed to export to Linear", error);
  }
});
