/**
 * @file The desktop adapter behind the wizard's session-discovery screen
 * (ISS-8346).
 *
 * Composes the three reads that already ship — the onboarding local-state wire
 * (ISS-8376, carrying ISS-8506's bytes and ISS-8507's estimate), the runtime
 * ingest progress, and the local session store — and hands them to the pure fold
 * in `@repo/app`. Everything desktop-shaped stops HERE: the fold sees plain
 * numbers, plain string harness keys and an injected label function, so the
 * shared package never learns this app's vocabulary.
 *
 * Which makes this file the place the two vocabularies are held together. The
 * `Record`s below are exhaustive over the DESKTOP unions, so a member added to
 * either one fails `tsc` here until somebody says what the shared side should
 * render — the `SessionLimitSourceTwin` pattern, and the reason the shared
 * package can state its own union without that being drift by copy.
 */

import type { AgentSessionQueryFilters } from "@repo/app/agents/data-source/agent-sessions-data-source";
import {
  type OnboardingAnalysisEstimate,
  OnboardingAnalysisEstimateStatus,
  type OnboardingAnalysisProgress,
  type OnboardingSessionDiscovery,
} from "@repo/app/onboarding/components/guided-onboarding-data";
import { harnessDisplayLabel } from "@repo/app/onboarding/lib/harness-display-label";
import {
  foldOnboardingSessionDiscovery,
  OnboardingEnumerationQuality,
  type OnboardingHarnessSessions,
  type OnboardingParseBytes,
} from "@repo/app/onboarding/lib/onboarding-session-discovery";
import { useEffect, useMemo, useRef } from "react";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../shared/local-session-source-status";
import {
  type AnalysisEtaWireShape,
  OnboardingHarnessOutcome,
  OnboardingInventoryCompleteness,
  OnboardingInventoryStatus,
  type OnboardingInventoryWire,
} from "../../shared/onboarding-local-state-contract";
import { UNKNOWN_HARNESS_BUCKET } from "../../shared/shared-agent-sessions-contract";
import { AnalysisEtaKind } from "../../shared/transcript-analysis-eta-contract";
import { useLocalSessionSourceStatus } from "../components/sessions/sessions-view-source-status";
import { useLocalAgentSessionUsage } from "../components/sessions/use-local-agent-session-usage";
import { BOOT_IMPORT_STORE_POLL_MS } from "./boot-import-store-poll";
import { isBootImportSettled } from "./ingest-progress-terminal";
import { useIngestProgress } from "./use-ingest-progress";
import { useOnboardingLocalState } from "./use-onboarding-local-state";

/** Device-wide, like the tour's own summary: this describes the whole machine. */
const ALL_LOCAL_SESSIONS: AgentSessionQueryFilters = {};

/** Milliseconds in a minute, for turning the estimate into sentence units. */
const MS_PER_MINUTE = 60_000;

/**
 * VALUE-level twin: every estimate kind this app can send, mapped to what the
 * shared view model renders for it.
 *
 * An exhaustive `Record` cannot be written without naming every member, so a
 * kind added to `AnalysisEtaKind` fails `tsc` HERE rather than falling through
 * to a default branch and silently rendering as "unknown" — the silent-default
 * hole a `Set` or a `switch` with a default would leave open.
 */
const ETA_KIND_TO_ESTIMATE: Record<
  AnalysisEtaKind,
  OnboardingAnalysisEstimateStatus
> = {
  [AnalysisEtaKind.Measured]: OnboardingAnalysisEstimateStatus.Measured,
  [AnalysisEtaKind.Calculating]: OnboardingAnalysisEstimateStatus.Calculating,
  [AnalysisEtaKind.Unavailable]: OnboardingAnalysisEstimateStatus.Unavailable,
  [AnalysisEtaKind.Complete]: OnboardingAnalysisEstimateStatus.Complete,
};

/**
 * The same table as a `Map`, because the key comes off the wire.
 *
 * DERIVED from the exhaustive `Record` so a new kind is carried here for free.
 * A plain object indexed by an untrusted string is the hazard this avoids:
 * `kind: "__proto__"` resolves to `Object.prototype`, which is truthy.
 */
