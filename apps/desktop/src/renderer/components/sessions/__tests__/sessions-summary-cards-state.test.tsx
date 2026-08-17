import {
  type AgentSessionUsageSummary,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestProgress } from "../../../hooks/use-ingest-progress";
import {
  deriveSessionsAvailability,
  isImportSettled,
  isLocalImportInProgress,
  resolveLocalSummaryCardsProps,
  resolveSummaryCardsErrored,
  type SessionsDisplayState,
  useSessionsImportProgress,
} from "../sessions-summary-cards-state";

const status = (ingest: IngestProgress) => ({ ingest });

const importing: IngestProgress = {
  byHarness: [],
  total: 7,
  processed: 3,
  preparing: false,
  complete: false,
};
const complete: IngestProgress = {
  byHarness: [],
  total: 7,
  processed: 7,
  preparing: false,
  complete: true,
};
// FEA-4156: the boot-import watchdog gave up — the wedged harness never
// settled, so processed (3) stays below total (7) forever, yet the import is
// terminal (degraded), not in progress.
const timedOut: IngestProgress = {
  byHarness: [],
  total: 7,
  processed: 3,
  preparing: false,
  complete: false,
  timedOut: true,
};
// ISS-4444 (wongk): the window between a poison source's `processed` reaching
// `total` and `recordFailure` landing the quarantine count. Aggregate
// `processed >= total` is briefly true, but `complete` is still false and
// `quarantinedCount` has not yet been set — the poller MUST NOT latch off here
// or it freezes couldNotImportCount at 0.
const countedButNotComplete: IngestProgress = {
  byHarness: [],
  total: 7,
  processed: 7,
  preparing: false,
  complete: false,
};

// FEA-4181 (review cid 3653690775): the errored-vs-syncing split the Sessions
// table body renders. A not-yet-hydrated local source is "syncing" (quiet
// holding message, no Retry); a failed read is "errored" (destructive alert +
// Retry) and wins over syncing so a real error never masquerades as still
// coming up.
describe("deriveSessionsAvailability", () => {
  it("flags an unhydrated local source as unavailable AND syncing (not errored)", () => {
    expect(
      deriveSessionsAvailability({
        displayState: "unavailable",
        isListError: false,
        isListLoading: false,
      })
    ).toEqual({
      isUnavailable: true,
      isSyncing: true,
      isTableLoading: false,
    });
  });

  it("errored read wins over syncing — unavailable but NOT syncing", () => {
    expect(
      deriveSessionsAvailability({
        displayState: "unavailable",
        isListError: true,
        isListLoading: false,
      })
    ).toEqual({
      isUnavailable: true,
      isSyncing: false,
      isTableLoading: false,
    });
  });

  it("a settled errored read (source ready) is unavailable, not syncing", () => {
    expect(
      deriveSessionsAvailability({
        displayState: "ready",
        isListError: true,
        isListLoading: false,
      })
    ).toEqual({
      isUnavailable: true,
      isSyncing: false,
      isTableLoading: false,
    });
  });

  // ISS-4483: a TRANSIENT db-host-restart read error (source ready, list errored,
  // but the error was transient) is NOT a breakage — it routes to the
  // syncing/reconnecting surface, never the hard error card. The read auto-retries.
  it("a TRANSIENT errored read (source ready) is unavailable AND syncing, not errored", () => {
    expect(
      deriveSessionsAvailability({
        displayState: "ready",
        isListError: true,
        isListErrorTransient: true,
        isListLoading: false,
      })
    ).toEqual({
      isUnavailable: true,
      isSyncing: true,
      isTableLoading: false,
    });
  });

  // A PERSISTENT errored read (explicitly non-transient) still routes to the hard
  // error card — unavailable but NOT syncing.
  it("a PERSISTENT errored read (source ready) is unavailable, NOT syncing", () => {
    expect(
      deriveSessionsAvailability({
        displayState: "ready",
        isListError: true,
        isListErrorTransient: false,
        isListLoading: false,
      })
    ).toEqual({
      isUnavailable: true,
      isSyncing: false,
      isTableLoading: false,
    });
  });

  it("a ready, non-errored source is neither unavailable nor syncing", () => {
    expect(
      deriveSessionsAvailability({
        displayState: "ready",
        isListError: false,
        isListLoading: false,
      })
    ).toEqual({
      isUnavailable: false,
      isSyncing: false,
      isTableLoading: false,
    });
  });

  it("marks the table loading while starting or the list read is loading", () => {
    expect(
      deriveSessionsAvailability({
        displayState: "starting",
        isListError: false,
        isListLoading: false,
      }).isTableLoading
    ).toBe(true);
    expect(
      deriveSessionsAvailability({
        displayState: "ready",
        isListError: false,
        isListLoading: true,
      }).isTableLoading
    ).toBe(true);
  });
});

