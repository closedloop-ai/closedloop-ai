// PRD-721: the Branches compiler for the canonical list query expression
// (ISS-9476), the Branches sibling of `session-list-query-lowering.ts`. Like
// it, it builds no predicate: a resolved expression is LOWERED to the
// `BranchServerPageQuery` params both hosts already validate and serve, so
// the expression reaches the host's one predicate set through its one request
// boundary. The cloud route and the desktop IPC boundary lower through this
// function with their own capability declaration.
//
// `.ts` extensions: see "Relative Imports in Emitted Helpers" in
// `packages/api/AGENTS.md`.
import {
  BranchListSortDirection,
  BranchListSortKey,
} from "./branch-list-contract.ts";
import {
  BRANCH_LIST_QUERY_FIELDS,
  type BranchListLegacyFilterParam,
} from "./branch-list-query-registry.ts";
import type { ListQueryCapability } from "./list-query-capability.ts";
import {
  type ListFilterScalar,
  type ListQueryExpression,
  ListQueryRefusal,
  type ListQueryRefused,
  type ListSortRule,
} from "./list-query-expression.ts";
import {
  type ListQueryLoweredValues,
  type ListQueryLoweringList,
  type ListQueryLoweringResult,
  type ListQueryLoweringTarget,
  lowerListQueryExpression,
  unsupportedField,
} from "./list-query-lowering.ts";
import { anchorListQueryWindowBound } from "./list-query-ordering-semantics.ts";

/** The param the server page carries its one sort rule's field in. */
export const BRANCH_LIST_SORT_KEY_PARAM = "sortKey";
/** The param the server page carries its one sort rule's direction in. */
export const BRANCH_LIST_SORT_DIR_PARAM = "sortDir";

/**
 * The params an expression lowers to. Set values are strings; a bound keeps
 * its scalar type (a LOC bound is a number, which the desktop IPC schema
 * requires and the cloud schema coerces), so one lowering serves both hosts.
 */
export type BranchListLoweredParams = Partial<
  Record<
    | BranchListLegacyFilterParam
    | typeof BRANCH_LIST_SORT_KEY_PARAM
    | typeof BRANCH_LIST_SORT_DIR_PARAM,
    ListFilterScalar | string[]
  >
>;

export type BranchListLoweringResult =
  ListQueryLoweringResult<BranchListLoweredParams>;

/**
 * Resolve `expression` against one host's Branches capability, then lower it.
 * Every refusal carries an ISS-9476 `ListQueryRefusal` code.
 */
export function lowerBranchListQueryExpression(
  expression: ListQueryExpression,
  capability: ListQueryCapability,
  target: ListQueryLoweringTarget
): BranchListLoweringResult {
  return lowerListQueryExpression(
    expression,
    capability,
    target,
    BRANCH_LOWERING
  );
}

/**
 * A text bound is anchored (ISS-9585) so an offsetless window bound names a
 * UTC instant on both hosts, as each host's legacy window read already does
 * (`anchorListQueryWindowBound` in `branch-list-query.ts` and
 * `shared-branches-window.ts`). A numeric bound is written as it is.
 */
function writeBranchBound(bound: ListFilterScalar): ListFilterScalar {
  return typeof bound === "string"
    ? String(anchorListQueryWindowBound(bound))
    : bound;
}

function writeBranchSorts(
  sorts: readonly ListSortRule[],
  target: ListQueryLoweringTarget,
  params: ListQueryLoweredValues
): ListQueryRefused | null {
  const [rule, ...rest] = sorts;
  if (!rule) {
    return null;
  }
  // The resolver refuses a second rule against either declaration; a
  // caller-built capability must not have the rest dropped.
  if (rest.length > 0) {
    return { code: ListQueryRefusal.TooManySortRules, details: {} };
  }
  if (
    !(
      target.acceptedParams.has(BRANCH_LIST_SORT_KEY_PARAM) &&
      target.acceptedParams.has(BRANCH_LIST_SORT_DIR_PARAM) &&
      isBranchListSortKey(rule.field)
    )
  ) {
    return unsupportedField(rule.field);
  }
  // A sortable Branches field id IS its `BranchListSortKey` spelling
  // (`BranchListField` derives from it), and the direction spellings are the
  // shared asc/desc pair.
  params[BRANCH_LIST_SORT_KEY_PARAM] = rule.field;
  params[BRANCH_LIST_SORT_DIR_PARAM] =
    rule.direction === BranchListSortDirection.Asc
      ? BranchListSortDirection.Asc
      : BranchListSortDirection.Desc;
  return null;
}

const BRANCH_SORT_KEYS: ReadonlySet<string> = new Set(
  Object.values(BranchListSortKey)
);

function isBranchListSortKey(field: string): boolean {
  return BRANCH_SORT_KEYS.has(field);
}

const BRANCH_LOWERING: ListQueryLoweringList<BranchListLegacyFilterParam> = {
  fields: BRANCH_LIST_QUERY_FIELDS,
  writeBound: writeBranchBound,
  writeSorts: writeBranchSorts,
};
