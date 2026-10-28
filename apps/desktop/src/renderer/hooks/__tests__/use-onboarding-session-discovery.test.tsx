import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import {
  OnboardingAnalysisEstimateStatus,
  OnboardingAnalysisProgressStatus,
  type OnboardingSessionSource,
  type OnboardingSourceDetection,
} from "@repo/app/onboarding/components/guided-onboarding-data";
import { GuidedOnboardingDialog } from "@repo/app/onboarding/components/guided-onboarding-dialog";
import { harnessDisplayLabel } from "@repo/app/onboarding/lib/harness-display-label";
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_SESSION_SOURCE_STATUSES,
  type LocalSessionSourceStatus,
} from "../../../shared/local-session-source-status";
import {
  type AnalysisEtaWireShape,
  ONBOARDING_INVENTORY_NO_REVISION,
  ONBOARDING_LOCAL_STATE_CONTRACT_VERSION,
  OnboardingHarness,
  OnboardingHarnessOutcome,
  OnboardingInventoryCompleteness,
  OnboardingInventoryStatus,
  type OnboardingInventoryWire,
} from "../../../shared/onboarding-local-state-contract";
import { UNKNOWN_HARNESS_BUCKET } from "../../../shared/shared-agent-sessions-contract";
import {
  ANALYSIS_ETA_CONTRACT_VERSION,
  AnalysisEtaKind,
  AnalysisEtaUnavailableReason,
} from "../../../shared/transcript-analysis-eta-contract";
import type { IngestProgress } from "../use-ingest-progress";
import type { OnboardingLocalStateRead } from "../use-onboarding-local-state";
import { useOnboardingSessionDiscovery } from "../use-onboarding-session-discovery";

type MeasuredInventoryWire = Extract<
  OnboardingInventoryWire,
  { status: typeof OnboardingInventoryStatus.Measured }
>;

type UsageStub = {
  data:
    | { byHarness: readonly { harness: string; sessionCount: number }[] }
    | undefined;
  isLoading: boolean;
  // ISS-10584: the hook now takes a read on the settle edge, so the stand-in
  // owes the same member the real `UseQueryResult` carries — a stub short of the
  // shape it replaces fails as a TypeError rather than as a wrong answer.
  refetch: () => Promise<unknown>;
};

/** A usage read stub carrying every member the hook actually touches. */
function usageStub(fields: Omit<UsageStub, "refetch">): UsageStub {
  return { ...fields, refetch: () => Promise.resolve(undefined) };
}

const stubs = vi.hoisted(() => ({
  localState: { state: "loading" } as OnboardingLocalStateRead,
  ingest: null as IngestProgress | null,
  usage: {
    data: undefined,
    isLoading: true,
    refetch: () => Promise.resolve(undefined),
  } as UsageStub,
  localSource: "ready" as LocalSessionSourceStatus,
}));

vi.mock("../use-onboarding-local-state", () => ({
  useOnboardingLocalState: () => stubs.localState,
}));
vi.mock("../use-ingest-progress", () => ({
  useIngestProgress: () => stubs.ingest,
}));
vi.mock("../../components/sessions/use-local-agent-session-usage", () => ({
  useLocalAgentSessionUsage: () => stubs.usage,
}));
vi.mock("../../components/sessions/sessions-view-source-status", () => ({
  useLocalSessionSourceStatus: () => ({
    recheck: () => undefined,
    status: stubs.localSource,
  }),
}));

function measuredInventory(
  overrides: Partial<MeasuredInventoryWire> = {}
): MeasuredInventoryWire {
  return {
    attributableRawBytes: 1000,
    discoveredBytes: 1000,
    eligibleParseBytes: 1000,
    enumeratedHarnesses: [],
    evidence: [],
    excludedBytes: 0,
    inventoryRevision: 1,
    parseCompleteness: OnboardingInventoryCompleteness.Complete,
    physicalBytes: 1000,
    status: OnboardingInventoryStatus.Measured,
    uploadCompleteness: OnboardingInventoryCompleteness.Complete,
    ...overrides,
  };
}

