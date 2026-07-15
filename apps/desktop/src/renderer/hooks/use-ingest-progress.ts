import { useEffect, useState } from "react";

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
  // Every harness's boot import has finished. The banner relies on this rather
  // than aggregate `processed >= total`, which is briefly true between the
  // staggered per-harness passes.
  complete: boolean;
};

// FEA-2264: the post-boot maintenance phase the main process is currently
// running (data-revision rebuild, then artifact-link backfill), or none. Mirrors
// the main-side `AgentDashboardMaintenanceProgress` but is parsed defensively
// from the runtime-status payload so the renderer never trusts its shape.
export type MaintenanceProgress = {
  active: boolean;
  phase: "rebuild" | "artifact-links" | null;
};

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
  maintenance?: MaintenanceProgress | null;
  cloudSync?: CloudSyncProgress | null;
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
  return readRuntimeStatus(status).maintenance ?? null;
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
  // Defensive optional-chaining at the single call site: `desktopApi` is typed
  // non-optional but can be absent in test/SSR contexts. Keeping the decision
  // here applies it uniformly to every status-derived hook.
  window.desktopApi
    ?.getRuntimeStatus()
    .then(emitRuntimeStatus)
    .catch(() => undefined);
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
};

/**
 * Project the local→cloud sync progress out of the runtime-status payload, or
 * null when the field is absent (older main process → indicator hidden). Drives
 * the Settings → Connection Status "History Sync" cell.
 */
export function parseCloudSync(status: unknown): CloudSyncProgress | null {
  return readRuntimeStatus(status).cloudSync ?? null;
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
 * Map a parsed cloud-sync snapshot to a compact status label + tone for the
 * Settings → Connection Status "History Sync" cell. Pure (no React) so it is
 * unit-testable in isolation. `null` (older main process / not yet polled) and
 * the signed-out/offline case both degrade to a muted "—".
 */
export function describeCloudSyncStatus(
  progress: CloudSyncProgress | null
): CloudSyncStatusDescription {
  if (progress === null || !progress.identified) {
    return { label: "—", detail: "Not connected to the cloud", tone: "muted" };
  }
  if (progress.backfilling) {
    // Surface dropped sessions DURING the walk, not only at the terminal
    // "Synced with issues" — a persistent poison row on a multi-hour
    // year-of-history backfill would otherwise stay hidden behind a clean
    // "Syncing (N)" for the entire window. Keep the count label (progress is
    // still real) but tint it a warning.
    if (progress.deadLetteredSessions > 0) {
      return {
        label: `Syncing (${progress.pendingBackfillSessions})`,
        detail: `Syncing your history — ${progress.deadLetteredSessions} session(s) could not sync`,
        tone: "warning",
      };
    }
    return {
      label: `Syncing (${progress.pendingBackfillSessions})`,
      detail: "Syncing your history to the cloud",
      tone: "pending",
    };
  }
  if (progress.caughtUp) {
    if (progress.deadLetteredSessions > 0) {
      return {
        label: "Synced with issues",
        detail: `${progress.deadLetteredSessions} session(s) could not sync`,
        tone: "warning",
      };
    }
    return {
      label: "Up to date",
      detail: "Your history is synced to the cloud",
      tone: "success",
    };
  }
  if (progress.pendingIncrementalSessions > 0) {
    return {
      label: "Syncing…",
      detail: "Syncing recent changes to the cloud",
      tone: "pending",
    };
  }
  return { label: "Checking…", detail: "Checking sync status", tone: "muted" };
}
