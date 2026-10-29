// ISS-9477 / PRD-721: the `listQuery` param at a list read boundary. Runs as
// the first preprocess step of a list's read schema, so the lowered legacy
// params meet the same strict element schemas and the same refinements a
// legacy request does. List-agnostic: Sessions (`app/agent-sessions/`) and
// Branches (`app/branches/`) each bind it to their own registry, capability and
// compiler.

import type { JsonObject } from "@repo/api/src/types/common";
import {
  LIST_QUERY_EXPRESSION_PARAM,
  type ListQueryExpression,
  ListQueryRefusal,
  type ListQueryRefused,
} from "@repo/api/src/types/list-query-expression";
import { parseListQueryExpression } from "@repo/api/src/types/list-query-expression-schema";
import {
  type ListQueryLoweringResult,
  type ListQueryLoweringTarget,
  malformed,
} from "@repo/api/src/types/list-query-lowering";
import { z } from "zod";
import { recordRequestListQueryRefusal } from "@/lib/observability/request-span-attribution";
import { isRecord } from "@/lib/type-guards";

/** The zod issue `params` key a refusal travels under to the route. */
const REFUSAL_ISSUE_PARAM = "listQueryRefused";

/** One list's half of the boundary. */
export type ListQueryBoundaryList = {
  /** The field a legacy param is an axis of, for the Malformed refusal. */
  fieldByLegacyParam: ReadonlyMap<string, string>;
  /** Whether a param sent beside `listQuery` is refused rather than merged. */
  isMixedParam: (name: string) => boolean;
  /** The lowering target for this request (the rest of its params). */
  targetFor: (
    rest: Readonly<Record<string, unknown>>
  ) => ListQueryLoweringTarget;
  /** Resolve and lower a parsed expression against the cloud capability. */
  lower: (
    expression: ListQueryExpression,
    target: ListQueryLoweringTarget
  ) => ListQueryLoweringResult<Readonly<Record<string, unknown>>>;
};

/**
 * The preprocess step for one list read schema. A request without `listQuery`
 * passes through untouched; one with it is replaced by the legacy params it
 * lowers to, or fails with a single refusal issue. Zod's pipe aborts on that
 * issue, so no later step reads a half-lowered request.
 */
export function createListQueryBoundaryPreprocess(
  list: ListQueryBoundaryList
): (value: unknown, ctx: z.RefinementCtx) => unknown {
  return (value, ctx) => {
    if (!isRecord(value) || value[LIST_QUERY_EXPRESSION_PARAM] === undefined) {
      return value;
    }
    const { [LIST_QUERY_EXPRESSION_PARAM]: raw, ...rest } = value;
    const lowered = lowerRequest(raw, rest, list);
    if (!lowered.ok) {
      addRefusalIssue(ctx, lowered.refused);
      return value;
    }
    return { ...rest, ...lowered.params };
  };
}

/**
 * The `ApiResult` `code` / `details` for a failed parse whose failure is a
 * list query refusal, or `undefined` for any other failure, which keeps its
 * existing zod-message-only 400.
 */
export function listQueryRefusalMetadata(
  issues: readonly z.core.$ZodIssue[]
): { code: string; details: JsonObject } | undefined {
  for (const issue of issues) {
    if (issue.code !== "custom") {
      continue;
    }
    const refused = refusalIssueParamsSchema.safeParse(issue.params);
    if (refused.success) {
      const refusal = refused.data[REFUSAL_ISSUE_PARAM];
      recordRequestListQueryRefusal(refusal.code);
      return refusal;
    }
  }
  return undefined;
}

function lowerRequest(
  raw: unknown,
  rest: Record<string, unknown>,
  list: ListQueryBoundaryList
): ListQueryLoweringResult<Readonly<Record<string, unknown>>> {
  const mixed = Object.keys(rest).find(list.isMixedParam);
  if (mixed !== undefined) {
    const field = list.fieldByLegacyParam.get(mixed);
    return {
      ok: false,
      refused: malformed(field === undefined ? {} : { field }),
    };
  }
  // A repeated `listQuery` arrives as an array: there is no one expression to read.
  if (typeof raw !== "string") {
    return { ok: false, refused: malformed({}) };
  }
  const parsed = parseListQueryExpression(raw);
  if (!parsed.ok) {
    return parsed;
  }
  return list.lower(parsed.expression, list.targetFor(rest));
}

function addRefusalIssue(
  ctx: z.RefinementCtx,
  refused: ListQueryRefused
): void {
  ctx.addIssue({
    code: "custom",
    message: `list query refused (${refused.code})`,
    path: [LIST_QUERY_EXPRESSION_PARAM],
    params: { [REFUSAL_ISSUE_PARAM]: refused },
  });
}

const refusalIssueParamsSchema = z.object({
  [REFUSAL_ISSUE_PARAM]: z.object({
    code: z.enum(Object.values(ListQueryRefusal)),
    details: z.object({
      field: z.string().optional(),
      operator: z.string().optional(),
    }),
  }),
});