function measuredEta(
  overrides: Partial<AnalysisEtaWireShape> = {}
): AnalysisEtaWireShape {
  return {
    contractVersion: ANALYSIS_ETA_CONTRACT_VERSION,
    inventoryRevision: 1,
    kind: AnalysisEtaKind.Measured,
    remainingMs: 60_000,
    ...overrides,
  };
}

/**
 * The estimate's state for the whole window a progress bar matters in: byte
 * progress is moving and there are not yet enough samples to state a TIME.
 */
function calculatingEta(
  overrides: Partial<AnalysisEtaWireShape> = {}
): AnalysisEtaWireShape {
  return {
    contractVersion: ANALYSIS_ETA_CONTRACT_VERSION,
    inventoryRevision: 1,
    kind: AnalysisEtaKind.Calculating,
    ...overrides,
  };
}

function readyState(
  inventory: OnboardingInventoryWire,
  eta: AnalysisEtaWireShape
): OnboardingLocalStateRead {
  return {
    snapshot: {
      analysisEta: eta,
      contractVersion: ONBOARDING_LOCAL_STATE_CONTRACT_VERSION,
      inventory,
    },
    state: "ready",
  };
}

function ingestProgress(
  overrides: Partial<IngestProgress> = {}
): IngestProgress {
  return {
    byHarness: [],
    complete: false,
    preparing: false,
    processed: 0,
    total: 0,
    ...overrides,
  };
}

beforeEach(() => {
  stubs.localState = { state: "loading" };
  stubs.ingest = null;
  stubs.localSource = LOCAL_SESSION_SOURCE_STATUSES.ready;
  // Unsettled by default: none of these cases care about `sessionsAnalyzed`,
  // and a settled-but-empty usage read would fold to `0` instead of `null`.
  stubs.usage = usageStub({ data: undefined, isLoading: true });
});

afterEach(() => {
  cleanup();
});

function expectDetectedRow(
  source: OnboardingSessionSource | undefined
): Extract<OnboardingSourceDetection, { status: "detected" }> {
  if (source === undefined || source.detection.status !== "detected") {
    throw new Error("expected a detected source row");
  }
  return source.detection;
}

