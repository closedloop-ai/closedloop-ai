// PRD-721: for a mock that stands in for a list route (the story and test
// fixture transport, e2e route handlers) and reads the legacy filter and sort
// params off the request. The grids send `listQuery`, so such a mock reads
// the params the request MEANS: its expression lowered the way the route
// lowers it, beside the params that travelled with it. A request without
// `listQuery` is read as it arrived.
//
// `.ts` extensions: see "Relative Imports in Emitted Helpers" in
// `packages/api/AGENTS.md`.
import {
  parseSessionSortRule,
  SESSION_SORT_RULES_QUERY_PARAM,
} from "./agent-session-sort.ts";
import { CLOUD_BRANCH_LIST_QUERY_CAPABILITY } from "./branch-list-query-capabilities.ts";
import {
  BRANCH_LIST_SORT_DIR_PARAM,
  BRANCH_LIST_SORT_KEY_PARAM,
  lowerBranchListQueryExpression,
} from "./branch-list-query-lowering.ts";
import {
  BRANCH_LIST_FIELD_BY_LEGACY_PARAM,
  BRANCH_LIST_SET_PARAMS,
} from "./branch-list-query-registry.ts";
import {
  SESSION_SORT_BY_PARAM,
  SESSION_SORT_DIR_PARAM,
} from "./list-query-client-requests.ts";
import {
  LIST_QUERY_EXPRESSION_PARAM,
  type ListFilterScalar,
  type ListQueryExpression,
  type ListQueryRefused,
} from "./list-query-expression.ts";
import { parseListQueryExpression } from "./list-query-expression-schema.ts";
import { SessionListField } from "./list-query-fields.ts";
import type { ListQueryLoweringTarget } from "./list-query-lowering.ts";
import { CLOUD_SESSION_LIST_QUERY_CAPABILITY } from "./session-list-query-capabilities.ts";
import { lowerSessionListQueryExpression } from "./session-list-query-lowering.ts";
import {
  SESSION_LIST_FIELD_BY_LEGACY_PARAM,
  SESSION_LIST_QUERY_FIELDS,
} from "./session-list-query-registry.ts";

type LoweredValues = Readonly<
  Record<string, ListFilterScalar | string[] | undefined>
>;

type Lower = (
  expression: ListQueryExpression
) =>
  | { ok: true; params: LoweredValues }
  | { ok: false; refused: ListQueryRefused };

/**
 * The legacy params a recorded `GET /agent-sessions` request means. The lead
 * sort rule is echoed as `sortBy` / `sortDir` beside `sorts`, as the legacy
 * grid sent it (`AgentSessionQueryFilters.sorts`).
 */
export function sessionListRequestParams(
  searchParams: URLSearchParams
): URLSearchParams {
  const params = lowerRequestParams(searchParams, (expression) =>
    lowerSessionListQueryExpression(
      expression,
      CLOUD_SESSION_LIST_QUERY_CAPABILITY,
      SESSION_LIST_ROUTE_TARGET
    )
  );
  const lead = parseSessionSortRule(
    params.get(SESSION_SORT_RULES_QUERY_PARAM) ?? ""
  );
  if (params !== searchParams && lead && !params.has(SESSION_SORT_BY_PARAM)) {
    params.set(SESSION_SORT_BY_PARAM, lead.column);
    params.set(SESSION_SORT_DIR_PARAM, lead.dir);
  }
  return params;
}

/** `url` with the legacy params its `GET /agent-sessions` request means. */
export function sessionListRequestUrl(url: URL): URL {
  return withSearchParams(url, sessionListRequestParams(url.searchParams));
}

/** The legacy params a recorded `GET /branches` request means. */
export function branchListRequestParams(
  searchParams: URLSearchParams
): URLSearchParams {
  return lowerRequestParams(searchParams, (expression) =>
    lowerBranchListQueryExpression(
      expression,
      CLOUD_BRANCH_LIST_QUERY_CAPABILITY,
      BRANCH_LIST_ROUTE_TARGET
    )
  );
}

/** `url` with the legacy params its `GET /branches` request means. */
export function branchListRequestUrl(url: URL): URL {
  return withSearchParams(url, branchListRequestParams(url.searchParams));
}

function lowerRequestParams(
  searchParams: URLSearchParams,
  lower: Lower
): URLSearchParams {
  const raw = searchParams.get(LIST_QUERY_EXPRESSION_PARAM);
  if (raw === null) {
    return searchParams;
  }
  const parsed = parseListQueryExpression(raw);
  if (!parsed.ok) {
    throw new Error(`listQuery did not parse: ${parsed.refused.code}`);
  }
  const lowered = lower(parsed.expression);
  if (!lowered.ok) {
    throw new Error(`listQuery was refused: ${lowered.refused.code}`);
  }
  const params = new URLSearchParams(searchParams);
  params.delete(LIST_QUERY_EXPRESSION_PARAM);
  for (const [name, value] of Object.entries(lowered.params)) {
    for (const entry of [value ?? []].flat()) {
      params.append(name, String(entry));
    }
  }
  return params;
}

function withSearchParams(url: URL, searchParams: URLSearchParams): URL {
  const next = new URL(url);
  next.search = searchParams.toString();
  return next;
}

const SESSION_QUALITY_PARAM =
  SESSION_LIST_QUERY_FIELDS[SessionListField.Quality].anyOf?.param;
const SESSION_LIST_PARAMS = [
  ...SESSION_LIST_FIELD_BY_LEGACY_PARAM.keys(),
  SESSION_SORT_RULES_QUERY_PARAM,
];

/** Every list param a Sessions field or sort lowers to; quality is scalar. */
const SESSION_LIST_ROUTE_TARGET: ListQueryLoweringTarget = {
  acceptedParams: new Set(SESSION_LIST_PARAMS),
  repeatableParams: new Set(
    SESSION_LIST_PARAMS.filter((name) => name !== SESSION_QUALITY_PARAM)
  ),
};

/** Every server-page param a Branches field or sort lowers to. */
const BRANCH_LIST_ROUTE_TARGET: ListQueryLoweringTarget = {
  acceptedParams: new Set([
    ...BRANCH_LIST_FIELD_BY_LEGACY_PARAM.keys(),
    BRANCH_LIST_SORT_KEY_PARAM,
    BRANCH_LIST_SORT_DIR_PARAM,
  ]),
  repeatableParams: BRANCH_LIST_SET_PARAMS,
};

/**
 * `url` with the legacy params its list request means, the list picked by the
 * route path (`/agent-sessions` or `/branches`). Any other URL, and a list
 * request without `listQuery`, is returned unchanged.
 */
export function listRequestUrl(url: URL): URL {
  if (url.pathname.endsWith(SESSION_LIST_PATH)) {
    return sessionListRequestUrl(url);
  }
  if (url.pathname.endsWith(BRANCH_LIST_PATH)) {
    return branchListRequestUrl(url);
  }
  return url;
}

const SESSION_LIST_PATH = "/agent-sessions";
const BRANCH_LIST_PATH = "/branches";
