import type {
  AgentSessionDetail,
  SessionThrottle,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { clampPercent } from "@repo/api/src/utils/math";
import { getEventMarkerKind } from "@repo/app/agents/components/detail/activity-dot-rendering";
import {
  normalizePersistedMarkerRow,
  resolveExplicitTraceRow,
  resolveLimitTraceRow,
  resolvePersistedMarkerPercent,
} from "@repo/app/agents/lib/marker-trace-row";
import { formatMarkerTime } from "@repo/app/agents/lib/session-marker-time";
import {
  getDateMs,
  getLimitDotPercent,
  getWindowPercent,
  hasTraceRow,
  type SessionTimelineWindow,
} from "@repo/app/agents/lib/session-timeline-geometry";
import { isSessionTerminatingLabel } from "@repo/lib/session-trace/derivation";
import {
  formatThrottleDuration,
  formatThrottleSourceLimitLabel,
  getSessionEventLimitLabel,
  getTurnEventLimitLabel,
  getTurnItemTimestamp,
} from "./session-limit-label-format";
import type { ActivityMarker } from "./session-timeline-axis";

export function buildActivityMarkers(
  session: AgentSessionDetail,
  window: SessionTimelineWindow | null
): ActivityMarker[] {
  if (session.markers && session.markers.length > 0) {
    return session.markers.map((marker) => ({
      ...marker,
      label: marker.label,
      // ISS-4821 (whitlockk / codex review): see resolvePersistedMarkerPercent —
      // `marker.x` is the producer's fraction over a window the DTO does not
      // carry, so it cannot stay verbatim once this screen resolves its own.
      x: resolvePersistedMarkerPercent(session, marker, window),
      // Normalize the marker instant through the same formatter every other
      // marker path uses. `SessionMarker.t` is TYPED `string`, but a synced
      // detail can deserialize the timestamp column to a runtime `Date`; copying
      // it verbatim rendered `[object Date]` as a React child in the timeline
      // tooltip (`<span>{event.t}</span>`) and crashed the whole detail subtree,
      // including the transcript panel under the same error boundary.
      t: formatMarkerTime(marker.t),
      /*
       * FEA-4252: a persisted `SessionMarker.tl` can be a raw producer index (a
       * TraceTimelineRow / correction-source index), NOT a `turnItems._row`, so
       * trusting it makes the downstream row translation correlate the wrong
       * turn (a coalesced second tool can carry `tl=2` while its DB turn is row
       * 1). Re-anchor ONLY when the persisted value is not already a real
       * `turnItems._row`: a matching value is a genuine DB turn and is kept, and
       * an absent `tl` stays absent so the dot remains an inert no-op rather than
       * resolving to a fabricated row.
       */
      tl: normalizePersistedMarkerRow(session, marker.tl, marker.t, marker.x),
    }));
  }

  const items = session.turnItems ?? [];
  return items
    .map((item, index) => buildTurnMarker(item, index, items.length))
    .filter((marker): marker is ActivityMarker => marker !== null);
}

/*
 * FEA-3642: rate-limit indicators are driven by STRUCTURED signals only. A
 * session that merely mentions "rate limit"/"429"/"throttle" in conversation or
 * tool output must show NO indicator; only a recorded throttle
 * (`session.throttles`/`session.throttleSources`) or an event the harness
 * classified as a limit (structured `eventType`/`data`, not free-text
 * `summary`/`title`/`text`) produces a dot. `buildTimelineLimitDots` — the sole
 * pure free-text scanner (timeline events carry only free-text `title`/`detail`,
 * no structured type) — is gone: it was the false-positive source.
 */
export function buildLimitDotEvents(
  session: AgentSessionDetail,
  window: SessionTimelineWindow | null
): ActivityMarker[] {
  const explicitThrottles = buildExplicitThrottleLimitDots(session, window);
  if (explicitThrottles.length > 0) {
    return dedupeLimitDotEvents(explicitThrottles);
  }

  return dedupeLimitDotEvents([
    ...buildThrottleSourceLimitDots(session, window),
    ...buildSessionEventLimitDots(session, window),
    ...buildTurnItemLimitDots(session, window),
  ]);
}

function buildExplicitThrottleLimitDots(
  session: AgentSessionDetail,
  window: SessionTimelineWindow | null
): ActivityMarker[] {
  return (session.throttles ?? []).map((throttle) => {
    /*
     * ISS-4821 (whitlockk review): `x0` is the PRODUCER's fraction, computed over
     * `startedAt → resolvePresentationEndMs` (packages/lib/session-trace/
     * derivation.ts). This early-return path kept it verbatim, so a throttle dot
     * never reached the new window math and stayed at its old fraction while the
     * axis around it moved. `t0` is an absolute instant, so recompute from that
     * and keep `x0` only when the timestamp or the window is unusable.
     */
    const x =
      getWindowPercent(window, throttle.t0) ?? clampPercent(throttle.x0);
    return withLimitDotInstant(
      {
        kind: "limit",
        label: formatThrottleLimitLabel(throttle),
        t: formatMarkerTime(throttle.t0),
        tl: resolveLimitTraceRow(session, throttle.t0, throttle.tl, x),
        x,
      },
      window,
      throttle.t0
    );
  });
}

function buildThrottleSourceLimitDots(
  session: AgentSessionDetail,
  window: SessionTimelineWindow | null
): ActivityMarker[] {
  return (session.throttleSources ?? []).map((source, index) => {
    const x = getLimitDotPercent(window, session, source.observedAt, index);
    return withLimitDotInstant(
      {
        kind: "limit",
        label: formatThrottleSourceLimitLabel(source),
        t: formatMarkerTime(source.observedAt),
        tl: resolveLimitTraceRow(session, source.observedAt, index, x),
        x,
      },
      window,
      source.observedAt
    );
  });
}

function buildSessionEventLimitDots(
  session: AgentSessionDetail,
  window: SessionTimelineWindow | null
): ActivityMarker[] {
  return session.events.flatMap((event, index) => {
    const label = getSessionEventLimitLabel(event);
    if (!label) {
      return [];
    }
    const x = getLimitDotPercent(window, session, event.createdAt, index);
    return [
      withLimitDotInstant(
        {
          kind: "limit",
          label,
          t: formatMarkerTime(event.createdAt),
          tl: resolveLimitTraceRow(session, event.createdAt, index, x),
          x,
        },
        window,
        event.createdAt
      ),
    ];
  });
}

function buildTurnItemLimitDots(
  session: AgentSessionDetail,
  window: SessionTimelineWindow | null
): ActivityMarker[] {
  return (session.turnItems ?? []).flatMap((item, index) => {
    const label = getTurnEventLimitLabel(item);
    const timestamp = getTurnItemTimestamp(item);
    if (!(label && timestamp)) {
      return [];
    }
    const fallbackRow = hasTraceRow(item) ? item._row : index;
    const x = getLimitDotPercent(window, session, timestamp, fallbackRow);
    return [
      withLimitDotInstant(
        {
          kind: "limit",
          label,
          t: formatMarkerTime(timestamp),
          tl: resolveExplicitTraceRow(
            hasTraceRow(item) ? item._row : null,
            session,
            timestamp,
            fallbackRow,
            x
          ),
          x,
        },
        window,
        timestamp
      ),
    ];
  });
}

function dedupeLimitDotEvents(events: ActivityMarker[]): ActivityMarker[] {
  const seen = new Set<string>();
  const deduped: ActivityMarker[] = [];
  for (const event of events) {
    const key = `${event.tl}:${event.t}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

/**
 * The fallback marker path, for a session with no PERSISTED markers.
 *
 * ISS-5819 (#4753 review, whitlockk): the marker carries its ABSOLUTE instant
 * alongside the ordinal `x` below. `x` here is `index / (total - 1)` — the
 * turn's POSITION IN THE LIST, not its position in time — which the session-wide
 * axis renders correctly because it plots in that same ordinal geometry, but
 * which a wall-clock window cannot read: on a two-hour run whose second of three
 * turns fires one minute in, an `x` of `50` put the dot an hour late. `item.t`
 * is the real timestamp and was already on hand, only ever formatted for
 * display, so the honest fix is to hand the instant to the consumer that needs a
 * clock rather than have it infer a time from a rank.
 *
 * Attached ONCE here rather than in each of the switch's four `return`s below,
 * so a fifth marker kind cannot be added without it. An unparseable `t` yields
 * `NaN` and is left off, and the projection falls back to `x`.
 */
export function buildTurnMarker(
  item: TurnItem,
  index: number,
  total: number
): ActivityMarker | null {
  const marker = buildOrdinalTurnMarker(item, index, total);
  if (marker === null) {
    return null;
  }
  // `"t" in item` rather than a cast: `TurnItem` is a union and its `idle` arm
  // carries no timestamp at all. Those arms produce no marker anyway, but the
  // narrowing is what makes that a fact the compiler holds rather than one this
  // function assumes about a sibling switch.
  const atMs = "t" in item ? getDateMs(item.t) : Number.NaN;
  return Number.isFinite(atMs) ? { ...marker, atMs } : marker;
}

function buildOrdinalTurnMarker(
  item: TurnItem,
  index: number,
  total: number
): ActivityMarker | null {
  const x = total <= 1 ? 0 : (index / (total - 1)) * 100;
  switch (item.type) {
    case "prompt":
      if (isSessionTerminatingLabel(item.text)) {
        return null;
      }
      return {
        kind: "prompt",
        x,
        t: formatMarkerTime(item.t),
        label: item.text,
        tl: item._row,
      };
    case "tools":
      // FEA-2192: a successful tool turn is routine agent activity, not human
      // steering; only surface a marker when the turn failed. Mirrors the
      // server-side buildTraceMarkers/traceMarkerKind path, which emits no
      // marker for successful tool events.
      return item.hasFail
        ? {
            kind: "fail",
            x,
            t: formatMarkerTime(item.t),
            label: item.summary,
            tl: item._row,
          }
        : null;
    case "event":
      if (getTurnEventLimitLabel(item)) {
        return null;
      }
      return {
        kind: getEventMarkerKind(item.dot),
        x,
        t: formatMarkerTime(item.t),
        label: item.tag ?? item.text,
        tl: item._row,
      };
    case "subagent": {
      // FEA-2192: a completed subagent run is routine agent activity, not human
      // steering; only mark failures (see the "tools" case). Cloud-sourced
      // subagents report "error" (not just "fail") as their failure status, so
      // match the package-wide vocabulary (agent-tree-utils) and the server-side
      // traceMarkerKind, which both treat "error" and "fail" as failures.
      const statusLower = item.status.toLowerCase();
      return statusLower.includes("fail") || statusLower.includes("error")
        ? {
            kind: "fail",
            x,
            t: formatMarkerTime(item.t),
            label: item.sub,
            tl: item._row,
          }
        : null;
    }
    case "say":
      return null;
    case "idle":
    case "sessionstart":
    case "end":
      return null;
    default:
      return assertNeverTurnItem(item);
  }
}

function formatThrottleLimitLabel(throttle: SessionThrottle): string {
  const duration = formatThrottleDuration(throttle.durMin);
  if (duration) {
    return `Throttled for ${duration}; resumed ${formatMarkerTime(throttle.t1)}`;
  }
  return `Throttled; resumed ${formatMarkerTime(throttle.t1)}`;
}

function assertNeverTurnItem(item: never): null {
  return item;
}

/**
 * Carry a limit dot's ABSOLUTE instant, the way {@link buildTurnMarker} already
 * carries a turn marker's. Every limit-dot builder above funnels through here.
 *
 * ISS-8721: `buildDotCells` orders the trouble lane by plotted `x`, and `x` is
 * not one scale on every path. A session with no persisted markers falls back to
 * `buildOrdinalTurnMarker`, whose `x` is the turn's ORDINAL, while a limit dot's
 * `x` is a fraction of the wall-clock window — so the comparison could put a
 * later limit ahead of an earlier failure, and `getDotJumpRow` takes the lane's
 * first member, so the rail's click landed on the wrong row. Both sides carrying
 * the instant is what gives that comparison one scale.
 *
 * WITHHELD when the window does not contain the instant, rather than attached
 * and clamped. `x` here is clamped into `[0, 100]`, so an event dated past the
 * window's end plots at 100 and `resolveMarkerMs` reads that back as the
 * window's own end — inside every rendered window. A true `atMs` reads back as
 * itself, lands past `projectMarkers`' `windowEndMs`, and DROPS the dot. Absent
 * is the honest answer for an instant this timeline has no position for, and it
 * leaves such a lane on the `x` order it has today rather than buying an
 * ordering by losing a dot. A `NaN` fails both comparisons, so an unparseable
 * timestamp takes the same path.
 */
function withLimitDotInstant(
  marker: ActivityMarker,
  window: SessionTimelineWindow | null,
  timestamp: unknown
): ActivityMarker {
  const atMs = getDateMs(timestamp);
  if (!(window && atMs >= window.startMs && atMs <= window.endMs)) {
    return marker;
  }
  return { ...marker, atMs };
}