// FEA-4128 review (wongk): the Sessions bar's ingest subscriber must bound its
// getRuntimeStatus poll to the import lifecycle — it may not keep polling every
// second for as long as the Cloud Sessions route stays open once the import has
// completed. These tests drive the real shared poller through a getRuntimeStatus
// mock and assert the interval tears down after completion.
describe("useSessionsImportProgress polling bound", () => {
  let getRuntimeStatus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function installRuntimeStatus(payloads: IngestProgress[]): void {
    let call = 0;
    getRuntimeStatus = vi.fn(() =>
      Promise.resolve(status(payloads[Math.min(call++, payloads.length - 1)]))
    );
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { getRuntimeStatus },
      writable: true,
    });
  }

  it("keeps polling while the import is in progress", async () => {
    installRuntimeStatus([importing, importing, importing]);
    const { result, unmount } = renderHook(() =>
      useSessionsImportProgress(true)
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(result.current?.complete).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(getRuntimeStatus).toHaveBeenCalledTimes(2);

    unmount();
  });

  it("stops polling once the import completes (does not poll forever)", async () => {
    // First poll shows in-progress, second reports complete; after that the
    // subscriber must latch off and issue no further getRuntimeStatus calls.
    installRuntimeStatus([importing, complete]);
    const { result, unmount } = renderHook(() =>
      useSessionsImportProgress(true)
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getRuntimeStatus).toHaveBeenCalledTimes(1);

    // Second interval delivers the complete payload; the latch fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const callsAtCompletion = getRuntimeStatus.mock.calls.length;
    expect(result.current?.complete).toBe(true);

    // Further intervals must NOT poll — the subscriber has torn down.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(getRuntimeStatus).toHaveBeenCalledTimes(callsAtCompletion);
    // The last observed snapshot is retained after the latch.
    expect(result.current?.complete).toBe(true);

    unmount();
  });

  it("never polls while disabled (Local mode)", async () => {
    installRuntimeStatus([importing]);
    const { result, unmount } = renderHook(() =>
      useSessionsImportProgress(false)
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(getRuntimeStatus).not.toHaveBeenCalled();
    expect(result.current).toBeNull();

    unmount();
  });

  it("stops polling once the import times out (a wedged harness is terminal)", async () => {
    // The watchdog gave up: processed stays below total, but the degraded
    // timedOut state is terminal — the subscriber must latch off exactly like
    // the complete case rather than polling forever behind the wedged harness.
    // Every poll returns timedOut so the latch fires on the first delivered
    // snapshot; assert the teardown by call-count plateau (the shared module
    // poller may replay a prior test's snapshot on subscribe, so we don't pin
    // the exact returned object here — the isLocalImportInProgress suite below
    // pins the timedOut mapping).
    installRuntimeStatus([timedOut, timedOut, timedOut]);
    const { unmount } = renderHook(() => useSessionsImportProgress(true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const callsAtTimeout = getRuntimeStatus.mock.calls.length;

    // Further intervals must NOT poll — the subscriber has torn down on the
    // terminal degraded state.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(getRuntimeStatus).toHaveBeenCalledTimes(callsAtTimeout);

    unmount();
  });
});

// FEA-4156 (wongk): a timed-out boot import is terminal, so the summary cards
// must resolve rather than skeleton forever behind a wedged harness whose
// processed count can never reach total.
describe("isLocalImportInProgress", () => {
  it("is true while a real import is advancing", () => {
    expect(isLocalImportInProgress(importing)).toBe(true);
  });

  it("is true during the pre-scan preparing phase", () => {
    expect(
      isLocalImportInProgress({
        byHarness: [],
        total: 0,
        processed: 0,
        preparing: true,
        complete: false,
      })
    ).toBe(true);
  });

  it("is false once a timed-out import gives up, even though processed < total", () => {
    expect(isLocalImportInProgress(timedOut)).toBe(false);
  });

  it("is false when the runtime is not yet up (null)", () => {
    expect(isLocalImportInProgress(null)).toBe(false);
  });
});

// ISS-4444 (wongk): the poll-teardown latch. It must NOT stop on aggregate
// processed>=total, because recordFailure lands quarantinedCount AFTER a poison
// source's processed has already reached total — an aggregate-count latch would
// freeze couldNotImportCount at 0 by stopping the poll before the count arrives.
describe("isImportSettled", () => {
  it("is true once the boot import reports complete", () => {
    expect(isImportSettled(complete)).toBe(true);
  });

  it("is true once a wedged harness times out (watchdog gave up)", () => {
    expect(isImportSettled(timedOut)).toBe(true);
  });

  it("is FALSE when processed>=total but complete is still false (quarantine count not yet landed)", () => {
    expect(isImportSettled(countedButNotComplete)).toBe(false);
  });

  it("is false while an import is still advancing", () => {
    expect(isImportSettled(importing)).toBe(false);
  });
});

describe("resolveLocalSummaryCardsProps", () => {
  const localTotals: AgentSessionUsageSummary = {
    viewerScope: AgentSessionViewerScope.Organization,
    totalSessions: 5,
    earliestSessionAt: null,
    latestSessionAt: null,
    totalInputTokens: 10,
    totalOutputTokens: 2,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 1,
    subscriptionEstimatedCost: 0,
    apiEstimatedCost: 1,
    byUser: [],
    byModel: [],
    byHarness: [],
    byRepository: [],
    lastSyncTargets: [],
  };

  it("passes no local fallback/skeleton signal in Local mode (single-source path)", () => {
    const props = resolveLocalSummaryCardsProps({
      isCloudMode: false,
      canFetchAuxiliaryData: true,
      localUsageData: localTotals,
      localUsageIsError: false,
      ingestProgress: importing,
    });
    // The fallback/skeleton signals stay OFF in Local mode (the view gates on the
    // local source being ready), and this ingest has no quarantine, so there is
    // no caveat at all — but it is now DERIVED from ingestProgress, not
    // force-zeroed. ISS-6115: `null` rather than 0, so the card renders its plain
    // scope caption instead of a caveat about nothing.
    expect(props).toEqual({
      localUsage: undefined,
      isLocalError: false,
      alwaysAvailableLoading: false,
      importInProgress: false,
      couldNotImportLabel: null,
    });
  });

  it("ISS-4444 (codex P2): surfaces the quarantine count in LOCAL mode too (signed-out/offline users)", () => {
    // A signed-out/offline user on the local SQLite source is exactly whose totals
    // silently omit the quarantined transcripts. The count must surface here just
    // as it does in Cloud mode — not be force-zeroed by the cloud-only branch.
    const props = resolveLocalSummaryCardsProps({
      isCloudMode: false,
      canFetchAuxiliaryData: false,
      localUsageData: localTotals,
      localUsageIsError: false,
      ingestProgress: { ...complete, quarantinedCount: 3 },
    });
    // ISS-6115: the resolver now hands down the stage-accurate PHRASE, not a
    // bare count — the progress payload carries no stage split here, which
    // degrades to the pre-ISS-6115 reading (all parse-stage).
    expect(props.couldNotImportLabel).toBe("3 transcripts couldn't be read");
    // The skeleton/fallback signals remain off in Local mode.
    expect(props.alwaysAvailableLoading).toBe(false);
    expect(props.importInProgress).toBe(false);
    expect(props.localUsage).toBeUndefined();
  });

  it("flags a genuine import as importInProgress (drives the 'Importing your history' caption)", () => {
    const props = resolveLocalSummaryCardsProps({
      isCloudMode: true,
      canFetchAuxiliaryData: true,
      localUsageData: undefined,
      localUsageIsError: false,
      ingestProgress: importing,
    });
    expect(props.alwaysAvailableLoading).toBe(true);
    expect(props.importInProgress).toBe(true);
  });

  it("skeletons a plain pending fallback WITHOUT claiming an import (neutral 'Loading…')", () => {
    // No import in flight (ingestProgress null) but the local read is still pending
    // — loading is true, importInProgress is false so the card says "Loading…".
    const props = resolveLocalSummaryCardsProps({
      isCloudMode: true,
      canFetchAuxiliaryData: true,
      localUsageData: undefined,
      localUsageIsError: false,
      ingestProgress: null,
    });
    expect(props.alwaysAvailableLoading).toBe(true);
    expect(props.importInProgress).toBe(false);
  });

  it("dashes (not spins) on a terminal local error — importInProgress false even mid-import", () => {
    const props = resolveLocalSummaryCardsProps({
      isCloudMode: true,
      canFetchAuxiliaryData: true,
      localUsageData: undefined,
      localUsageIsError: true,
      ingestProgress: importing,
    });
    expect(props.isLocalError).toBe(true);
    expect(props.alwaysAvailableLoading).toBe(false);
    expect(props.importInProgress).toBe(false);
  });

  it("settles to the local totals with no loading once the read resolves and no import runs", () => {
    const props = resolveLocalSummaryCardsProps({
      isCloudMode: true,
      canFetchAuxiliaryData: true,
      localUsageData: localTotals,
      localUsageIsError: false,
      ingestProgress: null,
    });
    expect(props.localUsage).toBe(localTotals);
    expect(props.alwaysAvailableLoading).toBe(false);
    expect(props.importInProgress).toBe(false);
  });

  it("surfaces the quarantined count so the cards can honestly say N couldn't import", () => {
    const props = resolveLocalSummaryCardsProps({
      isCloudMode: true,
      canFetchAuxiliaryData: true,
      localUsageData: localTotals,
      localUsageIsError: false,
      ingestProgress: { ...complete, quarantinedCount: 4 },
    });
    // The import completed (not in progress) with 4 quarantined files: the cards
    // resolve to real values AND surface the honest count.
    expect(props.importInProgress).toBe(false);
    expect(props.couldNotImportLabel).toBe("4 transcripts couldn't be read");
  });
});

// ISS-5281: `resolveCouldNotImportCount`'s own clamping contract moved with the
// helper to `components/__tests__/import-progress-display.test.ts`. Its use by
// this module's props resolver stays covered above
// (`couldNotImportLabel` assertions).

// The summary bar folds the delivery-metric read's own failure into its error
// state, but ONLY when there is no last-good data to keep rendering. This locks
// the three axes the SessionsView call site (SessionsView.tsx) drives it on so a
// regression can't (a) render a metric-read failure as real zeroes, (b) blank
// last-good cards on a refetch failure, or (c) miss the always-error unavailable
// source.
describe("resolveSummaryCardsErrored", () => {
  const ready: SessionsDisplayState = "ready";
  const unavailable: SessionsDisplayState = "unavailable";

  it("errors when the local source is unavailable, regardless of the metric read", () => {
    // An unavailable local source is always an error — even if a stale metric
    // read happens to hold data, the source it came from is gone.
    expect(
      resolveSummaryCardsErrored({
        displayState: unavailable,
        metricReadErrored: false,
        hasSummaryUsage: true,
      })
    ).toBe(true);
    expect(
      resolveSummaryCardsErrored({
        displayState: unavailable,
        metricReadErrored: true,
        hasSummaryUsage: false,
      })
    ).toBe(true);
  });

  it("errors on an initial metric-read failure with no data (dash the cards, never render false zeroes)", () => {
    expect(
      resolveSummaryCardsErrored({
        displayState: ready,
        metricReadErrored: true,
        hasSummaryUsage: false,
      })
    ).toBe(true);
  });

  it("does NOT error on a refetch failure that still holds last-good usage", () => {
    // A background refetch failed, but the previous summary is still in hand —
    // keep rendering it rather than blanking the whole bar (PLN-941 §5 parity).
    expect(
      resolveSummaryCardsErrored({
        displayState: ready,
        metricReadErrored: true,
        hasSummaryUsage: true,
      })
    ).toBe(false);
  });

  it("does NOT error on a healthy ready read", () => {
    expect(
      resolveSummaryCardsErrored({
        displayState: ready,
        metricReadErrored: false,
        hasSummaryUsage: true,
      })
    ).toBe(false);
    // A still-loading initial read (no error, no data yet) is loading, not errored.
    expect(
      resolveSummaryCardsErrored({
        displayState: ready,
        metricReadErrored: false,
        hasSummaryUsage: false,
      })
    ).toBe(false);
  });

  it("does NOT error while the source is still starting with no metric failure", () => {
    // "starting" is the loading axis (areSummaryCardsLoading), not the error axis
    // — a starting source with a clean read must resolve to not-errored so the
    // cards skeleton rather than dash.
    expect(
      resolveSummaryCardsErrored({
        displayState: "starting",
        metricReadErrored: false,
        hasSummaryUsage: false,
      })
    ).toBe(false);
  });
});
