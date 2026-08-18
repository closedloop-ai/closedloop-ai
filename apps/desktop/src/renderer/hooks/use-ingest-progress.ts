import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useEffect, useRef, useState } from "react";
import {
  type AgentMonitorRuntimeStatus,
  AgentMonitorRuntimeStatusKind,
} from "../../shared/agent-monitor-status";
import {
  type CloudSyncBacklog,
  CloudSyncBacklogState,
  resolveCloudSyncBacklog,
} from "../../shared/cloud-read-readiness-contract";
import { CloudSocketState } from "../../shared/cloud-socket-error";
import { DESKTOP_STOPPED_LANE_READINESS_FEATURE_FLAG_KEY } from "../../shared/stopped-lane-readiness-flag";
import {
  describeAllLaneRemainders,
  describeItemsRemaining,
  describeLaneRemainders,
  describeUndeliverableItems,
} from "../components/import-progress-display";
import { parseCloudReadReadinessBacklog } from "./parse-cloud-read-readiness";
import {
  type MaintenanceProgress,
  parseMaintenanceProgress,
} from "./parse-maintenance-progress";

export type HarnessIngest = {
  harness: string;
  total: number;
  processed: number;
};
export type IngestProgress = {
  byHarness: HarnessIngest[];
  total: number;
  processed: number;
  // A first-pass import has begun but the source scan has not yet produced a
  // total; the banner shows an indeterminate "preparing" state for this.
  preparing: boolean;
  /**
   * ISS-5281: the main process reporting that every first pass it began has
   * ENDED, no source scan is running, and nothing was left for retry. The banner
   * needs this producer-owned answer because the equivalent renderer-side
   * inference (`processed >= total && !preparing`) is not the same claim — see
   * `IngestProgressSnapshot.drained` for the three reachable ways it lies.
   * Optional so an older main process that never sends the field degrades to
   * `undefined`, treated as NOT drained: the splash then reports the stall as a
   * failure exactly as it did before, which is the honest direction when we
   * cannot prove the queue emptied.
   */
  drained?: boolean;
  // ISS-5115: the import loop has ACKNOWLEDGED a user pause by actually parking
  // on its pause gate. `paused` in the UI is a request; this is the collector
  // confirming it stopped. They diverge for as long as the loop takes to reach
  // its next gate, which during first-launch source discovery is the whole scan.
  // Optional so an older main process that never sends the field degrades to
  // `undefined` — treated as "not yet acknowledged", which under-claims and is
  // the safe direction.
  importParked?: boolean;
  // Every harness's boot import has finished. The banner relies on this rather
  // than aggregate `processed >= total`, which is briefly true between the
  // staggered per-harness passes.
  complete: boolean;
  // FEA-4156: the boot import gave up without settling — a harness import wedged
  // and the main-process watchdog timed out. Distinct from `complete`: no
  // post-boot maintenance runs, and the splash resolves into its graceful
  // partial-import (failed) state. Optional so an older main process that never
  // sends the field degrades to `false` (undefined) rather than mis-reporting.
  timedOut?: boolean;
  // ISS-4444: transcripts quarantined after their parse wedged repeatedly (a
  // CPU-spinning parser on a poison transcript). The boot import COMPLETES with
  // these skipped; the count lets the summary honestly surface "N transcripts
  // couldn't be read" instead of silently under-counting. Optional so an older
  // main process that never sends the field degrades to `undefined` (treated as 0).
  quarantinedCount?: number;
  // ISS-6115: the same population split by the stage that quarantined it. The
  // count above changed meaning when the import bound started charging the
  // quarantine store — an import stall means the transcript WAS read and its
  // WRITE did not finish — so "couldn't be read" is only true of `parse`.
  // Optional and per-key optional: an older main process sends neither, which
  // `resolveQuarantinedStageCounts` degrades to the pre-ISS-6115 reading (the
  // whole population attributed to `parse`, which is what it was).
  quarantinedByStage?: { parse?: number; import?: number };
};

// FEA-2264: the post-boot maintenance phase the main process is currently
// running (data-revision rebuild, then artifact-link backfill), or none.
// ISS-6241 moved the shape and its validation to `parse-maintenance-progress.ts`
// once it began carrying counts the splash does arithmetic on; re-exported here
// so existing importers keep resolving.
export type { MaintenanceProgress } from "./parse-maintenance-progress";

