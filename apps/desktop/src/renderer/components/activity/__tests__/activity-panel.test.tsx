import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_REQUESTS_LIVE_REFRESH_FEATURE_FLAG_KEY } from "../../../../shared/desktop-requests-live-refresh-flag";
import {
  ACTIVITY_REFRESH_INTERVAL_MS,
  ActivityPanel,
  REQUESTS_UNAVAILABLE_TITLE,
  statusCodeSeverity,
  statusCodeTextClass,
} from "../ActivityPanel";

// ISS-5808: the view's live behavior is behind a default-off desktop Labs
// toggle, so every mount here resolves the flag. Key-aware (not a blanket
// `true`) so a test that forgets to open the gate exercises the CLOSED path,
// which is what ships — the same shape sessions-view-responsive.test.tsx uses.
// Both exports are mocked: a subtree reaching for the Optional variant throws
// on a missing export.
const enabledFlags = vi.hoisted(() => new Set<string>());
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => enabledFlags.has(key),
  useFeatureFlagEnabledOptional: (key: string) => enabledFlags.has(key),
}));

function enableLiveRefresh(): void {
  enabledFlags.add(DESKTOP_REQUESTS_LIVE_REFRESH_FEATURE_FLAG_KEY);
}

beforeEach(() => {
  enabledFlags.clear();
});

// FEA-3258: the renderer used to hand-roll drifting local types and render a
// field the IPC payload never carries (event `summary`), so request rows were
// blank. These tests seed the REAL store shape
// (activity-log-store.ts::ActivityEvent) through the desktopApi bridge and
// assert the rendered rows show real method/path/status, not undefined.

type ActivityApiMocks = {
  getActivityEvents: ReturnType<typeof vi.fn>;
  clearActivityEvents: ReturnType<typeof vi.fn>;
};

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function installActivityApi({
  events = [],
}: {
  events?: unknown[];
}): ActivityApiMocks {
  const mocks: ActivityApiMocks = {
    getActivityEvents: vi.fn(async () => events),
    clearActivityEvents: vi.fn(async () => undefined),
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: mocks,
  });
  return mocks;
}

