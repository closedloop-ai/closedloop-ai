// ISS-9477: the `listQuery` param at the Sessions read boundary. Runs as the
// first preprocess step of every Sessions read schema, so the lowered legacy
// params meet the same strict element schemas and the same superRefine rules
// (`refineTeamScopeQuery`, `refineStatusCountsQuery`) a legacy request does.
// The list-agnostic boundary is `@/lib/list-query-param`, which Branches
// shares.

import { CLOUD_SESSION_LIST_QUERY_CAPABILITY } from "@repo/api/src/types/session-list-query-capabilities";
import {
  lowerSessionListQueryExpression,
  type SessionListLoweringTarget,
} from "@repo/api/src/types/session-list-query-lowering";
import {
  SESSION_LIST_FIELD_BY_LEGACY_PARAM,
  SESSION_LIST_QUERY_COMPANION_PARAMS,
} from "@repo/api/src/types/session-list-query-registry";
import type { z } from "zod";
import {
  createListQueryBoundaryPreprocess,
  listQueryRefusalMetadata as listQueryBoundaryRefusalMetadata,
} from "@/lib/list-query-param";

export type ListQueryRequestTarget = SessionListLoweringTarget & {
  /** Every Sessions list param name, for the mixing rule. */
  listParamNames: ReadonlySet<string>;
};

/**
 * The preprocess step for one Sessions read schema. A request without
 * `listQuery` passes through untouched; one with it is replaced by the legacy
 * params it lowers to, or fails with a single refusal issue.
 */
export function createListQueryPreprocess(
  target: ListQueryRequestTarget
): (value: unknown, ctx: z.RefinementCtx) => unknown {
  return createListQueryBoundaryPreprocess({
    fieldByLegacyParam: SESSION_LIST_FIELD_BY_LEGACY_PARAM,
    isMixedParam: (name) =>
      target.listParamNames.has(name) &&
      !SESSION_LIST_QUERY_COMPANION_PARAMS.has(name),
    targetFor: () => target,
    lower: (expression, loweringTarget) =>
      lowerSessionListQueryExpression(
        expression,
        CLOUD_SESSION_LIST_QUERY_CAPABILITY,
        loweringTarget
      ),
  });
}

/**
 * The `ApiResult` `code` / `details` for a failed Sessions parse whose failure
 * is a list query refusal. The Sessions routes import it from here.
 */
export const listQueryRefusalMetadata = listQueryBoundaryRefusalMetadata;
