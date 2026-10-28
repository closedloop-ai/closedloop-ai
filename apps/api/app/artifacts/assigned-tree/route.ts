import { ArtifactDateField } from "@repo/api/src/types/artifact-date-filter";
import { ArtifactGroupByMode } from "@repo/api/src/types/artifact-group-by-mode";
import {
  type AssignedTreeSort,
  AssignedTreeSortDirection,
  AssignedTreeSortKey,
} from "@repo/api/src/types/assigned-tree-sort";
import { PRIORITY_FILTER_VALUES } from "@repo/api/src/types/priority-filter";
import {
  ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM,
  ASSIGNED_ARTIFACT_TREE_MAX_TAG_IDS,
  AssignedArtifactTreeParam,
  PROJECT_TREE_MAX_ROOT_LIMIT,
  type ProjectTreeResponse,
} from "@repo/api/src/types/project-tree";
import {
  PRIORITY_UNSET_VALUE,
  PRIORITY_VALUES,
} from "@repo/api/src/types/search-query";
import { z } from "zod";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { isManualArtifactOrderingEnabled } from "@/lib/manual-artifact-ordering-feature";
import { repeatedQueryArray } from "@/lib/repeated-query-array";
import {
  errorResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import {
  ANY_ARTIFACT_STATUS_COUNT,
  anyArtifactStatusEnum,
} from "@/lib/validators/artifact-status";
import type { TreeAnchorFilters } from "../assigned-artifact-tree-anchors";
import { assignedArtifactTreeService } from "../assigned-artifact-tree-service";
import { resolveAssignedTreeSectionOrdering } from "../assigned-tree-section-ordering";

/**
 * One `?status=` occurrence. The union below accepts a bare element as well as
 * an array because `parseQueryParams` hands a single occurrence through as a
 * string and only collapses two or more into an array, so a schema that took
 * only arrays would reject `?status=TODO` — the common case.
 *
 * The trim is a spelling tolerance, never a dropped element: `?status=%20TODO`
 * from a hand-written curl still means TODO. An empty or whitespace-only
 * occurrence is a 400, because `?status=` is a status that failed to spell
 * itself rather than an empty selection — widening to the whole population
 * behind a parameter the caller believes narrowed it is the lie this rejects.
 */
const statusElementSchema = z.string().trim().pipe(anyArtifactStatusEnum);

/**
 * One `?priority=` occurrence, including the unset token: "no priority" is a
 * value this facet selects rather than a gap it cannot express (ISS-9665).
 *
 * Composed from the two canonical exports rather than written out, so a new
 * `Priority` member arrives here for free. The unset token LEADS so the tuple
 * is provably non-empty for `z.enum` — `PRIORITY_VALUES` is a
 * `readonly Priority[]`, not a tuple, so spreading it alone would not be. Same
 * construction the Branches list query uses.
 */
const priorityFilterValues = [
  PRIORITY_UNSET_VALUE,
  ...PRIORITY_VALUES,
] as const;

/**
 * Ceiling on `?projectId=` occurrences. Same reasoning as
 * {@link ASSIGNED_ARTIFACT_TREE_MAX_TAG_IDS}: the set is open (projects are
 * user-created), so there is no derived count to bound the `IN` list with.
 * Declared separately rather than shared with it so lowering one facet's cap
 * cannot silently move another's.
 */
export const MAX_PROJECT_FILTER_VALUES = 100;

const priorityElementSchema = z
  .string()
  .trim()
  .pipe(z.enum(priorityFilterValues));

/**
 * Query contract for the assignee-scoped tree. `.strict()` is deliberate and
 * stays: a param this route cannot honor — a recency window, or a sort column
 * outside `AssignedTreeSortKey` such as `status` or `priority` — is rejected
 * with a 400 rather than silently accepted and dropped. The project facet IS
 * honored since the 2026-10-16 ruling, and ISS-12636 made the five columns
 * `AssignedTreeSortKey` names honorable too.
 *
 * ISS-10471 adds the opt-in facets, each repeated once per value
 * (`?status=TODO&status=IN_PROGRESS`), the multi-value shape
 * `apps/api/AGENTS.md` requires and the one `GET /documents` already spells.
 * Built with {@link repeatedQueryArray} rather than a local union: it dedupes on
 * the RAW value BEFORE the cap is applied (ISS-7271), so one value repeated a
 * thousand times parses instead of 400ing, and it rejects an over-wide set
 * whole rather than truncating it (ISS-9073).
 * Elements are checked against `anyArtifactStatusEnum`, the same union the
 * create/update bodies read, so this does not start a second status inventory.
 * Deliberately not narrowed by artifact type: `Artifact.status` is freeform and
 * off-vocabulary rows exist, so a combination the lifecycle forbids is answered
 * with the rows that carry it rather than a 400 that would hide them.
 */
const assignedTreeQuerySchema = z
  .object({
    [ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM]: z.string().trim().uuid(),
    [AssignedArtifactTreeParam.Status]: repeatedQueryArray(
      statusElementSchema,
      ANY_ARTIFACT_STATUS_COUNT
    ),
    // Same string-literal coercion and reject-don't-guess posture the document
    // list's booleans use: anything other than "true"/"false" is a 400, never a
    // silent falsy default. "false" narrows nothing, as omission does.
    // Timezone-qualified, because the window is an ABSOLUTE instant: a bare
    // local timestamp would mean a different moment per reader, and the whole
    // reason the client resolves its preset before sending is that the window
    // must not move between page requests.
    [AssignedArtifactTreeParam.DateField]: z.enum(ArtifactDateField).optional(),
    [AssignedArtifactTreeParam.DateFrom]: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value))
      .optional(),
    [AssignedArtifactTreeParam.DateTo]: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value))
      .optional(),
    [AssignedArtifactTreeParam.HideCompletedItems]: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    [AssignedArtifactTreeParam.FavoritesOnly]: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    [AssignedArtifactTreeParam.ProjectId]: repeatedQueryArray(
      z.uuid(),
      MAX_PROJECT_FILTER_VALUES
    ),
    [AssignedArtifactTreeParam.TagId]: repeatedQueryArray(
      z.uuid(),
      ASSIGNED_ARTIFACT_TREE_MAX_TAG_IDS
    ),
    [AssignedArtifactTreeParam.Priority]: repeatedQueryArray(
      priorityElementSchema,
      PRIORITY_FILTER_VALUES.length
    ),
    /**
     * ISS-10472: the typed term, applied to the ANCHORS in SQL.
     *
     * Trimmed and dropped when blank, the same tolerance the status facet
     * applies: `?search=%20` is a term that failed to spell itself, not a
     * request to narrow to nothing. Server-side because the board pages
     * server-side — a client filter over one page would search the rows on
     * screen rather than the assignee's work.
     */
    [AssignedArtifactTreeParam.Search]: z
      .string()
      .trim()
      .transform((value) => (value === "" ? undefined : value))
      .optional(),
    /**
     * ISS-10472: root-group paging. `limit` CLAMPS rather than 400s, which is
     * the rule `PROJECT_TREE_MAX_ROOT_LIMIT` states for the per-project tree —
     * the bound protects the server, and a clamped read is still correct as
     * long as the response says it was bounded. Reusing that ceiling keeps the
     * two bounded artifact reads from drifting, as its own docstring asks.
     *
     * Both stay OPTIONAL. Omitting `limit` serves the unpaged tree, byte-for-
     * byte what callers got before this parameter existed, so an `apps/app`
     * bundle still in flight during a deploy is unaffected — but a `groupBy` or
     * `pageIndex` sent WITHOUT it is a 400, because dropping them would answer
     * a request for one page with the whole tree (see the refinement below).
     */
    [AssignedArtifactTreeParam.Limit]: z.coerce
      .number()
      .int()
      .transform((value) =>
        Math.min(Math.max(1, value), PROJECT_TREE_MAX_ROOT_LIMIT)
      )
      .optional(),
    /**
     * Floored at 0 and otherwise UNCAPPED, which is the position ISS-11161
     * reached for `DOCUMENT_LIST_MAX_OFFSET` and the reasoning carries here
     * unchanged: a deep offset costs a scan bounded by the matching population,
     * which this read already walks in full, so a ceiling protects nothing
     * while refusing past it strands a reader on a page they can see counted.
     */
    /**
     * ISS-10472: which field a GROUPED board sections by, or omitted for an
     * ungrouped one.
     *
     * Selecting a mode switches the paged unit from a row window to a SECTION,
     * so `offset` stops meaning a row offset — `pageIndex` is the page a
     * grouped caller asks for. Sending `offset` with a grouping is rejected
     * rather than silently reinterpreted, because the two name different things
     * and a caller that sent one meaning the other would get a page it did not
     * ask for.
     */
    [AssignedArtifactTreeParam.GroupBy]: z.enum(ArtifactGroupByMode).optional(),
    /**
     * ISS-12636: which ROOT column the query orders by, or omitted for stack
     * rank — the default, which is already server-side.
     *
     * The vocabulary is narrower than the board's `SortKey` and the enum is
     * what refuses the difference: `status` and `priority` 400 here rather than
     * being accepted and silently served in stack-rank order, because which of
     * the three ISS-9437 Status orderings the server would reproduce is an open
     * question (`AssignedTreeSortKey` records it). The schema stays `.strict()`
     * for the same reason it already did — a param this route cannot honor is
     * an error, not a dropped filter.
     */
    [AssignedArtifactTreeParam.SortBy]: z.enum(AssignedTreeSortKey).optional(),
    [AssignedArtifactTreeParam.SortDir]: z
      .enum(AssignedTreeSortDirection)
      .optional(),
    [AssignedArtifactTreeParam.PageIndex]: z.coerce
      .number()
      .int()
      .min(0)
      .optional(),
    [AssignedArtifactTreeParam.Offset]: z.coerce
      .number()
      .int()
      .transform((value) => Math.max(0, value))
      .optional(),
  })
  .strict()
  .superRefine((query, ctx) => {
    const isGrouped =
      query.groupBy !== undefined && query.groupBy !== ArtifactGroupByMode.None;
    if (isGrouped && query.offset !== undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "offset is a row offset and does not apply to a grouped read; use pageIndex",
        path: ["offset"],
      });
    }
    if (!isGrouped && query.pageIndex !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "pageIndex applies only to a grouped read; use offset",
        path: ["pageIndex"],
      });
    }
    // `limit` is what selects a paged derivation at all, so a GROUPING without
    // it describes a page of an unpaged read. Rejected rather than dropped:
    // `?groupBy=status&pageIndex=3` with no limit parsed, lost both
    // parameters, and answered with the whole unpaged tree — a caller that
    // asked for page 3 of a grouped board getting everything and no error
    // (marisolashgrove, PR #9026). A bare `pageIndex` needs no rule of its own:
    // without a grouping the check above already refuses it.
    if (query.limit === undefined && isGrouped) {
      ctx.addIssue({
        code: "custom",
        message: "groupBy requires limit, which selects a paged read",
        path: ["groupBy"],
      });
    }
    // A direction with nothing to apply it to. Dropped, it would answer a
    // request for descending order with the ascending default and look like a
    // sort that silently failed; honoured, it would have to pick a column the
    // caller never named.
    if (query.sortDir !== undefined && query.sortBy === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "sortDir requires sortBy, which names the column it orders",
        path: ["sortDir"],
      });
    }
    // `limit` selects the SQL-paged derivation, and that derivation is the only
    // one carrying an ORDER BY this column can reach: the unpaged arm resolves
    // roots in Node and orders them with `compareByStackRank`. Accepted without
    // it, `?sortBy=title` would return the whole tree in stack-rank order —
    // a sort that reported success and did nothing, which is the exact shape
    // `.strict()` exists to refuse. Same rule as `groupBy` above.
    if (query.limit === undefined && query.sortBy !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "sortBy requires limit, which selects the ordered read",
        path: ["sortBy"],
      });
    }
    const parts = [query.dateField, query.dateFrom, query.dateTo];
    const present = parts.filter((part) => part !== undefined).length;
    if (present !== 0 && present !== parts.length) {
      // A partial window is refused rather than ignored. Honouring one end
      // would answer a question the caller did not ask; dropping all three
      // silently would return the whole population behind a filter the UI still
      // shows as active.
      ctx.addIssue({
        code: "custom",
        message:
          "dateField, dateFrom and dateTo must be supplied together or not at all",
      });
      return;
    }
    if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) {
      // The browser treats an inverted range as NO narrowing and never sends
      // one. On the wire it is malformed input, so it is a 400 rather than a
      // silently unfiltered page.
      ctx.addIssue({
        code: "custom",
        message: "dateFrom must not be after dateTo",
      });
    }
  });