const INGEST_POLL_MS = 1000;

/**
 * The subset of the desktop runtime-status payload this file projects. The
 * `desktopApi` IPC boundary is typed `Promise<unknown>` (`desktop-api.d.ts`), so
 * the shape is asserted once, here. The payload is our own main-process output
 * (`app.ts` → `desktop:get-runtime-status`), shipped in the same package as this
 * renderer, so its field shapes are trusted rather than re-validated field by
 * field. The one guard is against a missing payload (before the first poll
 * resolves), which degrades each projection to `null`.
 */
type RuntimeStatusPayload = {
  ingest?: IngestProgress | null;
  // ISS-6241: `unknown` at the boundary, not the trusted shape — it is validated
  // field by field in `parseMaintenanceProgress` now that it carries the counts
  // the Compute step renders.
  maintenance?: unknown;
  cloudStatus?: unknown;
  cloudSync?: CloudSyncProgress | null;
  // ISS-5768: the whole-app, all-lanes backlog. `unknown` at the boundary, not
  // the trusted shape (wongk review): it is validated field by field in
  // `parseCloudReadReadinessBacklog`, because a partial or version-skewed object
  // reaching `resolveCloudSyncBacklog` threw inside the shared poll's fan-out
  // loop and starved every listener behind it. Absent or invalid degrades to an
  // `unknown` backlog, which renders as "Checking…" and never as "Up to date".
  cloudReadReadiness?: unknown;
  fileAccessBlocks?: FileAccessBlock[] | null;
  // ISS-4714: validated element-by-element in `parseAgentMonitorStatus`, so this
  // is `unknown` at the boundary rather than the trusted shape (an older main
  // process omits it; a malformed/future `kind` must degrade, not throw).
  agentMonitor?: unknown;
};

function readRuntimeStatus(status: unknown): RuntimeStatusPayload {
  return typeof status === "object" && status !== null
    ? (status as RuntimeStatusPayload)
    : {};
}

/**
 * Project the first-pass ingest progress out of the runtime-status payload, or
 * null when it is absent (the Agent Dashboard runtime is not up yet). Shared by
 * the first-launch dashboard loading treatment and the app-wide import banner so
 * the two never drift.
 */
export function parseIngest(status: unknown): IngestProgress | null {
  return readRuntimeStatus(status).ingest ?? null;
}

/**
 * Project the post-boot maintenance phase out of the runtime-status payload, or
 * null when the field is absent (older main process, or the Agent Dashboard
 * runtime is not up yet). The first-launch banner treats null as "no
 * maintenance" rather than latching the calm state on.
 */
export function parseMaintenance(status: unknown): MaintenanceProgress | null {
  // ISS-6241: validated, not cast. The payload now carries the numerator and
  // denominator the Compute step renders, so an unvalidated shape is how a
  // total the pass cannot substantiate reaches the screen.
  return parseMaintenanceProgress(readRuntimeStatus(status).maintenance);
}

// FEA-2264: a single shared poll of the main-process runtime status. Every
// status-derived hook subscribes to this one poller, so a component that mounts
// several of them (the first-launch banner reads both ingest and maintenance)
// makes one getRuntimeStatus IPC round-trip per interval instead of one per
// hook. The interval starts on the first subscriber and stops once the last one
// leaves, so it never polls while nothing is watching.
type RuntimeStatusListener = (status: unknown) => void;
const runtimeStatusListeners = new Set<RuntimeStatusListener>();
let runtimeStatusInterval: number | null = null;
let lastRuntimeStatus: unknown;
let hasRuntimeStatus = false;

function emitRuntimeStatus(status: unknown): void {
  lastRuntimeStatus = status;
  hasRuntimeStatus = true;
  for (const listener of runtimeStatusListeners) {
    listener(status);
  }
}

function pollRuntimeStatusOnce(): void {
  // Defensive optional-chaining at the single call site: `desktopApi` — and the
  // `getRuntimeStatus` method itself — is typed non-optional but can be absent
  // in test/SSR contexts or on an older preload (version skew). Guarding the
  // method call keeps a missing method from throwing synchronously and taking
  // down every status-derived hook subscribed to this shared poll.
  const pending = window.desktopApi?.getRuntimeStatus?.();
  pending?.then(emitRuntimeStatus).catch(() => undefined);
}

