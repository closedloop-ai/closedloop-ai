/**
 * ISS-9555: the desktop LOCAL producer's half of the Sessions page echo.
 *
 * Lives beside `shared-agent-sessions-api.ts` rather than inside it for two
 * reasons: that file is over the line ceiling and shrink-only, and the shape of
 * the echo is worth stating once for both of that file's list returns.
 *
 * Desktop CLOUD mode needs none of this — it and the web app share one data
 * source against one `apps/api` route, so the echo the route mints reaches both.
 * Only the local SQLite read has a second producer to teach.
 */

import {
  AgentSessionListCapability,
  type AgentSessionListPageInfo,
} from "@repo/api/src/types/agent-session-list-contract";
import type { SanitizedQuery } from "./shared-agent-sessions-query.js";

type PagedQuery = Pick<SanitizedQuery, "limit" | "offset">;

/**
 * What the local read served, for the response's `pageInfo`.
 *
 * The read is issued at `query.offset` and nothing moves it: an offset past the
 * population answers empty AT that offset, exactly as the cloud route does, so
 * the position echoed here is always the position the rows were taken from.
 * `sanitizeQuery` has already floored a negative, fractional, or non-numeric
 * offset to a value this producer can act on, so no impossible number reaches
 * the wire.
 */
export function sessionListPageEcho(
  query: PagedQuery
): AgentSessionListPageInfo {
  return {
    capability: AgentSessionListCapability.ServerPaginationV1,
    limit: query.limit,
    offset: query.offset,
  };
}
