import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_RUN_STALL_TIMEOUT_MS } from "../../../lib/active-runs";
import { ActiveRunsPanel } from "../active-runs-panel";
import { createAgentSessionListItemFixture } from "../session-list-fixtures";

/**
 * ISS-5286 — the panel's clock seam.
 *
 * The panel derives the stall classification and elapsed timers from a clock it
 * reads itself, so a story could not be made deterministic by pinning its
 * fixtures alone. `pinnedNowMs` pins that clock. These tests assert the prop actually
 * drives the derivation and suppresses the tick, and that omitting it leaves the
 * ticking default intact — a test that only pinned the clock would pass just as
 * well against a panel that accepted `pinnedNowMs` and ignored it.
 */
const NOW = new Date(2025, 5, 11, 12, 0, 0);
const NOW_MS = NOW.getTime();
/** Long enough to cross the stall window from `nearlyStalled`, and >1 tick. */
const PAST_STALL_MS = 60_000;
const STALLED_LABEL = "Stalled";

afterEach(() => {
  vi.useRealTimers();
});

describe("ActiveRunsPanel clock", () => {
  it("classifies from the pinned clock rather than the real one", () => {
    // Same fixture, two pinned instants: not yet stalled, then past the window.
    // If `pinnedNowMs` were accepted and dropped, both renders would agree.
    const { unmount } = render(
      <ActiveRunsPanel
        getSessionHref={hrefFor}
        isLoading={false}
        items={[nearlyStalled()]}
        pinnedNowMs={NOW_MS}
      />
    );
    expect(screen.queryByText(STALLED_LABEL)).toBeNull();
    unmount();

    render(
      <ActiveRunsPanel
        getSessionHref={hrefFor}
        isLoading={false}
        items={[nearlyStalled()]}
        pinnedNowMs={NOW_MS + PAST_STALL_MS}
      />
    );
    expect(screen.getByText(STALLED_LABEL)).toBeInTheDocument();
  });

  it("holds a pinned clock still when the tick interval would fire", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    render(
      <ActiveRunsPanel
        getSessionHref={hrefFor}
        isLoading={false}
        items={[nearlyStalled()]}
        pinnedNowMs={NOW_MS}
      />
    );
    expect(screen.queryByText(STALLED_LABEL)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(PAST_STALL_MS);
    });

    // Real time crossed the stall window; the pinned clock did not move, so the
    // run must still read as working.
    expect(screen.queryByText(STALLED_LABEL)).toBeNull();
  });

  it("still ticks on the real clock when no clock is pinned", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    render(
      <ActiveRunsPanel
        getSessionHref={hrefFor}
        isLoading={false}
        items={[nearlyStalled()]}
      />
    );
    expect(screen.queryByText(STALLED_LABEL)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(PAST_STALL_MS);
    });

    expect(screen.getByText(STALLED_LABEL)).toBeInTheDocument();
  });
});

function hrefFor(run: { id: string }): string {
  return `/sessions/${run.id}`;
}

/** Active, working, and 30s short of the stall window at {@link NOW}. */
function nearlyStalled() {
  return createAgentSessionListItemFixture({
    id: "ses-nearly-stalled",
    name: "Nearly stalled run",
    status: SESSION_STATUS.ACTIVE,
    harness: "claude",
    endedAt: null,
    startedAt: new Date(NOW_MS - 10 * 60 * 1000),
    lastActivityAt: new Date(NOW_MS - (ACTIVE_RUN_STALL_TIMEOUT_MS - 30_000)),
    phases: [
      {
        key: "stream",
        label: "Streaming turn",
        dur: "2m",
        cost: "$0",
        cIn: 0,
        cOut: 0,
        cCache: 0,
      },
    ],
  });
}
