import {
  PROJECT_TREE_CATEGORY_PARAM,
  PROJECT_TREE_CHILD_CURSOR_PARAM,
  PROJECT_TREE_CHILD_LIMIT_PARAM,
  PROJECT_TREE_CONTRIBUTOR_USER_ID_PARAM,
  PROJECT_TREE_DEFAULT_CHILD_LIMIT,
  PROJECT_TREE_HIERARCHY_PARAM,
  PROJECT_TREE_HIERARCHY_REVISION_PARAM,
  PROJECT_TREE_INCLUDE_PARAM,
  PROJECT_TREE_LIMIT_PARAM,
  PROJECT_TREE_MAX_CHILD_LIMIT,
  PROJECT_TREE_MAX_ROOT_LIMIT,
  PROJECT_TREE_PARENT_ARTIFACT_ID_PARAM,
  PROJECT_TREE_ROOT_CURSOR_PARAM,
  ProjectTreeCategory,
  type ProjectTreeDetailsResponse,
  ProjectTreeInclude,
  type ProjectTreeQueryFilters,
  type ProjectTreeResponse,
} from "@repo/api/src/types/project-tree";
import { Prisma, withDb } from "@repo/database";
import { z } from "zod";
import { projectTreeService } from "@/app/artifacts/project-tree-service";
import { ProjectHierarchyReadErrorCode } from "@/app/artifacts/project-tree-service/hierarchy-projection";
import { projectHierarchyCompatibilityService } from "@/app/projects/project-hierarchy-compatibility-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { isManualArtifactOrderingEnabled } from "@/lib/manual-artifact-ordering-feature";
import {
  badRequestResponse,
  conflictResponse,
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
>(async (auth, request, params) => {
  try {
    const { user } = auth;
    const { id: projectId } = await params;
    const project = await projectsService.findById(
      projectId,
      user.organizationId
    );

    if (!project) {
      return notFoundResponse("Project");
    }

    const parsedRequest = parseProjectTreeRequest(request);
    if (!parsedRequest.ok) {
      return badRequestResponse(parsedRequest.message);
    }

    const manualOrderingEnabled = await isManualArtifactOrderingEnabled(auth);
    const includeHierarchyRevision =
      request.nextUrl.searchParams.get(
        PROJECT_TREE_HIERARCHY_REVISION_PARAM
      ) === "true";
    const readTree = async () => {
      if (parsedRequest.options.hierarchy) {
        return parsedRequest.includeDetails
          ? projectTreeService.getProjectTreeWithDetailsResult(
              project.id,
              user.organizationId,
              parsedRequest.options
            )
          : projectTreeService.getProjectTreeResult(
              project.id,
              user.organizationId,
              parsedRequest.options
            );
      }
      let tree: ProjectTreeResponse | ProjectTreeDetailsResponse;
      if (manualOrderingEnabled && parsedRequest.includeDetails) {
        tree =
          await projectTreeService.getManuallyOrderedProjectTreeWithDetails(
            project.id,
            user.organizationId,
            parsedRequest.options
          );
      } else if (manualOrderingEnabled) {
        tree = await projectTreeService.getManuallyOrderedProjectTree(
          project.id,
          user.organizationId,
          parsedRequest.options
        );
      } else if (parsedRequest.includeDetails) {
        tree = await projectTreeService.getProjectTreeWithDetails(
          project.id,
          user.organizationId,
          parsedRequest.options
        );
      } else {
        tree = await projectTreeService.getProjectTree(
          project.id,
          user.organizationId,
          parsedRequest.options
        );
      }
      return { ok: true as const, value: tree };
    };
    const treeResult = includeHierarchyRevision
      ? await withDb.tx(
          async () => {
            const result = await readTree();
            if (!result.ok) {
              return result;
            }
            const revision =
              await projectHierarchyCompatibilityService.getRevision(
                project.id,
                user.organizationId,
                {
                  userId: user.id,
                  authMethod: auth.authMethod,
                  apiKeyId: auth.apiKeyId,
                  desktopSessionId: auth.desktopSessionId,
                },
                "current"
              );
            return revision
              ? {
                  ok: true as const,
                  value: {
                    ...result.value,
                    hierarchyRevision: revision.revision,
                  },
                }
              : result;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
        )
      : await readTree();
    if (!treeResult.ok) {
      switch (treeResult.error.code) {
        case ProjectHierarchyReadErrorCode.ParentUnavailable:
          return notFoundResponse("Parent artifact");
        case ProjectHierarchyReadErrorCode.InvalidCursor:
          return badRequestResponse("Invalid hierarchy cursor");
        case ProjectHierarchyReadErrorCode.StaleCursor:
          return conflictResponse("Project hierarchy cursor is stale", {
            details: { version: treeResult.error.version },
          });
        default: {
          const exhaustive: never = treeResult.error;
          return exhaustive;
        }
      }
    }
    return successResponse(treeResult.value);
  } catch (error) {
    return errorResponse("Failed to fetch project tree", error);
  }
});

type ParsedProjectTreeRequest =
  | {
      ok: true;
      includeDetails: boolean;
      options: ProjectTreeQueryFilters;
    }
  | { ok: false; message: string };

function parseProjectTreeRequest(request: {
  nextUrl: { searchParams: URLSearchParams };
}): ParsedProjectTreeRequest {
  const includeDetails =
    request.nextUrl.searchParams.get(PROJECT_TREE_INCLUDE_PARAM) ===
    ProjectTreeInclude.Details;
  const contributorUserId = parseContributorUserId(request);
  const limit = parseRootLimit(request);
  const category = parseCategory(request);
  const hierarchy = parseHierarchy(request);
  const parentArtifactId = parseParentArtifactId(request);
  const childCursor = parseChildCursor(request);
  const childLimit = parseChildLimit(request);
  const rootCursor = parseRootCursor(request);
  if (contributorUserId === null) {
    return { message: "Invalid contributorUserId", ok: false };
  }
  if (limit === null) {
    return { message: "Invalid limit", ok: false };
  }
  if (category === null) {
    return { message: "Invalid category", ok: false };
  }
  if (
    hierarchy === null ||
    parentArtifactId === null ||
    childCursor === null ||
    childLimit === null ||
    rootCursor === null
  ) {
    return { message: "Invalid hierarchy query", ok: false };
  }
  const hierarchyError = validateHierarchyQuery({
    category,
    childCursor,
    childLimit,
    contributorUserId,
    hierarchy,
    limit,
    parentArtifactId,
    rootCursor,
  });
  if (hierarchyError) {
    return { message: hierarchyError, ok: false };
  }
  return {
    includeDetails,
    ok: true,
    options: {
      category,
      childCursor,
      childLimit:
        hierarchy && parentArtifactId !== undefined
          ? (childLimit ?? PROJECT_TREE_DEFAULT_CHILD_LIMIT)
          : childLimit,
      contributorUserId,
      hierarchy,
      limit,
      parentArtifactId,
      rootCursor,
    },
  };
}

function validateHierarchyQuery(
  options: ProjectTreeQueryFilters
): string | undefined {
  const hasChildParameter =
    options.parentArtifactId !== undefined ||
    options.childCursor !== undefined ||
    options.childLimit !== undefined;
  if (!options.hierarchy && hasChildParameter) {
    return "Hierarchy parameters require hierarchy=true";
  }
  if (!options.hierarchy && options.rootCursor !== undefined) {
    return "Root cursor requires hierarchy=true";
  }
  if (options.hierarchy && options.contributorUserId !== undefined) {
    return "Hierarchy reads do not support contributor filters";
  }
  if (
    options.parentArtifactId !== undefined &&
    options.rootCursor !== undefined
  ) {
    return "Child reads do not support root cursors";
  }
  if (
    options.parentArtifactId === undefined &&
    (options.childCursor !== undefined || options.childLimit !== undefined)
  ) {
    return "Child cursor and limit require parentArtifactId";
  }
  if (
    options.parentArtifactId !== undefined &&
    options.category !== undefined
  ) {
    return "Child reads do not support category";
  }
  if (
    options.parentArtifactId !== undefined &&
    (options.limit !== undefined || options.contributorUserId !== undefined)
  ) {
    return "Child reads do not support root limits or contributor filters";
  }
  return undefined;
}

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

function parseRootCursor(request: {
  nextUrl: { searchParams: URLSearchParams };
}): string | undefined | null {
  const value = request.nextUrl.searchParams.get(
    PROJECT_TREE_ROOT_CURSOR_PARAM
  );
  if (value === null) {
    return undefined;
  }
  const parsed = z.string().trim().min(1).safeParse(value);
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

/**
 * Parse `?category=` into a population filter. Same three-outcome shape as
 * `parseRootLimit`: `undefined` (absent — the unfiltered tree), a valid
 * category, or `null` → 400. An unknown value is rejected rather than ignored:
 * a client that asked for one category and silently received the whole project
 * would page and count a population its tab does not render.
 */
function parseCategory(request: {
  nextUrl: { searchParams: URLSearchParams };
}): ProjectTreeCategory | undefined | null {
  const value = request.nextUrl.searchParams.get(PROJECT_TREE_CATEGORY_PARAM);
  if (value === null) {
    return undefined;
  }
  const parsed = z.enum(ProjectTreeCategory).safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseHierarchy(request: {
  nextUrl: { searchParams: URLSearchParams };
}): boolean | null {
  const value = request.nextUrl.searchParams.get(PROJECT_TREE_HIERARCHY_PARAM);
  if (value === null) {
    return false;
  }
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  return null;
}

function parseParentArtifactId(request: {
  nextUrl: { searchParams: URLSearchParams };
}): string | undefined | null {
  const value = request.nextUrl.searchParams.get(
    PROJECT_TREE_PARENT_ARTIFACT_ID_PARAM
  );
  if (value === null) {
    return undefined;
  }
  const parsed = z.string().trim().uuid().safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseChildCursor(request: {
  nextUrl: { searchParams: URLSearchParams };
}): string | undefined | null {
  const value = request.nextUrl.searchParams.get(
    PROJECT_TREE_CHILD_CURSOR_PARAM
  );
  if (value === null) {
    return undefined;
  }
  const parsed = z.string().trim().min(1).safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseChildLimit(request: {
  nextUrl: { searchParams: URLSearchParams };
}): number | undefined | null {
  const value = request.nextUrl.searchParams.get(
    PROJECT_TREE_CHILD_LIMIT_PARAM
  );
  if (value === null) {
    return undefined;
  }
  if (value.trim() === "") {
    return null;
  }
  const parsed = z.coerce.number().int().safeParse(value);
  if (!parsed.success) {
    return null;
  }
  return Math.min(Math.max(1, parsed.data), PROJECT_TREE_MAX_CHILD_LIMIT);
}
