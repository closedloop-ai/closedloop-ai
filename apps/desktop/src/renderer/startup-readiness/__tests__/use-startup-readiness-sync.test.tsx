/**
 * ISS-11668: the bar's lifecycle across parsing and the cloud sync, as ruled in
 * #symphony-dev on 2026-09-30 (Marisol): the bar leaves once parsing completes,
 * comes back once syncing begins, which only happens after the user's sync
 * election, shows parsing while parsing runs (alone or beside syncing), and
 * states dead letters before leaving.
 *
 * The status hooks are mocked through a mutable `inputs` bag, so every case that
 * moves an input calls `rerender()`. `useIngestProgress` also records the
 * `active` flag it was last handed, which is how a case tells a parked pass
 * (pollers released) from a running one.
 */

import {
  BANNER_EXIT_ANIMATION_MS,
  DEFAULT_LABEL,
  OnboardingAnalysisBanner,
} from "@repo/app/onboarding/components/onboarding-analysis-banner";
import { resolveAnalysisBannerInputs } from "@repo/app/onboarding/lib/onboarding-analysis-banner-inputs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READY_AGENT_MONITOR_RUNTIME_STATUS } from "../../../shared/agent-monitor-status";
import type { CloudSyncBacklog } from "../../../shared/cloud-read-readiness-contract";
import type { CloudStatus } from "../../hooks/use-cloud-status";
import type { CloudSyncProgress } from "../../hooks/use-cloud-sync-progress";
import type { IngestProgress } from "../../hooks/use-ingest-progress";
import {
  SYNC_DEAD_LETTER_HOLD_MS,
  useStartupReadiness,
} from "../use-startup-readiness";
import {
  CAUGHT_UP_CLOUD_SYNC,
  DRAINED_BACKLOG,
  MEASURED_ANALYSIS,
  ONLINE_CLOUD_STATUS,
} from "./startup-readiness-fixtures";

const REVEAL_DELAY_MS = 350;
const MAINTENANCE_BRIDGE_MS = 2500;
const PARSING_COUNTER = "261 / 270";
/** Sessions synced over sessions to sync, unit-less (ISS-11668 ruling 10). */
const SYNCING_COUNTER = "3 / 10";
/** The same sync once every session is delivered. */
const FINISHED_SYNC_COUNTS = {
  deliveredSessions: 10,
  inFlightTotalSessions: 10,
};
const FINISHED_SYNC_COUNTER = "10 / 10";
const DEAD_LETTER_LINE =
  "2 source files could not sync. Local sessions remain available.";

const inputs = vi.hoisted(() => ({
  ingest: null as IngestProgress | null,
  maintenance: null as { active: boolean } | null,
  cloudSync: null as CloudSyncProgress | null,
  cloudSyncBacklog: null as CloudSyncBacklog | null,
  cloudStatus: null as CloudStatus | null,
  lastActive: null as boolean | null,
}));

vi.mock("../../hooks/use-agent-monitor-status", () => ({
  useAgentMonitorStatus: () => READY_AGENT_MONITOR_RUNTIME_STATUS,
}));
vi.mock("../../components/sessions/use-local-agent-session-usage", () => ({
  useLocalAgentSessionUsage: () => ({
    data: { totalSessions: 5 },
    isError: false,
  }),
}));
vi.mock("../../hooks/use-ingest-progress", () => ({
  useIngestProgress: (active: boolean) => {
    inputs.lastActive = active;
    return inputs.ingest;
  },
  useMaintenanceProgress: () => inputs.maintenance,
}));
vi.mock("../../hooks/use-cloud-status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/use-cloud-status")>()),
  useCloudStatus: () => inputs.cloudStatus,
}));
vi.mock("../../hooks/use-cloud-sync-progress", () => ({
  useCloudSyncProgress: () => inputs.cloudSync,
  useCloudSyncBacklog: () => inputs.cloudSyncBacklog,
}));

let client: QueryClient;

beforeEach(() => {
  vi.useFakeTimers();
  inputs.ingest = processing();
  inputs.maintenance = null;
  inputs.cloudSync = null;
  inputs.cloudSyncBacklog = DRAINED_BACKLOG;
  inputs.cloudStatus = ONLINE_CLOUD_STATUS;
  inputs.lastActive = null;
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});