afterEach(() => {
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

const REQUEST_EVENT = {
  id: "evt-1",
  type: "request",
  timestamp: "2026-07-22T10:15:30.000Z",
  method: "POST",
  path: "/api/gateway/spawn",
  statusCode: 200,
  durationMs: 42,
  detail: "spawned claude",
};

describe("ActivityPanel gateway request log (FEA-3258)", () => {
  it("renders real method/path/status from the ActivityEvent payload, not a blank summary", async () => {
    installActivityApi({ events: [REQUEST_EVENT] });
    render(<ActivityPanel />);

    await waitFor(() => {
      expect(screen.getByText("POST")).toBeTruthy();
    });
    expect(screen.getByText("200")).toBeTruthy();
    // path and detail render together in the leaf description cell. The exact
    // normalized string matches only the leaf span, not its ancestors (which
    // also carry the timestamp/method/status text).
    expect(
      screen.getByText("/api/gateway/spawn — spawned claude")
    ).toBeTruthy();
    // The dead `summary` field is gone: nothing renders the literal "undefined".
    expect(screen.queryByText("undefined")).toBeNull();
  });
});

// FEA-3988 (+ review #3663): the Gateway Request Log gets the full shared
// `EmptyState` (title + description + a tokenized icon). The log copy also distinguishes a genuinely empty log from one whose events
// are hidden behind an unchecked category filter, so it never claims "nothing
// has arrived" while events sit behind a toggle.
describe("ActivityPanel empty states (FEA-3988)", () => {
  it("renders the full EmptyState for the Gateway Request Log", async () => {
    installActivityApi({});
    const { container } = render(<ActivityPanel />);

    await waitFor(() => {
      expect(screen.getByText("No gateway requests yet")).toBeTruthy();
    });
    // The canonical EmptyState carries a description + a glyph. Scope the icon
    // count to the empty-icon media slot so unrelated svgs (the checkbox
    // controls) cannot satisfy the assertion.
    expect(
      screen.getByText("Gateway requests will appear here as agents make them.")
    ).toBeTruthy();
    expect(
      container.querySelectorAll('[data-slot="empty-icon"] svg')
    ).toHaveLength(1);
  });

  it("shows the filtered-empty copy — not the onboarding copy — when events exist but a category is hidden", async () => {
    // A security event is loaded, but "Show Security Events" is toggled off, so
    // `filtered.length === 0` while `events.length > 0`. The copy must not claim
    // requests have not arrived (whitlockk review #3663).
    installActivityApi({
      events: [{ ...REQUEST_EVENT, id: "sec-1", type: "security" }],
    });
    render(<ActivityPanel />);

    // Both category events render first.
    await waitFor(() => expect(screen.getByText("POST")).toBeTruthy());
    // Hide security events → the only loaded event is filtered out.
    fireEvent.click(screen.getByLabelText("Show Security Events"));

    await waitFor(() =>
      expect(screen.getByText("No requests match the filters")).toBeTruthy()
    );
    expect(
      screen.getByText(
        "Requests are hidden by the event filters above. Re-enable a category to see them."
      )
    ).toBeTruthy();
    // The onboarding copy must NOT appear while an event sits behind the toggle.
    expect(screen.queryByText("No gateway requests yet")).toBeNull();
  });
});

describe("statusCodeSeverity / statusCodeTextClass", () => {
  it("buckets HTTP status ranges into semantic severities", () => {
    expect(statusCodeSeverity(200)).toBe("success");
    expect(statusCodeSeverity(404)).toBe("warning");
    expect(statusCodeSeverity(500)).toBe("error");
    expect(statusCodeSeverity(101)).toBe("neutral");
  });

  it("maps severity to tokenized text-color classes (no off-token colors)", () => {
    expect(statusCodeTextClass(200)).toBe("text-success");
    expect(statusCodeTextClass(404)).toBe("text-warning-foreground");
    expect(statusCodeTextClass(500)).toBe("text-destructive");
    expect(statusCodeTextClass(101)).toBe("text-[var(--muted-foreground)]");
  });
});

/**
 * The view loaded once on mount and never again, so it showed its mount-time
 * snapshot for as long as it stayed open. Requests arrive with nothing in the
 * renderer to announce them, so the view has to re-read.
 */
describe("ActivityPanel freshness (ISS-5808)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Pins the clock. Every case below is about ordering across time — a poll
   * that must fire, or one that must not — so the clock is controlled rather
   * than observed (root `AGENTS.md`: no real-clock assertions, no fixed
   * sleeps).
   */
  function useFrozenClock(): void {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T10:05:00.000Z"));
  }

  /**
   * Advances the pinned clock and then lets React commit whatever the resulting
   * read produced.
   *
   * The `act` wrapper is the load-bearing part, not ceremony. Advancing the
   * timer only FIRES the interval callback; that callback starts an async
   * `load()` whose `Promise.all` and subsequent `setState` still need further
   * microtask turns and a React commit before anything reaches the DOM.
   * `advanceTimersByTimeAsync` does not wait for any of that, so a bare
   * advance-then-assert was a race decided by how many scheduler boundaries
   * happened to elapse — green locally, flaky on CI. `act`'s async form drains
   * React's work loop until quiescent, making the commit a precondition of the
   * assertion instead of a coin flip.
   */
  async function advanceAndSettle(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("shows a request that arrives after the view was opened", async () => {
    enableLiveRefresh();
    useFrozenClock();
    const mocks = installActivityApi({});
    render(<ActivityPanel />);

    await advanceAndSettle(0);
    expect(screen.getByText("No gateway requests yet")).toBeTruthy();

    // A request arrives while the operator is looking at the page.
    mocks.getActivityEvents.mockResolvedValue([REQUEST_EVENT]);
    await advanceAndSettle(ACTIVITY_REFRESH_INTERVAL_MS);

    expect(screen.getByText("POST")).toBeTruthy();
    expect(screen.queryByText("No gateway requests yet")).toBeNull();
  });

  it("does not poll while the Labs gate is closed", async () => {
    // No enableLiveRefresh() — this is the shipped default, and it must behave
    // exactly as the view did before the flag existed: one read on mount, and
    // the mount-time snapshot thereafter.
    useFrozenClock();
    const mocks = installActivityApi({});
    render(<ActivityPanel />);

    await advanceAndSettle(0);
    const callsAfterMount = mocks.getActivityEvents.mock.calls.length;
    expect(callsAfterMount).toBe(1);

    mocks.getActivityEvents.mockResolvedValue([REQUEST_EVENT]);
    await advanceAndSettle(ACTIVITY_REFRESH_INTERVAL_MS * 4);

    expect(mocks.getActivityEvents.mock.calls.length).toBe(callsAfterMount);
    expect(screen.getByText("No gateway requests yet")).toBeTruthy();
    expect(screen.queryByText("POST")).toBeNull();
  });

  it("stops polling once unmounted", async () => {
    enableLiveRefresh();
    useFrozenClock();
    const mocks = installActivityApi({});
    const { unmount } = render(<ActivityPanel />);

    await advanceAndSettle(ACTIVITY_REFRESH_INTERVAL_MS);
    const callsAtUnmount = mocks.getActivityEvents.mock.calls.length;
    // The poll really was running, so the count below measures teardown rather
    // than a timer that never armed.
    expect(callsAtUnmount).toBeGreaterThan(1);
    unmount();

    await advanceAndSettle(ACTIVITY_REFRESH_INTERVAL_MS * 4);

    expect(mocks.getActivityEvents.mock.calls.length).toBe(callsAtUnmount);
  });
});

/**
 * A failed read and an empty list are different facts, and the panel must never
 * spend one's copy on the other (review #4783).
 */
describe("ActivityPanel read failures (ISS-5808)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function useFrozenClock(): void {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T10:05:00.000Z"));
  }

  async function advanceAndSettle(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("does not claim the request log is empty when the read failed", async () => {
    enableLiveRefresh();
    useFrozenClock();
    const mocks = installActivityApi({});
    mocks.getActivityEvents.mockRejectedValue(new Error("db-host exited"));
    render(<ActivityPanel />);

    await advanceAndSettle(0);

    expect(screen.getByText(REQUESTS_UNAVAILABLE_TITLE)).toBeTruthy();
    // The onboarding copy asserts nothing has arrived — unknowable after a
    // failed read.
    expect(screen.queryByText("No gateway requests yet")).toBeNull();
  });

  it("renders the previous empty-state copy while the Labs gate is closed", async () => {
    // Flag off: a failed read falls back to the pre-ISS-5808 rendering, so the
    // new copy cannot reach an installed build before someone opts in.
    useFrozenClock();
    const mocks = installActivityApi({});
    mocks.getActivityEvents.mockRejectedValue(new Error("db-host exited"));
    render(<ActivityPanel />);

    await advanceAndSettle(0);

    expect(screen.getByText("No gateway requests yet")).toBeTruthy();
    expect(screen.queryByText(REQUESTS_UNAVAILABLE_TITLE)).toBeNull();
  });
});

