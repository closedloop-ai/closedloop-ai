import {
  PROJECT_TREE_CONTRIBUTOR_USER_ID_PARAM,
  PROJECT_TREE_INCLUDE_PARAM,
  PROJECT_TREE_LIMIT_PARAM,
  PROJECT_TREE_MAX_ROOT_LIMIT,
  type ProjectTreeDetailsResponse,
  ProjectTreeInclude,
  type ProjectTreeResponse,
} from "@repo/api/src/types/project-tree";
import { z } from "zod";
import { projectTreeService } from "@/app/artifacts/project-tree-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { projectsService } from "../../service";

/**
 * GET /projects/:id/tree - Get project entity tree
 * Returns all artifacts, features, and external links organized hierarchically
 * by entity link chains.
 *
 * With `?include=details`, every artifact node is enriched in place with
 * artifact-level view details (tags, generation status), so the documents
 * table renders from one request (FEA-1763, PLN-874).
 */
export const GET = withAnyAuth<
  ProjectTreeResponse | ProjectTreeDetailsResponse,
  "/projects/[id]/tree"
>(async ({ user }, request, params) => {
  try {
    const { id: projectId } = await params;
    const project = await projectsService.findById(
      projectId,
      user.organizationId
    );

    if (!project) {
      return notFoundResponse("Project");
    }

    const includeDetails =
      request.nextUrl.searchParams.get(PROJECT_TREE_INCLUDE_PARAM) ===
      ProjectTreeInclude.Details;
    const contributorUserId = parseContributorUserId(request);
    if (contributorUserId === null) {
      return badRequestResponse("Invalid contributorUserId");
    }

    const limit = parseRootLimit(request);
    if (limit === null) {
      return badRequestResponse("Invalid limit");
    }

    const tree = includeDetails
      ? await projectTreeService.getProjectTreeWithDetails(
          project.id,
          user.organizationId,
          { contributorUserId, limit }
        )
      : await projectTreeService.getProjectTree(
          project.id,
          user.organizationId,
          { contributorUserId, limit }
        );

    return successResponse(tree);
  } catch (error) {
    return errorResponse("Failed to fetch project tree", error);
  }
});

function parseContributorUserId(request: {
  nextUrl: { searchParams: URLSearchParams };
}): string | undefined | null {
  const value = request.nextUrl.searchParams.get(
    PROJECT_TREE_CONTRIBUTOR_USER_ID_PARAM
  );
  if (value === null) {
    return undefined;
  }
  const parsed = z.string().trim().uuid().safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Parse `?limit=` into a root-node bound (ISS-5307).
 *
 * Three outcomes, deliberately distinct: `undefined` (param absent — the
 * unbounded read every caller got before this existed), a clamped positive
 * integer, or `null` for a value that is present but not a number at all,
 * which the caller turns into a 400. A malformed bound is rejected rather than
 * silently treated as "unbounded": a client that asked to be bounded and was
 * quietly handed the whole project would render a page footer describing a
 * bound the server never applied.
 *
 * A numerically out-of-range value is CLAMPED rather than rejected — the floor
 * of 1 stops a `0`/negative from producing an empty page for a non-empty
 * project, and the ceiling protects the server. Either way the response's
 * `truncation` states what was actually served, so a clamp cannot mislead.
 */
function parseRootLimit(request: {
  nextUrl: { searchParams: URLSearchParams };
}): number | undefined | null {
  const value = request.nextUrl.searchParams.get(PROJECT_TREE_LIMIT_PARAM);
  if (value === null) {
    return undefined;
  }
  const raw = value.trim();
  // `?limit=` with no value is a malformed request, not an unbounded one.
  // Without this guard `z.coerce.number()` reads "" as 0, which the clamp then
  // turns into a one-root page — a silently wrong answer to a broken question.
  if (raw === "") {
    return null;
  }
  const parsed = z.coerce.number().int().safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  return Math.min(Math.max(1, parsed.data), PROJECT_TREE_MAX_ROOT_LIMIT);
}