/**
 * GET /artifacts/assigned-tree?assigneeId=<userId> — the merged, org-scoped
 * artifact tree for one assignee (FEA-1651, parent FEA-908; flagged by whitlockk in
 * the PR #1077 review).
 *
 * Answers with the same `ProjectTreeResponse` shape as `GET /projects/:id/tree`
 * so tree consumers work against one contract, and collapses the My Tasks
 * client fan-out — previously one request per project the user is assigned in —
 * into a single request. The organization always comes from the authenticated
 * caller, never from the query string.
 */
export const GET = withAnyAuth<ProjectTreeResponse, "/artifacts/assigned-tree">(
  async (auth, request) => {
    const { user } = auth;
    const { params, errorResponse: invalidParams } = parseQueryParams(
      request,
      assignedTreeQuerySchema
    );
    if (invalidParams) {
      return invalidParams;
    }

    const filters = {
      favoritesOnly: params.favoritesOnly,
      dateWindow:
        params.dateField && params.dateFrom && params.dateTo
          ? {
              field: params.dateField,
              from: params.dateFrom,
              to: params.dateTo,
            }
          : undefined,
      hideCompletedItems: params.hideCompletedItems,
      priority: params.priority,
      projectIds: params.projectId,
      search: params.search,
      status: params.status,
      tagIds: params.tagId,
    };

    try {
      const manualOrderingEnabled = await isManualArtifactOrderingEnabled(auth);
      // `limit` is what selects the paged derivation: an offset without one is
      // an offset into an unbounded result, which `DocumentListFilters` already
      // documents as meaningless.
      const tree = manualOrderingEnabled
        ? await resolveManuallyOrderedTree(params, filters, user)
        : await resolveTree(params, filters, user);
      return successResponse(tree);
    } catch (error) {
      return errorResponse("Failed to fetch assigned artifact tree", error);
    }
  }
);