const ETA_KIND_LOOKUP = new Map<string, OnboardingAnalysisEstimateStatus>(
  Object.entries(ETA_KIND_TO_ESTIMATE)
);

/**
 * VALUE-level twin: how completely the inventory says it enumerated, mapped to
 * whether the shared fold may state the counts derived from it.
 *
 * `partial` maps to Whole by ruling (ISS-8346, 2026-09-04, option A): a sweep
 * with one impaired probe still measured everything else it walked, and the
 * approved screen states that floor rather than withholding its percentage and
 * estimate. Only a sweep that measured nothing withdraws.
 */
const COMPLETENESS_TO_QUALITY: Record<
  OnboardingInventoryCompleteness,
  OnboardingEnumerationQuality
> = {
  [OnboardingInventoryCompleteness.Complete]:
    OnboardingEnumerationQuality.Whole,
  [OnboardingInventoryCompleteness.Partial]: OnboardingEnumerationQuality.Whole,
  [OnboardingInventoryCompleteness.Unavailable]:
    OnboardingEnumerationQuality.Withdrawn,
};

/** The one arm of the inventory wire that carries measurements. */
type MeasuredInventoryWire = Extract<
  OnboardingInventoryWire,
  { status: typeof OnboardingInventoryStatus.Measured }
>;

export type OnboardingSessionDiscoveryRead = {
  discovery: OnboardingSessionDiscovery;
  progress: OnboardingAnalysisProgress;
  /**
   * Whether the boot import reached one of the producer's own terminals.
   *
   * Read from the terminal FLAGS, never from `byHarness` being non-empty: that
   * map persists for the whole manager lifetime — a settled pass stays in the
   * snapshot — so its non-emptiness is not a liveness claim (ISS-5281).
   */
  settled: boolean;
  /** PRD-689: a tracked import pass began, or boot import reached a terminal. */
  started: boolean;
};

/**
 * ISS-8346 — what the discovery step and the analysis banner render.
 *
 * `active` gates all three reads, and it is what a host that does not want them
 * passes `false`. It is NOT a claim that these reads are taken once: the local
 * state re-reads every `ONBOARDING_LOCAL_STATE_POLL_MS` and the ingest progress
 * every second, both for as long as `active` holds, which on this app's only
 * caller is the whole session.
 *
 * The analyzed read below is the narrowest of the three — it is the only one
 * that STOPS, at the boot import's own terminal. Reviewers have read the older
 * wording here as "nothing in this hook may poll" and proposed gating that read
 * on the discovery STEP being on screen; that would be wrong, because the
 * analysis banner renders the same advancing count and is deliberately mounted
 * across phases and past the wizard's exit (`guided-onboarding-dialog-host.tsx`
 * — "ADDITIVE to and orthogonal to the wizard beneath it"). Freezing the read
 * outside the step would put the ISS-10584 defect back on the surface that
 * outlives the step.
 */
