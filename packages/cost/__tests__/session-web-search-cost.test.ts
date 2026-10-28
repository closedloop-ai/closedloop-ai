/**
 * ISS-7821: the session-level web-search line item, shared by the cloud's
 * `SessionDetail.estimatedCost` derivation and (by JSON path) the desktop's two
 * SQL derivations.
 *
 * The cases below are the ones that decide whether three surfaces report the
 * same dollar figure for one session: where the count is read from, and what
 * happens to values the SQL twin clamps.
 */
import { describe, expect, it } from "vitest";
import { WEB_SEARCH_COST_PER_REQUEST_USD } from "../src/harness-cost-parity";
import {
  MAX_SESSION_ESTIMATED_COST_USD,
  MAX_SESSION_WEB_SEARCH_REQUESTS,
  SESSION_WEB_SEARCH_REQUESTS_JSON_PATH,
  sessionWebSearchCostUsd,
  sessionWebSearchRequests,
} from "../src/session-web-search-cost";

const withCount = (web_search_requests: unknown) => ({
  usageExtras: { web_search_requests },
});

describe("sessionWebSearchRequests", () => {
  it("reads the count the collector persists", () => {
    expect(sessionWebSearchRequests(withCount(3))).toBe(3);
  });

  it("reports 0 for metadata that never recorded a web search", () => {
    // Each of these is a real shape the field arrives as: the key is only
    // persisted when the count is above zero, the blob is optional entirely, and
    // a non-object is what a corrupt or legacy row deserializes to.
    expect(sessionWebSearchRequests({ usageExtras: {} })).toBe(0);
    expect(sessionWebSearchRequests({})).toBe(0);
    expect(sessionWebSearchRequests(undefined)).toBe(0);
    expect(sessionWebSearchRequests(null)).toBe(0);
    expect(sessionWebSearchRequests("usageExtras")).toBe(0);
    expect(sessionWebSearchRequests([{ usageExtras: { x: 1 } }])).toBe(0);
  });

  it("clamps exactly where the SQL twin clamps", () => {
    // `MAX(0, CAST(… AS INTEGER))`: negatives floor at 0 and a fraction
    // truncates toward zero. Matching this is the point — a JS reader that
    // rounded or refused where the SQL clamped would reintroduce the
    // cross-surface disagreement this module exists to remove.
    expect(sessionWebSearchRequests(withCount(-5))).toBe(0);
    expect(sessionWebSearchRequests(withCount(-0.4))).toBe(0);
    expect(sessionWebSearchRequests(withCount(2.9))).toBe(2);
  });

  it("coerces like SQLite's CAST, not like Number() (review: whitlockk)", () => {
    // The shapes where the two coercions are DIFFERENT FUNCTIONS, and where the
    // JS one was wrong in the expensive direction. Each expectation is the value
    // `CAST(json_extract(…) AS INTEGER)` produces for the same blob, so the
    // cloud's figure and the desktop's stay equal on corrupt input too.
    //
    // `Number("2e3")` is 2000; CAST reads the leading integer prefix and stops.
    expect(sessionWebSearchRequests(withCount("2e3"))).toBe(2);
    // `Number([3])` is 3 — a one-element array coerces through its member —
    // while `json_extract` hands CAST the TEXT "[3]", which has no integer
    // prefix at all.
    expect(sessionWebSearchRequests(withCount([3]))).toBe(0);
    expect(sessionWebSearchRequests(withCount({ count: 3 }))).toBe(0);
    // A trailing-garbage prefix parse, which both sides agree on.
    expect(sessionWebSearchRequests(withCount("12abc"))).toBe(12);
    expect(sessionWebSearchRequests(withCount("  7  "))).toBe(7);
    expect(sessionWebSearchRequests(withCount("-4"))).toBe(0);
  });

  it("refuses a count too large to price instead of overflowing the column", () => {
    // ISS-7821 (review: whitlockk). `SessionDetail.estimatedCost` is
    // `Decimal(14, 6)`, so a count whose line item needs a ninth integer digit
    // makes the session upsert THROW — the corrupt count would take the whole
    // payload down with it rather than costing nothing.
    expect(sessionWebSearchRequests(withCount(10_000_000_000))).toBe(0);
    expect(
      sessionWebSearchRequests(withCount(MAX_SESSION_WEB_SEARCH_REQUESTS + 1))
    ).toBe(0);
    expect(sessionWebSearchRequests(withCount(Number.MAX_SAFE_INTEGER))).toBe(
      0
    );
    // A huge count reached through the TEXT path is bounded by the same rule.
    expect(sessionWebSearchRequests(withCount("99999999999999"))).toBe(0);
    // The boundary itself is still a real count, so the bound cannot be read as
    // "large counts are refused" — only counts the column cannot hold are.
    expect(
      sessionWebSearchRequests(withCount(MAX_SESSION_WEB_SEARCH_REQUESTS))
    ).toBe(MAX_SESSION_WEB_SEARCH_REQUESTS);
  });

  it("bounds the count at what the destination column can actually store", () => {
    // Ties the limit to the schema rather than to a number chosen here: the
    // largest accepted count must price AT MOST to the column's ceiling, and one
    // more must exceed it. Without the second assertion the bound could be set
    // anywhere below the ceiling and still look correct.
    expect(
      MAX_SESSION_WEB_SEARCH_REQUESTS * WEB_SEARCH_COST_PER_REQUEST_USD
    ).toBeLessThanOrEqual(MAX_SESSION_ESTIMATED_COST_USD);
    expect(
      (MAX_SESSION_WEB_SEARCH_REQUESTS + 1) * WEB_SEARCH_COST_PER_REQUEST_USD
    ).toBeGreaterThan(MAX_SESSION_ESTIMATED_COST_USD);
  });

  it("never yields a non-number a cost sum could inherit", () => {
    // NaN is the failure that matters here: it would propagate through the
    // addition and reach the column as a confident non-number.
    expect(sessionWebSearchRequests(withCount("not-a-number"))).toBe(0);
    expect(sessionWebSearchRequests(withCount(Number.NaN))).toBe(0);
    expect(sessionWebSearchRequests(withCount(Number.POSITIVE_INFINITY))).toBe(
      0
    );
    expect(sessionWebSearchRequests(withCount({}))).toBe(0);
  });

  it("casts a boolean count the way SQLite's JSON true/false arrive", () => {
    // `json_extract` hands CAST a JSON true as 1 and false as 0.
    expect(sessionWebSearchRequests(withCount(true))).toBe(1);
    expect(sessionWebSearchRequests(withCount(false))).toBe(0);
  });
});

describe("sessionWebSearchCostUsd", () => {
  it("prices the count at the shared per-request rate", () => {
    expect(sessionWebSearchCostUsd(withCount(3))).toBeCloseTo(
      3 * WEB_SEARCH_COST_PER_REQUEST_USD,
      12
    );
  });

  it("charges a session that never searched nothing at all", () => {
    expect(sessionWebSearchCostUsd({})).toBe(0);
  });
});

describe("SESSION_WEB_SEARCH_REQUESTS_JSON_PATH", () => {
  it("is the path the desktop SQL fragment interpolates", () => {
    // Asserted as a literal, not rebuilt from the segments: the whole value of
    // sharing this constant is that BOTH readers resolve the same field, and a
    // test that re-derived it from its own source could not notice the path
    // moving out from under the persisted data.
    expect(SESSION_WEB_SEARCH_REQUESTS_JSON_PATH).toBe(
      "$.usageExtras.web_search_requests"
    );
  });
});
