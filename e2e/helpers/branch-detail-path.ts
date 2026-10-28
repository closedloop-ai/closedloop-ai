/**
 * The `/branches/<id>` reads a route fixture may claim, matched and parsed here
 * so no fixture can claim a path it has no row for. Three matchers, because the
 * fixtures author their ids differently and claim different sub-resources:
 * `parseBranchDetailPath` (ISS-6876) is digits-only and detail-only;
 * `parseBranchDetailRoute` (ISS-6965) takes `branch-`-prefixed ids and one fixed
 * sub-resource set; `resolveBranchFixtureRead` (ISS-7644) takes the caller's
 * claimed set and an opaque id, and folds the method into the decision.
 *
 * The first two accept only ids a FIXTURE authors, so a production artifact id —
 * percent-encoded — declines there. The third does not narrow the id at all, by
 * design: whether a fixture holds a ROW for one is the caller's to answer, and
 * narrowing it to `branch-`-prefixed would decline `no-sessions` and
 * `missing-branch` and make those specs vacuous.
 *
 * `/branches/branch-100/trace-comments?surface=branch_detail` is a real read the
 * branch detail page issues. A `startsWith("/branches/branch-")` matcher claims
 * it too, and the id parse that followed (`Number(id.slice(-3))` over
 * `"branch-100/trace-comments"`) then yielded `NaN`, which surfaced three frames
 * later as `RangeError: Invalid time value` from the fixture's date arithmetic.
 *
 * Anchoring the pattern excludes every present and future sub-resource by
 * construction, and returning `null` rather than a `NaN` index means a path this
 * module cannot read can never be fulfilled with a fabricated branch row.
 */

// Digits, not a pinned width: the exclusion this module exists for is carried by
// the anchors, so pinning the fixture's current zero-padding here would only
// couple two files that can drift apart silently.
const BRANCH_DETAIL_PATH_PATTERN = /^\/branches\/branch-(\d+)$/;

export type BranchDetailTarget = {
  id: string;
  index: number;
};

/** Strip the `/api` BFF prefix so one predicate matches both web origins. */
export function branchApiPath(pathname: string): string {
  return pathname.startsWith("/api/branches")
    ? pathname.slice("/api".length)
    : pathname;
}

/**
 * The branch a path addresses, or `null` when it is not a branch detail read —
 * an analytics rollup, the cohort POST, or any `/branches/<id>/<sub-resource>`.
 * A non-null result always carries an integer `index`.
 */
export function parseBranchDetailPath(
  pathname: string
): BranchDetailTarget | null {
  const digits = BRANCH_DETAIL_PATH_PATTERN.exec(branchApiPath(pathname))?.[1];
  if (digits === undefined) {
    return null;
  }
  return { id: `branch-${digits}`, index: Number(digits) };
}

/**
 * The `/branches/<id>` sub-resources a branch-detail route fixture answers.
 * `trace-comments` is deliberately absent (ISS-6965): it is a real branch-detail
 * read that a subtract-known-exceptions matcher claimed and then fulfilled with a
 * branch-detail body — a well-formed 200 of entirely the wrong shape.
 */
export const BranchDetailSubResource = {
  Comments: "comments",
  SelectedPullRequest: "selected-pull-request",
  Trace: "trace",
} as const;
export type BranchDetailSubResource =
  (typeof BranchDetailSubResource)[keyof typeof BranchDetailSubResource];

export type BranchDetailRouteTarget = {
  id: string;
  subResource: BranchDetailSubResource | null;
};

/**
 * Whether each sub-resource path carries a trailing segment. Exhaustive on
 * purpose: a member added to the const without an entry here fails `tsc`, which
 * is the only drift signal a regex alternation could not have given.
 */
const SUB_RESOURCE_TAKES_TAIL: Record<BranchDetailSubResource, boolean> = {
  [BranchDetailSubResource.Comments]: false,
  [BranchDetailSubResource.SelectedPullRequest]: true,
  [BranchDetailSubResource.Trace]: false,
};

// The `branch-` prefix is what separates an id from the `analytics` and `usage`
// rollups, which share the `/branches/<segment>` shape and own their own routes.
// The sub-resource segment is captured whole rather than enumerated, so the const
// above stays the ONLY place the claimed names are written down.
const BRANCH_DETAIL_ROUTE_PATTERN =
  /^\/branches\/(?<id>branch-[\w-]+)(?:\/(?<subResource>[^/]+)(?<tail>\/[^/]+)?)?$/;

/**
 * The branch read a path addresses, or `null` when this fixture does not model
 * it — an analytics rollup, `trace-comments`, or any sub-resource added later.
 * Declining is the point: a claimed path it has no row for would otherwise be
 * answered with a branch-detail body.
 */
export function parseBranchDetailRoute(
  pathname: string
): BranchDetailRouteTarget | null {
  const groups = BRANCH_DETAIL_ROUTE_PATTERN.exec(
    branchApiPath(pathname)
  )?.groups;
  if (groups?.id === undefined) {
    return null;
  }
  const id = groups.id;
  if (groups.subResource === undefined) {
    return { id, subResource: null };
  }
  const subResource = Object.values(BranchDetailSubResource).find(
    (member) => member === groups.subResource
  );
  if (subResource === undefined) {
    return null;
  }
  const hasTail = groups.tail !== undefined;
  return SUB_RESOURCE_TAKES_TAIL[subResource] === hasTail
    ? { id, subResource }
    : null;
}

