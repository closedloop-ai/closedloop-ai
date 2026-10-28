/**
 * ISS-10903: the phase/reveal machinery inside `useStartupReadiness`, which the
 * sibling `use-startup-readiness.test.tsx` does not reach — that file drives
 * what the bar renders, this one drives the timers and gates around it.
 *
 * The REVEAL delay is a timing contract rather than a projection: a startup
 * that is already finished must never flash the banner, so reaching Ready before
 * the reveal delay elapses ends the banner outright rather than showing it and
 * immediately hiding it. What the bar does once parsing completes (ISS-11668) is
 * `use-startup-readiness-sync.test.tsx`.
 *
 * The sub-hooks are mocked through a mutable `inputs` bag. React does not
 * re-render because a module variable changed, so every case that moves an
 * input calls `rerender()` — advancing timers alone would silently assert
 * against the PREVIOUS inputs and pass for the wrong reason.
 */

import { OnboardingAnalysisBanner } from "@repo/app/onboarding/components/onboarding-analysis-banner";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READY_AGENT_MONITOR_RUNTIME_STATUS } from "../../../shared/agent-monitor-status";
import { CloudStatusKind } from "../../hooks/use-cloud-status";
import type { IngestProgress } from "../../hooks/use-ingest-progress";
import {
  type StartupAnalysisRead,
  useStartupReadiness,
} from "../use-startup-readiness";
import {
  ANALYZED_UNREAD_ANALYSIS,
  INVENTORY_PENDING_ANALYSIS,
  MEASURED_ANALYSIS,
  UNCOUNTED_ANALYSIS,
  UNMEASURED_ANALYSIS,
} from "./startup-readiness-fixtures";

const REVEAL_DELAY_MS = 350;
const MAINTENANCE_BRIDGE_MS = 2500;
const PROTOTYPE_LABEL = "Analyzing session records";
/** `MEASURED_ANALYSIS`: the prototype fixture's 261 of 270 sessions. */
const MEASURED_COUNTER = "261 / 270";

const inputs = vi.hoisted(() => ({
  analysis: null as unknown,
  agentMonitor: null as unknown,
  ingest: null as IngestProgress | null,
  maintenance: null as { active: boolean } | null,
  savedSessions: {
    data: undefined as { totalSessions: number } | undefined,
    isError: false,
  },
}));

vi.mock("../../hooks/use-agent-monitor-status", () => ({
  useAgentMonitorStatus: () => inputs.agentMonitor,
}));
vi.mock("../../components/sessions/use-local-agent-session-usage", () => ({
  useLocalAgentSessionUsage: () => inputs.savedSessions,
}));
vi.mock("../../hooks/use-ingest-progress", () => ({
  useIngestProgress: () => inputs.ingest,
  useMaintenanceProgress: () => inputs.maintenance,
}));
vi.mock("../../hooks/use-cloud-status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/use-cloud-status")>()),
  useCloudStatus: () => ({
    kind: CloudStatusKind.Disabled,
    reason: "Cloud connection is off",
  }),
}));
vi.mock("../../hooks/use-cloud-sync-progress", () => ({
  useCloudSyncProgress: () => null,
  useCloudSyncBacklog: () => null,
}));

let client: QueryClient;

