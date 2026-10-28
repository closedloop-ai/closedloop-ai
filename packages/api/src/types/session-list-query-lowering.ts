// ISS-9477 (PRD-706 R10-S02), shared with the desktop by ISS-9479 (R10-S04):
// the Sessions compiler for the canonical list query expression (ISS-9476,
// PRD-721). It does not build a predicate. It LOWERS a resolved expression to
// the host's legacy Sessions params, so the expression and the legacy params
// reach the host's one predicate set through the one request boundary (ISS-9477
// ruling: routing, not a rewrite). Both hosts lower through this function with
// their own capability declaration, so a clause cannot mean one thing on the
// cloud and another on the desktop. The clause rules are list-agnostic and live
// in `list-query-lowering.ts`, which the Branches compiler shares.
//
// `.ts` extensions: see "Relative Imports in Emitted Helpers" in
// `packages/api/AGENTS.md`.
import {
  formatSessionSortRule,
  SESSION_SORT_RULES_QUERY_PARAM,
} from "./agent-session-sort.ts";
import type { ListQueryCapability } from "./list-query-capability.ts";
import type {
  ListFilterScalar,
  ListQueryExpression,
  ListQueryRefused,
  ListSortRule,
} from "./list-query-expression.ts";
import {
  type ListQueryLoweredValues,
  type ListQueryLoweringList,
  type ListQueryLoweringTarget,
  lowerListQueryExpression,
  unsupportedField,
} from "./list-query-lowering.ts";
import { anchorListQueryWindowBound } from "./list-query-ordering-semantics.ts";
import {
  SESSION_LIST_QUERY_FIELDS,
  type SessionListLegacyFilterParam,
} from "./session-list-query-registry.ts";

/**
 * The legacy params an expression lowers to, as raw request values: the shape
 * the host's request boundary already validates, so a lowered value meets the
 * exact element rules a legacy request meets.
 */
export type SessionListLoweredParams = Partial<
  Record<
    SessionListLegacyFilterParam | typeof SESSION_SORT_RULES_QUERY_PARAM,
    string | string[]
  >
>;

export type SessionListLoweringResult =
  | { ok: true; params: SessionListLoweredParams }
  | { ok: false; refused: ListQueryRefused };

/**
 * What the schema receiving the lowered params can take. A lowered param the
 * schema does not accept (`sorts` on a read with no sort) is refused with the
 * field that asked for it, rather than handed on to a strict schema that would
 * 400 with no refusal code.
 */
export type SessionListLoweringTarget = ListQueryLoweringTarget;

/**
 * Resolve `expression` against one host's Sessions capability, then lower it.
 * Every refusal carries an ISS-9476 `ListQueryRefusal` code.
 */
export function lowerSessionListQueryExpression(
  expression: ListQueryExpression,
  capability: ListQueryCapability,
  target: SessionListLoweringTarget
): SessionListLoweringResult {
  const lowered = lowerListQueryExpression(
    expression,
    capability,
    target,
    SESSION_LOWERING
  );
  return lowered.ok
    ? { ok: true, params: toSessionParams(lowered.params) }
    : lowered;
}

/**
 * Every Sessions param is a string or a list of strings on the wire, so a
 * bound is written as text, anchored first (ISS-9585): a bound decides
 * population, so an offsetless one names a UTC instant on every host rather
 * than each host's own clock.
 */
function writeSessionBound(bound: ListFilterScalar): string {
  return String(anchorListQueryWindowBound(bound));
}

function writeSessionSorts(
  sorts: readonly ListSortRule[],
  target: ListQueryLoweringTarget,
  params: ListQueryLoweredValues
): ListQueryRefused | null {
  const [first] = sorts;
  if (!first) {
    return null;
  }
  if (
    !(
      target.acceptedParams.has(SESSION_SORT_RULES_QUERY_PARAM) &&
      target.repeatableParams.has(SESSION_SORT_RULES_QUERY_PARAM)
    )
  ) {
    return unsupportedField(first.field);
  }
  // Sort field ids ARE each host's sort column spellings (cloud:
  // `list-query-session-registry.test.ts`; desktop:
  // `session-list-query-capability-conformance.test.ts`), and the resolver has
  // already refused any field this host cannot sort by.
  params[SESSION_SORT_RULES_QUERY_PARAM] = sorts.map((rule) =>
    formatSessionSortRule(rule.field, rule.direction)
  );
  return null;
}

const SESSION_LOWERING: ListQueryLoweringList<SessionListLegacyFilterParam> = {
  fields: SESSION_LIST_QUERY_FIELDS,
  writeBound: writeSessionBound,
  writeSorts: writeSessionSorts,
};

/**
 * Every value the Sessions lowering writes is text: set values are
 * stringified, bounds go through {@link writeSessionBound}, and sorts are
 * formatted rules. Narrowed here rather than cast.
 */
function toSessionParams(
  params: ListQueryLoweredValues
): SessionListLoweredParams {
  const sessionParams: Record<string, string | string[]> = {};
  for (const [param, value] of Object.entries(params)) {
    sessionParams[param] = Array.isArray(value) ? value : String(value);
  }
  return sessionParams;
}
