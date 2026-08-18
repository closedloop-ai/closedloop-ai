import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_DURATION_TICK_MS } from "../../../lib/session-duration";
import { createAgentSessionListItemFixture } from "../session-list-fixtures";
import { SyncedSessionsTable } from "../synced-sessions-table";
import {
  getGridCellForSessionName,
  renderWithFlags,
} from "./synced-sessions-table.test-helpers";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

/**
 * ISS-5131: the Sessions LIST half of the Duration rule — `now - start` while
 * running, `end - start` once terminal — driven through the real render path
 * (`SyncedSessionsTable` -> the pure row mapper -> the cell), not through the
 * resolver in isolation. The unit-level rule lives in
 * `packages/app/agents/lib/__tests__/session-duration.test.ts`; this pins that
 * the value actually reaches the cell.
 */

const DURATION_COLUMN_LABEL = "Duration";
const EM_DASH_REGEX = /^—$/;

// The reported session `019fb3e3`: COMPLETED, but its `lastActivityAt` tracks
// SYNC time and lands six days past `endedAt`, and the collector's `wallClock`
// was derived from that same anchor. The cell read 170h for a 31h run.
const inflatedCompletedItem = createAgentSessionListItemFixture({
  id: "inflated-completed",
  name: "Inflated completed",
  status: SESSION_STATUS.INACTIVE,
  startedAt: new Date("2026-07-28T14:58:31.028Z"),
  endedAt: new Date("2026-07-29T22:02:53.365Z"),
  lastActivityAt: new Date("2026-08-04T17:28:37.425Z"),
  wallClock: "170h 30m",
});

// A terminal session with no end instant: one instant is not a span.
const unmeasurableItem = createAgentSessionListItemFixture({
  id: "unmeasurable",
  name: "Unmeasurable",
  status: SESSION_STATUS.INACTIVE,
  startedAt: new Date("2026-06-10T10:00:00.000Z"),
  endedAt: null,
  lastActivityAt: new Date("2026-06-10T10:00:00.000Z"),
  wallClock: null,
});

function renderDurationColumn(
  items: Parameters<typeof SyncedSessionsTable>[0]["items"]
) {
  renderWithFlags(
    <SyncedSessionsTable
      getSessionHref={(item) => `/sessions/${item.id}`}
      items={items}
      visibleColumns={new Set(["name", "duration"])}
    />,
    []
  );
}

// A session that is still going. Its Duration is measured to `now`, so the cell
// has to keep up with the clock rather than freeze at whatever it read on mount.
const runningItem = createAgentSessionListItemFixture({
  id: "running",
  name: "Running",
  status: SESSION_STATUS.ACTIVE,
  startedAt: new Date("2026-06-10T10:00:00.000Z"),
  endedAt: null,
  lastActivityAt: new Date("2026-06-10T10:00:00.000Z"),
  wallClock: null,
});

afterEach(() => {
  vi.useRealTimers();
});

function durationCellText(sessionName: string): string {
  return (
    getGridCellForSessionName(
      sessionName,
      DURATION_COLUMN_LABEL
    ).textContent?.trim() ?? ""
  );
}

describe("SyncedSessionsTable Duration cell — ISS-5131 wall-time rule", () => {
  it("measures a terminal row start -> endedAt, ignoring a later lastActivityAt and the collector wallClock", () => {
    renderDurationColumn([inflatedCompletedItem]);

    expect(durationCellText("Inflated completed")).toBe("31h 4m");
    expect(durationCellText("Inflated completed")).not.toBe("170h 30m");
  });

  it("renders the no-data dash for a terminal row with no end instant", () => {
    // Never a fabricated "0s", and never a span measured against `now()` that
    // would keep growing on a finished session.
    renderDurationColumn([unmeasurableItem]);

    expect(durationCellText("Unmeasurable")).toMatch(EM_DASH_REGEX);
  });

  it("does not render two different claims identically", () => {
    renderDurationColumn([inflatedCompletedItem, unmeasurableItem]);

    expect(durationCellText("Inflated completed")).not.toBe(
      durationCellText("Unmeasurable")
    );
  });
});

/**
 * ISS-5131 (#4409 review): the list cell's CLOCK, driven through the real render
 * path.
 *
 * The row mapper runs inside a `useMemo` keyed on `items`, and TanStack's
 * structural sharing keeps that array referentially stable across refetches that
 * return an unchanged page — so without a ticking time signal in the deps a
 * running session's Duration sits frozen at mount. Worse, the tick used to ride
 * `sessions-honest-unknown-states`, a closed-by-default gate, so for everyone
 * with that flag off no timer ran at all: the same session read one number here
 * and a different one on its detail page, and neither was `now`.
 *
 * `renderWithFlags(..., [])` mounts with NO flags enabled, which is exactly the
 * configuration that used to freeze — so this fails if the tick is re-gated.
 */
describe("SyncedSessionsTable Duration cell — the running measure advances (#4409)", () => {
  it("re-reads the clock on the shared tick with every flag OFF", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00.000Z"));
    renderDurationColumn([runningItem]);
    expect(durationCellText("Running")).toBe("2h 0m");

    act(() => {
      vi.advanceTimersByTime(SESSION_DURATION_TICK_MS * 2);
    });
    expect(durationCellText("Running")).toBe("2h 1m");
  });
});
