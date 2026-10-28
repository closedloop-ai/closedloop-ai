import type { UploadQueueCounts } from "@repo/app/shared/components/upload-queue-view";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  type CloudSyncBacklog,
  CloudSyncBacklogState,
  resolveCloudSyncBacklog,
} from "../../shared/cloud-read-readiness-contract";
import { DESKTOP_STOPPED_LANE_READINESS_FEATURE_FLAG_KEY } from "../../shared/stopped-lane-readiness-flag";
import {
  describeAllLaneRemainders,
  describeItemsRemaining,
  describeLaneRemainders,
  describeUndeliverableItems,
} from "../components/import-progress-display";
import { uploadQueueCounts } from "../components/sessions/cloud-sync-pending-sessions";
import { parseCloudReadReadinessBacklog } from "./parse-cloud-read-readiness";
import {
  readRuntimeStatus,
  useRuntimeStatusValue,
} from "./use-runtime-status-poll";

// FEA-2733: content-blind local→cloud sync progress for the "syncing your
// history" indicator. Mirrors the main-side `AgentSessionSyncProgress`; the
// renderer projects it out of the runtime-status payload, degrading to null
// (indicator hidden) when the field is absent — e.g. an older main process —
// rather than showing a spurious "up to date".
export type CloudSyncProgress = {
  identified: boolean;
  pendingBackfillSessions: number;
  pendingIncrementalSessions: number;
  // ISS-7099: what the lane has delivered under this identity, and the total
  // that pair is measured against. The main-side snapshot also carries the
  // per-queue ready counts `inFlightTotalSessions` is derived from; they are
  // deliberately NOT mirrored here, because no renderer surface reads them and
  // an unread field on a parsed payload is dead weight. ISS-12529: and the
  // sessions in the batch on the wire right now (`sendingSessions`), which the
  // upload queue view reads as in flight.
  //
  // Optional AND nullable, for two different absences a reader handles the same
  // way. Absent: a main process that predates the fields. Null: the lane has
  // them but they are not yet attributable to the current compute target (its
  // source key and its hydrated key disagree mid-switch). Either way the surface
  // must fall back rather than read the absence as zero.
  deliveredSessions?: number | null;
  inFlightTotalSessions?: number | null;
  sendingSessions?: number | null;
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
 * The field is VALIDATED, not asserted (whitlockk review): the same answer covers a
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

/**
 * ISS-4542/ISS-5768: build the "could not sync" tail for the History Sync
 * detail. Returns null when nothing was dead-lettered (the clean "Up to date" /
 * "Syncing" path).
 *
 * The count is the WHOLE-APP dead-letter total, floored by the two per-lane
 * counts `progress` carries. ISS-4542 folded `deadLetteredSessions` and
 * `deadLetteredComponents` — session metadata and component inventory, two of
 * the lanes in `main/sync/AGENTS.md`. A dead-letter in the invocation-parts or
 * transcript-archive lane was invisible here, which is how a
 * screen could carry a badge reading "1 item could not be uploaded" beside a
 * clean "Up to date": the abandoned item was in a lane this phrase could not see.
 *
 * `Math.max` rather than a branch because the two sources have different
 * freshness, and under-reporting an abandoned item is the failure that matters.
 * `progress` is live per poll; `backlog` is the burn-down's last 60s sample and
 * reads `unknown` (count 0) before the first one. Whichever has seen more
 * dead-letters is the one telling the truth.
 *
 * The noun is deliberately "item", matching the shared
 * {@link describeUndeliverableItems} wording, so no two indicators on one screen
 * count the same thing in different units.
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
 * from {@link resolveCloudSyncBacklog}, the one aggregate every completeness
 * indicator reads, so no two can quote different totals for one machine.
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
  // ISS-6206 (whitlockk review on #5050): the label collapses a long tail into
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
 * ISS-12529: the upload queue view's counts, read off the same shared 1s
 * runtime-status poll as {@link useCloudSyncProgress} rather than a polling
 * path of its own (AC-003). `null` until the lane has measured its queues.
 */
export function useUploadQueueCounts(
  active: boolean
): UploadQueueCounts | null {
  return uploadQueueCounts(useCloudSyncProgress(active));
}