function subscribeRuntimeStatus(listener: RuntimeStatusListener): () => void {
  runtimeStatusListeners.add(listener);
  // Replay the latest status so a late subscriber paints immediately rather
  // than waiting a full interval for the next poll.
  if (hasRuntimeStatus) {
    listener(lastRuntimeStatus);
  }
  if (runtimeStatusInterval === null) {
    pollRuntimeStatusOnce();
    runtimeStatusInterval = window.setInterval(
      pollRuntimeStatusOnce,
      INGEST_POLL_MS
    );
  }
  return () => {
    runtimeStatusListeners.delete(listener);
    if (runtimeStatusListeners.size === 0 && runtimeStatusInterval !== null) {
      window.clearInterval(runtimeStatusInterval);
      runtimeStatusInterval = null;
    }
  };
}

/**
 * Subscribe to the shared runtime-status poll and project each payload through
 * `parse` while `active`. Returns null until the first response. `parse` must be
 * a stable reference (a module-level parser), since it participates in the
 * effect dependencies.
 */
function useRuntimeStatusValue<T>(
  active: boolean,
  parse: (status: unknown) => T | null
): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    if (!active) {
      return;
    }
    let cancelled = false;
    const unsubscribe = subscribeRuntimeStatus((status) => {
      if (!cancelled) {
        setValue(parse(status));
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [active, parse]);
  return value;
}

/** Polls the main-process ingest progress while `active`. */
export function useIngestProgress(active: boolean): IngestProgress | null {
  return useRuntimeStatusValue(active, parseIngest);
}

/**
 * Polls the main-process post-boot maintenance phase while `active`. Returns
 * null until the first response (and whenever the field is absent), so the
 * banner treats "unknown" as "no maintenance" rather than latching the calm
 * state on. Defensive against a missing `desktopApi` (test/SSR contexts).
 */
export function useMaintenanceProgress(
  active: boolean
): MaintenanceProgress | null {
  return useRuntimeStatusValue(active, parseMaintenance);
}

// FEA-2733: content-blind local→cloud sync progress for the "syncing your
// history" indicator. Mirrors the main-side `AgentSessionSyncProgress`; the
// renderer projects it out of the runtime-status payload, degrading to null
// (indicator hidden) when the field is absent — e.g. an older main process —
// rather than showing a spurious "up to date".
export type CloudSyncProgress = {
  identified: boolean;
  pendingBackfillSessions: number;
  pendingIncrementalSessions: number;
  backfilling: boolean;
  caughtUp: boolean;
  deadLetteredSessions: number;
  // ISS-4542: component-inventory rows dead-lettered to the back of their lane
  // after repeated send failures. Optional so an older main process that never
  // emits the field degrades to `0` rather than mis-reporting. Folded into the
  // same "synced with issues" warning as `deadLetteredSessions`.
  deadLetteredComponents?: number;
};

/**
 * Project the local→cloud sync progress out of the runtime-status payload, or
 * null when the field is absent (older main process → indicator hidden). Drives
 * the Settings → Connection Status "History Sync" cell.
 */
export function parseCloudSync(status: unknown): CloudSyncProgress | null {
  return readRuntimeStatus(status).cloudSync ?? null;
}

/** The backlog nobody has measured yet. Never mistaken for a drained one. */
const UNKNOWN_BACKLOG: CloudSyncBacklog = resolveCloudSyncBacklog(null);

/**
 * ISS-5768: project the whole-app backlog out of the runtime-status payload.
 * An absent `cloudReadReadiness` (older main process) resolves to the `unknown`
 * backlog rather than a drained one — the whole point of this ticket is that
 * "nobody has looked" and "nothing is owed" are different answers.
 *
 * The field is VALIDATED, not asserted (wongk review): the same answer covers a
 * partial or version-skewed object, which previously threw here and — inside the
 * shared poll's single fan-out loop — starved every listener behind it while the
 * last good value stayed cached on screen.
 */
export function parseCloudSyncBacklog(status: unknown): CloudSyncBacklog {
  return parseCloudReadReadinessBacklog(
    readRuntimeStatus(status).cloudReadReadiness
  );
}

/**
 * ISS-6206: the same projection with strict lane readiness — a lane that never
 * ran cannot round the app up to "Up to date", and the remainder comes back as
 * per-lane counts. Declared at module level beside its sibling because
 * `useRuntimeStatusValue` requires a STABLE parser reference; selecting between
 * two constants keeps the poll subscription from tearing down on every render.
 */
export function parseStrictCloudSyncBacklog(status: unknown): CloudSyncBacklog {
  return parseCloudReadReadinessBacklog(
    readRuntimeStatus(status).cloudReadReadiness,
    { strictLaneReadiness: true }
  );
}

export type CloudSyncStatusTone = "pending" | "success" | "warning" | "muted";
export type CloudSyncStatusDescription = {
  /** Compact cell label, e.g. "Syncing (12)" / "Up to date". */
  label: string;
  /** Longer phrasing for a tooltip / aria-label. */
  detail: string;
  tone: CloudSyncStatusTone;
};

/**
 * Map the cloud-sync snapshot to a compact status label + tone for the
 * Settings → Connection Status "History Sync" cell. Pure (no React) so it is
 * unit-testable in isolation. `null` (older main process / not yet polled) and
 * the signed-out/offline case both degrade to a muted "—".
 *
 * ISS-5768: `backlog` is REQUIRED, and it — not `progress.caughtUp` — decides
 * whether this cell may say "Up to date".
 *
 * `caughtUp` is the session backfill/incremental queues and nothing else: one of
 * the five lanes in `main/sync/AGENTS.md`. `progress`'s two dead-letter fields
 * cover two of the five. Driving a whole-app completeness claim off either meant
 * this cell read "Up to date" on a machine owing 2,985 component-inventory rows
 * with one item dead-lettered in a lane `progress` cannot even represent —
 * beside a `Cloud (partial)` badge reading the whole-app aggregate and saying so
 * plainly. Two indicators, one screen, opposite answers.
 *
 * So the completeness claim now comes from {@link resolveCloudSyncBacklog} over
 * every lane, and the parameter is required rather than optional precisely so a
 * future caller cannot omit it and silently inherit the per-lane claim again.
 * `progress` is still read, for the identity gate and as the never-under-report
 * floor on dead-letters below.
 */
export function describeCloudSyncStatus(
  progress: CloudSyncProgress | null,
  backlog: CloudSyncBacklog
): CloudSyncStatusDescription {
  if (progress === null || !progress.identified) {
    return { label: "—", detail: "Not connected to the cloud", tone: "muted" };
  }
  const couldNotSyncDetail = describeCouldNotSync(progress, backlog);
  switch (backlog.state) {
    case CloudSyncBacklogState.Drained:
      // Every lane owes nothing. `Drained` implies a whole-app dead-letter count
      // of zero, but the per-lane floor can still be non-zero across the one
      // sample the 60s burn-down has yet to take, so the warning still wins.
      return couldNotSyncDetail
        ? {
            label: "Synced with issues",
            detail: couldNotSyncDetail,
            tone: "warning",
          }
        : {
            label: "Up to date",
            detail: "Your history is synced to your workspace",
            tone: "success",
          };
    case CloudSyncBacklogState.Outstanding:
      return describeOutstandingBacklog(backlog, couldNotSyncDetail);
    case CloudSyncBacklogState.Abandoned:
      // Nothing left to attempt, and a lane gave up — which is what `Abandoned`
      // MEANS, so `couldNotSyncDetail` is always non-null here.
      return {
        label: "Synced with issues",
        detail: couldNotSyncDetail ?? "",
        tone: "warning",
      };
    case CloudSyncBacklogState.Unknown:
      return describeUnverifiedBacklog(couldNotSyncDetail);
    default: {
      // A state added later must fail `tsc` here rather than silently inherit
      // the "Checking…" branch — the closed union lives in another module.
      const unhandled: never = backlog.state;
      return describeUnverifiedBacklog(couldNotSyncDetail, unhandled);
    }
  }
}

/**
 * The cell for "we cannot establish that nothing is owed": the burn-down has
 * taken no sample yet (the first ~60s of every launch — ISS-5749), or a lane
 * could not measure or classify its own remainder.
 *
 * It deliberately does NOT say "Synced with issues" even when a dead-letter is
 * known. "Synced" is a completeness claim, and this branch is the one where
 * completeness is exactly what has not been established — asserting it here
 * would be the ISS-5768 defect moved one branch over. It reports the abandoned
 * item, which IS established, and says the rest is still being checked.
 */
function describeUnverifiedBacklog(
  couldNotSyncDetail: string | null,
  _unhandled?: never
): CloudSyncStatusDescription {
  if (couldNotSyncDetail) {
    return {
      label: "Sync issues",
      detail: `${couldNotSyncDetail} Still checking whether the rest of your history is synced.`,
      tone: "warning",
    };
  }
  return {
    label: "Checking…",
    detail: "Checking whether your history is fully synced",
    tone: "muted",
  };
}

/**
 * Polls the main-process local→cloud sync progress while `active`, so the
 * Settings → Connection Status "History Sync" cell advances live as a backfill
 * drains instead of pinning at the value captured when the tab mounted. Returns
 * null until the first response (and whenever the field is absent). Subscribes
 * to the same shared 1s poller as the ingest/maintenance hooks — no extra
 * getRuntimeStatus round-trip per interval.
 */
export function useCloudSyncProgress(
  active: boolean
): CloudSyncProgress | null {
  return useRuntimeStatusValue(active, parseCloudSync);
}

/**
 * ISS-5768: project the whole-app, all-lanes backlog out of the runtime-status
 * payload. Rides the same shared 1s poller as the sibling hooks — no extra
 * getRuntimeStatus round-trip — and is what any "is sync finished?" claim must
 * consult instead of the session-lane-only `caughtUp`.
 *
 * Never returns null: an absent field (older main process) or an unsampled
 * burn-down both resolve to an `unknown` backlog, which callers must render as
 * unverified rather than as complete.
 */
export function useCloudSyncBacklog(active: boolean): CloudSyncBacklog {
  // ISS-6206, closed by default: without the Labs opt-in this resolves exactly
  // as it did before, so a stopped lane still counts toward "Up to date" and the
  // cell still prints the cross-lane total. Optional rather than strict because
  // this hook is mounted from sites with no `FeatureFlagAdapterProvider`
  // ancestor (the runtime-status poll tests, Storybook); the strict hook throws
  // there, and `false` — the closed default — is the right answer for a mount
  // site that cannot resolve the flag at all.
  const strictLaneReadiness = useFeatureFlagEnabledOptional(
    DESKTOP_STOPPED_LANE_READINESS_FEATURE_FLAG_KEY
  );
  return (
    useRuntimeStatusValue(
      active,
      strictLaneReadiness ? parseStrictCloudSyncBacklog : parseCloudSyncBacklog
    ) ?? UNKNOWN_BACKLOG
  );
}

export const CloudStatusKind = {
  ...CloudSocketState,
  Unknown: "unknown",
} as const;

export type CloudStatusKind =
  (typeof CloudStatusKind)[keyof typeof CloudStatusKind];

export type CloudStatus =
  | { kind: typeof CloudStatusKind.Degraded; error: string }
  | { kind: typeof CloudStatusKind.Idle }
  | { kind: typeof CloudStatusKind.Online }
  | { kind: typeof CloudStatusKind.Unknown };

const IDLE_CLOUD_STATUS: CloudStatus = { kind: CloudStatusKind.Idle };
const ONLINE_CLOUD_STATUS: CloudStatus = { kind: CloudStatusKind.Online };
const UNKNOWN_CLOUD_STATUS: CloudStatus = { kind: CloudStatusKind.Unknown };
const DEFAULT_CLOUD_CONNECTION_ERROR = "Cloud connection failed";

/**
 * Project the cloud socket state from runtime status. A missing field returns
 * null so an older preload/main-process pair remains compatible, while a
 * present but malformed or future state becomes `unknown` instead of being
 * mistaken for idle, online, or degraded.
 */
export function parseCloudStatus(status: unknown): CloudStatus | null {
  const cloudStatus = readRuntimeStatus(status).cloudStatus;
  if (cloudStatus === undefined || cloudStatus === null) {
    return null;
  }
  if (
    typeof cloudStatus !== "object" ||
    !("state" in cloudStatus) ||
    typeof cloudStatus.state !== "string"
  ) {
    return UNKNOWN_CLOUD_STATUS;
  }
  if (cloudStatus.state === CloudStatusKind.Idle) {
    return IDLE_CLOUD_STATUS;
  }
  if (cloudStatus.state === CloudStatusKind.Online) {
    return ONLINE_CLOUD_STATUS;
  }
  if (cloudStatus.state === CloudStatusKind.Degraded) {
    const error =
      "error" in cloudStatus &&
      typeof cloudStatus.error === "string" &&
      cloudStatus.error.trim().length > 0
        ? cloudStatus.error
        : DEFAULT_CLOUD_CONNECTION_ERROR;
    return { kind: CloudStatusKind.Degraded, error };
  }
  return UNKNOWN_CLOUD_STATUS;
}

/**
 * Polls the main-process cloud socket state while `active`. This subscribes to
 * the existing shared one-second runtime-status poll, so Settings can update
 * after mount without adding another IPC round-trip per interval.
 */
export function useCloudStatus(active: boolean): CloudStatus | null {
  return useRuntimeStatusValue(active, parseCloudStatus);
}

// FEA-3639: a harness transcript root the desktop main process could not read —
// a denied macOS file-access prompt, surfaced so the Sessions view can say so
// explicitly instead of stalling silently. Mirrors the main-side `FileAccessBlock`.
export type FileAccessBlock = {
  /** Harness key (e.g. `"codex"`) whose root is unreadable. */
  harness: string;
  /** The unreadable root, home-abbreviated (e.g. `~/.codex/sessions`). */
  path: string;
};

// Stable empty reference so the (overwhelmingly common) unblocked case never
// churns a re-render: the shared poll re-runs `parse` every second, so returning
// a fresh `[]` each time would re-render every Sessions subscriber once a second.
const NO_FILE_ACCESS_BLOCKS: FileAccessBlock[] = [];

/**
 * Project the file-access blocks out of the runtime-status payload. Degrades to
 * the stable empty array when the field is absent (an older main process → the
 * prompt stays hidden), matching the additive-field degrade of the sibling
 * projections. Entries are validated element-by-element (review fix): this is an
 * IPC boundary, so a version-skewed payload such as `[null]` must be dropped
 * here rather than reaching the banner and throwing on `block.harness`.
 */
export function parseFileAccessBlocks(status: unknown): FileAccessBlock[] {
  const blocks = readRuntimeStatus(status).fileAccessBlocks;
  if (!Array.isArray(blocks)) {
    return NO_FILE_ACCESS_BLOCKS;
  }
  const valid = blocks.filter(isFileAccessBlock);
  // Reuse the stable empty reference when nothing survives, so the common
  // (unblocked / all-malformed) case never churns a re-render every poll.
  return valid.length > 0 ? valid : NO_FILE_ACCESS_BLOCKS;
}

/**
 * Polls the main-process file-access blocks while `active`. Returns the stable
 * empty array until the first response (and whenever nothing is blocked), so the
 * Sessions prompt appears only when a root is genuinely unreadable and clears on
 * the next poll once the user grants access.
 */
export function useFileAccessBlocks(active: boolean): FileAccessBlock[] {
  return (
    useRuntimeStatusValue(active, parseFileAccessBlocks) ??
    NO_FILE_ACCESS_BLOCKS
  );
}

/**
 * ISS-4542/ISS-5768: build the "could not sync" tail for the History Sync
 * detail. Returns null when nothing was dead-lettered (the clean "Up to date" /
 * "Syncing" path).
 *
 * The count is the WHOLE-APP dead-letter total, floored by the two per-lane
 * counts `progress` carries. ISS-4542 folded `deadLetteredSessions` and
 * `deadLetteredComponents` — session metadata and component inventory, two of
 * the five lanes in `main/sync/AGENTS.md`. A dead-letter in the invocation-parts,
 * transcript-archive, or trace-comment lane was invisible here, which is how a
 * screen could carry a badge reading "1 item could not be uploaded" beside a
 * clean "Up to date": the abandoned item was in a lane this phrase could not see.
 *
 * `Math.max` rather than a branch because the two sources have different
 * freshness, and under-reporting an abandoned item is the failure that matters.
 * `progress` is live per poll; `backlog` is the burn-down's last 60s sample and
 * reads `unknown` (count 0) before the first one. Whichever has seen more
 * dead-letters is the one telling the truth.
 *
 * The noun is deliberately "item", matching the cutover badge's own wording, so
 * the two indicators on one screen no longer count the same thing in different
 * units.
 */
function describeCouldNotSync(
  progress: CloudSyncProgress,
  backlog: CloudSyncBacklog
): string | null {
  const deadLettered = Math.max(
    sanitizeDeadLetterCount(backlog.deadLetteredCount),
    sanitizeDeadLetterCount(progress.deadLetteredSessions) +
      sanitizeDeadLetterCount(progress.deadLetteredComponents)
  );
  if (deadLettered <= 0) {
    return null;
  }
  return describeUndeliverableItems(deadLettered);
}

/**
 * A dead-letter count we are willing to print. Negative, non-finite, and absent
 * values all become `0` rather than reaching `toLocaleString()` — a cell reading
 * "NaN items could not be uploaded" is a worse lie than the one this ticket
 * fixes. `0` is the safe floor here specifically because the caller takes the
 * MAX of two independently-sourced counts, so discarding a corrupt one falls
 * back to the other rather than suppressing the warning outright.
 */
function sanitizeDeadLetterCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/**
 * ISS-5768: the "work is still owed" cell. The count is the whole-app remainder
 * from the same aggregate the `Cloud (partial)` badge reads, so the two can
 * never quote different totals for one machine.
 *
 * `Outstanding` guarantees a non-null, positive `itemsRemaining` (an unmeasurable
 * remainder resolves to `Unknown` instead), so this never renders a fabricated
 * number. A lower-bound remainder is marked `+` rather than presented as exact.
 */
function describeOutstandingBacklog(
  backlog: CloudSyncBacklog,
  couldNotSyncDetail: string | null
): CloudSyncStatusDescription {
  const remaining = backlog.itemsRemaining ?? 0;
  const approx = backlog.itemsRemainingIsLowerBound ? "+" : "";
  // ISS-6206: prefer the per-lane breakdown, whose counts each carry a unit a
  // reader can act on. `null` is the flag-off path (no breakdown was computed),
  // which keeps the pre-ISS-6206 cross-lane total exactly as it was.
  const laneCopy = describeLaneRemainders(backlog.laneRemainders);
  // "left", not a bare parenthetical: a lone number in a row of bare numbers
  // (Gateway Port sits two cells over) reads as easily as "done" as "remaining".
  const label = laneCopy
    ? `Syncing (${laneCopy} left)`
    : `Syncing (${remaining.toLocaleString()}${approx} left)`;
  // ISS-6206 (wongk review on #5050): the label collapses a long tail into
  // "and N other kinds", so the detail carries every lane — otherwise a third lane's
  // actual backlog is not reachable on the screen at all.
  const noun =
    describeAllLaneRemainders(backlog.laneRemainders) ??
    describeItemsRemaining(remaining, backlog.itemsRemainingIsLowerBound);
  // Where they are GOING, not where they are. Everything is on the device; under
  // a "Syncing" label the reader wants the destination.
  const detail = `${noun} still to upload to your workspace.`;
  if (couldNotSyncDetail) {
    return {
      label,
      detail: `${detail} ${couldNotSyncDetail}`,
      tone: "warning",
    };
  }
  return { label, detail, tone: "pending" };
}

/**
 * Narrow one unknown array element to a `FileAccessBlock`. Uses `in`-guarded
 * property access (no cast) so a `null`/primitive/partial entry from a
 * version-skewed main process is rejected instead of crashing the banner.
 */
function isFileAccessBlock(value: unknown): value is FileAccessBlock {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    "harness" in value &&
    typeof value.harness === "string" &&
    "path" in value &&
    typeof value.path === "string"
  );
}