/**
 * The `/branches/<id>` sub-resources a branch route fixture may claim. A name
 * absent here can never be claimed, so a route added under
 * `apps/api/app/branches/[id]/` — `refresh`, `compatibility`,
 * `custom-field-values` — declines by construction instead of joining the
 * claimed set the moment it ships (ISS-7644).
 */
export const BranchFixtureSubResource = {
  Comments: "comments",
  SelectedPullRequest: "selected-pull-request",
  Trace: "trace",
  TraceComments: "trace-comments",
} as const;
export type BranchFixtureSubResource =
  (typeof BranchFixtureSubResource)[keyof typeof BranchFixtureSubResource];

/**
 * Narrowed to the caller's claimed list so a per-fixture payload map can be an
 * exhaustive `Record` over exactly what that fixture claims.
 */
export type BranchFixtureRouteTarget<
  T extends BranchFixtureSubResource = BranchFixtureSubResource,
> = {
  id: string;
  subResource: T | null;
};

/**
 * The trailing segments each sub-resource claims, empty when it takes none.
 * Named, not counted: `selected-pull-request` has exactly two real children —
 * `diff` and `files`, the only routes under
 * `apps/api/app/branches/[id]/selected-pull-request/` and the only values
 * `selectedPullRequestPath` interpolates — so an arity rule alone would claim
 * `/selected-pull-request/checks` and answer a typo, or a child route added
 * later, with this fixture's body instead of letting it fall through (whitlockk,
 * PR #5622).
 *
 * Exhaustive on purpose: a member added to the const above without an entry
 * here fails `tsc`, which is the only drift signal a regex alternation could
 * not have given.
 *
 * Separate from `SUB_RESOURCE_TAKES_TAIL` above because it is keyed by a
 * different const; folding the two matchers into one is ISS-7659's job, not a
 * merge resolution's.
 */
const FIXTURE_SUB_RESOURCE_TAILS: Record<
  BranchFixtureSubResource,
  readonly string[]
> = {
  [BranchFixtureSubResource.Comments]: [],
  [BranchFixtureSubResource.SelectedPullRequest]: ["diff", "files"],
  [BranchFixtureSubResource.Trace]: [],
  [BranchFixtureSubResource.TraceComments]: [],
};

// The rollups that share the `/branches/<segment>` shape with a branch id. They
// are the only siblings of `[id]` under `apps/api/app/branches/`, and each owns
// its own route in every fixture here.
const BRANCH_COLLECTION_SEGMENTS: readonly string[] = ["analytics", "usage"];

// The sub-resource segment is captured whole rather than enumerated, so the
// caller's claimed list stays the ONLY place claimed names are written down.
const BRANCH_FIXTURE_ROUTE_PATTERN =
  /^\/branches\/(?<id>[^/]+)(?:\/(?<subResource>[^/]+)(?<tail>\/[^/]+)?)?$/;

/**
 * The branch READ a request addresses, or `null` when it is a write, or a path
 * `claimed` does not cover. Declining is the point: a path a fixture has no row
 * for would otherwise be answered with a branch-detail body — a well-formed 200
 * of the wrong shape that leaves the spec green while it asserts on fabricated
 * JSON (ISS-7644).
 *
 * The method is part of the decision rather than a check each handler repeats:
 * `/branches/<id>` takes DELETE and both `comments` and `trace-comments` take
 * POST, and a fabricated 200 read body would report a write that never happened.
 *
 * Ids are accepted as an opaque segment because fixtures author their own
 * (`branch-1`, `branch-awaiting-sync`, `missing-branch`); narrowing that to
 * digits would decline every read and make the specs vacuous. Whether a fixture
 * has a ROW for a given id is the caller's to answer.
 */
export function resolveBranchFixtureRead<T extends BranchFixtureSubResource>(
  method: string,
  pathname: string,
  claimed: readonly T[]
): BranchFixtureRouteTarget<T> | null {
  if (method !== "GET") {
    return null;
  }
  const groups = BRANCH_FIXTURE_ROUTE_PATTERN.exec(
    branchApiPath(pathname)
  )?.groups;
  const id = groups?.id;
  if (id === undefined || BRANCH_COLLECTION_SEGMENTS.includes(id)) {
    return null;
  }
  if (groups?.subResource === undefined) {
    return { id, subResource: null };
  }
  const subResource = claimed.find((member) => member === groups.subResource);
  if (subResource === undefined) {
    return null;
  }
  const allowedTails = FIXTURE_SUB_RESOURCE_TAILS[subResource];
  const tail = groups.tail?.slice(1);
  const tailIsClaimed =
    tail === undefined
      ? allowedTails.length === 0
      : allowedTails.includes(tail);
  return tailIsClaimed ? { id, subResource } : null;
}
