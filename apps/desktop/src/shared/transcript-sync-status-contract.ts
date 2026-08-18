/**
 * Renderer-facing projection of the transcript archive lane's status
 * (FEA-2715 / ISS-4719).
 *
 * The main-process handler (`desktop:get-transcript-sync-status` in
 * `main/ipc/runtime-info-ipc.ts`) computes the lane's four egress preconditions
 * plus a per-status row census, and the preload exposes it on
 * `window.desktopApi.getTranscriptSyncStatus`. Per AGENTS.md, values that cross
 * the main/renderer boundary live in a shared, node-free module so the two sides
 * can't drift — the main service (`transcript-sync-options.ts` re-exports these),
 * the preload bridge, and the renderer `desktopApi` type all import from here.
 *
 * Node-free by design: the renderer tsconfig has no `@types/node`, so this
 * module must not import anything that pulls in node builtins (`node:fs`,
 * `Buffer`, …). The archive-lane's status/class const unions live HERE (not in
 * the node-adjacent `transcript-sync-types.ts`, which re-exports them) precisely
 * because they cross into the renderer as the KEYS of
 * {@link TranscriptSyncStatusCounts} below: keeping the narrow unions on the
 * boundary is what stops an impossible fixture like `status: "syncing"` from
 * compiling and preserves exhaustive checks on the renderer side.
 */

/** Upload/queue lifecycle stored on `TranscriptSyncState.status`. */
export const TranscriptSyncStatus = {
  Idle: "idle",
  Queued: "queued",
  Uploading: "uploading",
  Failed: "failed",
  Dead: "dead",
} as const;
export type TranscriptSyncStatus =
  (typeof TranscriptSyncStatus)[keyof typeof TranscriptSyncStatus];

/**
 * Priority class. `live` (hook/watcher-driven current sessions) is always
 * drained ahead of `backfill` (historical files enumerated on first connect /
 * startup sweep) so a large history pass never starves active-session sync.
 */
export const TranscriptSyncClass = {
  Live: "live",
  Backfill: "backfill",
} as const;
export type TranscriptSyncClass =
  (typeof TranscriptSyncClass)[keyof typeof TranscriptSyncClass];

const TRANSCRIPT_SYNC_STATUS_VALUES = new Set<string>(
  Object.values(TranscriptSyncStatus)
);
const TRANSCRIPT_SYNC_CLASS_VALUES = new Set<string>(
  Object.values(TranscriptSyncClass)
);

/** Narrow an unconstrained DB `status` string to a known member, else null. */
export function asTranscriptSyncStatus(
  value: string
): TranscriptSyncStatus | null {
  return TRANSCRIPT_SYNC_STATUS_VALUES.has(value)
    ? (value as TranscriptSyncStatus)
    : null;
}

/** Narrow an unconstrained DB `sync_class` string to a known member, else null. */
export function asTranscriptSyncClass(
  value: string
): TranscriptSyncClass | null {
  return TRANSCRIPT_SYNC_CLASS_VALUES.has(value)
    ? (value as TranscriptSyncClass)
    : null;
}

/**
 * How many archive-lane rows sit in each lifecycle status, across the WHOLE
 * table.
 *
 * `Record`-keyed on the status union so a new {@link TranscriptSyncStatus}
 * member fails typecheck here until every producer counts it, rather than
 * silently reading as zero. Every key is always present; a status with no rows
 * is `0`, which is a real count and not "unknown" — an unresolved read is
 * represented by the renderer's own read union, never by a missing key here.
 */
export type TranscriptSyncStatusCounts = Record<TranscriptSyncStatus, number>;

/**
 * The PRD-532 §7 consent + org-policy egress gate, as THREE states rather than
 * a boolean.
 *
 * ISS-5348 (review): a boolean could not tell a settled denial apart from the
 * boot window where the org policy has not resolved yet — `OrgSyncPolicyStore`
 * is born `Unknown` and `orgPolicyAllowsSessionSync` fails closed on it, so both
 * arrived as `false`. That is correct for EGRESS (never upload on an unresolved
 * policy) and wrong for DISPLAY: the splash renders at boot, which is precisely
 * when the window is open, so the footer stated "Transcript upload isn't active"
 * as settled fact and then flipped on the next poll. Egress still keys off
 * `Allowed` alone, so failing closed is unchanged; only the renderer gains the
 * ability to say "not resolved yet" instead of inventing a denial.
 */
export const TranscriptEgressGate = {
  /** Consent tier and org policy both permit egress. */
  Allowed: "allowed",
  /** A settled no: an insufficient/absent consent tier, or a denying policy. */
  Denied: "denied",
  /** The org policy has not resolved yet. NOT a denial — no verdict exists. */
  Unresolved: "unresolved",
} as const;
export type TranscriptEgressGate =
  (typeof TranscriptEgressGate)[keyof typeof TranscriptEgressGate];

/**
 * The snapshot returned to the renderer.
 *
 * ISS-4716: `enabled` alone is NOT the egress gate — it is only the persisted
 * `transcriptSyncEnabled` toggle. `TranscriptSyncService.shouldRun()` ANDs four
 * preconditions (tier/org-policy consent, the toggle, online, and a live
 * store), and a consumer that reads only `enabled` will describe a lane that
 * cannot run as if it were healthy. `tierGate` and `storeReady` expose the two
 * the service used to keep private, so the renderer can tell "you turned it
 * off" apart from "your org policy denies this" apart from "your org policy
 * hasn't resolved yet" apart from "the database isn't up yet".
 *
 * All fields are REQUIRED: main, preload, and the renderer ship in a single
 * Electron build, so this shape never crosses a version-skewed boundary and an
 * optional field would only add an unreachable `undefined` branch.
 */
export type TranscriptSyncStatusSnapshot = {
  enabled: boolean;
  online: boolean;
  /**
   * PRD-532 §7 consent + org-policy egress gate. Three-valued so a consumer
   * cannot render the unresolved boot window as a settled denial — see
   * {@link TranscriptEgressGate}. Only `Allowed` permits the lane to drain.
   */
  tierGate: TranscriptEgressGate;
  /** `shouldRun()`'s store precondition: false while the DB is starting or failed. */
  storeReady: boolean;
  /**
   * Whole-table counts per lifecycle status.
   *
   * ISS-5348 (review): this replaced a newest-100 row window. That window was
   * an unindexed full-table read and sort on every 5s poll of a visible splash
   * (no index covers `last_mtime_ms DESC, updated_at ASC`, and SQLite cannot
   * walk a mixed-direction order from an ASC index), and it was a SAMPLE — a
   * user with thousands of older dead-lettered rows could show a clean window,
   * so the footer could miss the exact failure it exists to report. A
   * `GROUP BY status` aggregate is served by the leading column of
   * `idx_transcript_sync_state_status_next`, materializes no rows in the
   * heap-capped db-host worker, and describes the whole population.
   */
  statusCounts: TranscriptSyncStatusCounts;
};

/**
 * A {@link TranscriptSyncStatusCounts} with every status present at zero.
 *
 * Built by iterating the union rather than written out as a literal, so adding
 * a {@link TranscriptSyncStatus} member cannot leave a key `undefined` here —
 * a missing key would read as "no rows" and silently under-report a real state.
 * Shared by the store, the service's no-store snapshot, and the no-service IPC
 * fallback so those three cannot drift into different notions of "empty".
 */
export function emptyTranscriptStatusCounts(): TranscriptSyncStatusCounts {
  const counts = {} as TranscriptSyncStatusCounts;
  for (const status of Object.values(TranscriptSyncStatus)) {
    counts[status] = 0;
  }
  return counts;
}
