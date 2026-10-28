// PRD-721 / ISS-9346: the Sessions and Branches bindings of the one client
// builder (`buildListQueryFromLegacyParams`), which every product grid calls to
// send `listQuery` instead of the legacy filter and sort params. Each binding
// reads its list's legacy sort params into sort rules and names the receiving
// host's capability; the builder does the rest.
//
// `.ts` extensions: see "Relative Imports in Emitted Helpers" in
// `packages/api/AGENTS.md`.
import {
  parseSessionSortRule,
  SESSION_SORT_RULES_QUERY_PARAM,
} from "./agent-session-sort.ts";
import {
  CLOUD_BRANCH_LIST_QUERY_CAPABILITY,
  DESKTOP_BRANCH_LIST_QUERY_CAPABILITY,
} from "./branch-list-query-capabilities.ts";
import {
  BRANCH_LIST_SORT_DIR_PARAM,
  BRANCH_LIST_SORT_KEY_PARAM,
} from "./branch-list-query-lowering.ts";
import { BRANCH_LIST_QUERY_VOCABULARY } from "./branch-list-query-registry.ts";
import {
  type ListQueryExpression,
  ListSortDirection,
  type ListSortRule,
} from "./list-query-expression.ts";
import {
  buildListQueryStructuredRequest,
  buildListQueryUrlParams,
} from "./list-query-legacy-params.ts";
import {
  CLOUD_SESSION_LIST_QUERY_CAPABILITY,
  DESKTOP_SESSION_LIST_QUERY_CAPABILITY,
} from "./session-list-query-capabilities.ts";
import { SESSION_LIST_QUERY_VOCABULARY } from "./session-list-query-registry.ts";

/** The scalar Sessions sort pair's params, the one-rule echo of `sorts`. */
export const SESSION_SORT_BY_PARAM = "sortBy";
export const SESSION_SORT_DIR_PARAM = "sortDir";

type LegacyParams = Readonly<Record<string, unknown>>;

/**
 * `GET /agent-sessions` params with `listQuery` in place of the legacy filter
 * and sort params, or `null` to send the legacy params unchanged.
 */
export function buildSessionListQueryUrlParams(
  params: LegacyParams
): Record<string, unknown> | null {
  return buildListQueryUrlParams(
    SESSION_LIST_QUERY_VOCABULARY,
    CLOUD_SESSION_LIST_QUERY_CAPABILITY,
    { params, sorts: sessionListQuerySorts(params) }
  );
}

/** The desktop Sessions IPC request with `listQuery`, or `null`. */
export function buildSessionListQueryIpcRequest<TRequest extends LegacyParams>(
  request: TRequest
): (Partial<TRequest> & { listQuery: ListQueryExpression }) | null {
  return buildListQueryStructuredRequest(
    SESSION_LIST_QUERY_VOCABULARY,
    DESKTOP_SESSION_LIST_QUERY_CAPABILITY,
    request,
    sessionListQuerySorts(request)
  );
}

/**
 * `GET /branches` params with `listQuery` in place of the legacy filter and
 * sort params, or `null` to send the legacy params unchanged.
 */
export function buildBranchListQueryUrlParams(
  params: LegacyParams
): Record<string, unknown> | null {
  return buildListQueryUrlParams(
    BRANCH_LIST_QUERY_VOCABULARY,
    CLOUD_BRANCH_LIST_QUERY_CAPABILITY,
    { params, sorts: branchListQuerySorts(params) }
  );
}

/** The desktop Branches IPC request with `listQuery`, or `null`. */
export function buildBranchListQueryIpcRequest<TRequest extends LegacyParams>(
  request: TRequest
): (Partial<TRequest> & { listQuery: ListQueryExpression }) | null {
  return buildListQueryStructuredRequest(
    BRANCH_LIST_QUERY_VOCABULARY,
    DESKTOP_BRANCH_LIST_QUERY_CAPABILITY,
    request,
    branchListQuerySorts(request)
  );
}

/**
 * The Sessions sort as rules, read the way `resolveSessionSortRules` reads it
 * (`apps/api/app/agent-sessions/service/session-sort-rules.ts`): a non-empty
 * `sorts` list wins, else `sortBy` with `sortDir` defaulting to `desc`. `null`
 * when an entry is not a readable rule.
 */
function sessionListQuerySorts(params: LegacyParams): ListSortRule[] | null {
  const rules = params[SESSION_SORT_RULES_QUERY_PARAM];
  if (Array.isArray(rules) && rules.length > 0) {
    const parsed: ListSortRule[] = [];
    for (const raw of rules) {
      const rule = typeof raw === "string" ? parseSessionSortRule(raw) : null;
      const direction = rule ? listSortDirectionOf(rule.dir) : null;
      if (!(rule && direction)) {
        return null;
      }
      parsed.push({ field: rule.column, direction });
    }
    return parsed;
  }
  const sortBy = params[SESSION_SORT_BY_PARAM];
  if (sortBy === undefined) {
    return [];
  }
  const direction = listSortDirectionOf(
    params[SESSION_SORT_DIR_PARAM] ?? ListSortDirection.Desc
  );
  return typeof sortBy === "string" && direction
    ? [{ field: sortBy, direction }]
    : null;
}

/**
 * The Branches server page's one `sortKey` / `sortDir` pair as a rule. `null`
 * when only one half is present: the host's default for the missing half is
 * not something an expression states.
 */
function branchListQuerySorts(params: LegacyParams): ListSortRule[] | null {
  const sortKey = params[BRANCH_LIST_SORT_KEY_PARAM];
  const sortDir = params[BRANCH_LIST_SORT_DIR_PARAM];
  if (sortKey === undefined && sortDir === undefined) {
    return [];
  }
  const direction = listSortDirectionOf(sortDir);
  return typeof sortKey === "string" && direction
    ? [{ field: sortKey, direction }]
    : null;
}

function listSortDirectionOf(value: unknown): ListSortDirection | null {
  if (value === ListSortDirection.Asc) {
    return ListSortDirection.Asc;
  }
  return value === ListSortDirection.Desc ? ListSortDirection.Desc : null;
}