/**
 * A poll can answer AFTER a load that started later. Committing it would move
 * the view backwards, restoring request rows the operator had just cleared
 * (whitlockk, #4783).
 */
describe("ActivityPanel superseded responses (ISS-5808)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops a slow poll that answers after Clear Request Log", async () => {
    enableLiveRefresh();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T10:05:00.000Z"));
    const mocks = installActivityApi({ events: [REQUEST_EVENT] });
    render(<ActivityPanel />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("POST")).toBeTruthy();

    // A background poll starts and stalls mid-flight, holding the PRE-clear
    // rows it already snapshotted.
    const stalledPoll = deferredEvents();
    mocks.getActivityEvents.mockReturnValue(stalledPoll.promise);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVITY_REFRESH_INTERVAL_MS);
    });

    // The operator clears the log; that load starts later and answers first.
    mocks.getActivityEvents.mockResolvedValue([]);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Clear Request Log" })
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.clearActivityEvents).toHaveBeenCalled();
    expect(screen.getByText("No gateway requests yet")).toBeTruthy();

    // Now the stalled poll finally answers with the rows from before the clear.
    await act(async () => {
      stalledPoll.resolve([REQUEST_EVENT]);
      await vi.advanceTimersByTimeAsync(0);
    });

    // It must not resurrect them.
    expect(screen.queryByText("POST")).toBeNull();
    expect(screen.getByText("No gateway requests yet")).toBeTruthy();
  });
});

/**
 * The five-second poll must not cost the request log its contents. `load` sets
 * the blocking `loading` state, which replaces the whole log with "Loading...",
 * and running that on every poll made the rows flash away on a cadence
 * (review #4783). Only a load the user is waiting on may blank it.
 */
describe("ActivityPanel background refresh (ISS-5808)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the request log on screen while a poll is in flight", async () => {
    enableLiveRefresh();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T10:05:00.000Z"));
    const mocks = installActivityApi({ events: [REQUEST_EVENT] });
    render(<ActivityPanel />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("POST")).toBeTruthy();

    // Hold the next refresh mid-flight so the in-flight state is observable.
    const pending = deferredEvents();
    mocks.getActivityEvents.mockReturnValue(pending.promise);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVITY_REFRESH_INTERVAL_MS);
    });

    // Mid-poll, the log still shows what it knew — no blanking spinner.
    expect(screen.queryByText("Loading...")).toBeNull();
    expect(screen.getByText("POST")).toBeTruthy();

    await act(async () => {
      pending.resolve([REQUEST_EVENT]);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("POST")).toBeTruthy();
  });

  it("still blanks the log for a load the user asked for", async () => {
    // The Refresh button is a foreground load: the spinner is honest feedback
    // there, and this pins that the background path did not remove it.
    enableLiveRefresh();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T10:05:00.000Z"));
    const mocks = installActivityApi({ events: [REQUEST_EVENT] });
    render(<ActivityPanel />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("POST")).toBeTruthy();

    const pending = deferredEvents();
    mocks.getActivityEvents.mockReturnValue(pending.promise);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("Loading...")).toBeTruthy();

    await act(async () => {
      pending.resolve([REQUEST_EVENT]);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("POST")).toBeTruthy();
  });
});

/** A promise of activity events the test resolves by hand. */
function deferredEvents(): {
  promise: Promise<unknown[]>;
  resolve: (value: unknown[]) => void;
} {
  let resolve!: (value: unknown[]) => void;
  const promise = new Promise<unknown[]>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