export function useOnboardingSessionDiscovery(
  active: boolean,
  attemptId?: string
): OnboardingSessionDiscoveryRead {
  const localState = useOnboardingLocalState(active, attemptId);
  const ingest = useIngestProgress(active);
  // The store read waits for the local source to report READY — the same probe
  // the Sessions view gates on. Before that the main process answers the usage
  // read with no rows, which the fold would take as a measured zero: on a
  // machine holding 7,700 analyzed sessions the step read "0 analyzed" beside
  // real found counts, put 0% on the bar and disabled Continue until the next
  // poll (seen live on 2026-09-04). Unread is `null`, never `0`.
  const { status: localSourceStatus } = useLocalSessionSourceStatus();
  const localSourceReady =
    localSourceStatus === LOCAL_SESSION_SOURCE_STATUSES.ready;
  // ISS-10584: derived here rather than inside the memo below because it also
  // decides whether the analyzed read polls, and the read is taken above it.
  const settled = isBootImportSettled(ingest);
  const usage = useLocalAgentSessionUsage(ALL_LOCAL_SESSIONS, {
    enabled: active && localSourceReady,
    // The store gains a `sessions` row at the head of each session's import (the
    // FK-parent `session_main_agent` group commits in its own transaction, ahead
    // of the `events` group that carries the cost), so this read moves per
    // SESSION. Taken once, as it was, it froze at whatever the store held when
    // the step mounted — zero on a cold first launch, which is the ticket's
    // "0 analyzed for minutes, then 100%". Nothing about the import changed; the
    // renderer simply never asked again.
    refetchInterval: settled ? false : BOOT_IMPORT_STORE_POLL_MS,
  });
  const refetchUsage = usage.refetch;
  // ISS-10584: clearing a refetch interval does not itself issue a fetch, and
  // this client holds `staleTime: Infinity` with no focus/reconnect refetch, so
  // without this the number the step keeps FOREVER is the last poll — taken up
  // to one interval before the final session committed. That renders as a
  // settled, measured "8 of 10" over a finished import, which is the arriving
  // value being published as the complete one. One read on the settle edge is
  // what makes the terminal figure the store's own.
  const settledReadTaken = useRef(false);
  useEffect(() => {
    if (!(settled && active && localSourceReady)) {
      settledReadTaken.current = false;
      return;
    }
    if (settledReadTaken.current) {
      return;
    }
    settledReadTaken.current = true;
    // A rejected read leaves the last successful count standing, which is a
    // real measurement one poll old rather than a fabricated one; nothing here
    // may log it, because this module is browser code.
    refetchUsage().catch(() => undefined);
  }, [active, localSourceReady, refetchUsage, settled]);

  const snapshot = localState.state === "ready" ? localState.snapshot : null;
  const inventory = snapshot?.inventory ?? null;
  const analysisEta = snapshot?.analysisEta ?? null;
  const usageByHarness = usage.data?.byHarness;
  const usageSettled = localSourceReady && !usage.isLoading;

  return useMemo(() => {
    const measured =
      inventory?.status === OnboardingInventoryStatus.Measured
        ? inventory
        : null;
    return {
      ...foldOnboardingSessionDiscovery({
        absent: absentHarnesses(measured),
        analyzed: analyzedSessions(usageByHarness, usageSettled),
        bytes: parseBytes(measured, analysisEta),
        estimate: toEstimate(analysisEta),
        found: discoveredSessions(measured),
        label: harnessDisplayLabel,
        logBytes: measured?.physicalBytes ?? null,
        quality: enumerationQuality(measured),
      }),
      settled: isBootImportSettled(ingest),
      // beginPass creates these rows; inventory/store denominators do not.
      started:
        isBootImportSettled(ingest) || (ingest?.byHarness.length ?? 0) > 0,
    };
  }, [analysisEta, ingest, inventory, usageByHarness, usageSettled]);
}

/** The estimate this build can state from the wire's own kind. */
function toEstimate(
  eta: AnalysisEtaWireShape | null
): OnboardingAnalysisEstimate {
  if (eta === null) {
    return { status: OnboardingAnalysisEstimateStatus.Unknown };
  }
  const status = ETA_KIND_LOOKUP.get(eta.kind);
  if (status === undefined) {
    return { status: OnboardingAnalysisEstimateStatus.Unknown };
  }
  if (status !== OnboardingAnalysisEstimateStatus.Measured) {
    return { status };
  }
  // A measured kind whose number did not survive the boundary is not a measured
  // estimate. Substituting zero would report "0 minutes" — a completion claim —
  // for a duration nobody produced.
  if (eta.remainingMs === undefined) {
    return { status: OnboardingAnalysisEstimateStatus.Unavailable };
  }
  return {
    remainingMinutes: eta.remainingMs / MS_PER_MINUTE,
    status: OnboardingAnalysisEstimateStatus.Measured,
  };
}

/**
 * Sessions discovered per harness, from the wire and nowhere else.
 *
 * Neither other lane can supply a count. The ingest total is
 * `pendingSources.length` (`beginPass` in `collector-manager-pass-scan.ts`), the
 * population left AFTER the already-imported and unchanged sources were dropped,
 * which equals the corpus only on a cold first import. The store read counts
 * what has been ANALYZED, which is a different population from what is on disk.
 * So a harness the inventory does not count (Cursor, Copilot) has no counted
 * row and is outside the total; the screen states the floor it measured
 * (ISS-8346 ruling, 2026-09-04) and lists the rest as unreported (ISS-11346).
 */