describe("useOnboardingSessionDiscovery (ISS-8346)", () => {
  it("sums every counted harness into the total and reaches the byte fallback", () => {
    stubs.localState = readyState(
      measuredInventory({
        sessionsByHarness: [
          { harness: OnboardingHarness.Claude, sessionCount: 40 },
          { harness: "cursor" as OnboardingHarness, sessionCount: 12 },
        ],
      }),
      measuredEta({ remainingBytes: 400 })
    );
    stubs.ingest = ingestProgress({
      byHarness: [{ harness: "cursor", processed: 12, total: 12 }],
    });

    const { result } = renderHook(() => useOnboardingSessionDiscovery(true));
    const { discovery, progress } = result.current;

    expect(discovery.status).toBe("measured");
    if (discovery.status !== "measured") {
      return;
    }
    expect(discovery.sessionsFound).toBe(52);
    expect(progress).toEqual({
      percent: 60,
      status: OnboardingAnalysisProgressStatus.Measured,
    });
  });

  it("takes a Claude session count from the wire, never from the ingest file total", () => {
    // The ingest total (99) is a FILE count, not a session count, and it
    // disagrees with the wire's own measured count (7). Only harnesses in the
    // desktop hook's one-to-one set may borrow their count from ingest; Claude
    // is not one of them, so the wire number must be the one that survives.
    stubs.localState = readyState(
      measuredInventory({
        sessionsByHarness: [
          { harness: OnboardingHarness.Claude, sessionCount: 7 },
        ],
      }),
      measuredEta()
    );
    stubs.ingest = ingestProgress({
      byHarness: [{ harness: "claude", processed: 99, total: 99 }],
    });

    const { result } = renderHook(() => useOnboardingSessionDiscovery(true));
    const { discovery } = result.current;

    expect(discovery.status).toBe("measured");
    if (discovery.status !== "measured") {
      return;
    }
    expect(discovery.sessionsFound).toBe(7);
    expect(discovery.sources).toEqual([
      {
        detection: { analyzed: null, found: 7, status: "detected" },
        harness: OnboardingHarness.Claude,
        label: harnessDisplayLabel(OnboardingHarness.Claude),
      },
    ]);
  });

  it("counts a harness present in both the wire and the ingest set only once", () => {
    // A harness string arrives off a process boundary and is not guaranteed to
    // respect the closed union on either side — the cast below stands in for
    // that, forcing a legitimate overlap between the wire's own count and the
    // ingest-only set so the dedup itself is what is under test.
    const overlapping = "cursor" as OnboardingHarness;
    stubs.localState = readyState(
      measuredInventory({
        sessionsByHarness: [{ harness: overlapping, sessionCount: 5 }],
      }),
      measuredEta()
    );
    stubs.ingest = ingestProgress({
      byHarness: [{ harness: "cursor", processed: 12, total: 12 }],
    });

    const { result } = renderHook(() => useOnboardingSessionDiscovery(true));
    const { discovery } = result.current;

    expect(discovery.status).toBe("measured");
    if (discovery.status !== "measured") {
      return;
    }
    expect(discovery.sessionsFound).toBe(5);
    expect(discovery.sources).toEqual([
      {
        detection: { analyzed: null, found: 5, status: "detected" },
        harness: "cursor",
        label: harnessDisplayLabel("cursor"),
      },
    ]);
  });

  // The counterfactual for ISS-11591 on the desktop adapter. ISS-11346 had
  // this same inventory produce five rows, the last two `unknown`; the
  // operator's 2026-09-29 ruling retires them, so an uncounted Cursor or
  // Copilot must not reach the list at all.
  it("lists only the sources the sweep counted, never the ones it did not (ISS-11591)", () => {
    stubs.localState = readyState(
      measuredInventory({
        sessionsByHarness: [
          { harness: OnboardingHarness.Claude, sessionCount: 3 },
          { harness: OnboardingHarness.Codex, sessionCount: 2 },
          { harness: OnboardingHarness.OpenCode, sessionCount: 1 },
        ],
      }),
      measuredEta()
    );

    const { result } = renderHook(() => useOnboardingSessionDiscovery(true));
    const { discovery } = result.current;

    expect(discovery.status).toBe("measured");
    if (discovery.status !== "measured") {
      return;
    }
    expect(
      discovery.sources.map((source) => [source.label, source.detection.status])
    ).toEqual([
      ["Claude Code", "detected"],
      ["Codex", "detected"],
      ["OpenCode", "detected"],
    ]);
    expect(discovery.sources.map((source) => source.label)).not.toContain(
      "Cursor"
    );
    expect(discovery.sources.map((source) => source.label)).not.toContain(
      "Copilot"
    );
    expect(discovery.sessionsFound).toBe(6);
  });

  it("lists no sources before the sweep reports, so the awaiting-scan state stays", () => {
    // What the main process sends until its first sweep lands.
    stubs.localState = readyState(
      { status: OnboardingInventoryStatus.Unavailable },
      {
        contractVersion: ANALYSIS_ETA_CONTRACT_VERSION,
        inventoryRevision: ONBOARDING_INVENTORY_NO_REVISION,
        kind: AnalysisEtaKind.Unavailable,
        reason: AnalysisEtaUnavailableReason.ProgressIndeterminate,
      }
    );

    const { result } = renderHook(() => useOnboardingSessionDiscovery(true));
    const { discovery } = result.current;

    expect(discovery.status).toBe("measured");
    if (discovery.status !== "measured") {
      return;
    }
    expect(discovery.sources).toEqual([]);
  });

  it("reports settled when the boot import completed", () => {
    stubs.ingest = ingestProgress({
      byHarness: [{ harness: "claude", processed: 5, total: 5 }],
      complete: true,
    });

    const { result } = renderHook(() => useOnboardingSessionDiscovery(true));

    expect(result.current.settled).toBe(true);
  });

  it("reports settled when the boot import timed out", () => {
    stubs.ingest = ingestProgress({
      byHarness: [{ harness: "claude", processed: 5, total: 5 }],
      timedOut: true,
    });

    const { result } = renderHook(() => useOnboardingSessionDiscovery(true));

    expect(result.current.settled).toBe(true);
  });

  it("reports settled when the boot import exhausted its retries", () => {
    stubs.ingest = ingestProgress({
      byHarness: [{ harness: "claude", processed: 5, total: 5 }],
      retriesExhausted: true,
    });

    const { result } = renderHook(() => useOnboardingSessionDiscovery(true));

    expect(result.current.settled).toBe(true);
  });

  it("does not read a non-empty byHarness snapshot alone as settled", () => {
    // ISS-5281: `byHarness` persists for the whole manager lifetime, so a
    // settled pass stays in the snapshot long after it finished. Its
    // non-emptiness is not a liveness claim — only the producer's own
    // terminal flags are.
    stubs.ingest = ingestProgress({
      byHarness: [{ harness: "claude", processed: 5, total: 5 }],
    });

    const { result } = renderHook(() => useOnboardingSessionDiscovery(true));

    expect(result.current.settled).toBe(false);
  });

  it("renders a proven-absent harness as not-detected, and a disabled one as no row at all", () => {
    stubs.localState = readyState(
      measuredInventory({
        evidence: [
          {
            harness: OnboardingHarness.Claude,
            outcome: OnboardingHarnessOutcome.Absent,
          },
          {
            harness: OnboardingHarness.Codex,
            outcome: OnboardingHarnessOutcome.Disabled,
          },
        ],
      }),
      measuredEta()
    );

    const { result } = renderHook(() => useOnboardingSessionDiscovery(true));
    const { discovery } = result.current;

    expect(discovery.status).toBe("measured");
    if (discovery.status !== "measured") {
      return;
    }
    // Exactly one row: proven-absent Claude. Disabled Codex is a different
    // fact the design has no copy for, so it contributes no row at all.
    expect(discovery.sources).toEqual([
      {
        detection: { status: "not-detected" },
        harness: OnboardingHarness.Claude,
        label: harnessDisplayLabel(OnboardingHarness.Claude),
      },
    ]);
    expect(discovery.sources.map((source) => source.harness)).not.toContain(
      OnboardingHarness.Codex
    );
  });

  it("derives the session ratio from the wire count and the store read", () => {
    stubs.localState = readyState(
      measuredInventory({
        enumeratedHarnesses: [OnboardingHarness.Claude],
        evidence: [
          {
            harness: OnboardingHarness.Claude,
            outcome: OnboardingHarnessOutcome.Measured,
          },
        ],
        sessionsByHarness: [
          { harness: OnboardingHarness.Claude, sessionCount: 40 },
        ],
      }),
      measuredEta()
    );
    stubs.usage = usageStub({
      data: {
        byHarness: [{ harness: OnboardingHarness.Claude, sessionCount: 10 }],
      },
      isLoading: false,
    });

    const { result } = renderHook(() => useOnboardingSessionDiscovery(true));

    expect(result.current.progress).toEqual({
      percent: 25,
      status: OnboardingAnalysisProgressStatus.Measured,
    });
  });

  it("drops the unknown-harness bucket and any non-positive row from the analyzed read", () => {
    stubs.localState = readyState(
      measuredInventory({
        evidence: [
          {
            harness: OnboardingHarness.Claude,
            outcome: OnboardingHarnessOutcome.Measured,
          },
        ],
        sessionsByHarness: [
          { harness: OnboardingHarness.Claude, sessionCount: 40 },
        ],
      }),
      measuredEta()
    );
    stubs.usage = usageStub({
      data: {
        byHarness: [
          { harness: OnboardingHarness.Claude, sessionCount: 10 },
          // Neither is a tool the user installed: the bucket merges NULL-harness
          // rows with rows whose column literally says "unknown", and a zero row
          // is a harness the store has nothing for.
          { harness: UNKNOWN_HARNESS_BUCKET, sessionCount: 25 },
          { harness: "gemini", sessionCount: 0 },
        ],
      },
      isLoading: false,
    });

    const { result } = renderHook(() => useOnboardingSessionDiscovery(true));
    const { discovery } = result.current;

    expect(discovery.status).toBe("measured");
    if (discovery.status !== "measured") {
      return;
    }
    // 10, not 35: counting the unknown bucket would over-report what we found,
    // and it would also push the analyzed total past its own population.
    expect(discovery.sessionsAnalyzed).toBe(10);
    expect(discovery.sources).toHaveLength(1);
  });

  it("withdraws the byte fallback when the inventory and estimate revisions disagree", () => {
    stubs.localState = readyState(
      measuredInventory({ inventoryRevision: 5 }),
      measuredEta({ inventoryRevision: 6, remainingBytes: 500 })
    );
    // No session counts from either source, so the byte lane is the only
    // possible route to a measured percentage.
    stubs.ingest = ingestProgress();

    const { result } = renderHook(() => useOnboardingSessionDiscovery(true));

    // A percent HERE could only come from dividing a numerator and a
    // denominator that describe two different sweeps.
    expect(result.current.progress).toEqual({
      status: OnboardingAnalysisProgressStatus.Unknown,
    });
  });

  it("degrades a measured estimate with no remainingMs to unavailable, never to zero minutes", () => {
    stubs.localState = readyState(
      measuredInventory(),
      measuredEta({ remainingMs: undefined })
    );

    const { result } = renderHook(() => useOnboardingSessionDiscovery(true));
    const { discovery } = result.current;

    expect(discovery.status).toBe("measured");
    if (discovery.status !== "measured") {
      return;
    }
    expect(discovery.estimate).toEqual({
      status: OnboardingAnalysisEstimateStatus.Unavailable,
    });
  });

  it("still yields a usable discovery from an inventory with no sessionsByHarness field", () => {
    // The shape an older desktop build sends: contract version 1 predates
    // ISS-8346's per-harness counts, so the key is absent, not empty. A real v1
    // payload carries a probe row per harness, and `evidence` is the field that
    // decides this case — defaulting it to `[]` would exercise the other branch.
    stubs.localState = readyState(
      measuredInventory({
        evidence: [
          {
            harness: OnboardingHarness.Claude,
            outcome: OnboardingHarnessOutcome.Measured,
          },
        ],
        physicalBytes: 4096,
      }),
      measuredEta({ remainingBytes: 400 })
    );

    const { result } = renderHook(() => useOnboardingSessionDiscovery(true));
    const { discovery } = result.current;

    expect(discovery.status).toBe("measured");
    if (discovery.status !== "measured") {
      return;
    }
    expect(discovery.logBytes).toBe(4096);
    // No count was reported for anything, so it is withheld rather than
    // fabricated as zero.
    expect(discovery.sessionsFound).toBeNull();
    // The byte fallback still divides: 600 of 1000 eligible bytes are done. A
    // v1 build cannot count sessions, and that is no reason to withhold the
    // percentage its bytes support (ISS-8346 ruling, 2026-09-04).
    expect(result.current.progress).toEqual({
      percent: 60,
      status: OnboardingAnalysisProgressStatus.Measured,
    });
  });

  it("derives the percentage from a PARTIAL sweep (ISS-8346 ruling 2026-09-04: an impaired probe does not erase the floor)", () => {
    // Tamsin's machine: OpenCode's probe reports an impairment, so the sweep
    // is `partial`, while Claude and Codex were measured whole. An earlier
    // revision mapped that to a short enumeration and withheld the percentage,
    // the estimate and the completion title from the approved screen.
    stubs.localState = readyState(
      measuredInventory({
        parseCompleteness: OnboardingInventoryCompleteness.Partial,
        sessionsByHarness: [
          { harness: OnboardingHarness.Claude, sessionCount: 40 },
          { harness: OnboardingHarness.Codex, sessionCount: 60 },
        ],
      }),
      measuredEta()
    );
    stubs.usage = usageStub({
      data: {
        byHarness: [
          { harness: OnboardingHarness.Claude, sessionCount: 40 },
          { harness: OnboardingHarness.Codex, sessionCount: 10 },
        ],
      },
      isLoading: false,
    });

    const { result } = renderHook(() => useOnboardingSessionDiscovery(true));
    const { discovery, progress } = result.current;

    expect(discovery.status).toBe("measured");
    if (discovery.status !== "measured") {
      return;
    }
    expect(discovery.sessionsFound).toBe(100);
    expect(discovery.estimate).toEqual({
      remainingMinutes: 1,
      status: OnboardingAnalysisEstimateStatus.Measured,
    });
    expect(progress).toEqual({
      percent: 50,
      status: OnboardingAnalysisProgressStatus.Measured,
    });

    // Negative control: a sweep that measured NOTHING still withdraws.
    stubs.localState = readyState(
      measuredInventory({
        parseCompleteness: OnboardingInventoryCompleteness.Unavailable,
        sessionsByHarness: [
          { harness: OnboardingHarness.Claude, sessionCount: 40 },
        ],
      }),
      measuredEta()
    );
    const { result: withdrawn } = renderHook(() =>
      useOnboardingSessionDiscovery(true)
    );
    expect(withdrawn.current.discovery.status).toBe("measured");
    if (withdrawn.current.discovery.status !== "measured") {
      return;
    }
    expect(withdrawn.current.discovery.sessionsFound).toBeNull();
  });
  it("states the parse percentage while the estimate is still CALCULATING (ISS-10624)", () => {
    // The window the bar exists for. Before this the only byte numerator on the
    // wire was `AnalysisEtaWire.remainingBytes`, which only a `measured`
    // estimate carries, so for the whole calculating window the renderer held
    // `eligibleParseBytes` and nothing to divide into it — and swept forever.
    stubs.localState = readyState(
      measuredInventory({ eligibleParseBytes: 1000, parsedBytes: 360 }),
      calculatingEta()
    );

    const { result } = renderHook(() => useOnboardingSessionDiscovery(true));

    expect(result.current.progress).toEqual({
      percent: 36,
      status: OnboardingAnalysisProgressStatus.Measured,
    });
  });

  it("prefers the transported numerator over the estimate's remainder", () => {
    // Both routes are available and they disagree, so the assertion can only
    // pass on one of them: 36 is the parse lane's own position, 90 would be the
    // estimate's remainder. A fallback-first order reads 90.
    stubs.localState = readyState(
      measuredInventory({ eligibleParseBytes: 1000, parsedBytes: 360 }),
      measuredEta({ remainingBytes: 100 })
    );

    const { result } = renderHook(() => useOnboardingSessionDiscovery(true));

    expect(result.current.progress).toEqual({
      percent: 36,
      status: OnboardingAnalysisProgressStatus.Measured,
    });
  });

  it("degrades exactly as before for a main process that sends no numerator", () => {
    // VERSION SKEW. An older main omits `parsedBytes` entirely, and the two
    // cases below are today's behaviour unchanged: a measured estimate still
    // carries a remainder and still divides; a calculating one carries none and
    // the percentage is withheld rather than invented.
    stubs.localState = readyState(
      measuredInventory({ eligibleParseBytes: 1000 }),
      measuredEta({ remainingBytes: 400 })
    );
    const { result: viaEta } = renderHook(() =>
      useOnboardingSessionDiscovery(true)
    );
    expect(viaEta.current.progress).toEqual({
      percent: 60,
      status: OnboardingAnalysisProgressStatus.Measured,
    });

    stubs.localState = readyState(
      measuredInventory({ eligibleParseBytes: 1000 }),
      calculatingEta()
    );
    const { result: viaNothing } = renderHook(() =>
      useOnboardingSessionDiscovery(true)
    );
    expect(viaNothing.current.progress).toEqual({
      status: OnboardingAnalysisProgressStatus.Unknown,
    });
  });

  it("withdraws a numerator larger than its own total rather than clamping it", () => {
    // A skewed or buggy producer. Clamping would render 100% — a completion
    // claim — so the older route answers instead, and a build with neither
    // would state nothing at all.
    stubs.localState = readyState(
      measuredInventory({ eligibleParseBytes: 1000, parsedBytes: 2000 }),
      measuredEta({ remainingBytes: 400 })
    );

    const { result } = renderHook(() => useOnboardingSessionDiscovery(true));

    expect(result.current.progress).toEqual({
      percent: 60,
      status: OnboardingAnalysisProgressStatus.Measured,
    });
  });

  it("reads the store as UNREAD, never as zero, until the local source reports ready", () => {
    // Seen live on 2026-09-04: for the first seconds after launch the main
    // process answered the usage read with no rows on a store holding 7,700
    // analyzed sessions, so the step read "0 analyzed" beside real counts,
    // put 0% on the bar and disabled Continue. A settled-looking empty answer
    // before readiness is not a measurement.
    stubs.localSource = LOCAL_SESSION_SOURCE_STATUSES.starting;
    stubs.localState = readyState(
      measuredInventory({
        sessionsByHarness: [
          { harness: OnboardingHarness.Claude, sessionCount: 40 },
        ],
      }),
      measuredEta()
    );
    stubs.usage = usageStub({ data: { byHarness: [] }, isLoading: false });

    const { result } = renderHook(() => useOnboardingSessionDiscovery(true));
    const { discovery, progress } = result.current;

    expect(discovery.status).toBe("measured");
    if (discovery.status !== "measured") {
      return;
    }
    expect(discovery.sessionsFound).toBe(40);
    expect(discovery.sessionsAnalyzed).toBeNull();
    expect(expectDetectedRow(discovery.sources[0]).analyzed).toBeNull();
    expect(progress).not.toEqual({
      percent: 0,
      status: OnboardingAnalysisProgressStatus.Measured,
    });

    // Positive control: the same empty answer AFTER readiness is a real zero.
    stubs.localSource = LOCAL_SESSION_SOURCE_STATUSES.ready;
    const { result: ready } = renderHook(() =>
      useOnboardingSessionDiscovery(true)
    );
    expect(ready.current.discovery.status).toBe("measured");
    if (ready.current.discovery.status !== "measured") {
      return;
    }
    expect(ready.current.discovery.sessionsAnalyzed).toBe(0);
    expect(ready.current.progress).toEqual({
      percent: 0,
      status: OnboardingAnalysisProgressStatus.Measured,
    });
  });
});

