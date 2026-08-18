import { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  isSessionComparisonEnabled,
  resolveSessionSummaryDeltas,
  sessionComparisonQuery,
  sessionSummaryScopeKey,
  useSessionComparisonSuppressed,
} from "../sessions-summary-comparison";

/**
 * ISS-6041 — the two-axis gate on the desktop Sessions strip's period-over-period
 * comparison, unit-tested apart from the view that consumes it.
 *
 * The pairing is the point: Cloud mode is what makes a comparison POSSIBLE (the
 * HTTP producer serves it; the local SQLite one cannot), and the shared Grid
 * Parity gate is what makes it VISIBLE. Either axis alone must not turn it on.
 */

/** The props {@link useSessionComparisonSuppressed} takes, for `renderHook`. */
type SuppressedProps = Parameters<typeof useSessionComparisonSuppressed>[0];

const SETTLED_READ: SuppressedProps["read"] = {
  isLoading: false,
  isError: false,
  isPlaceholderData: false,
  isFetching: false,
};

const USAGE_WITH_COMPARISON = {
  comparison: {
    priorStartDate: "2026-06-14T00:00:00.000Z",
    priorEndDate: "2026-07-13T23:59:59.999Z",
    deltas: { sessions: 25 },
  },
} as Parameters<typeof resolveSessionSummaryDeltas>[0]["usage"];

describe("isSessionComparisonEnabled", () => {
  it.each([
    { isCloudMode: true, comparisonV2Enabled: true, expected: true },
    { isCloudMode: true, comparisonV2Enabled: false, expected: false },
    { isCloudMode: false, comparisonV2Enabled: true, expected: false },
    { isCloudMode: false, comparisonV2Enabled: false, expected: false },
  ])("cloud=$isCloudMode gate=$comparisonV2Enabled → $expected", ({
    isCloudMode,
    comparisonV2Enabled,
    expected,
  }) => {
    expect(
      isSessionComparisonEnabled({ isCloudMode, comparisonV2Enabled })
    ).toBe(expected);
  });
});

describe("sessionComparisonQuery", () => {
  it("carries the prior-window opt-in when the surface compares", () => {
    expect(sessionComparisonQuery(true)).toEqual({
      comparison: AgentSessionComparisonMode.Prior,
    });
  });

  // An `undefined` entry would change the React Query key's hash inputs and the
  // wire shape for every non-comparing surface. The key must be ABSENT.
  it("adds no key at all when it does not", () => {
    expect(Object.keys(sessionComparisonQuery(false))).toEqual([]);
  });
});

describe("resolveSessionSummaryDeltas", () => {
  it("maps the producer's percentages onto the cards when the surface compares", () => {
    const deltas = resolveSessionSummaryDeltas({
      dateRange: "30d",
      enabled: true,
      suppressed: false,
      usage: USAGE_WITH_COMPARISON,
    });

    expect(deltas?.sessions?.delta).toBe(25);
    // Absent entries stay absent — never a fabricated 0%.
    expect(deltas?.tokens).toBeUndefined();
  });

  // `undefined` — not an empty object — is what keeps a non-comparing strip free
  // of even the "No prior period" placeholder.
  it("hands the cards nothing when the surface does not compare", () => {
    expect(
      resolveSessionSummaryDeltas({
        dateRange: "30d",
        enabled: false,
        suppressed: false,
        usage: USAGE_WITH_COMPARISON,
      })
    ).toBeUndefined();
  });

  it("grades nothing while the host reports the comparison suppressed", () => {
    const deltas = resolveSessionSummaryDeltas({
      dateRange: "30d",
      enabled: true,
      suppressed: true,
      usage: USAGE_WITH_COMPARISON,
    });

    // Still an object — this surface DOES compare, so the placeholder is
    // honest — but no card is graded against figures that may not be its own.
    expect(deltas).toBeDefined();
    expect(deltas?.sessions).toBeUndefined();
  });

  // A usage half that failed on its own resolves the combined read with `usage`
  // omitted, and the cards then paint the local fallback totals. Grading those
  // with a cloud comparison would compare two different populations.
  it("grades nothing when the usage half produced no summary", () => {
    const deltas = resolveSessionSummaryDeltas({
      dateRange: "30d",
      enabled: true,
      suppressed: false,
      usage: undefined,
    });

    expect(deltas?.sessions).toBeUndefined();
  });

  // "All time" has no prior period at all, so no card carries a chip regardless.
  it("nulls the caption for a range with no prior period", () => {
    const deltas = resolveSessionSummaryDeltas({
      dateRange: "all",
      enabled: true,
      suppressed: false,
      usage: USAGE_WITH_COMPARISON,
    });

    expect(deltas?.label).toBeNull();
    expect(deltas?.sessions).toBeUndefined();
  });
});