function discoveredSessions(
  measured: MeasuredInventoryWire | null
): readonly OnboardingHarnessSessions[] | null {
  const found = (measured?.sessionsByHarness ?? []).map(
    (entry): OnboardingHarnessSessions => ({
      harness: entry.harness,
      sessions: entry.sessionCount,
    })
  );
  // NO rows is not "zero sessions": the inventory has not reported, so the
  // step must say the count is unavailable rather than that the machine is
  // empty.
  return found.length > 0 ? found : null;
}

/** Sessions already in the local store, or `null` while that read is in flight. */
function analyzedSessions(
  byHarness: readonly { harness: string; sessionCount: number }[] | undefined,
  settled: boolean
): readonly OnboardingHarnessSessions[] | null {
  if (!settled || byHarness === undefined) {
    return null;
  }
  return (
    byHarness
      // The `unknown` bucket merges NULL-harness rows with rows whose harness
      // column literally said "unknown". Neither is a tool the user installed,
      // so counting it would over-report what we found — the same filter
      // `useTourHarnesses` applies for the same reason.
      .filter(
        (row) => row.harness !== UNKNOWN_HARNESS_BUCKET && row.sessionCount > 0
      )
      .map((row) => ({ harness: row.harness, sessions: row.sessionCount }))
  );
}

/** Harnesses the sweep PROVED are not installed. */
function absentHarnesses(
  measured: MeasuredInventoryWire | null
): readonly string[] {
  return (measured?.evidence ?? [])
    .filter((entry) => entry.outcome === OnboardingHarnessOutcome.Absent)
    .map((entry) => entry.harness);
}

/** Whether the counts derived from this inventory may be stated at all. */
function enumerationQuality(
  measured: MeasuredInventoryWire | null
): OnboardingEnumerationQuality {
  if (measured === null) {
    return OnboardingEnumerationQuality.Withdrawn;
  }
  return COMPLETENESS_TO_QUALITY[measured.parseCompleteness];
}

/**
 * The byte remainder and its denominator, supplied only when both describe the
 * SAME sweep.
 *
 * TWO ROUTES TO THE NUMERATOR, preferred in the order of how much they claim.
 * The inventory's own `parsedBytes` (ISS-10624) is the parse lane's position,
 * reported on every read and independent of whether a TIME can be estimated; it
 * is preferred because the older route carries a numerator only on a `measured`
 * ETA, so for the whole `calculating` window — the window a progress bar exists
 * for — the renderer held a denominator and nothing to divide into it, and the
 * bar swept indefinitely over a percentage that was computable all along.
 *
 * The ETA route stays as the VERSION-SKEW fallback: a main process older than
 * `parsedBytes` sends no such field, and it must degrade to exactly what it does
 * today rather than losing the percentage it can still support.
 *
 * The two revisions are one fact stated twice, and dividing a numerator from one
 * sweep by a denominator from another is a fabricated measurement that can land
 * outside 0..100. The wire parser already withdraws a mismatched pair, so this
 * is the second holder of that invariant rather than the only one — and it is
 * the one that would still be right if this hook were ever fed a snapshot from
 * somewhere else. The preferred route needs no such check: its numerator and
 * denominator are two fields of ONE inventory arm, so they name one sweep
 * structurally. What it does check is the arithmetic invariant the boundary
 * parser cannot see across sibling fields — a numerator past its own total is a
 * skewed or buggy producer, and the honest answer there is the older route or
 * none, never a clamp.
 */
function parseBytes(
  measured: MeasuredInventoryWire | null,
  eta: AnalysisEtaWireShape | null
): OnboardingParseBytes | null {
  if (measured === null) {
    return null;
  }
  const parsed = measured.parsedBytes;
  if (parsed !== undefined && parsed <= measured.eligibleParseBytes) {
    return {
      eligible: measured.eligibleParseBytes,
      remaining: measured.eligibleParseBytes - parsed,
    };
  }
  if (eta === null) {
    return null;
  }
  if (eta.kind !== AnalysisEtaKind.Measured) {
    return null;
  }
  if (eta.remainingBytes === undefined) {
    return null;
  }
  if (measured.inventoryRevision !== eta.inventoryRevision) {
    return null;
  }
  return {
    eligible: measured.eligibleParseBytes,
    remaining: eta.remainingBytes,
  };
}