describe("PRD-689 discovery lifecycle gate", () => {
  it.each([
    ["unreported", null, false],
    ["ready empty store", ingestProgress(), false],
    ["preparing", ingestProgress({ preparing: true }), false],
    [
      "begun pass at zero",
      ingestProgress({
        byHarness: [{ harness: "claude", total: 950, processed: 0 }],
        total: 950,
      }),
      true,
    ],
    ["completed empty pass", ingestProgress({ complete: true }), true],
    ["timed out", ingestProgress({ timedOut: true }), true],
    ["retries exhausted", ingestProgress({ retriesExhausted: true }), true],
  ])("%s uses the producer lifecycle", (_name, ingest, started) => {
    stubs.ingest = ingest;
    stubs.localState = readyState(
      measuredInventory({
        sessionsByHarness: [
          { harness: OnboardingHarness.Claude, sessionCount: 950 },
        ],
      }),
      measuredEta()
    );
    stubs.usage = usageStub({ data: { byHarness: [] }, isLoading: false });
    const { result } = renderHook(() => useOnboardingSessionDiscovery(true));
    expect(result.current.progress).toEqual({
      status: OnboardingAnalysisProgressStatus.Measured,
      percent: 0,
    });
    expect(result.current.started).toBe(started);
  });
});

/**
 * ISS-10892: the approved "Session analysis started." subtext is three
 * sentences, and the middle one states a measured duration. It renders only for
 * an estimate that reached `Measured`, so the question the ticket asks is
 * whether the desktop producer can put one there at all.
 *
 * Driven through the REAL desktop hook into the REAL shared dialog, because the
 * seam is the subject: the ETA arrives as a wire payload, is folded by
 * `toEstimate`, carried through `foldOnboardingSessionDiscovery`, and composed
 * into the sentence by the step. A fixture that handed the step a ready-made
 * `estimate` would prove none of that.
 *
 * The sentences are written out here on purpose, and `getAnalysisDescription`
 * composes them from inline template literals with no constant to import — so
 * these ARE the pin, not a trip-wire over one. That is only safe on the PRESENT
 * case: a reword reddens it, which is the right failure. The ABSENT case must
 * not depend on the same literal, or a reword would make the regression it
 * exists to catch pass silently. So it is carried by `ANY_MINUTES`, which
 * matches a duration in any wording, and it reads the SAME rendered node the
 * present case asserts on, so it cannot pass by matching nothing.
 */
