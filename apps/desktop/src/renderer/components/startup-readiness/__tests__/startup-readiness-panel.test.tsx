import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StartupReadinessPanel } from "../startup-readiness-panel";
import { startupProgressBarName } from "../startup-readiness-progress";

const SOURCE_FILE_COPY_PATTERN = /This count tracks source files, not sessions/;
const PAUSED_COPY_PATTERN = /History processing is paused/;
const PAUSING_COPY_PATTERN = /Pausing after the step already in progress/;
/** ISS-5768: the panel's whole-app cloud-completeness claim (`cloudVerified`). */
const CLOUD_UP_TO_DATE_PATTERN = /Cloud history is up to date/;
/** Any "N of M sessions" count, for the absence assertions. */
const SESSION_COUNT_PATTERN = /of .* sessions/;

const hooks = vi.hoisted(() => ({
  agentMonitor: {
    kind: "ready",
    dbAhead: false,
    reason: null,
  } as unknown,
  ingest: {
    byHarness: [],
    total: 14,
    processed: 13,
    preparing: false,
    complete: false,
    quarantinedCount: 0,
  } as unknown,
  maintenance: { active: false, phase: null } as unknown,
  cloudSync: {
    identified: true,
    pendingBackfillSessions: 0,
    pendingIncrementalSessions: 0,
    backfilling: false,
    caughtUp: true,
    deadLetteredSessions: 0,
  } as unknown,
  // ISS-5768: the whole-app backlog behind the panel's `cloudVerified` claim.
  // Drained here so the existing scenarios keep their pre-ISS-5768 meaning;
  // the outstanding/dead-lettered cases are covered against the pure
  // derivation in `startup-readiness-state.test.ts`.
  cloudSyncBacklog: {
    state: "drained",
    itemsRemaining: 0,
    itemsRemainingIsLowerBound: false,
    deadLetteredCount: 0,
  } as unknown,
  cloudStatus: { kind: "online" } as unknown,
  savedSessions: {
    data: { totalSessions: 3087 },
    isError: false,
  } as unknown,
}));

vi.mock("../../../hooks/use-ingest-progress", () => ({
  CloudStatusKind: {
    Degraded: "degraded",
    Idle: "idle",
    Online: "online",
    Unknown: "unknown",
  },
  useAgentMonitorStatus: () => hooks.agentMonitor,
  useCloudStatus: () => hooks.cloudStatus,
  useCloudSyncBacklog: () => hooks.cloudSyncBacklog,
  useCloudSyncProgress: () => hooks.cloudSync,
  useIngestProgress: () => hooks.ingest,
  useMaintenanceProgress: () => hooks.maintenance,
}));

vi.mock("../../sessions/use-local-agent-session-usage", () => ({
  useLocalAgentSessionUsage: () => hooks.savedSessions,
}));

let desktopApiDescriptor: PropertyDescriptor | undefined;

