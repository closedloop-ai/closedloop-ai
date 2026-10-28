import type { DocumentListSummary } from "@repo/api/src/types/document-list-summary";
import { documentSummaryService } from "@/app/documents/document-summary-service";
import { documentSummaryQueryValidator } from "@/app/documents/validators";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveProjectId } from "@/lib/identifier-utils";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";

/**
 * GET /documents/summary — the four counts the Documents index summary band
 * renders (ISS-8936). Accepts API key (`sk_live_`) or Clerk session auth.
 *
 * It takes the SAME filter vocabulary as `GET /documents` minus paging and
 * ordering (see {@link documentSummaryQueryValidator}), because the band's whole
 * job is to describe the population that endpoint would return for the same
 * query. A caller narrows both with one set of params, or the two disagree.
 * ISS-12600 adds the index's owner, tag and favorite facets, which only the
 * metric endpoints honor.
 *
 * `status` is read with `getAll`, not off `Object.fromEntries`, for the reason
 * the list route's own comment gives: `fromEntries` keeps only the LAST
 * occurrence, so `?status=TODO&status=DONE` would be summarized as DONE alone —
 * a filter the caller asked for, dropped without a word, and a band describing a
 * different population than the list beside it.
 */
export const GET = withAnyAuth<DocumentListSummary, "/documents/summary">(
  async ({ user }, request) => {
    try {
      const searchParams = request.nextUrl.searchParams;
      const queryParams: Record<string, unknown> = Object.fromEntries(
        searchParams.entries()
      );
      const statusValues = searchParams.getAll("status");
      if (statusValues.length > 0) {
        queryParams.status = statusValues;
      }
      if (searchParams.has("artifactIds")) {
        queryParams.artifactIds = searchParams.getAll("artifactIds");
      }
      const typeValues = searchParams.getAll("types");
      if (typeValues.length > 0) {
        queryParams.types = typeValues;
      }
      // ISS-12600: the owner and tag facets repeat their key, like `status`.
      const assigneeValues = searchParams.getAll("assigneeIds");
      if (assigneeValues.length > 0) {
        queryParams.assigneeIds = assigneeValues;
      }
      const tagValues = searchParams.getAll("tagIds");
      if (tagValues.length > 0) {
        queryParams.tagIds = tagValues;
      }

      const parseResult = documentSummaryQueryValidator.safeParse(queryParams);
      if (!parseResult.success) {
        return badRequestResponse(
          `Invalid query parameters: ${parseResult.error.message}`
        );
      }

      const { projectId, ...restQuery } = parseResult.data;
      let resolvedProjectId: string | undefined;
      if (projectId) {
        const pId = await resolveProjectId(projectId, user.organizationId);
        // A project the caller cannot see is a 404, not a summary of the whole
        // org: folding it to "no project filter" would answer a narrowed
        // question with every document the reader can reach.
        if (!pId) {
          return notFoundResponse("Project");
        }
        resolvedProjectId = pId;
      }

      const summary = await documentSummaryService.summarizeScope(
        {
          ...restQuery,
          projectId: resolvedProjectId,
          organizationId: user.organizationId,
        },
        user.id
      );
      if (!summary.ok) {
        return badRequestResponse(summary.error);
      }
      return successResponse(summary.value);
    } catch (error) {
      return errorResponse("Failed to summarize documents", error);
    }
  }
);
