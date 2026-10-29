import { TABLE_PAGE_SIZE_MAX } from "./table-page-size-limits.ts";

/**
 * ISS-8528: ceiling on the `offset` accepted by `GET /agent-sessions`.
 *
 * Sessions was the one list surface in the repo that never got this bound, so a
 * deep offset reached Prisma as a raw `skip` on the default `findDbPaginatedPage`
 * path — a scan Postgres walks and discards in full, on a read that carries no
 * transaction timeout. Level with the siblings that already reject there:
 * `TAG_LIST_MAX_OFFSET` and `BRANCH_TRACE_MAX_OFFSET`.
 *
 * Shared rather than owned by `apps/api` because the value is published in three
 * places that must agree: the route validator, the hand-written OpenAPI spec
 * (`apps/web/content/docs/api-reference/openapi.json`), and the MCP
 * `list-agent-sessions` tool. A spec or tool advertising a wider bound than the
 * route enforces compiles a client that 400s at runtime. Its own lightweight
 * module so `apps/mcp` can import the value without pulling in the whole
 * `agent-session` type surface.
 */
export const SESSION_LIST_MAX_OFFSET = 10_000;

/**
 * ISS-9073: ceiling on the DISTINCT values one repeatable `GET /agent-sessions`
 * facet accepts (`userIds`, `repositories`, `models`, ...). Each value is one
 * bind parameter in the facet's `IN` list, and the open-valued facets cannot be
 * bounded by de-duplication alone the way an enum facet can. Level with
 * `BRANCH_LIST_MAX_FILTER_VALUES`, which Branches already applies to the same
 * facet UI.
 *
 * Published in two places that must agree: the route validator and the
 * hand-written OpenAPI spec (`maxItems`). The MCP session tools expose none of
 * the multi-select facets, so there is no third.
 */
export const SESSION_LIST_MAX_FILTER_VALUES = 100;

/**
 * ISS-9692: ceiling on the `limit` accepted by `GET /agent-sessions`.
 *
 * DERIVED from {@link TABLE_PAGE_SIZE_MAX} — the largest rung any list surface
 * offers — rather than written out, which is the whole point of the ticket. It
 * was a bare `100` in two hand-maintained places (`apps/api`'s validator, which
 * rejects with a 400 before the service runs, and the service's own clamp), so
 * adding a rung to the shared ladder offered Sessions users a size the API
 * refused outright.
 *
 * Why 100 was safe to leave behind: it dates to the surface's founding commit
 * (PRD-365, #1226) and was never a measured ceiling. The read costs a fixed
 * ~6 batched queries per page regardless of page size — the page read plus
 * grouped source-artifact, transcript-disposition, reconciled-cost, comment-count
 * and custom-field reads — so there is no fan-out or N+1 that a larger page
 * multiplies. The in-memory paths (cost-reconciled and display-value sorts)
 * retain `offset + limit` rows while walking the population in
 * `SESSION_CANDIDATE_CHUNK_SIZE` (5,000) chunks, so at the worst case this API
 * admits — `SESSION_LIST_MAX_OFFSET` — residency goes from 10,100 rows to
 * 10,500, a 4% move on a bound already dominated by the offset ceiling.
 *
 * Published in two other places that must not advertise a WIDER bound than this
 * one: the hand-written OpenAPI spec
 * (`apps/web/content/docs/api-reference/openapi.json`) and the MCP
 * `list-agent-sessions` tool. The MCP tool stays on its own narrower
 * `MAX_PAGE_LIMIT`, which is safe — a client that asks for less is never
 * rejected.
 */
export const SESSION_LIST_MAX_LIMIT = TABLE_PAGE_SIZE_MAX;