/**
 * Pick the derivation this request asked for.
 *
 * `limit` is what selects a PAGED read at all: an offset without one is an
 * offset into an unbounded result, which `DocumentListFilters` already
 * documents as meaningless. A grouping then selects the SECTION-paged read.
 *
 * The section ordering is resolved HERE and above the service call, not inside
 * it: the resolution awaits a PostHog round trip, and the service's read must
 * not spend a snapshot's budget on a flag lookup
 * (`app/branches/branch-status-ordering.ts` records that constraint).
 */
async function resolveTree(
  params: AssignedTreeQuery,
  filters: TreeAnchorFilters,
  user: { id: string; organizationId: string; clerkId?: string | null }
): Promise<ProjectTreeResponse> {
  const assigneeId = params[ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM];
  const sort = resolveSort(params);
  if (params.limit === undefined) {
    return assignedArtifactTreeService.getAssignedArtifactTree(
      assigneeId,
      user.organizationId,
      user.id,
      filters
    );
  }
  if (
    params.groupBy === undefined ||
    params.groupBy === ArtifactGroupByMode.None
  ) {
    const paging = { limit: params.limit, offset: params.offset ?? 0, sort };
    return assignedArtifactTreeService.getAssignedArtifactTreePage(
      assigneeId,
      user.organizationId,
      user.id,
      paging,
      filters
    );
  }
  // `clerkUserId` is load-bearing on a PERCENTAGE rollout: the browser
  // identifies PostHog with the Clerk id alone, so bucketing on the internal id
  // would resolve a DIFFERENT ordering here than the client's own flags
  // (`lib/feature-flag-identity.ts`, ISS-8196) — the exact drift naming the
  // ordering on the response exists to prevent.
  const ordering = await resolveAssignedTreeSectionOrdering({
    clerkUserId: user.clerkId,
    userId: user.id,
  });
  const grouping = {
    groupBy: params.groupBy,
    ordering,
    pageIndex: params.pageIndex ?? 0,
    pageSize: params.limit,
    sort,
  };
  return assignedArtifactTreeService.getAssignedArtifactTreeSectionPage(
    assigneeId,
    user.organizationId,
    user.id,
    grouping,
    filters
  );
}

