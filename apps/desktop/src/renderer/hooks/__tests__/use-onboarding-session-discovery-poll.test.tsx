import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../../shared/local-session-source-status";
import {
  ONBOARDING_LOCAL_STATE_CONTRACT_VERSION,
  OnboardingHarness,
  OnboardingInventoryCompleteness,
  OnboardingInventoryStatus,
} from "../../../shared/onboarding-local-state-contract";
import {
  ANALYSIS_ETA_CONTRACT_VERSION,
  AnalysisEtaKind,
} from "../../../shared/transcript-analysis-eta-contract";
import { BOOT_IMPORT_STORE_POLL_MS } from "../boot-import-store-poll";
import type { IngestProgress } from "../use-ingest-progress";
import type { OnboardingLocalStateRead } from "../use-onboarding-local-state";
import { useOnboardingSessionDiscovery } from "../use-onboarding-session-discovery";

/**
 * ISS-10584 — the analyzed count MOVES while the boot import is running.
 *
 * The defect this file exists for is motion, not a final value: every figure the
 * step rendered was already correct once the import finished, and a test that
 * checks only a start and an end passes on the pre-fix code. So the assertions
 * below pin a SEQUENCE — the intermediate counts, in order, before completion.
 *
 * `useLocalAgentSessionUsage` is deliberately NOT mocked here. It is the module
 * the fix changed, so a fake standing in for it would leave the production poll
 * unexercised and the sequence would be the fake's, not the hook's. The seam is
 * pushed down to `window.desktopApi`, which is where the real read ends, and the
 * counts it returns are whole session counts (ISS-10582's predicate rejects any
 * value no count can take, so a fractional intermediate would withdraw the
 * analyzed read entirely rather than render smoother motion).
 */

const HARNESS = OnboardingHarness.Claude;

// The store's answer on successive reads: a cold first launch that gains
// sessions as the import commits them. Literals, not values derived from the
// hook's own output — a fixture computed from the thing under test agrees with
// its own mistakes.
const STORE_READS = [0, 3, 7, 10];
const SESSIONS_FOUND = 10;

type UsageStubCall = { sessionCount: number };

let usageCalls = 0;
let storeReads: number[] = [];

const stubs = vi.hoisted(() => ({
  ingest: null as IngestProgress | null,
  localState: { state: "loading" } as OnboardingLocalStateRead,
}));

vi.mock("../use-onboarding-local-state", () => ({
  useOnboardingLocalState: () => stubs.localState,
}));
vi.mock("../use-ingest-progress", () => ({
  useIngestProgress: () => stubs.ingest,
}));
vi.mock("../../components/sessions/sessions-view-source-status", () => ({
  useLocalSessionSourceStatus: () => ({
    recheck: () => undefined,
    status: LOCAL_SESSION_SOURCE_STATUSES.ready,
  }),
}));

function readyState(): OnboardingLocalStateRead {
  return {
    snapshot: {
      analysisEta: {
        contractVersion: ANALYSIS_ETA_CONTRACT_VERSION,
        inventoryRevision: 1,
        kind: AnalysisEtaKind.Calculating,
      },
      contractVersion: ONBOARDING_LOCAL_STATE_CONTRACT_VERSION,
      inventory: {
        attributableRawBytes: 1000,
        discoveredBytes: 1000,
        eligibleParseBytes: 1000,
        enumeratedHarnesses: [HARNESS],
        evidence: [],
        excludedBytes: 0,
        inventoryRevision: 1,
        parseCompleteness: OnboardingInventoryCompleteness.Complete,
        physicalBytes: 1000,
        sessionsByHarness: [{ harness: HARNESS, sessionCount: SESSIONS_FOUND }],
        status: OnboardingInventoryStatus.Measured,
        uploadCompleteness: OnboardingInventoryCompleteness.Complete,
      },
    },
    state: "ready",
  };
}

function runningImport(): IngestProgress {
  return {
    byHarness: [{ harness: HARNESS, processed: 0, total: 12 }],
    complete: false,
    preparing: false,
    processed: 0,
    total: 12,
  };
}

function settledImport(): IngestProgress {
  return { ...runningImport(), complete: true, processed: 12 };
}

function installUsageStub(): void {
  (window as unknown as { desktopApi: unknown }).desktopApi = {
    agentSessionsApi: {
      usage: () => {
        const index = Math.min(usageCalls, storeReads.length - 1);
        usageCalls += 1;
        const byHarness: UsageStubCall[] = [];
        return Promise.resolve({
          byHarness: byHarness
            .concat({
              sessionCount: storeReads[index] ?? 0,
            })
            .map((row) => ({ ...row, harness: HARNESS })),
        });
      },
    },
  };
}