/**
 * ISS-4714: narrow one unknown runtime-status `kind` string to the closed set of
 * Agent Monitor status kinds. A version-skewed/future value falls through to
 * null in the parser rather than surfacing an unknown state.
 */
function toAgentMonitorStatusKind(
  kind: string
): AgentMonitorRuntimeStatusKind | null {
  for (const known of Object.values(AgentMonitorRuntimeStatusKind)) {
    if (known === kind) {
      return known;
    }
  }
  return null;
}

/**
 * ISS-4714: project the Agent Monitor runtime status out of the runtime-status
 * payload. Returns null when the field is absent (an older main process → no
 * degraded state shown, matching the additive-optional degrade of the sibling
 * projections). The `kind` is validated against the closed set, and `dbAhead` is
 * only ever honored on a `Failed` status, so a malformed or version-skewed
 * payload can never make the renderer claim "update required" while the runtime
 * is actually healthy — nor crash the banner on a partial entry.
 */
export function parseAgentMonitorStatus(
  status: unknown
): AgentMonitorRuntimeStatus | null {
  const value = readRuntimeStatus(status).agentMonitor;
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return null;
  }
  const rawKind = value.kind;
  if (typeof rawKind !== "string") {
    return null;
  }
  const kind = toAgentMonitorStatusKind(rawKind);
  if (kind === null) {
    return null;
  }
  const failed = kind === AgentMonitorRuntimeStatusKind.Failed;
  // dbAhead is meaningful only for a failed runtime; never let a truthy flag on
  // a ready/starting payload surface the degraded UI.
  const dbAhead =
    failed &&
    "dbAhead" in value &&
    typeof value.dbAhead === "boolean" &&
    value.dbAhead;
  const reason =
    failed && "reason" in value && typeof value.reason === "string"
      ? value.reason
      : null;
  return { kind, dbAhead, reason };
}

