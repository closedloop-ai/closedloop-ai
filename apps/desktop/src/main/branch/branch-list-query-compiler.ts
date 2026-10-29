/**
 * @file branch-list-query-compiler.ts
 * @description PRD-721: the desktop compiler for the canonical list query
 * expression (ISS-9476) on the Branches list, the sibling of
 * `../session/session-list-query-compiler.ts`.
 *
 * A Branches IPC request carrying `listQuery` is parsed at the trust boundary
 * by the strict ISS-9476 schema (`parseListQueryExpressionValue`), resolved
 * against `DESKTOP_BRANCH_LIST_QUERY_CAPABILITY`, and lowered through the same
 * `lowerBranchListQueryExpression` the cloud route runs, into the
 * `BranchServerPageQuery` params this read already serves. It writes no SQL
 * and no predicate: the lowered request meets the same server-page schema a
 * legacy request meets.
 */

import { BranchListPageMode } from "@repo/api/src/types/branch-list-contract";
import { branchServerPageQueryShape } from "@repo/api/src/types/branch-list-contract-schema";
import { DESKTOP_BRANCH_LIST_QUERY_CAPABILITY } from "@repo/api/src/types/branch-list-query-capabilities";
import { lowerBranchListQueryExpression } from "@repo/api/src/types/branch-list-query-lowering";
import {
  BRANCH_LIST_FIELD_BY_LEGACY_PARAM,
  BRANCH_LIST_QUERY_VOCABULARY,
  BRANCH_LIST_SET_PARAMS,
} from "@repo/api/src/types/branch-list-query-registry";
import {
  LIST_QUERY_EXPRESSION_PARAM,
  type ListQueryRefused,
} from "@repo/api/src/types/list-query-expression";
import { parseListQueryExpressionValue } from "@repo/api/src/types/list-query-expression-schema";
import { isListQueryAxisParam } from "@repo/api/src/types/list-query-legacy-params";
import {
  type ListQueryLoweringTarget,
  malformed,
} from "@repo/api/src/types/list-query-lowering";
import { z } from "zod";

/**
 * A `listQuery` this host refused, carrying the ISS-9476 refusal. The message
 * spells the code the way the cloud route's refusal issue does, because only
 * the message survives the IPC bridge.
 */
export class BranchListQueryRefusedError extends Error {
  readonly refused: ListQueryRefused;

  constructor(refused: ListQueryRefused) {
    super(`list query refused (${refused.code})`);
    this.name = "BranchListQueryRefusedError";
    this.refused = refused;
  }
}

/**
 * `value` with its `listQuery` lowered into the legacy params, or `value`
 * untouched when it carries none, which is every request a renderer that
 * predates PRD-721's Branches compiler sends. Throws
 * {@link BranchListQueryRefusedError} for an expression this host cannot
 * serve: dropping it would answer with every row.
 */
export function compileBranchListQueryRequest(value: unknown): unknown {
  const request = requestRecordSchema.safeParse(value);
  if (
    !request.success ||
    request.data[LIST_QUERY_EXPRESSION_PARAM] === undefined
  ) {
    return value;
  }
  const { [LIST_QUERY_EXPRESSION_PARAM]: listQuery, ...rest } = request.data;
  const mixed = Object.keys(rest).find(
    (name) =>
      rest[name] !== undefined &&
      isListQueryAxisParam(name, BRANCH_LIST_QUERY_VOCABULARY)
  );
  if (mixed !== undefined) {
    const field = BRANCH_LIST_FIELD_BY_LEGACY_PARAM.get(mixed);
    throw new BranchListQueryRefusedError(
      malformed(field === undefined ? {} : { field })
    );
  }
  const parsed = parseListQueryExpressionValue(listQuery);
  if (!parsed.ok) {
    throw new BranchListQueryRefusedError(parsed.refused);
  }
  const lowered = lowerBranchListQueryExpression(
    parsed.expression,
    DESKTOP_BRANCH_LIST_QUERY_CAPABILITY,
    rest.pageMode === BranchListPageMode.Server
      ? SERVER_PAGE_TARGET
      : LEGACY_READ_TARGET
  );
  if (!lowered.ok) {
    throw new BranchListQueryRefusedError(lowered.refused);
  }
  return { ...rest, ...lowered.params };
}

const requestRecordSchema = z.record(z.string(), z.unknown());

/** A server page: the strict schema the IPC boundary validates it with. */
const SERVER_PAGE_TARGET: ListQueryLoweringTarget = {
  acceptedParams: new Set(Object.keys(branchServerPageQueryShape)),
  repeatableParams: BRANCH_LIST_SET_PARAMS,
};

/**
 * A request without `pageMode=server` reaches the complete-corpus reads, which
 * read the date window (`shared-branches-window.ts`) and the LOC range
 * (`filterCanonicalDesktopCohort`) and none of the server page's facets: the
 * params the cloud also accepts outside server mode.
 */
const LEGACY_READ_TARGET: ListQueryLoweringTarget = {
  acceptedParams: new Set(["startDate", "endDate", "locMin", "locMax"]),
  repeatableParams: BRANCH_LIST_SET_PARAMS,
};
