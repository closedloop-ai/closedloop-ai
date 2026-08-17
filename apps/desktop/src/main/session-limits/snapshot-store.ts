/**
 * @file snapshot-store.ts
 * @description In-memory store + reconciliation for subscription session-limit
 * snapshots (PRD-539, FEA-3493).
 *
 * Three sources push point-in-time snapshots into the store:
 *  - `usage_api` — AUTHORITATIVE, the owned `/api/oauth/usage` endpoint
 *    (PRD-538 R5; see {@link file://./usage-api-client.ts});
 *  - `statusline` — RICH, continuous per-window percentages;
 *  - `rate_limit_event` — COARSE, status/reset/type only.
 * (See {@link file://./mappers.ts} for the local source→snapshot mappers.)
 *
 * The store keeps only the freshest snapshot per source and reconciles them into
 * a single latest {@link SessionLimitsSnapshot} for the renderer via
 * {@link resolveSessionLimits}. The resolver prefers a fresh AUTHORITATIVE
 * sample, then a fresh RICH one, then a fresh COARSE one, and — when every
 * sample is stale — returns null so
 * the renderer hides the UI rather than showing stale bars as current. The
 * renderer reads `fetchedAt`/`source` off the resolved snapshot for the detail
 * drawer's provenance footer (FEA-3494); see {@link resolveSessionLimits}.
 */
import type {
  SessionLimitSource,
  SessionLimitsSnapshot,
} from "../../shared/session-limits-channel.js";

/**
 * Which producer captured a snapshot. The values are the shared
 * {@link SessionLimitSource} literals (SSOT in session-limits-channel), so the
 * source the reconciler stamps onto {@link SessionLimitsSnapshot.source} is the
 * exact union the renderer reads.
 */
export const SessionLimitSnapshotSource = {
  /** Owned `GET /api/oauth/usage` — AUTHORITATIVE server-computed utilization. */
  UsageApi: "usage_api",
  /** Interactive statusline `rate_limits` — RICH continuous percentages. */
  Statusline: "statusline",
  /** Non-interactive `rate_limit_event` (`SDKRateLimitInfo`) — COARSE. */
  RateLimitEvent: "rate_limit_event",
} as const satisfies Record<string, SessionLimitSource>;
export type SessionLimitSnapshotSource = SessionLimitSource;

/** A source-tagged snapshot plus the capture time used for ordering/staleness. */
export type StoredSessionLimitSnapshot = {
  source: SessionLimitSnapshotSource;
  /** Epoch ms when this snapshot was captured (drives freshness ordering). */
  fetchedAtMs: number;
  /** The mapped snapshot; its own `fetchedAt` (ISO) is what the UI displays. */
  limits: SessionLimitsSnapshot;
};

/**
 * A snapshot older than this is treated as stale and is not surfaced to the
 * renderer (the resolver returns null once every sample is stale). 15 minutes
 * comfortably covers the renderer's 5-minute refresh cadence plus jitter.
 */
export const SESSION_LIMIT_STALE_AFTER_MS = 15 * 60 * 1000;

/** The freshest snapshot from a given source, or null when none exists. */
function freshestFromSource(
  snapshots: readonly StoredSessionLimitSnapshot[],
  source: SessionLimitSnapshotSource
): StoredSessionLimitSnapshot | null {
  let best: StoredSessionLimitSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.source !== source) {
      continue;
    }
    if (!best || snapshot.fetchedAtMs > best.fetchedAtMs) {
      best = snapshot;
    }
  }
  return best;
}

