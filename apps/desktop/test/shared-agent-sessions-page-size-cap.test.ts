import { TABLE_PAGE_SIZE_MAX } from "@repo/api/src/types/table-page-size-limits";
import { describe, expect, it } from "vitest";
import {
  clampLimit,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_IDS,
  MAX_LIST_LIMIT,
} from "../src/main/session/shared-agent-sessions-list-bounds.js";
import { sanitizeQuery } from "../src/main/session/shared-agent-sessions-query.js";
import { SESSIONS_SURFACE_DATE_WINDOW_FIELD } from "../src/shared/session-date-window-contract.js";

/**
 * ISS-9692 (codex review) — the LOCAL Sessions producer serves the largest page
 * the rows-per-page ladder offers.
 *
 * The desktop renderer sends the reader's chosen `limit` and derives the next
 * page's `offset` from that same number. `clampLimit` bounded it at 100 while
 * the ladder offered 500, and because a clamp SILENTLY narrows rather than
 * rejecting, the failure had no surface at all: the first page came back with
 * 100 rows, the pager moved to offset 500, and sessions 100–499 were
 * unreachable. Every existing bounds case asserted the clamp's floor and its
 * non-finite fallback; none asserted its ceiling against the ladder, so the cap
 * could sit below the offer indefinitely.
 *
 * Driven through `sanitizeQuery` — the function the IPC handlers actually call
 * on an untrusted renderer payload — rather than against `MAX_LIST_LIMIT`,
 * because a constant comparison stays green if a second bound is introduced
 * between the renderer and the query.
 */
const RENDERER_QUERY_BASE = { offset: 0 } as const;

describe("local Sessions paging bounds", () => {
  it("serves the largest offered page size unclamped", () => {
    const query = sanitizeQuery(
      { ...RENDERER_QUERY_BASE, limit: TABLE_PAGE_SIZE_MAX },
      SESSIONS_SURFACE_DATE_WINDOW_FIELD
    );

    expect(query.limit).toBe(TABLE_PAGE_SIZE_MAX);
  });

  it("pages the second window of the largest offered page size", () => {
    // The offset the renderer computes from that size has to survive the same
    // trip: a limit honoured but an offset narrowed would skip the same rows in
    // the other direction.
    const query = sanitizeQuery(
      {
        limit: TABLE_PAGE_SIZE_MAX,
        offset: TABLE_PAGE_SIZE_MAX,
      },
      SESSIONS_SURFACE_DATE_WINDOW_FIELD
    );

    expect(query.offset).toBe(TABLE_PAGE_SIZE_MAX);
    expect(query.limit).toBe(TABLE_PAGE_SIZE_MAX);
  });

  it("still bounds a limit past the largest offered page size", () => {
    // The ceiling moved; it did not disappear. A renderer asking for more than
    // the ladder can offer is still narrowed rather than passed to SQLite.
    expect(clampLimit(TABLE_PAGE_SIZE_MAX + 1)).toBe(TABLE_PAGE_SIZE_MAX);
  });

  it("still falls back to the default for a non-numeric limit", () => {
    expect(clampLimit("500")).toBe(DEFAULT_LIST_LIMIT);
  });

  /**
   * ISS-9692 — the explicit-id bound does NOT ride the page-size ladder.
   *
   * The two were one constant, so raising the page ceiling to 500 silently
   * widened how many ids a single request may name from 100 to 500 — visible
   * only as a chunking assertion flipping 100 → 108 in
   * `shared-agent-sessions-api.test.ts`. Nothing about a 500-row page implies a
   * caller may name 500 ids; this fails if they are folded back together.
   */
  it("keeps the explicit-id bound independent of the page-size ladder", () => {
    expect(MAX_LIST_IDS).toBe(100);
    expect(MAX_LIST_IDS).not.toBe(MAX_LIST_LIMIT);
    // Not vacuous: the page ceiling really did move, which is what made the
    // shared constant a hazard rather than a harmless alias.
    expect(MAX_LIST_LIMIT).toBe(TABLE_PAGE_SIZE_MAX);
  });
});