describe("StartupReadinessPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hooks.agentMonitor = {
      kind: "ready",
      dbAhead: false,
      reason: null,
    };
    hooks.ingest = {
      byHarness: [],
      total: 14,
      processed: 13,
      preparing: false,
      complete: false,
      quarantinedCount: 0,
    };
    hooks.maintenance = { active: false, phase: null };
    hooks.cloudSync = {
      identified: true,
      pendingBackfillSessions: 0,
      pendingIncrementalSessions: 0,
      backfilling: false,
      caughtUp: true,
      deadLetteredSessions: 0,
    };
    // ISS-5768: reset alongside its siblings. Without this a case that drives an
    // outstanding backlog leaks it into every later case in the file.
    hooks.cloudSyncBacklog = {
      state: "drained",
      itemsRemaining: 0,
      itemsRemainingIsLowerBound: false,
      deadLetteredCount: 0,
    };
    hooks.cloudStatus = { kind: "online" };
    hooks.savedSessions = {
      data: { totalSessions: 3087 },
      isError: false,
    };
    desktopApiDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "desktopApi"
    );
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    if (desktopApiDescriptor) {
      Object.defineProperty(window, "desktopApi", desktopApiDescriptor);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
    vi.restoreAllMocks();
  });

  it("reveals honest source-file progress without blocking saved sessions", () => {
    const setPaused = vi.fn(() => Promise.resolve());
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { setAgentMonitorImportPaused: setPaused },
    });

    render(<StartupReadinessPanel />);
    expect(screen.queryByTestId("startup-readiness-panel")).toBeNull();

    act(() => vi.advanceTimersByTime(350));

    expect(screen.getByText("3,087 saved sessions ready")).toBeTruthy();
    expect(screen.getByText("13 of 14")).toBeTruthy();
    expect(screen.getByText(SOURCE_FILE_COPY_PATTERN)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(setPaused).toHaveBeenCalledWith(true);

    // ISS-5115 (wongk review): the click is a REQUEST. The collector only parks
    // at its next pause gate, so until it reports `importParked` the panel says
    // it is pausing rather than claiming work already stopped.
    expect(screen.getByText(PAUSING_COPY_PATTERN)).toBeTruthy();
    expect(screen.queryByText(PAUSED_COPY_PATTERN)).toBeNull();

    // Re-render on the collector's acknowledgement without advancing the clock,
    // which would carry the panel out of this phase entirely.
    hooks.ingest = { ...(hooks.ingest as object), importParked: true };
    fireEvent.click(
      screen.getByRole("button", { name: "Hide startup details" })
    );

    expect(screen.getByText(PAUSED_COPY_PATTERN)).toBeTruthy();
    expect(screen.queryByText(PAUSING_COPY_PATTERN)).toBeNull();
  });

  /**
   * ISS-5768: the panel must CONSUME the whole-app backlog hook, not just
   * receive one. Replacing `useCloudSyncBacklog(active)` with a drained constant
   * — the realistic regression shape, since the input is required — compiles
   * cleanly and would pass every other case in this file, because they all pin
   * the backlog drained. This pair varies it and asserts the render moves.
   */
  it("stops claiming the cloud is up to date when another lane still owes work", () => {
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { setAgentMonitorImportPaused: vi.fn(() => Promise.resolve()) },
    });
    // The reported machine: session lanes drained (`caughtUp` above is true)
    // while the component inventory still owes 2,985 rows.
    hooks.cloudSyncBacklog = {
      state: "outstanding",
      itemsRemaining: 2985,
      itemsRemainingIsLowerBound: false,
      deadLetteredCount: 0,
    };

    render(<StartupReadinessPanel />);
    act(() => vi.advanceTimersByTime(350));

    expect(screen.queryByText(CLOUD_UP_TO_DATE_PATTERN)).toBeNull();
  });

  it("does claim the cloud is up to date once every lane owes nothing", () => {
    // The counterfactual for the case above: identical inputs but a drained
    // backlog, so the assertion there cannot pass on copy that never renders.
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { setAgentMonitorImportPaused: vi.fn(() => Promise.resolve()) },
    });
    render(<StartupReadinessPanel />);
    act(() => vi.advanceTimersByTime(350));

    expect(screen.getByText(CLOUD_UP_TO_DATE_PATTERN)).toBeTruthy();
  });

  it("carries overall startup on one global bar instead of the top ring", () => {
    // ISS-5115 production wiring: deleting the bar from the panel body, or
    // restoring the header ring it replaced, fails here rather than only in the
    // bar's own isolated test.
    render(<StartupReadinessPanel />);
    act(() => vi.advanceTimersByTime(350));

    const bar = screen.getByRole("progressbar", {
      name: startupProgressBarName("Processing local history"),
    });
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);

    // The removed ring took its accessible name from the headline. Nothing in
    // the panel may reuse that name as a status icon any more.
    expect(screen.queryByLabelText("3,087 saved sessions ready")).toBeNull();
    // In-flight has no header glyph at all — that was the redundancy.
    expect(screen.queryByLabelText("Startup complete")).toBeNull();
    expect(screen.queryByLabelText("Startup needs attention")).toBeNull();
  });

  it("keeps a shape-bearing glyph for the terminal attention outcome", () => {
    // Design review, ISS-5115: with the ring gone, Ready and Attention were
    // separated only by the hue of one bar. The glyph carries the outcome so
    // the distinction does not rest on colour alone (WCAG 1.4.1).
    hooks.cloudSync = {
      identified: true,
      pendingBackfillSessions: 0,
      pendingIncrementalSessions: 0,
      backfilling: false,
      caughtUp: true,
      deadLetteredSessions: 2,
    };
    hooks.ingest = {
      byHarness: [],
      total: 14,
      processed: 14,
      preparing: false,
      complete: true,
      quarantinedCount: 0,
    };

    render(<StartupReadinessPanel />);
    // The maintenance bridge has to elapse before the reveal delay is armed.
    act(() => vi.advanceTimersByTime(2500));
    act(() => vi.advanceTimersByTime(350));

    expect(screen.queryByLabelText("Startup needs attention")).not.toBeNull();
    expect(
      screen.getByRole("progressbar", {
        name: startupProgressBarName("Startup needs attention"),
      })
    ).not.toBeNull();
  });

  it("does not flash the panel when startup settles inside the maintenance bridge", () => {
    hooks.ingest = {
      byHarness: [],
      total: 0,
      processed: 0,
      preparing: false,
      complete: true,
      quarantinedCount: 0,
    };

    render(<StartupReadinessPanel />);
    act(() => vi.advanceTimersByTime(2500));

    expect(screen.queryByTestId("startup-readiness-panel")).toBeNull();
  });

  // ISS-6241 (wongk review): the Compute-count Labs flag reaches THIS surface
  // too. With both flags on the panel names the maintenance pass's real
  // population on the step that is doing the work; with the count flag off it
  // renders exactly as it did before.
  describe("the derived-view maintenance count (ISS-6241)", () => {
    const preparingViews = () => {
      hooks.ingest = {
        byHarness: [],
        total: 14,
        processed: 14,
        preparing: false,
        complete: true,
        quarantinedCount: 0,
      };
      hooks.maintenance = {
        active: true,
        phase: "rebuild",
        processed: 412,
        total: 1299,
      };
    };

    it("names the population on the live step when the flag is on", () => {
      preparingViews();

      render(<StartupReadinessPanel showComputeProgress={true} />);
      act(() => vi.advanceTimersByTime(350));

      expect(screen.queryByText("412 of 1,299 sessions")).not.toBeNull();
    });

    it("names no population when the flag is off", () => {
      preparingViews();

      render(<StartupReadinessPanel />);
      act(() => vi.advanceTimersByTime(350));

      // The same panel is on screen — the absence is the count, not the panel.
      expect(screen.queryByTestId("startup-readiness-panel")).not.toBeNull();
      expect(screen.queryByText("412 of 1,299 sessions")).toBeNull();
    });

    it("names no population when the pass reported no counts", () => {
      preparingViews();
      hooks.maintenance = { active: true, phase: "rebuild" };

      render(<StartupReadinessPanel showComputeProgress={true} />);
      act(() => vi.advanceTimersByTime(350));

      expect(screen.queryByTestId("startup-readiness-panel")).not.toBeNull();
      expect(screen.queryByText(SESSION_COUNT_PATTERN)).toBeNull();
    });
  });
});
