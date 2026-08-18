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
  deriveJobLabel,
  formatJobStatus,
  JOBS_STALE_LABEL,
  JOBS_UNAVAILABLE_LABEL,
  jobStatusVariant,
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

// FEA-3258 + FEA-3259: the renderer used to hand-roll drifting local types and
// render fields the IPC payload never carries (event `summary`, job
// `description`) — so request rows were blank and job rows fell through to the
// raw opaque id. These tests seed the REAL store shapes
// (activity-log-store.ts::ActivityEvent, job-store.ts::LocalJob) through the
// desktopApi bridge and assert the rendered rows show real method/path/status
// and a derived job label, not undefined / the raw id.

type ActivityApiMocks = {
  getActivityEvents: ReturnType<typeof vi.fn>;
  listRunningJobs: ReturnType<typeof vi.fn>;
  listCompletedJobs: ReturnType<typeof vi.fn>;
  clearActivityEvents: ReturnType<typeof vi.fn>;
};

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function installActivityApi({
  events = [],
  running = [],
  completed = [],
}: {
  events?: unknown[];
  running?: unknown[];
  completed?: unknown[];
}): ActivityApiMocks {
  const mocks: ActivityApiMocks = {
    getActivityEvents: vi.fn(async () => events),
    listRunningJobs: vi.fn(async () => running),
    listCompletedJobs: vi.fn(async () => completed),
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

const RUNNING_JOB = {
  id: "denny-loop-9f3c-UNIQUE-JOB-ID-42",
  kind: "SYMPHONY_LOOP",
  loopId: "loop-1",
  command: "EXECUTE",
  ticketId: "FEA-3259",
  status: "RUNNING",
  startedAt: "2026-07-22T10:00:00.000Z",
  updatedAt: "2026-07-22T10:00:00.000Z",
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

describe("ActivityPanel job rows (FEA-3259)", () => {
  it("renders a humanized derived label for a running job, not the raw job id or enum", async () => {
    installActivityApi({ running: [RUNNING_JOB] });
    render(<ActivityPanel />);

    // Command is humanized ("Execute"), never the raw SCREAMING_SNAKE enum.
    await waitFor(() => {
      expect(screen.getByText("Execute · FEA-3259")).toBeTruthy();
    });
    expect(screen.queryByText("EXECUTE · FEA-3259")).toBeNull();
    // The opaque id must NOT be what the row shows.
    expect(screen.queryByText("denny-loop-9f3c-UNIQUE-JOB-ID-42")).toBeNull();
  });

  it("renders a humanized status badge, not the raw enum", async () => {
    installActivityApi({
      running: [{ ...RUNNING_JOB, status: "AWAITING_USER" }],
    });
    render(<ActivityPanel />);

    await waitFor(() => {
      expect(screen.getByText("Awaiting user")).toBeTruthy();
    });
    expect(screen.queryByText("AWAITING_USER")).toBeNull();
  });

  it("renders a humanized derived label for a completed job, not the raw job id", async () => {
    installActivityApi({
      completed: [{ ...RUNNING_JOB, status: "COMPLETED" }],
    });
    render(<ActivityPanel />);

    // Completed Jobs live inside a <details>; the label is present in the DOM.
    await waitFor(() => {
      expect(screen.getByText("Execute · FEA-3259")).toBeTruthy();
    });
    expect(screen.queryByText("denny-loop-9f3c-UNIQUE-JOB-ID-42")).toBeNull();
  });
});

// FEA-3988 (+ review #3663): the Gateway Request Log — the page's primary
// content — gets the full shared `EmptyState` (title + description + a tokenized
// icon). The running/completed job sub-panels keep a single muted line instead
// of a stacked full empty state (three down a column read as template filler).
// The log copy also distinguishes a genuinely empty log from one whose events
// are hidden behind an unchecked category filter, so it never claims "nothing
// has arrived" while events sit behind a toggle.
describe("ActivityPanel empty states (FEA-3988)", () => {
  it("renders the full EmptyState for the Gateway Request Log and muted lines for the job panels", async () => {
    installActivityApi({});
    const { container } = render(<ActivityPanel />);

    await waitFor(() => {
      expect(screen.getByText("No gateway requests yet")).toBeTruthy();
    });
    // The job sub-panels are single muted lines, not full empty states.
    expect(screen.getByText("No running jobs")).toBeTruthy();
    // Completed Jobs live inside a <details> but are always rendered in the DOM.
    expect(screen.getByText("No completed jobs")).toBeTruthy();
    // The canonical EmptyState carries a description + a glyph the bare lines do
    // not. Scope the icon count to the empty-icon media slot so unrelated svgs
    // (the checkbox controls) cannot satisfy the assertion — exactly one full
    // empty state renders (the request log), so exactly one empty-icon slot.
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
    // requests have not arrived (wongk review #3663).
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

describe("deriveJobLabel", () => {
  it("combines the humanized command with the first available scope id (ticket > slug > loop)", () => {
    expect(
      deriveJobLabel({
        id: "raw-id",
        command: "REQUEST_CHANGES",
        ticketId: "FEA-1",
        artifactSlug: "slug-x",
        loopId: "loop-x",
      } as never)
    ).toBe("Request changes · FEA-1");
    expect(
      deriveJobLabel({
        id: "raw-id",
        command: "PLAN",
        artifactSlug: "slug-x",
        loopId: "loop-x",
      } as never)
    ).toBe("Plan · slug-x");
    expect(
      deriveJobLabel({
        id: "raw-id",
        command: "GENERATE_PRD",
        loopId: "loop-x",
      } as never)
    ).toBe("Generate PRD · loop-x");
  });

  it("falls back to the humanized command or scope alone, and only to the raw id as a last resort", () => {
    expect(deriveJobLabel({ id: "raw-id", loopId: "loop-x" } as never)).toBe(
      "loop-x"
    );
    expect(deriveJobLabel({ id: "raw-id", command: "PLAN" } as never)).toBe(
      "Plan"
    );
    expect(deriveJobLabel({ id: "raw-id" } as never)).toBe("raw-id");
  });
});

describe("formatJobStatus", () => {
  it("humanizes each raw LocalJobStatus enum for the badge", () => {
    expect(formatJobStatus("AWAITING_USER")).toBe("Awaiting user");
    expect(formatJobStatus("TIMED_OUT")).toBe("Timed out");
    expect(formatJobStatus("RUNNING")).toBe("Running");
    expect(formatJobStatus("COMPLETED")).toBe("Completed");
  });
});

describe("jobStatusVariant", () => {
  it("maps uppercase LocalJobStatus to semantic badge variants", () => {
    expect(jobStatusVariant("RUNNING")).toBe("default");
    expect(jobStatusVariant("COMPLETED")).toBe("success");
    expect(jobStatusVariant("FAILED")).toBe("error");
    expect(jobStatusVariant(undefined)).toBe("outline");
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
 * snapshot for as long as it stayed open. Observed live: a PLAN loop was
 * running and present in the job store while this card read "No running jobs".
 * A web-dispatched loop arrives over the cloud socket with nothing in the
 * renderer to announce it, so the view has to re-read.
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

  it("shows a job that starts after the view was opened", async () => {
    enableLiveRefresh();
    useFrozenClock();
    const mocks = installActivityApi({ running: [] });
    render(<ActivityPanel />);

    await advanceAndSettle(0);
    expect(screen.getByText("No running jobs")).toBeTruthy();

    // The loop starts while the operator is looking at the page.
    mocks.listRunningJobs.mockResolvedValue([RUNNING_JOB]);
    await advanceAndSettle(ACTIVITY_REFRESH_INTERVAL_MS);

    expect(screen.getByText("Execute · FEA-3259")).toBeTruthy();
    expect(screen.queryByText("No running jobs")).toBeNull();
  });

  it("does not poll while the Labs gate is closed", async () => {
    // No enableLiveRefresh() — this is the shipped default, and it must behave
    // exactly as the view did before the flag existed: one read on mount, and
    // the mount-time snapshot thereafter.
    useFrozenClock();
    const mocks = installActivityApi({ running: [] });
    render(<ActivityPanel />);

    await advanceAndSettle(0);
    const callsAfterMount = mocks.listRunningJobs.mock.calls.length;
    expect(callsAfterMount).toBe(1);

    mocks.listRunningJobs.mockResolvedValue([RUNNING_JOB]);
    await advanceAndSettle(ACTIVITY_REFRESH_INTERVAL_MS * 4);

    expect(mocks.listRunningJobs.mock.calls.length).toBe(callsAfterMount);
    expect(screen.getByText("No running jobs")).toBeTruthy();
    expect(screen.queryByText("Execute · FEA-3259")).toBeNull();
  });

  it("stops polling once unmounted", async () => {
    enableLiveRefresh();
    useFrozenClock();
    const mocks = installActivityApi({ running: [] });
    const { unmount } = render(<ActivityPanel />);

    await advanceAndSettle(ACTIVITY_REFRESH_INTERVAL_MS);
    const callsAtUnmount = mocks.listRunningJobs.mock.calls.length;
    // The poll really was running, so the count below measures teardown rather
    // than a timer that never armed.
    expect(callsAtUnmount).toBeGreaterThan(1);
    unmount();

    await advanceAndSettle(ACTIVITY_REFRESH_INTERVAL_MS * 4);

    expect(mocks.listRunningJobs.mock.calls.length).toBe(callsAtUnmount);
  });
});

/**
 * A failed read and an empty list are different facts, and the panel must never
 * spend one's copy on the other. The dangerous variant is a failure that lands
 * on top of rows already on screen: they keep their "Running" badges and look
 * current, so the failure has to be surfaced independently of whether anything
 * is cached (review #4783).
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

  it("says the read failed rather than reporting zero running jobs", async () => {
    enableLiveRefresh();
    useFrozenClock();
    const mocks = installActivityApi({ running: [] });
    mocks.listRunningJobs.mockRejectedValue(new Error("db-host exited"));
    render(<ActivityPanel />);

    await advanceAndSettle(0);

    // Reporting the failure as "No running jobs" tells the operator their work
    // is not running when it may well be.
    expect(screen.getByText(JOBS_UNAVAILABLE_LABEL)).toBeTruthy();
    expect(screen.queryByText("No running jobs")).toBeNull();
  });

  it("keeps the last known rows but marks them stale when a later poll fails", async () => {
    enableLiveRefresh();
    useFrozenClock();
    const mocks = installActivityApi({ running: [RUNNING_JOB] });
    render(<ActivityPanel />);

    await advanceAndSettle(0);
    expect(screen.getByText("Execute · FEA-3259")).toBeTruthy();
    expect(screen.queryByText(JOBS_STALE_LABEL)).toBeNull();

    // The db-host exits mid-session; the next poll rejects while rows are up.
    mocks.listRunningJobs.mockRejectedValue(new Error("db-host exited"));
    await advanceAndSettle(ACTIVITY_REFRESH_INTERVAL_MS);

    // The rows are kept — dropping them would claim the job ended — but they
    // are no longer presented as current.
    expect(screen.getByText("Execute · FEA-3259")).toBeTruthy();
    expect(screen.getByText(JOBS_STALE_LABEL)).toBeTruthy();
    // And the empty-list copy must not appear while rows are on screen.
    expect(screen.queryByText(JOBS_UNAVAILABLE_LABEL)).toBeNull();
  });

  it("clears the failure notice once a later poll succeeds", async () => {
    enableLiveRefresh();
    useFrozenClock();
    const mocks = installActivityApi({ running: [RUNNING_JOB] });
    mocks.listRunningJobs.mockRejectedValue(new Error("db-host exited"));
    render(<ActivityPanel />);

    await advanceAndSettle(0);
    expect(screen.getByText(JOBS_UNAVAILABLE_LABEL)).toBeTruthy();

    mocks.listRunningJobs.mockResolvedValue([RUNNING_JOB]);
    await advanceAndSettle(ACTIVITY_REFRESH_INTERVAL_MS);

    // A recovered read must retract the warning, not leave it up forever.
    expect(screen.queryByText(JOBS_UNAVAILABLE_LABEL)).toBeNull();
    expect(screen.queryByText(JOBS_STALE_LABEL)).toBeNull();
    expect(screen.getByText("Execute · FEA-3259")).toBeTruthy();
  });

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
    mocks.listRunningJobs.mockRejectedValue(new Error("db-host exited"));
    render(<ActivityPanel />);

    await advanceAndSettle(0);

    expect(screen.getByText("No running jobs")).toBeTruthy();
    expect(screen.queryByText(JOBS_UNAVAILABLE_LABEL)).toBeNull();
    expect(screen.queryByText(JOBS_STALE_LABEL)).toBeNull();
  });
});

/**
 * The three reads are independent IPC calls that fail independently, so one
 * rejection must not discard the other two results — nor speak for their data.
 * The old `Promise.all` did both: an activity-log outage threw away a perfectly
 * good running-jobs list and then reported the loss as a jobs-read failure
 * (wongk, #4783).
 */
describe("ActivityPanel partial read failures (ISS-5808)", () => {
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

  it("keeps a good jobs list when only the activity log fails", async () => {
    enableLiveRefresh();
    useFrozenClock();
    const mocks = installActivityApi({ running: [RUNNING_JOB] });
    mocks.getActivityEvents.mockRejectedValue(new Error("log store gone"));
    render(<ActivityPanel />);

    await advanceAndSettle(0);

    // The jobs read succeeded, so its rows render and NOTHING claims the jobs
    // could not be read.
    expect(screen.getByText("Execute · FEA-3259")).toBeTruthy();
    expect(screen.queryByText(JOBS_UNAVAILABLE_LABEL)).toBeNull();
    expect(screen.queryByText(JOBS_STALE_LABEL)).toBeNull();
    // The failure is reported against the source that actually failed.
    expect(screen.getByText(REQUESTS_UNAVAILABLE_TITLE)).toBeTruthy();
  });

  it("keeps a good activity log when only the jobs read fails", async () => {
    enableLiveRefresh();
    useFrozenClock();
    const mocks = installActivityApi({ events: [REQUEST_EVENT] });
    mocks.listRunningJobs.mockRejectedValue(new Error("db-host exited"));
    render(<ActivityPanel />);

    await advanceAndSettle(0);

    // The log read succeeded, so its rows render and the log does not borrow
    // the jobs failure.
    expect(screen.getByText("POST")).toBeTruthy();
    expect(screen.queryByText(REQUESTS_UNAVAILABLE_TITLE)).toBeNull();
    expect(screen.getByText(JOBS_UNAVAILABLE_LABEL)).toBeTruthy();
  });
});

/**
 * `listRunningJobs` snapshots before async filesystem enrichment, so a poll can
 * answer AFTER a load that started later. Committing it would move the view
 * backwards — including restoring request rows the operator had just cleared
 * (wongk, #4783).
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
 * and running that on every poll made the rows flash away on a cadence — the
 * IPC read awaits snapshot enrichment and filesystem work, so the gap is
 * visible (review #4783). Only a load the user is waiting on may blank it.
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