beforeEach(() => {
  vi.useFakeTimers();
  inputs.analysis = MEASURED_ANALYSIS;
  inputs.agentMonitor = READY_AGENT_MONITOR_RUNTIME_STATUS;
  inputs.maintenance = null;
  inputs.savedSessions = { data: { totalSessions: 5 }, isError: false };
  inputs.ingest = processing();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

afterEach(() => {
  cleanup();
  client.clear();
  // Unconditional: a case that throws mid-way must not leave a frozen clock
  // behind for the next one.
  vi.useRealTimers();
});

describe("useStartupReadiness — the reveal delay", () => {
  it("shows nothing until the reveal delay has elapsed", async () => {
    const view = mount();

    await view.advance(REVEAL_DELAY_MS - 50);
    expect(screen.queryByRole("progressbar")).toBeNull();

    await view.advance(100);
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  it("never flashes the banner for a startup that is already finished", async () => {
    // Ready before anything was revealed: the banner is skipped outright.
    // With this ingest/maintenance combination, readiness only settles once
    // the maintenance bridge elapses, so that is when the short-circuit fires
    // and — without it — when the reveal timer would instead start. Sampling
    // only after the whole window has elapsed would still read null even if
    // the short-circuit were deleted, because the flashed banner would have
    // already retired by then; sampling inside the window is what actually
    // pins the short-circuit's effect.
    inputs.ingest = complete();
    inputs.maintenance = { active: false };
    const view = mount();

    await view.advance(MAINTENANCE_BRIDGE_MS - 50);
    expect(screen.queryByRole("progressbar")).toBeNull();

    // The bridge has now elapsed and readiness has settled to Ready.
    await view.advance(100);
    expect(screen.queryByRole("progressbar")).toBeNull();

    // Squarely inside the window a deleted short-circuit would reveal the
    // banner in (after the would-be reveal delay).
    await view.advance(REVEAL_DELAY_MS);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  // ISS-11668 ruling 16 (operator, 2026-10-02): the first frame shows "X / Y",
  // so parsing waits until Session discovery has measured Y.
  it("holds the parsing bar until Session discovery has measured the sessions found", async () => {
    inputs.analysis = UNMEASURED_ANALYSIS;
    const view = mount();
    await view.advance(REVEAL_DELAY_MS + 50);
    expect(screen.queryByRole("progressbar")).toBeNull();

    inputs.analysis = MEASURED_ANALYSIS;
    await view.rerender();
    await view.advance(REVEAL_DELAY_MS + 50);
    expect(screen.getByText(MEASURED_COUNTER)).toBeTruthy();
  });

  it("keeps holding while discovery is measured but the inventory has not reported", async () => {
    inputs.analysis = INVENTORY_PENDING_ANALYSIS;
    const view = mount();
    await view.advance(REVEAL_DELAY_MS + 50);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("keeps holding until the analyzed count is read as well", async () => {
    inputs.analysis = ANALYZED_UNREAD_ANALYSIS;
    const view = mount();
    await view.advance(REVEAL_DELAY_MS + 50);
    expect(screen.queryByRole("progressbar")).toBeNull();

    inputs.analysis = MEASURED_ANALYSIS;
    await view.rerender();
    await view.advance(REVEAL_DELAY_MS + 50);
    expect(screen.getByText(MEASURED_COUNTER)).toBeTruthy();
  });

  // Operator ruling, 2026-10-02: where discovery counts nothing (Cursor or
  // Copilot only), the bar shows without a counter rather than not at all.
  it("shows the bar without a counter where discovery counts no sessions", async () => {
    inputs.analysis = UNCOUNTED_ANALYSIS;
    const view = mount();
    await view.advance(REVEAL_DELAY_MS + 50);
    expect(screen.getByText(PROTOTYPE_LABEL)).toBeTruthy();
    expect(screen.queryByText(MEASURED_COUNTER)).toBeNull();
  });

  it("says the prototype's label before any collector has reported", async () => {
    inputs.agentMonitor = null;
    inputs.ingest = null;
    inputs.savedSessions = { data: undefined, isError: false };
    const view = mount();

    await view.advance(REVEAL_DELAY_MS + 50);

    expect(screen.getByText(PROTOTYPE_LABEL)).toBeTruthy();
    // ISS-10940: the bar carries no control in this phase either. Queried by
    // ROLE ALONE rather than by a name: the pause label is deleted copy, and an
    // absence assertion that names it would pass against any locator that has
    // stopped matching anything.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("useStartupReadiness — saved-session readiness", () => {
  it("keeps the banner up when the saved-session read fails", async () => {
    inputs.savedSessions = { data: undefined, isError: true };
    const view = mount();

    await view.advance(REVEAL_DELAY_MS + 50);

    // An errored read is not a finished startup; the banner must not retire.
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  it("keeps the banner up while the saved-session count is still loading", async () => {
    inputs.savedSessions = { data: undefined, isError: false };
    const view = mount();

    await view.advance(REVEAL_DELAY_MS + 50);

    expect(screen.getByRole("progressbar")).toBeTruthy();
  });
});

function processing(): IngestProgress {
  return {
    byHarness: [],
    total: 5,
    processed: 2,
    preparing: false,
    complete: false,
  };
}

function complete(): IngestProgress {
  return {
    byHarness: [],
    total: 5,
    processed: 5,
    preparing: false,
    complete: true,
  };
}

function Surface() {
  return (
    <OnboardingAnalysisBanner
      {...useStartupReadiness({
        analysis: inputs.analysis as StartupAnalysisRead,
        syncElected: false,
      })}
    />
  );
}

function Fixture() {
  return (
    <QueryClientProvider client={client}>
      <Surface />
    </QueryClientProvider>
  );
}

/**
 * Mount the banner over the hook. `rerender` is required after moving anything
 * in `inputs`: the mocked sub-hooks read that bag at render time, and React has
 * no reason to re-render just because a module variable changed.
 */
function mount() {
  const utils = render(<Fixture />);
  return {
    async advance(ms: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    },
    async rerender() {
      await act(() => {
        utils.rerender(<Fixture />);
      });
    },
  };
}