/**
 * Reconcile stored snapshots into the single latest {@link SessionLimitsSnapshot}
 * for the renderer.
 *
 * Preference order:
 *  1. the freshest AUTHORITATIVE (`usage_api`) sample, when it is not stale —
 *     the owned `/usage` endpoint computes every window server-side, so it
 *     outranks both local producers (PRD-538 R5);
 *  2. else the freshest RICH (statusline) sample, when it is not stale;
 *  3. else the freshest COARSE (`rate_limit_event`) sample, when not stale;
 *  4. else null — every sample is stale.
 *
 * When everything is stale we return null (the renderer then hides the UI)
 * rather than surfacing a last-known snapshot as if it were current: a stale
 * snapshot would otherwise render as live bars indefinitely once a producer
 * wrote once and then stopped. The detail drawer surfaces `fetchedAt` +
 * `source` as a provenance line (FEA-3494), but the fresh-only gate here is what
 * keeps the bars honest; a renderable stale state can be reintroduced in a
 * follow-up that also renders a distinct "stale" affordance. This also keeps the
 * IPC contract's "every failure resolves to null → hide the UI" invariant.
 *
 * The returned snapshot is stamped with the winning `source` so the renderer can
 * label the data's provenance without a second IPC field.
 *
 * Returns null when there are no snapshots, or when all are stale.
 */
export function resolveSessionLimits(
  snapshots: readonly StoredSessionLimitSnapshot[],
  nowMs: number,
  staleAfterMs: number = SESSION_LIMIT_STALE_AFTER_MS
): SessionLimitsSnapshot | null {
  if (snapshots.length === 0) {
    return null;
  }
  const isFresh = (snapshot: StoredSessionLimitSnapshot): boolean =>
    nowMs - snapshot.fetchedAtMs <= staleAfterMs;

  // PRD-538 R5: the owned `/usage` endpoint is the server's own computation of
  // every window, so a fresh sample from it outranks both local producers — the
  // statusline only reports the windows the harness happened to print, and the
  // rate_limit_event carries no continuous percentage at all.
  const authoritative = freshestFromSource(
    snapshots,
    SessionLimitSnapshotSource.UsageApi
  );
  if (authoritative && isFresh(authoritative)) {
    return stampSource(authoritative);
  }
  const rich = freshestFromSource(
    snapshots,
    SessionLimitSnapshotSource.Statusline
  );
  if (rich && isFresh(rich)) {
    return stampSource(rich);
  }
  const coarse = freshestFromSource(
    snapshots,
    SessionLimitSnapshotSource.RateLimitEvent
  );
  if (coarse && isFresh(coarse)) {
    return stampSource(coarse);
  }
  // Everything is stale → hide the UI until the renderer can display staleness.
  return null;
}

/** Stamp the winning snapshot's provenance `source` onto its rendered payload. */
function stampSource(
  winner: StoredSessionLimitSnapshot
): SessionLimitsSnapshot {
  return { ...winner.limits, source: winner.source };
}

/**
 * Holds the latest snapshot per source and reconciles them on demand. A single
 * shared instance ({@link sessionLimitsSnapshotStore}) is read by the IPC
 * handler and written by the statusline / rate_limit_event producers.
 */
export class SessionLimitsSnapshotStore {
  readonly #bySource = new Map<
    SessionLimitSnapshotSource,
    StoredSessionLimitSnapshot
  >();

  /** Record a snapshot, keeping only the freshest per source. */
  record(snapshot: StoredSessionLimitSnapshot): void {
    const existing = this.#bySource.get(snapshot.source);
    if (!existing || snapshot.fetchedAtMs >= existing.fetchedAtMs) {
      this.#bySource.set(snapshot.source, snapshot);
    }
  }

  /** Reconcile the stored snapshots into the latest snapshot for the renderer. */
  resolve(
    nowMs: number,
    staleAfterMs: number = SESSION_LIMIT_STALE_AFTER_MS
  ): SessionLimitsSnapshot | null {
    return resolveSessionLimits(
      [...this.#bySource.values()],
      nowMs,
      staleAfterMs
    );
  }

  /** Drop all stored snapshots (used by tests to isolate the shared instance). */
  clear(): void {
    this.#bySource.clear();
  }
}

/** Process-wide store shared by the IPC reader and the snapshot producers. */
export const sessionLimitsSnapshotStore = new SessionLimitsSnapshotStore();