describe("useStartupReadiness — parsing", () => {
  it("leaves once parsing completes, without waiting on the view rebuild", async () => {
    const view = mount({ syncElected: false });
    await view.advance(REVEAL_DELAY_MS + 50);
    expect(screen.getByText(PARSING_COUNTER)).toBeTruthy();

    inputs.ingest = complete();
    inputs.maintenance = { active: true };
    await view.rerender({ syncElected: false });
    await view.advance(BANNER_EXIT_ANIMATION_MS + 50);

    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("keeps the parsing treatment while syncing runs beside it, then hands over to the sync", async () => {
    inputs.cloudSync = syncing();
    const view = mount({ syncElected: true });
    await view.advance(REVEAL_DELAY_MS + 50);
    expect(screen.getByText(PARSING_COUNTER)).toBeTruthy();
    expect(screen.getByText(DEFAULT_LABEL)).toBeTruthy();

    inputs.ingest = complete();
    await view.rerender({ syncElected: true });

    // No exit and re-entry between the two: the sync counter replaces the
    // parse counter in place.
    expect(screen.getByText(SYNCING_COUNTER)).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "30"
    );
  });

  it("says what parsing says while syncing: the default label, a unit-less counter and the default progress name (ISS-11668 ruling 10)", async () => {
    inputs.cloudSync = syncing();
    const view = mount({ syncElected: true });
    await view.advance(REVEAL_DELAY_MS + 50);
    const parsingName = screen
      .getByRole("progressbar")
      .getAttribute("aria-label");

    inputs.ingest = complete();
    await view.rerender({ syncElected: true });

    expect(screen.getByText(SYNCING_COUNTER)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(DEFAULT_LABEL);
    expect(screen.getByRole("progressbar").getAttribute("aria-label")).toBe(
      parsingName
    );
  });
});

describe("useStartupReadiness — the sync election", () => {
  it("never enters the sync before the user chooses a sync option", async () => {
    // ISS-11592's latch: lanes gated on consent still owe work, which held the
    // bar in the sync phase for as long as consent was unset.
    inputs.cloudSync = syncing();
    inputs.ingest = complete();
    const view = mount({ syncElected: false });

    await view.advance(MAINTENANCE_BRIDGE_MS + REVEAL_DELAY_MS + 50);

    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(inputs.lastActive).toBe(false);
  });

  it("parks its pollers once parsing settles, then comes back for the sync the election starts", async () => {
    const view = mount({ syncElected: false });
    await view.advance(REVEAL_DELAY_MS + 50);

    inputs.ingest = complete();
    await view.rerender({ syncElected: false });
    await view.advance(MAINTENANCE_BRIDGE_MS + BANNER_EXIT_ANIMATION_MS);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(inputs.lastActive).toBe(false);

    inputs.cloudSync = syncing();
    await view.rerender({ syncElected: true });
    expect(inputs.lastActive).toBe(true);
    await view.advance(REVEAL_DELAY_MS + 50);

    expect(screen.getByText(DEFAULT_LABEL)).toBeTruthy();
    expect(screen.getByText(SYNCING_COUNTER)).toBeTruthy();
  });

  it("keeps watching after the election even while the cloud has not answered", async () => {
    inputs.ingest = complete();
    const view = mount({ syncElected: false });
    await view.advance(MAINTENANCE_BRIDGE_MS + 50);
    expect(inputs.lastActive).toBe(false);

    // The statuses the pass parked on predate sign-in: no cloud in play, so the
    // phase reads `Ready`. The pass must keep watching rather than stop there.
    await view.rerender({ syncElected: true });
    await view.advance(REVEAL_DELAY_MS + 50);
    expect(inputs.lastActive).toBe(true);

    inputs.cloudSync = syncing();
    await view.rerender({ syncElected: true });
    await view.advance(REVEAL_DELAY_MS + 50);

    expect(screen.getByText(SYNCING_COUNTER)).toBeTruthy();
  });

  it("leaves when the sync drains, and comes back the next time syncing starts", async () => {
    inputs.ingest = complete();
    inputs.cloudSync = syncing();
    const view = mount({ syncElected: true });
    await view.advance(REVEAL_DELAY_MS + 50);
    expect(screen.getByText(SYNCING_COUNTER)).toBeTruthy();

    inputs.cloudSync = CAUGHT_UP_CLOUD_SYNC;
    await view.rerender({ syncElected: true });
    await view.advance(MAINTENANCE_BRIDGE_MS + BANNER_EXIT_ANIMATION_MS);
    expect(screen.queryByRole("progressbar")).toBeNull();
    // Still watching: the bar shows whenever syncing happens (Marisol, 2026-10-01).
    expect(inputs.lastActive).toBe(true);

    inputs.cloudSync = syncing();
    await view.rerender({ syncElected: true });
    await view.advance(REVEAL_DELAY_MS + 50);
    expect(screen.getByText(SYNCING_COUNTER)).toBeTruthy();
  });
});

describe("useStartupReadiness — dead letters", () => {
  it("keeps the sync counter while a dead letter lands mid-sync, and states it once the sync is done", async () => {
    inputs.ingest = complete();
    inputs.cloudSync = { ...syncing(), deadLetteredSessions: 2 };
    const view = mount({ syncElected: true });
    await view.advance(REVEAL_DELAY_MS + 50);
    expect(screen.getByText(SYNCING_COUNTER)).toBeTruthy();

    // Past the dead-letter hold: the bar is still reporting the sync.
    await view.advance(SYNC_DEAD_LETTER_HOLD_MS + 100);
    expect(screen.getByText(SYNCING_COUNTER)).toBeTruthy();
    expect(inputs.lastActive).toBe(true);

    inputs.cloudSync = { ...CAUGHT_UP_CLOUD_SYNC, deadLetteredSessions: 2 };
    await view.rerender({ syncElected: true });
    expect(screen.getByText(DEAD_LETTER_LINE)).toBeTruthy();

    await view.advance(SYNC_DEAD_LETTER_HOLD_MS + BANNER_EXIT_ANIMATION_MS);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  // ISS-11668 ruling 15 (operator, 2026-10-02): a finished sync slides out on
  // its own counter, never the parse counter.
  it("slides out on the finished sync's own counter, never the parse counter", async () => {
    inputs.ingest = complete();
    inputs.cloudSync = syncing();
    const view = mount({ syncElected: true });
    await view.advance(REVEAL_DELAY_MS + 50);
    expect(screen.getByText(SYNCING_COUNTER)).toBeTruthy();

    inputs.cloudSync = { ...CAUGHT_UP_CLOUD_SYNC, ...FINISHED_SYNC_COUNTS };
    await view.rerender({ syncElected: true });
    // Mid-exit: still on screen, on the sync's final counter.
    expect(screen.getByText(FINISHED_SYNC_COUNTER)).toBeTruthy();
    expect(screen.queryByText(PARSING_COUNTER)).toBeNull();

    await view.advance(BANNER_EXIT_ANIMATION_MS);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("states the records that could not sync once per sync, then leaves", async () => {
    inputs.ingest = complete();
    inputs.cloudSync = { ...CAUGHT_UP_CLOUD_SYNC, deadLetteredSessions: 2 };
    const view = mount({ syncElected: true });
    await view.advance(REVEAL_DELAY_MS + 50);
    expect(screen.getByText(DEAD_LETTER_LINE)).toBeTruthy();

    await view.advance(SYNC_DEAD_LETTER_HOLD_MS - 100);
    expect(screen.getByText(DEAD_LETTER_LINE)).toBeTruthy();

    await view.advance(100 + BANNER_EXIT_ANIMATION_MS);
    expect(screen.queryByRole("progressbar")).toBeNull();

    // Stated once: the same dead letters do not bring the bar back.
    await view.advance(SYNC_DEAD_LETTER_HOLD_MS + REVEAL_DELAY_MS);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(inputs.lastActive).toBe(true);

    // The next sync states them again once it ends.
    inputs.cloudSync = { ...syncing(), deadLetteredSessions: 2 };
    await view.rerender({ syncElected: true });
    await view.advance(REVEAL_DELAY_MS + 50);
    expect(screen.getByText(SYNCING_COUNTER)).toBeTruthy();

    inputs.cloudSync = { ...CAUGHT_UP_CLOUD_SYNC, deadLetteredSessions: 2 };
    await view.rerender({ syncElected: true });
    await view.advance(REVEAL_DELAY_MS + 50);
    expect(screen.getByText(DEAD_LETTER_LINE)).toBeTruthy();
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

/** A backfill under way: 3 of 10 sessions delivered, 7 still owed. */
function syncing(): CloudSyncProgress {
  return {
    ...CAUGHT_UP_CLOUD_SYNC,
    pendingBackfillSessions: 7,
    backfilling: true,
    caughtUp: false,
    deliveredSessions: 3,
    inFlightTotalSessions: 10,
  };
}

/**
 * Rendered the way the onboarding host renders it: the pass is the resolver's
 * override, and the finished parse is the onboarding-derived fallback beside it.
 */
function Surface({ syncElected }: { syncElected: boolean }) {
  const override = useStartupReadiness({
    analysis: MEASURED_ANALYSIS,
    syncElected,
  });
  return (
    <OnboardingAnalysisBanner
      {...resolveAnalysisBannerInputs({
        discovery: MEASURED_ANALYSIS.discovery,
        history: [],
        override,
        phase: undefined,
        progress: MEASURED_ANALYSIS.progress,
        settled: true,
      })}
    />
  );
}

function Fixture({ syncElected }: { syncElected: boolean }) {
  return (
    <QueryClientProvider client={client}>
      <Surface syncElected={syncElected} />
    </QueryClientProvider>
  );
}

function mount({ syncElected }: { syncElected: boolean }) {
  const utils = render(<Fixture syncElected={syncElected} />);
  return {
    async advance(ms: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    },
    async rerender(next: { syncElected: boolean }) {
      await act(() => {
        utils.rerender(<Fixture syncElected={next.syncElected} />);
      });
    },
  };
}