/**
 * Polls the main-process Agent Monitor runtime status while `active`, subscribing
 * to the same shared 1s runtime-status poll as the ingest/maintenance hooks (no
 * extra IPC round-trip per interval). Returns null until the first response and
 * whenever the field is absent.
 */
export function useAgentMonitorStatus(
  active: boolean
): AgentMonitorRuntimeStatus | null {
  return useRuntimeStatusValue(active, parseAgentMonitorStatus);
}

/**
 * ISS-4714 (wongk review): the Agent Monitor runtime status reaches a TERMINAL
 * verdict at boot — `Ready` (the DB opened) or `Failed` (it did not, e.g. the
 * DB-ahead refusal). Neither transitions again within a process lifetime, so a
 * banner reading this status has nothing left to observe after the first
 * verdict. This BOUNDED wrapper mirrors `useSessionsImportProgress` /
 * `first-launch-import-banner`: it polls the shared 1s runtime-status poll only
 * until the first `Ready`/`Failed` snapshot, then latches a stop so the shared
 * interval tears down (when no other subscriber holds it) instead of reading and
 * parsing `authorized_keys.json` on main every second for the whole session. The
 * last terminal snapshot is returned unchanged after the latch — a `Failed`
 * verdict (which the banner renders) stays visible; a `Ready` verdict keeps the
 * banner hidden.
 */