async function resolveManuallyOrderedTree(
  params: AssignedTreeQuery,
  filters: TreeAnchorFilters,
  user: { id: string; organizationId: string; clerkId?: string | null }
): Promise<ProjectTreeResponse> {
  const assigneeId = params[ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM];
  const sort = resolveSort(params);
  if (params.limit === undefined) {
    return assignedArtifactTreeService.getManuallyOrderedAssignedArtifactTree(
      assigneeId,
      user.organizationId,
      user.id,
      filters
    );
  }
  if (
    params.groupBy === undefined ||
    params.groupBy === ArtifactGroupByMode.None
  ) {
    return assignedArtifactTreeService.getManuallyOrderedAssignedArtifactTreePage(
      assigneeId,
      user.organizationId,
      user.id,
      { limit: params.limit, offset: params.offset ?? 0, sort },
      filters
    );
  }
  const ordering = await resolveAssignedTreeSectionOrdering({
    clerkUserId: user.clerkId,
    userId: user.id,
  });
  return assignedArtifactTreeService.getManuallyOrderedAssignedArtifactTreeSectionPage(
    assigneeId,
    user.organizationId,
    user.id,
    {
      groupBy: params.groupBy,
      ordering,
      pageIndex: params.pageIndex ?? 0,
      pageSize: params.limit,
      sort,
    },
    filters
  );
}

type AssignedTreeQuery = z.infer<typeof assignedTreeQuerySchema>;

/**
 * The requested root ordering, or `undefined` for stack rank.
 *
 * `sortDir` defaults to ascending, which is what the board's own `sortDir`
 * state does. The pair is resolved HERE, once, so the unpaged, row-paged and
 * section-paged arms cannot each default it differently.
 */
function resolveSort(params: AssignedTreeQuery): AssignedTreeSort | undefined {
  if (params.sortBy === undefined) {
    return undefined;
  }
  return {
    key: params.sortBy,
    direction: params.sortDir ?? AssignedTreeSortDirection.Asc,
  };
}
