/**
 * Where a Session Timeline dot BELONGS: the transcript row it jumps to, and the
 * fraction of the resolved window it is drawn at.
 *
 * Extracted from `agent-session-detail-view.tsx` because none of this is
 * rendering. It is the arithmetic
 * that reconciles a marker minted by one producer, against one window, with the
 * window THIS screen resolved and the transcript THIS screen renders, and it
 * belongs beside the geometry it consumes rather than inside a view component.
 * Behavior is unchanged by the move; see `session-timeline-geometry.ts` for the
 * window itself.
 */

import type {
  AgentSessionDetail,
  SessionMarker,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import {
  clamp,
  clampNonNegativeCount,
  clampPercent,
} from "@repo/api/src/utils/math";
import {
  getDateMs,
  getTurnItemMs,
  getWindowPercent,
  hasTimedTraceRow,
  hasTraceRow,
  type SessionTimelineWindow,
} from "@repo/app/agents/lib/session-timeline-geometry";

export function resolveExplicitTraceRow(
  explicitRow: number | null | undefined,
  session: AgentSessionDetail,
  timestamp: unknown,
  fallbackRow: number,
  fallbackPercent: number
): number {
  if (typeof explicitRow === "number" && Number.isFinite(explicitRow)) {
    return clampNonNegativeCount(explicitRow);
  }
  return resolveLimitTraceRow(session, timestamp, fallbackRow, fallbackPercent);
}

export function resolveLimitTraceRow(
  session: AgentSessionDetail,
  timestamp: unknown,
  fallbackRow: number,
  fallbackPercent: number
): number {
  const rows = session.turnItems?.filter(hasTimedTraceRow) ?? [];
  const timestampMs = getDateMs(timestamp);
  if (Number.isFinite(timestampMs) && rows.length > 0) {
    return getNearestTraceRow(rows, timestampMs);
  }
  return getTraceRowFromPercent(session, fallbackPercent, fallbackRow);
}

/**
 * Where a PERSISTED marker belongs on the resolved timeline window
 * (ISS-4821, whitlockk + codex review).
 *
 * `SessionMarker.x` is the producer's fraction over the producer's own window,
 * and that window is not in the detail DTO — so once this screen resolves a
 * different window, keeping `x` relabels the axis while leaving the dot where it
 * was. The two producers differ in what they preserve:
 *   - the cloud path (`deriveCorrectionMarkers`, packages/lib/session-trace/
 *     derivation.ts) writes `t: source.observedAt` — an ABSOLUTE instant, so it
 *     rebases directly;
 *   - the desktop path (`buildTraceMarkers`, apps/desktop/src/main/database/
 *     session-trace.ts) writes `t: formatTraceClockOffset(rowMs - startMs)` — a
 *     relative clock offset like "1:00:00", which carries no absolute instant.
 *     For that shape the marker's re-anchored transcript row IS an absolute
 *     instant, so rebase from the row's timestamp instead.
 *
 * Only when neither is available — no parseable `t`, no timed transcript row —
 * does the stored fraction stand, which keeps an older payload rendering exactly
 * as it does today. That last case is where whitlockk's suggested DTO addition (an
 * optional producer source-window, or absolute marker times) would remove the
 * remaining guesswork; it needs a desktop producer change and a skew fallback,
 * so it is deliberately not folded into this PR.
 */
export function resolvePersistedMarkerPercent(
  session: AgentSessionDetail,
  marker: SessionMarker,
  window: SessionTimelineWindow | null
): number {
  const fromTimestamp = getWindowPercent(window, marker.t);
  if (fromTimestamp !== null) {
    return fromTimestamp;
  }
  const rowMs = getPersistedMarkerRowMs(session, marker);
  return getWindowPercent(window, rowMs) ?? clampPercent(marker.x);
}

/*
 * FEA-4252: normalize a persisted marker's jump row into a real `turnItems._row`
 * so the downstream row translation starts from a genuine DB turn identity.
 * - An absent or non-finite `tl` yields `undefined` — the dot stays an inert
 *   no-op, never a fabricated jump to the top.
 * - A `tl` that already names a real `turnItems._row` is a valid DB turn and is
 *   kept as-is (the common, aligned case).
 * - Only a `tl` that is NOT a real row (a raw TraceTimelineRow / correction index
 *   the desktop producer emitted) is re-anchored to the nearest real row by the
 *   marker's instant, falling back to its horizontal position.
 *
 * ISS-7632: the return type is `number | undefined` because "no usable row" is a
 * value this function genuinely produces. It used to be declared `number` and
 * reached through `return tl as number`, so the compiler believed the first
 * bullet above could not happen and no caller was ever forced to handle it.
 *
 * `undefined` rather than echoing the caller's value back: the guard's meaning
 * is "not a usable row", and echoing only re-tells the lie in a new shape. A
 * `NaN` is a legal `number`, so `return tl` would still satisfy the widened
 * signature while handing every reader a row that survives their `?? null` and
 * points nowhere; and `SessionMarker` is parsed from a synced JSON column, so
 * `tl` can arrive as a `null` or a string the declared type forbids. One
 * `undefined` is the only answer that is true for every input that actually
 * reaches this guard.
 */
export function normalizePersistedMarkerRow(
  session: AgentSessionDetail,
  tl: number | undefined,
  timestamp: unknown,
  percent: number
): number | undefined {
  if (typeof tl !== "number" || !Number.isFinite(tl)) {
    return undefined;
  }
  const rows = session.turnItems ?? [];
  const isRealRow = rows.some((item) => "_row" in item && item._row === tl);
  if (isRealRow) {
    return tl;
  }
  return resolveLimitTraceRow(session, timestamp, tl, percent);
}

/** The absolute instant of the transcript row a persisted marker re-anchors to. */
function getPersistedMarkerRowMs(
  session: AgentSessionDetail,
  marker: SessionMarker
): Date | null {
  const row = normalizePersistedMarkerRow(
    session,
    marker.tl,
    marker.t,
    marker.x
  );
  if (row === undefined) {
    return null;
  }
  for (const item of session.turnItems ?? []) {
    if (hasTimedTraceRow(item) && item._row === row) {
      return new Date(getTurnItemMs(item));
    }
  }
  return null;
}

function getNearestTraceRow(
  rows: (TurnItem & { _row: number; t: string })[],
  timestampMs: number
): number {
  let nearestRow = rows[0]?._row ?? 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const distance = Math.abs(getTurnItemMs(row) - timestampMs);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestRow = row._row;
    }
  }
  return clampNonNegativeCount(nearestRow);
}

function getTraceRowFromPercent(
  session: AgentSessionDetail,
  percent: number,
  fallbackRow: number
): number {
  const rows = session.turnItems?.filter(hasTraceRow) ?? [];
  if (rows.length === 0) {
    return clampNonNegativeCount(fallbackRow);
  }
  const index = clamp(
    Math.round((clampPercent(percent) / 100) * (rows.length - 1)),
    0,
    rows.length - 1
  );
  return clampNonNegativeCount(rows[index]?._row ?? fallbackRow);
}
