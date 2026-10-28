/**
 * @file session-web-search-cost.ts
 * @description ISS-7821: the SESSION-level web-search line item, read from a
 * session's persisted `metadata` blob.
 *
 * Web search is billed per REQUEST (a server-side tool), never per token, so it
 * never lives in a `token_usage` / `tokenUsageByModel` row and a token sum can
 * never contain it. It has to be added once, at the session level, from the
 * count the collector persisted — and every derivation of a session's total cost
 * has to add it, or that derivation is systematically low by exactly this
 * amount for every session that used web search.
 *
 * Two derivations already do: the desktop's `sessions.cost_usd_estimated` and
 * `session_analytics.est_cost`, both through the `webSearchCostSql` fragment.
 * The cloud's `SessionDetail.estimatedCost` is a THIRD, independent derivation
 * that summed only the per-model token rows, so for any session with
 * `web_search_requests > 0` it reported a lower dollar figure than the desktop
 * did for the same session — measured at $0.03 on a $0.04753625 session, about
 * 63% of the total. This module is the JS half of that one line item, so the
 * cloud can add it from the SAME persisted field at the same price.
 */
import { WEB_SEARCH_COST_PER_REQUEST_USD } from "./harness-cost-parity";

/**
 * Where the collector persists the count, as object keys. Exported so the SQL
 * fragment and this reader name ONE path: they cannot share an implementation
 * (one is SQLite `json_extract`, one is a JS lookup), so the path is the part
 * that can be shared, and it is the part that silently returns "no web search"
 * for every session in the fleet if the two ever disagree.
 *
 * `web_search_requests` is snake_case because it is the collector's persisted
 * wire spelling, not a TypeScript identifier.
 */
export const SESSION_WEB_SEARCH_REQUESTS_METADATA_PATH = [
  "usageExtras",
  "web_search_requests",
] as const;

/** The same path in SQLite `json_extract` form. */
export const SESSION_WEB_SEARCH_REQUESTS_JSON_PATH = `$.${SESSION_WEB_SEARCH_REQUESTS_METADATA_PATH.join(".")}`;

/**
 * The largest dollar figure the cloud's `SessionDetail.estimatedCost`
 * (`@db.Decimal(14, 6)`) can hold: 8 integer digits, 6 fractional.
 *
 * Read off the column, not chosen — a limit invented here would be a product
 * decision about how much web search a session may bill for, which this module
 * has no standing to make. What it does have standing to say is that a figure
 * the destination cannot store is not a figure.
 */
export const MAX_SESSION_ESTIMATED_COST_USD = 99_999_999.999_999;

/**
 * The largest request count whose line item still fits that column (ISS-7821
 * review: whitlockk). Above it the count cannot be a real measurement AND the write
 * would fail: `10_000_000_000` requests prices to $100,000,000, one digit past
 * `Decimal(14, 6)`, so the whole session upsert throws and the slice never
 * lands. Corrupt metadata must degrade to "no line item", never to a failed
 * ingest of everything else in the payload.
 */
export const MAX_SESSION_WEB_SEARCH_REQUESTS = Math.floor(
  MAX_SESSION_ESTIMATED_COST_USD / WEB_SEARCH_COST_PER_REQUEST_USD
);

/**
 * SQLite's `CAST(<text> AS INTEGER)`: the longest LEADING prefix that parses as
 * an integer, with leading whitespace skipped and any remainder ignored.
 */
const SQLITE_INTEGER_TEXT_PREFIX = /^\s*[+-]?\d+/;

/**
 * The persisted request count, or 0.
 *
 * Deliberately CLAMPING rather than refusing, which is the opposite of how
 * `computeHarnessCost` treats a corrupt `webSearchRequests` (ISS-4730 refuses it
 * as `invalid_count` with a null cost). The difference is what each is for.
 * There, the count is an INPUT a caller supplied for a row being priced, and a
 * garbage input must not buy a confident price. Here, the job is to reproduce a
 * stored session-level line item that another writer has ALREADY computed from
 * this same field — so matching that writer bit for bit is the whole contract,
 * including on garbage. `MAX(0, CAST(COALESCE(…, 0) AS INTEGER))` is what the
 * SQL does; a JS reader that refused where the SQL clamped would reintroduce the
 * very disagreement this module exists to remove.
 *
 * ONE departure from that, deliberately: a count past
 * {@link MAX_SESSION_WEB_SEARCH_REQUESTS} yields 0 where the SQL would keep
 * clamping. The SQL twin writes a SQLite REAL and survives an absurd count; this
 * reader's value lands in `Decimal(14, 6)`, which does not, and a throw here
 * fails the ingest of the whole payload rather than of the one bad field. So the
 * two surfaces can disagree on a session whose count is already impossible —
 * chosen over the alternative, which is that the session does not sync at all.
 *
 * ISS-7821 review (whitlockk): matching it therefore means implementing SQLite's
 * coercion, not JavaScript's. A bare `Number()` is a DIFFERENT function on the
 * shapes a version-skewed or corrupt blob actually arrives as, and it is wrong
 * in the expensive direction — `"2e3"` is 2000 to `Number` and 2 to `CAST`, and
 * the array `[3]` is 3 to `Number` (single-element arrays coerce through their
 * one member) while `json_extract` hands `CAST` the text `'[3]'`, which is 0. So
 * the JS twin billed 1000x and 3x on inputs the SQL twin billed once and not at
 * all. The rules below are SQLite's, so the two agree on the corrupt cases the
 * way they already agreed on the clean ones.
 */
export function sessionWebSearchRequests(metadata: unknown): number {
  let cursor: unknown = metadata;
  for (const key of SESSION_WEB_SEARCH_REQUESTS_METADATA_PATH) {
    if (
      typeof cursor !== "object" ||
      cursor === null ||
      Array.isArray(cursor)
    ) {
      return 0;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  const count = sqliteIntegerCast(cursor);
  // A count too large to price is corrupt, not enormous. Yielding 0 keeps it a
  // missing line item rather than a rejected payload.
  if (count > MAX_SESSION_WEB_SEARCH_REQUESTS) {
    return 0;
  }
  return count;
}

/**
 * `CAST(COALESCE(json_extract(…), 0) AS INTEGER)` over the value `json_extract`
 * would have produced, then `MAX(0, …)`.
 *
 * The JSON types map as SQLite maps them: a number casts toward zero, a boolean
 * arrives as 1/0, absent/null coalesces to 0, and an object or array arrives as
 * its JSON TEXT — which has no integer prefix, hence 0.
 */
function sqliteIntegerCast(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return 0;
    }
    // Truncate toward zero, then clamp — in that order, so a value between -1
    // and 0 lands on 0 either way.
    return Math.max(0, Math.trunc(value));
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "string") {
    const prefix = SQLITE_INTEGER_TEXT_PREFIX.exec(value);
    if (!prefix) {
      return 0;
    }
    const parsed = Number(prefix[0]);
    if (!Number.isFinite(parsed)) {
      return 0;
    }
    return Math.max(0, parsed);
  }
  return 0;
}

/** The session's web-search line item in USD. 0 when it never used web search. */
export function sessionWebSearchCostUsd(metadata: unknown): number {
  return sessionWebSearchRequests(metadata) * WEB_SEARCH_COST_PER_REQUEST_USD;
}
