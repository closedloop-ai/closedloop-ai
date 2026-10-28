import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import type { DateRange } from "@repo/app/shared/lib/format-utils";
import {
  DATE_RANGE_LABELS,
  DEFAULT_DATE_RANGE,
} from "@repo/app/shared/lib/format-utils";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture, DAY_MS } from "../session-list-fixtures";
import { SESSIONS_FILTERED_EMPTY_TITLE } from "../sessions-empty-state";
import {
  resolveSessionsFiltersActive,
  resolveSessionsRows,
} from "../sessions-list-surface-model";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

/**
 * ISS-8217 — the v2 date-range toggle, on the CLIENT-side surface.
 *
 * The control wrote view state and nothing read it: `resolveSessionsRows`
 * filtered on the two facets and the owner scope, never the window, so the
 * toolbar showed a selected range over rows it had never been measured against.
 * `resolveSessionsFiltersActive` matched that omission in its client arm, so a
 * window that emptied the list produced the genuinely-empty state — "no sessions
 * yet" at an org with plenty.
 *
 * The axis is the session's START instant (`startedAtMs`), by operator ruling
 * (2026-08-29): a range means "sessions that BEGAN in this window", chosen over
 * last-activity because it is stable — a row never leaves the window once it is
 * in it. Note this is deliberately NOT the field the SERVER-driven surface
 * windows on (`SESSIONS_SURFACE_DATE_FIELD = "lastActivityAt"`).
 */

/**
 * The clock every case below is pinned to. Mid-month and mid-day so that a
 * month rollover in the 30d/90d bounds is exercised rather than dodged, and so
 * the UTC-day quantization is visibly distinct from the instant.
 */
const NOW_ISO = "2026-06-15T12:00:00.000Z";

/**
 * The inclusive lower bound of each preset at {@link NOW_ISO}, written out
 * INDEPENDENTLY rather than imported from `getStableUtcDateWindowForRange`.
 *
 * Deriving them from the helper under guard would make this file agree with
 * whatever that helper does, including a regression in it — the window would be
 * "correct" by construction and the test could not fail. These were computed by
 * hand from the documented contract (an N-day window ending with the current UTC
 * day, so it opens at 00:00:00.000Z on `today - N + 1`).
 */
const WINDOW_START_ISO: Record<"7d" | "30d" | "90d", string> = {
  "7d": "2026-06-09T00:00:00.000Z",
  "30d": "2026-05-17T00:00:00.000Z",
  "90d": "2026-03-18T00:00:00.000Z",
};

const MS = 1;

function rowStartedAt(id: string, startedAtIso: string): SessionTableRow {
  return createSessionTableRowFixture({
    id,
    name: id,
    startedAtMs: Date.parse(startedAtIso),
  });
}

function clientRows(
  rows: readonly SessionTableRow[],
  dateRange: DateRange
): string[] {
  return resolveSessionsRows({
    customFieldFilters: new Map(),
    dateRange,
    facets: DEFAULT_SESSION_FACET_FILTERS,
    isServerDriven: false,
    rows,
    scopeUserId: null,
    search: "",
    sorts: [],
  }).sorted.map((row) => row.id);
}