export function useTerminalAgentMonitorStatus(): AgentMonitorRuntimeStatus | null {
  const [terminal, setTerminal] = useState(false);
  const lastStatusRef = useRef<AgentMonitorRuntimeStatus | null>(null);
  const polled = useAgentMonitorStatus(!terminal);

  useEffect(() => {
    if (polled === null) {
      return;
    }
    lastStatusRef.current = polled;
    if (polled.kind !== AgentMonitorRuntimeStatusKind.Starting) {
      // Ready or Failed — the verdict is terminal for this process; stop polling.
      setTerminal(true);
    }
  }, [polled]);

  // While polling, the live snapshot; after the latch, the last terminal one.
  return terminal ? lastStatusRef.current : polled;
}

/**
 * Test-only: reset the module-level shared runtime-status poll (listeners,
 * interval, and the replayed last-status cache). Vitest reuses one module
 * instance across a file's tests, so without this a component mounted in a later
 * test synchronously receives the PREVIOUS test's cached status on subscribe —
 * which a latching consumer (e.g. `useTerminalAgentMonitorStatus`) would then
 * settle on before the fresh poll resolves. Call from `afterEach` (after
 * unmounting) so each test starts from a clean poll.
 */
export function __resetRuntimeStatusPollForTests(): void {
  runtimeStatusListeners.clear();
  if (runtimeStatusInterval !== null) {
    globalThis.clearInterval(runtimeStatusInterval);
    runtimeStatusInterval = null;
  }
  lastRuntimeStatus = undefined;
  hasRuntimeStatus = false;
}