/** Consecutive duplicates removed, leaving the distinct readings in order. */
function collapseRepeats(
  values: readonly (number | null)[]
): (number | null)[] {
  return values.filter(
    (value, index) => index === 0 || value !== values[index - 1]
  );
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.useFakeTimers();
  usageCalls = 0;
  storeReads = STORE_READS;
  stubs.localState = readyState();
  stubs.ingest = runningImport();
  installUsageStub();
});

afterEach(() => {
  vi.useRealTimers();
  // Unconditional, and restored to react-query's own "ask the document" default
  // rather than to `true`: a case that blurs the window must not leave every
  // later case in this worker believing it is focused.
  focusManager.setEventListener((handleFocus) => {
    const listener = () => handleFocus();
    window.addEventListener("visibilitychange", listener, false);
    return () => window.removeEventListener("visibilitychange", listener);
  });
  (window as unknown as { desktopApi?: unknown }).desktopApi = undefined;
});

describe("useOnboardingSessionDiscovery analyzed polling", () => {
  it("advances the analyzed count through intermediate values while the import runs", async () => {
    const { result } = renderHook(() => useOnboardingSessionDiscovery(true), {
      wrapper,
    });
    const observed: (number | null)[] = [];
    const record = () => {
      const { discovery } = result.current;
      observed.push(
        discovery.status === "measured" ? discovery.sessionsAnalyzed : null
      );
    };

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    record();
    // One extra poll beyond the scripted reads: a refetch resolves on a later
    // microtask than the timer that fired it, so the last value needs a turn to
    // reach the render. Repeated readings are collapsed below rather than
    // asserted positionally, because WHICH tick a value lands on is react-query's
    // business and the contract under test is only that the values arrive, in
    // order, before the import settles.
    for (let poll = 0; poll <= STORE_READS.length; poll += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BOOT_IMPORT_STORE_POLL_MS);
      });
      record();
    }

    // The whole point: four distinct readings, in ascending order, every one of
    // them taken while `stubs.ingest` still reports an unfinished import. A
    // pre-fix run collapses to [0] — one reading, held for the whole pass.
    expect(collapseRepeats(observed)).toEqual(STORE_READS);
    expect(stubs.ingest?.complete).toBe(false);
  });

  it("keeps advancing while the window is unfocused", async () => {
    // The boot import runs for minutes, which is exactly when a user switches
    // away. Without `refetchIntervalInBackground` react-query suspends the
    // interval on an unfocused window and the count freezes again — the ticket's
    // defect arriving by a second route. jsdom reports itself focused, so the
    // focus has to be driven explicitly or this case proves nothing.
    focusManager.setFocused(false);
    const { result } = renderHook(() => useOnboardingSessionDiscovery(true), {
      wrapper,
    });
    const observed: (number | null)[] = [];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    for (let poll = 0; poll <= STORE_READS.length; poll += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BOOT_IMPORT_STORE_POLL_MS);
      });
      const { discovery } = result.current;
      observed.push(
        discovery.status === "measured" ? discovery.sessionsAnalyzed : null
      );
    }
    expect(collapseRepeats(observed)).toEqual(STORE_READS);
  });

  it("takes one last read on the settle edge, then stops", async () => {
    // Clearing a refetch interval issues no fetch of its own, so without the
    // settle-edge read the step would keep the last POLLED value forever and
    // render it as a finished measurement. Drive a real running-to-settled
    // transition: the store's final answer must be the one that survives.
    const { result, rerender } = renderHook(
      () => useOnboardingSessionDiscovery(true),
      { wrapper }
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const duringImport = usageCalls;
    stubs.ingest = settledImport();
    await act(async () => {
      rerender();
      await vi.advanceTimersByTimeAsync(0);
    });
    const afterSettle = usageCalls;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOOT_IMPORT_STORE_POLL_MS * 4);
    });
    const { discovery } = result.current;
    expect(afterSettle).toBe(duringImport + 1);
    // No further polling once settled: the edge read is the last one taken.
    expect(usageCalls).toBe(afterSettle);
    expect(discovery.status === "measured" && discovery.sessionsAnalyzed).toBe(
      STORE_READS[1]
    );
  });

  it("keeps a genuinely empty harness reading as none rather than as motion", async () => {
    storeReads = [0, 0];
    stubs.ingest = settledImport();
    const { result } = renderHook(() => useOnboardingSessionDiscovery(true), {
      wrapper,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOOT_IMPORT_STORE_POLL_MS);
    });
    const { discovery, progress } = result.current;
    expect(discovery.status).toBe("measured");
    if (discovery.status !== "measured") {
      throw new Error("expected a measured discovery");
    }
    expect(discovery.sessionsAnalyzed).toBe(0);
    expect(discovery.sources[0]?.detection).toEqual({
      analyzed: 0,
      found: SESSIONS_FOUND,
      status: "detected",
    });
    expect(progress).toEqual({ percent: 0, status: "measured" });
  });
});