describe("SessionsListSurfaceV2 client-side date range", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * THE headline assertion, and it discriminates in BOTH directions in one case
   * on purpose. A fixture whose rows all fall inside the window would pass
   * against a resolver that filters nothing — which is precisely the defect
   * ("a selected range over unfiltered rows"), so a one-directional fixture
   * could not detect it.
   */
  it("keeps a session that began inside the window and drops one that began before it", () => {
    const inside = rowStartedAt("inside", "2026-06-14T09:00:00.000Z");
    const outside = rowStartedAt("outside", "2026-06-01T09:00:00.000Z");

    expect(clientRows([inside, outside], "7d")).toEqual(["inside"]);
  });

  /**
   * The edge lands deterministically rather than drifting with the clock: the
   * bound is INCLUSIVE, so a session starting on the instant the window opens is
   * in it, and one a single millisecond earlier is not.
   */
  it("includes a session starting exactly on the boundary and excludes one 1ms before", () => {
    const boundaryMs = Date.parse(WINDOW_START_ISO["7d"]);
    const onBoundary = createSessionTableRowFixture({
      id: "on-boundary",
      startedAtMs: boundaryMs,
    });
    const justBefore = createSessionTableRowFixture({
      id: "just-before",
      startedAtMs: boundaryMs - MS,
    });

    expect(clientRows([onBoundary, justBefore], "7d")).toEqual(["on-boundary"]);
  });

  /**
   * Each preset measures its OWN window. Asserted as one case per preset with
   * both a row inside and a row outside, so a resolver that hardwired a single
   * lookback would fail on two of the three.
   */
  it.each([
    { range: "7d" as const },
    { range: "30d" as const },
    { range: "90d" as const },
  ])("applies the $range window rather than a fixed lookback", ({ range }) => {
    const boundaryMs = Date.parse(WINDOW_START_ISO[range]);
    const inside = createSessionTableRowFixture({
      id: "inside",
      startedAtMs: boundaryMs + MS,
    });
    const outside = createSessionTableRowFixture({
      id: "outside",
      startedAtMs: boundaryMs - MS,
    });

    expect(clientRows([inside, outside], range)).toEqual(["inside"]);
  });

  /**
   * `all` means NO bound, not a very large one. The ancient row is dated well
   * beyond any plausible stand-in lookback, so a resolver that implemented "all"
   * as e.g. 3650 days would drop it and fail here.
   */
  it("applies no date bound at all under the unbounded range", () => {
    const ancient = rowStartedAt("ancient", "1999-01-01T00:00:00.000Z");
    const recent = rowStartedAt("recent", "2026-06-14T09:00:00.000Z");

    expect(clientRows([ancient, recent], "all")).toEqual(["ancient", "recent"]);
    // The same population under the default window, so the case above is a
    // property of "all" rather than of a fixture nothing could exclude.
    expect(clientRows([ancient, recent], DEFAULT_DATE_RANGE)).toEqual([
      "recent",
    ]);
  });

  /**
   * A row whose producer emitted an unparseable start timestamp keeps its place.
   * Excluding on an unknown value would let one malformed field delete a row
   * from every bounded window — this ticket's defect pointed the other way.
   */
  it("keeps a row with no start instant rather than windowing it away", () => {
    const unknownStart = createSessionTableRowFixture({
      id: "unknown-start",
      startedAtMs: null,
      startedLabel: null,
    });
    const outside = rowStartedAt("outside", "2026-06-01T09:00:00.000Z");

    expect(clientRows([unknownStart, outside], "7d")).toEqual([
      "unknown-start",
    ]);
  });

  /**
   * A future-dated row (clock-skewed producer) is not hidden by a lookback.
   * Only the LOWER bound is applied, so nothing the reader can select removes a
   * row for being too RECENT.
   */
  it("keeps a future-dated session inside a bounded window", () => {
    const future = rowStartedAt("future", "2027-01-01T00:00:00.000Z");

    expect(clientRows([future], "7d")).toEqual(["future"]);
  });

  /**
   * The server-hosted mount must not double-filter. Its `rows` are one already
   * windowed server page, and the server windows on a DIFFERENT field
   * (`lastActivityAt`), so re-applying a start-instant window here would drop
   * rows the server matched.
   */
  it("leaves a server-driven page untouched however narrow the range", () => {
    const ancient = rowStartedAt("ancient", "1999-01-01T00:00:00.000Z");

    const result = resolveSessionsRows({
      customFieldFilters: new Map(),
      dateRange: "7d",
      facets: DEFAULT_SESSION_FACET_FILTERS,
      isServerDriven: true,
      rows: [ancient],
      scopeUserId: null,
      search: "",
      sorts: [],
    });

    expect(result.sorted.map((row) => row.id)).toEqual(["ancient"]);
  });

  /**
   * The two halves of the ticket's complaint have to agree: rows narrowed by a
   * window, and a filter state that SAYS the list is narrowed. While the client
   * arm omitted the window, a range that emptied the list rendered the
   * never-had-any empty state with no way back.
   */
  it("reports a non-default window as an active filter on the client surface", () => {
    const activeArgs = {
      facets: DEFAULT_SESSION_FACET_FILTERS,
      isServerDriven: false,
      scopeUserId: null,
      search: "",
    };

    expect(
      resolveSessionsFiltersActive({
        customWindowActive: false,
        ...activeArgs,
        dateRange: "90d",
      })
    ).toBe(true);
    expect(
      resolveSessionsFiltersActive({
        customWindowActive: false,
        ...activeArgs,
        dateRange: DEFAULT_DATE_RANGE,
      })
    ).toBe(false);
  });

  /**
   * The production wiring, not just the unit: the surface has to thread the
   * SELECTED range into the resolver.
   *
   * Mounted on a NON-default range on purpose. At `7d` the selected value and
   * `DEFAULT_DATE_RANGE` are the same string, so the mutation this ticket is
   * actually about — a call site that passes a fixed default and leaves the
   * toggle writing view state nobody reads — would render identically and this
   * case could not fail. `only-in-90d` is the row that tells them apart: it is
   * outside the default window and inside the selected one.
   */
  it("renders rows for the range the surface has selected, not the default one", () => {
    const restoreContainerWidth = stubContainerWidthPx(1440);
    try {
      render(
        <SessionsListSurfaceV2
          initialDateRange="90d"
          rows={[
            rowStartedAt("agent/in-7d", "2026-06-14T09:00:00.000Z"),
            rowStartedAt("agent/only-in-90d", "2026-04-01T09:00:00.000Z"),
            rowStartedAt("agent/outside-90d", "2026-01-04T09:00:00.000Z"),
          ]}
          usage={undefined}
        />
      );

      expect(screen.getByText("agent/in-7d")).toBeInTheDocument();
      // Fails if the surface passes the DEFAULT range instead of the selected one.
      expect(screen.getByText("agent/only-in-90d")).toBeInTheDocument();
      // Fails if the surface passes no window at all.
      expect(screen.queryByText("agent/outside-90d")).toBeNull();
    } finally {
      restoreContainerWidth();
    }
  });

  /**
   * The window is time-relative, so it has to keep moving on a mount whose ROWS
   * never change identity — which is the ordinary case, TanStack structural
   * sharing handing back the same page across refetches. Reading the clock
   * inside the row memo instead of feeding it in as an input froze the window at
   * whatever it said when the inputs last changed, so a row aged out of the
   * range and stayed on screen indefinitely.
   *
   * The row below opens INSIDE the 7d window and falls out of it purely by the
   * passage of time; `rows` is the same array instance across the whole test.
   */
  it("drops a row that ages out of the window without any input changing", () => {
    const restoreContainerWidth = stubContainerWidthPx(1440);
    try {
      const rows = [rowStartedAt("agent/ages-out", "2026-06-09T06:00:00.000Z")];

      render(
        <SessionsListSurfaceV2
          initialDateRange="7d"
          rows={rows}
          usage={undefined}
        />
      );

      expect(screen.getByText("agent/ages-out")).toBeInTheDocument();

      // Past the UTC rollover that carries the 7d window's opening edge beyond
      // this row's start instant. Nothing else about the mount changes.
      act(() => {
        vi.advanceTimersByTime(3 * DAY_MS);
      });

      expect(screen.queryByText("agent/ages-out")).toBeNull();
    } finally {
      restoreContainerWidth();
    }
  });

  /**
   * The window and the empty state have to agree, and the DEFAULT window is the
   * case that catches it. `resolveSessionsFiltersActive` reports a default range
   * as no filter — correctly, since it also gates whether "Clear filters" is
   * worth offering — so a client list emptied by the untouched 7d window would
   * render the genuinely-empty copy and tell a reader with plenty of sessions
   * that they have none.
   *
   * Both directions in one case: the same population renders the filtered copy
   * when the window hides it, and no empty state at all when the window admits
   * it, so this cannot pass against a surface that always claims to be filtered.
   */
  it("says the list is filtered, not empty, when the default window hides every row", () => {
    const restoreContainerWidth = stubContainerWidthPx(1440);
    try {
      const olderThanDefaultWindow = [
        rowStartedAt("agent/old-row", "2026-01-04T09:00:00.000Z"),
      ];

      const { unmount } = render(
        <SessionsListSurfaceV2
          initialDateRange={DEFAULT_DATE_RANGE}
          rows={olderThanDefaultWindow}
          usage={undefined}
        />
      );

      // ISS-11913: the window alone hides the row, so the filtered empty names
      // the window, as Branches' does.
      expect(screen.getByText(DATE_RANGE_EMPTY_COPY)).toBeInTheDocument();
      expect(screen.queryByText(GENUINELY_EMPTY_TITLE)).toBeNull();

      // A FRESH mount rather than a rerender: `initialDateRange` only seeds the
      // surface's own view state, so re-rendering with a new one is inert.
      unmount();
      render(
        <SessionsListSurfaceV2
          initialDateRange="all"
          rows={olderThanDefaultWindow}
          usage={undefined}
        />
      );

      expect(screen.getByText("agent/old-row")).toBeInTheDocument();
      expect(screen.queryByText(SESSIONS_FILTERED_EMPTY_TITLE)).toBeNull();
    } finally {
      restoreContainerWidth();
    }
  });

  /**
   * ISS-8217 review: the `all` → bounded TRANSITION, driven through the toolbar
   * control a reader actually clicks.
   *
   * `useCoarseNow` is disabled while the range is unbounded — nothing needs a
   * moving window — so an idle list carries the instant it MOUNTED at, and
   * enabling the hook used to start the interval without re-reading the clock.
   * The first bounded render then measured its window from a days-old instant
   * and stayed wrong until the first tick.
   *
   * Five UTC days pass between the mount and the click, which is what makes the
   * case discriminate: the row below is inside the 7d window measured from the
   * MOUNT instant (opens 2026-06-09) and outside it measured from the CLICK
   * instant (opens 2026-06-14). A minutes-long gap would put both bounds on the
   * same UTC day and this would pass against the unfixed hook.
   *
   * The clock is MOVED rather than advanced: under `all` the hook schedules no
   * interval, so no tick exists that could have rescued the value.
   */
  it("windows on the current instant when the range moves from all to bounded", () => {
    const restoreContainerWidth = stubContainerWidthPx(1440);
    try {
      render(
        <SessionsListSurfaceV2
          initialDateRange="all"
          rows={[
            rowStartedAt("agent/stale-window", "2026-06-10T09:00:00.000Z"),
          ]}
          usage={undefined}
        />
      );

      expect(screen.getByText("agent/stale-window")).toBeInTheDocument();

      vi.setSystemTime(new Date("2026-06-20T12:00:00.000Z"));
      fireEvent.click(screen.getByLabelText(DATE_RANGE_LABELS["7d"]));

      expect(screen.queryByText("agent/stale-window")).toBeNull();
      // The positive sibling: the row is gone because the WINDOW moved, not
      // because the click emptied the list however it was measured.
      fireEvent.click(screen.getByLabelText(DATE_RANGE_LABELS["30d"]));
      expect(screen.getByText("agent/stale-window")).toBeInTheDocument();
    } finally {
      restoreContainerWidth();
    }
  });
});

/** The copy `SessionsEmptyState` renders when the window alone hides rows. */
const DATE_RANGE_EMPTY_COPY =
  "No sessions were active in the selected date range.";

/** The copy it renders for `ListEmptyReason.Empty` — the one this must not be. */
const GENUINELY_EMPTY_TITLE = "No sessions yet";