const FOUND_CLAUSE = "We found";
const SESSIONS_CLAUSE = "local sessions.";
const ESTIMATE_SENTENCE = "Full analysis is estimated to take 37 minutes.";
const BACKGROUND_SENTENCE =
  "You can start using Closedloop while we continue analyzing your logs in the background.";
/** Any minute count at all, so an absent estimate cannot invent one. */
const ANY_MINUTES = /\d+\s+minutes?\./;

const THIRTY_SEVEN_MINUTES_MS = 37 * 60_000;

/** Required by the dialog's props; this step renders none of them. */
const DOWNLOAD_HREFS = {
  linux: "https://downloads.test/Closedloop.AppImage",
  mac: "https://downloads.test/Closedloop-universal.dmg",
  windows: "https://downloads.test/Closedloop-Setup.exe",
} as const;

function analysisInventory(): MeasuredInventoryWire {
  return measuredInventory({
    eligibleParseBytes: 1000,
    parsedBytes: 400,
    physicalBytes: 2_400_000_000,
    sessionsByHarness: [
      { harness: OnboardingHarness.Claude, sessionCount: 270 },
    ],
  });
}

/** The subtext the desktop analysis step actually renders, as one string. */
function renderAnalysisSubtext(eta: AnalysisEtaWireShape): string {
  stubs.localState = readyState(analysisInventory(), eta);
  const { result } = renderHook(() => useOnboardingSessionDiscovery(true));
  render(
    <GuidedOnboardingDialog
      analysisStarted={true}
      brand={<span>Closedloop.ai</span>}
      discovery={result.current.discovery}
      downloadHrefs={DOWNLOAD_HREFS}
      onComplete={() => undefined}
      open
      phase={OnboardingPhase.SessionDiscovery}
      progress={result.current.progress}
    />
  );
  const description = screen
    .getByRole("dialog")
    .querySelector('[data-slot="dialog-description"]');
  if (!description) {
    throw new Error("analysis step rendered no description");
  }
  return description.textContent ?? "";
}