describe("sessionSummaryScopeKey", () => {
  // The usage aggregate and its prior window do not depend on pagination or
  // sort, and the HTTP source strips both from the usage URL — so neither may
  // change the scope identity.
  it("is unchanged by pagination and sort", () => {
    const base = { startDate: "2026-07-14", statuses: ["active"] };

    expect(
      sessionSummaryScopeKey({
        ...base,
        limit: 25,
        offset: 0,
      })
    ).toBe(
      sessionSummaryScopeKey({
        ...base,
        limit: 25,
        offset: 25,
        sortBy: "cost",
        sortDir: "asc",
      })
    );
  });

  // `search` and `countOnly` are desktop-local hints the cloud routes do not
  // model — `toBaseFilters` strips both from the usage URL — so neither can move
  // the aggregate or its prior window, and neither may re-suppress the chips.
  it("is unchanged by the desktop-local hints the cloud usage read strips", () => {
    const base = { startDate: "2026-07-14", statuses: ["active"] };

    expect(sessionSummaryScopeKey(base)).toBe(
      sessionSummaryScopeKey({ ...base, search: "deploy", countOnly: true })
    );
  });

  it("changes when a facet or the time window changes", () => {
    const scope = { startDate: "2026-07-14", statuses: ["active"], limit: 25 };

    expect(sessionSummaryScopeKey(scope)).not.toBe(
      sessionSummaryScopeKey({ ...scope, statuses: ["inactive"] })
    );
    expect(sessionSummaryScopeKey(scope)).not.toBe(
      sessionSummaryScopeKey({ ...scope, startDate: "2026-06-14" })
    );
    expect(sessionSummaryScopeKey(scope)).not.toBe(
      sessionSummaryScopeKey({ ...scope, endDate: "2026-08-14" })
    );
  });

  // Key ORDER must not be part of the identity: the filter object is assembled
  // by spreads whose order can shift without the scope changing.
  it("does not depend on key insertion order", () => {
    expect(sessionSummaryScopeKey({ startDate: "a", endDate: "b" })).toBe(
      sessionSummaryScopeKey({ endDate: "b", startDate: "a" })
    );
  });
});

describe("useSessionComparisonSuppressed", () => {
  it.each([
    { state: "loading", read: { ...SETTLED_READ, isLoading: true } },
    { state: "errored", read: { ...SETTLED_READ, isError: true } },
  ])("suppresses with no coherent snapshot ($state)", ({ read }) => {
    const { result } = renderHook(() =>
      useSessionComparisonSuppressed({ read, summaryScopeKey: "scope-a" })
    );

    expect(result.current).toBe(true);
  });

  it("does not suppress a settled read", () => {
    const { result } = renderHook(() =>
      useSessionComparisonSuppressed({
        read: SETTLED_READ,
        summaryScopeKey: "scope-a",
      })
    );

    expect(result.current).toBe(false);
  });

  // The defect this hook exists for: desktop's combined query key carries
  // limit/offset/sortBy, so a page turn re-keys the query and hands back
  // placeholder data. The scope is identical, so the held comparison still
  // describes the figures beside it and the chips must survive the turn.
  it("keeps the comparison across a page turn (placeholder, same scope)", () => {
    const { result, rerender } = renderHook(
      (props: SuppressedProps) => useSessionComparisonSuppressed(props),
      { initialProps: { read: SETTLED_READ, summaryScopeKey: "scope-a" } }
    );
    expect(result.current).toBe(false);

    rerender({
      read: { ...SETTLED_READ, isPlaceholderData: true, isFetching: true },
      summaryScopeKey: "scope-a",
    });

    expect(result.current).toBe(false);
  });

  // A real scope change is different in kind: the figures on screen describe the
  // OLD population, so grading them with the new window would be a false claim.
  it("suppresses across a facet change (placeholder, different scope)", () => {
    const { result, rerender } = renderHook(
      (props: SuppressedProps) => useSessionComparisonSuppressed(props),
      { initialProps: { read: SETTLED_READ, summaryScopeKey: "scope-a" } }
    );
    expect(result.current).toBe(false);

    rerender({
      read: { ...SETTLED_READ, isPlaceholderData: true, isFetching: true },
      summaryScopeKey: "scope-b",
    });

    expect(result.current).toBe(true);
  });

  // ...and once the new scope's own read settles, it compares again.
  it("compares again once the new scope has landed", () => {
    const { result, rerender } = renderHook(
      (props: SuppressedProps) => useSessionComparisonSuppressed(props),
      { initialProps: { read: SETTLED_READ, summaryScopeKey: "scope-a" } }
    );

    rerender({
      read: { ...SETTLED_READ, isPlaceholderData: true, isFetching: true },
      summaryScopeKey: "scope-b",
    });
    expect(result.current).toBe(true);

    rerender({ read: SETTLED_READ, summaryScopeKey: "scope-b" });

    expect(result.current).toBe(false);
  });

  // A background refetch of the SAME scope holds the chips; the data in hand is
  // still that scope's own settled response.
  it("holds the comparison through a same-scope background refetch", () => {
    const { result, rerender } = renderHook(
      (props: SuppressedProps) => useSessionComparisonSuppressed(props),
      { initialProps: { read: SETTLED_READ, summaryScopeKey: "scope-a" } }
    );

    rerender({
      read: { ...SETTLED_READ, isFetching: true },
      summaryScopeKey: "scope-a",
    });

    expect(result.current).toBe(false);
  });
});
