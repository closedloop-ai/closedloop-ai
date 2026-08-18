/**
 * @file statusline-reader.ts
 * @description Producer that feeds the RICH `statusline` source into the
 * session-limit snapshot store (PRD-539, FEA-3523).
 *
 * The install script (`statusline-capture.js`) writes a point-in-time snapshot
 * to `<userData>/session-limits/statusline-snapshot.json` on every interactive
 * Claude render, but nothing read it back. This poller reads that file on a
 * low-frequency cadence (matching the renderer's ~5-minute refresh and the
 * store's staleness window), maps it into a {@link SessionLimitsSnapshot}, and
 * records it — so the resolver prefers this RICH continuous sample over the
 * COARSE `rate_limit_event` one.
 *
 * FAIL-CLOSED: a missing, empty, corrupt, or stale file must NEVER throw or
 * record bogus data. The snapshot's `fetchedAtMs` is derived from the file's own
 * `fetchedAt` (falling back to mtime, then now), so a stale file naturally ages
 * out of the store's freshness window instead of masquerading as current.
 */
import { promises as fs } from "node:fs";
import { hasRenderableSessionLimit } from "../../shared/session-limits-channel.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import { mapStatuslineSnapshotFile } from "./mappers.js";
import {
  SessionLimitSnapshotSource,
  type SessionLimitsSnapshotStore,
  sessionLimitsSnapshotStore,
} from "./snapshot-store.js";

const TAG = "session-limits-statusline-reader";

/** Poll cadence: matches the renderer's ~5-minute refresh + store staleness. */
export const STATUSLINE_POLL_MS_DEFAULT = 5 * 60 * 1000;

export type StatuslineReaderDeps = {
  /** Resolve the snapshot file path (defaults to the installer's location). */
  snapshotPath: () => string;
  store?: SessionLimitsSnapshotStore;
  /** Current epoch ms (fallback capture time); defaults to `Date.now`. */
  now?: () => number;
  pollMs?: number;
  log?: (message: string) => void;
};

export type StatuslineReader = {
  /** Read the file once and record a snapshot when present/valid. */
  readOnce: () => Promise<void>;
  /** Begin polling (idempotent). */
  start: () => void;
  /** Stop polling (idempotent). */
  stop: () => void;
};

/**
 * Derive the capture time (epoch ms) that drives store freshness. Prefer the
 * file's own `fetchedAt` ISO, then the file's mtime, then `nowMs`. A malformed
 * `fetchedAt` never yields a future/NaN timestamp.
 */
function resolveFetchedAtMs(
  fileFetchedAt: unknown,
  mtimeMs: number,
  nowMs: number
): number {
  if (typeof fileFetchedAt === "string" && fileFetchedAt.length > 0) {
    const parsed = Date.parse(fileFetchedAt);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (Number.isFinite(mtimeMs) && mtimeMs > 0) {
    return mtimeMs;
  }
  return nowMs;
}

/**
 * Create the statusline snapshot poller. Reads
 * `statusline-snapshot.json`, maps it, and records a RICH snapshot. All IO and
 * parse failures are swallowed (fail-closed): a bad read simply leaves the
 * store untouched.
 */
export function createStatuslineReader(
  deps: StatuslineReaderDeps
): StatuslineReader {
  const store = deps.store ?? sessionLimitsSnapshotStore;
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? STATUSLINE_POLL_MS_DEFAULT;
  const log = deps.log ?? ((message: string) => gatewayLog.warn(TAG, message));
  let interval: ReturnType<typeof setInterval> | null = null;

  async function readOnce(): Promise<void> {
    const filePath = deps.snapshotPath();
    let raw: string;
    let mtimeMs = 0;
    try {
      const [contents, stat] = await Promise.all([
        fs.readFile(filePath, "utf8"),
        fs.stat(filePath),
      ]);
      raw = contents;
      mtimeMs = stat.mtimeMs;
    } catch {
      // Missing/unreadable file is the normal pre-install state — not an error.
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      log(
        `corrupt statusline snapshot ignored: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return;
    }
    try {
      const nowMs = now();
      const fetchedAtMs = resolveFetchedAtMs(
        (parsed as { fetchedAt?: unknown } | null)?.fetchedAt,
        mtimeMs,
        nowMs
      );
      const limits = mapStatuslineSnapshotFile(
        parsed,
        new Date(fetchedAtMs).toISOString()
      );
      // FEA-3523: a valid-JSON file that lacks usable `rate_limits` (an older
      // Claude Code/statusline payload, or malformed stdin the capture script
      // still turns into `fiveHour: null`/`sevenDay: null`) maps to an all-null
      // snapshot. Recording it would win reconciliation — the resolver always
      // prefers a fresh RICH statusline sample over the COARSE rate_limit_event —
      // yet the renderer hides all-null snapshots, so a single empty render would
      // suppress a valid coarse rejected-event bar until the staleness window
      // expires. Skip empty snapshots so the coarse source stays visible.
      if (!hasRenderableSessionLimit(limits)) {
        return;
      }
      store.record({
        source: SessionLimitSnapshotSource.Statusline,
        fetchedAtMs,
        limits,
      });
    } catch (error) {
      log(
        `statusline snapshot ingest skipped: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  // readOnce() already swallows all IO/parse failures internally; the extra
  // `.catch` is a belt-and-braces guard so a rejected promise never surfaces as
  // an unhandled rejection from the fire-and-forget poll tick.
  const tick = (): void => {
    readOnce().catch(() => {
      /* readOnce never rejects; guard defensively */
    });
  };

  return {
    readOnce,
    start(): void {
      if (interval) {
        return;
      }
      // Read once immediately so a snapshot written before boot is picked up.
      tick();
      interval = setInterval(tick, pollMs);
      if (typeof interval === "object" && "unref" in interval) {
        interval.unref();
      }
    },
    stop(): void {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}