describe("desktop analysis subtext (ISS-10892)", () => {
  it("states the measured duration between the two approved sentences", () => {
    const subtext = renderAnalysisSubtext(
      measuredEta({ remainingMs: THIRTY_SEVEN_MINUTES_MS })
    );

    expect(
      screen.getByRole("heading", { name: "Session analysis started." })
    ).toBeTruthy();
    expect(subtext).toContain(FOUND_CLAUSE);
    expect(subtext).toContain(SESSIONS_CLAUSE);
    expect(subtext).toContain(ESTIMATE_SENTENCE);
    expect(subtext).toContain(BACKGROUND_SENTENCE);
    expect(subtext.indexOf(ESTIMATE_SENTENCE)).toBeLessThan(
      subtext.indexOf(BACKGROUND_SENTENCE)
    );
  });

  it("invents no duration while the estimate is still calculating", () => {
    const subtext = renderAnalysisSubtext(calculatingEta());

    // The same node the measured case reads, so this cannot pass by matching
    // nothing: the two flanking sentences are still there.
    expect(subtext).toContain(FOUND_CLAUSE);
    expect(subtext).toContain(BACKGROUND_SENTENCE);
    expect(subtext).not.toContain(ESTIMATE_SENTENCE);
    expect(subtext).not.toMatch(ANY_MINUTES);
  });
});
