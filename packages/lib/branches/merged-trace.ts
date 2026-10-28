import type { TurnItem } from "@repo/api/src/types/agent-session";
import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";

/**
 * Idle threshold for the cross-session merged trace: a PAUSE this long or longer
 * — measured from the end of the last item that was still running to the start
 * of the next — synthesizes an `idle` marker.
 *
 * SSOT pair with `DEFAULT_IDLE_THRESHOLD_MS` in
 * `packages/app/branches/lib/branch-derivations.ts` — the renderer re-derives
 * idle spans from the same instants for the swimlane's bursts, on the same tab,
 * and must agree with this builder. ISS-8720: what they measure is now shared
 * code (`mergedTraceItemEndMs`) rather than two walks a comment asks to match.
 */
export const MERGED_TRACE_IDLE_THRESHOLD_MS = 120_000; // 2 min

/** Parse a subagent cost label (e.g. "$0.42") into a number, else null. */
export function parseSubagentCostUsd(value: string | null): number | null {
  if (value == null) {
    return null;
  }
  const parsed = Number.parseFloat(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Map a Sessions-detail `TurnItem` onto the contract `MergedTraceItem`, tagging
 * its `sessionId`. The detail projection (`projectAgentSessionTurnItems`) only
 * ever emits `prompt`/`say`/`tools`/`subagent`/`event`/`end` — the per-session
 * `sessionstart` and the gap `idle` markers are SYNTHESIZED by the merge below
 * (the projection carries neither), so those fall through to `null` here.
 */
export function mapTurnItemToTrace(
  item: TurnItem,
  sessionId: string
): MergedTraceItem | null {
  switch (item.type) {
    case "prompt":
    case "say":
      return {
        type: item.type,
        sessionId,
        t: item.t,
        tMs: item.tMs,
        cumCostUsd: item.cum,
        actorName: item.actor.name,
        text: item.text,
      };
    case "tools":
      return {
        type: "tools",
        sessionId,
        t: item.t,
        tMs: item.tMs,
        endMs: item.endMs,
        summary: item.summary,
        hasFail: item.hasFail,
        failN: item.failN,
        // Carry the per-tool rows so the branch trace's tool cards expand with
        // the same detail the session-detail trace shows.
        items: item.items,
      };
    case "subagent":
      return {
        type: "subagent",
        sessionId,
        t: item.t,
        tMs: item.tMs,
        sub: item.sub,
        model: item.model,
        // FEA-4178: `costUsd` stays the fixed-2dp label parse for
        // legacy/compatibility consumers, but carry the EXACT `costDelta` (and
        // running `cum`) the projection attributed so the branch merge never
        // loses precision to the `$0.00` label — the adapter prefers these and
        // falls back to the label parse only for older producers that omit them.
        costUsd: parseSubagentCostUsd(item.cost),
        costDeltaUsd: item.costDelta ?? null,
        cumCostUsd: item.cum,
      };
    case "event":
      return {
        type: "event",
        sessionId,
        t: item.t,
        dot: item.dot,
        text: item.text,
        tag: item.tag,
      };
    case "end":
      return { type: "end", sessionId, text: item.text };
    default:
      return null;
  }
}

/**
 * One branch-linked session's contribution to the merged trace: its identity, a
 * session-start actor, and its already-projected turn items. Callers project the
 * raw `AgentSessionEvent`s into `turnItems` on their own surface (the desktop
 * local loader or the cloud read path), then hand the surface-agnostic result
 * here so the map/merge/idle logic stays a single source of truth.
 */
export type MergedTraceSessionInput = {
  sessionId: string;
  /** ISO session start — anchors the synthesized `sessionstart` marker. */
  startedAt: string;
  /** `sessionstart.actor.name` (session name, else primary model). */
  actorName: string | null;
  /** `sessionstart.actor.harness`. */
  harness: string | null;
  turnItems: readonly TurnItem[];
};

/** Project one session's inputs into its stamped `MergedTraceItem`s (+ end tail). */
export function collectSessionTraceItems(session: MergedTraceSessionInput): {
  stamped: { ms: number; item: MergedTraceItem }[];
  tail: MergedTraceItem[];
  unstampedCount: number;
} {
  const stamped: { ms: number; item: MergedTraceItem }[] = [];
  const tail: MergedTraceItem[] = [];
  let unstampedCount = 0;

  // Synthesize exactly one session-boundary marker at the session's start. The
  // detail projection never emits one, and the richer `isResumed`/`machine`
  // signals have no v1 producer — they stay undefined until a producer captures
  // them (the contract union already carries the optional fields).
  const startMs = Date.parse(session.startedAt);
  if (!Number.isNaN(startMs)) {
    stamped.push({
      ms: startMs,
      item: {
        type: "sessionstart",
        sessionId: session.sessionId,
        t: session.startedAt,
        actor: { name: session.actorName, harness: session.harness },
      },
    });
  }

  for (const turn of session.turnItems) {
    const mapped = mapTurnItemToTrace(turn, session.sessionId);
    if (!mapped) {
      continue;
    }
    if (mapped.type === "end") {
      tail.push(mapped);
      continue;
    }
    const ms = Date.parse(mapped.t);
    if (Number.isNaN(ms)) {
      // ISS-9723 (#6884 review, davetho): this turn HAS a trace
      // representation and cannot be placed, so it is an unreadable item like
      // any other — and it is discarded HERE, upstream of the schema partition
      // that reports drops. Counting it is what stops "nothing was unreadable"
      // and "something unreadable was removed before anyone could count it"
      // being the same answer, which is the collapse this ticket exists to end.
      unstampedCount += 1;
      continue;
    }
    stamped.push({ ms, item: mapped });
  }
  return { stamped, tail, unstampedCount };
}

/**
 * Build the chronological cross-session `mergedTrace`: collect each session's
 * synthesized `sessionstart` + mapped turn items, k-way merge-sort all stamped
 * items by timestamp (flatten + stable sort by ms), and synthesize an `idle`
 * marker wherever the PAUSE before an item reaches the idle threshold. `end`
 * markers (which carry no timestamp) trail the stream.
 */
export function buildMergedTrace(
  sessions: readonly MergedTraceSessionInput[]
): MergedTraceItem[] {
  return buildMergedTraceWithDiscards(sessions).items;
}

/**
 * The same build, plus the per-Session count of turn items it DISCARDED for an
 * unreadable timestamp.
 *
 * ISS-9723 (#6884 review, davetho). `buildMergedTrace` has always dropped a
 * turn whose `t` will not parse, silently and before any consumer could see it.
 * That was invisible while a producer also withheld the whole Session for one
 * unparseable item — the Session was gone either way — but this ticket keeps
 * such a Session and reports a count, and a drop nothing counts makes the served
 * trace claim `Complete` over an item it removed. So the builder now says what
 * it took.
 *
 * Additive by construction: `buildMergedTrace` above keeps its exact shape for
 * every existing caller, and only the two branch-trace producers — the cloud
 * read path and the Desktop main-process builder — read the counts, so both
 * report the same drops from one definition.
 *
 * SYNTHESIZED MARKERS ARE NOT COUNTED. A `sessionstart` this builder declines to
 * synthesize because `startedAt` will not parse is not a producer item that went
 * missing; it is a marker that was never evidence. Neither is a turn
 * `mapTurnItemToTrace` returns `null` for — that is a turn type the trace
 * deliberately does not represent, and counting it would disclose a gap to a
 * reader who is missing nothing. Only a turn that HAS a trace representation and
 * cannot be placed in time is a drop.
 */
export function buildMergedTraceWithDiscards(
  sessions: readonly MergedTraceSessionInput[]
): {
  items: MergedTraceItem[];
  /** Per-Session count of discarded turns; a Session that lost none is absent. */
  unstampedCountBySession: Map<string, number>;
} {
  return mergeCollectedTraceSessions(
    sessions.map((session) => ({
      sessionId: session.sessionId,
      ...collectSessionTraceItems(session),
    }))
  );
}

/** Merge already collected sessions, so callers can isolate collection failures. */
export function mergeCollectedTraceSessions(
  sessions: readonly (ReturnType<typeof collectSessionTraceItems> & {
    sessionId: string;
  })[]
): {
  items: MergedTraceItem[];
  unstampedCountBySession: Map<string, number>;
} {
  const stamped: { ms: number; item: MergedTraceItem }[] = [];
  const tail: MergedTraceItem[] = [];
  const unstampedCountBySession = new Map<string, number>();
  for (const session of sessions) {
    const collected = session;
    stamped.push(...collected.stamped);
    tail.push(...collected.tail);
    if (collected.unstampedCount > 0) {
      unstampedCountBySession.set(
        session.sessionId,
        (unstampedCountBySession.get(session.sessionId) ?? 0) +
          collected.unstampedCount
      );
    }
  }
  stamped.sort((a, b) => a.ms - b.ms);

  const merged: MergedTraceItem[] = [];
  // The latest instant anything was still running. A running MAX, not the
  // previous item's end: sorting is by START, so a long `tools` run can enclose
  // a later-starting item and still be the last thing active.
  let activeUntilMs = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < stamped.length; i += 1) {
    const current = stamped[i];
    if (i > 0) {
      const gapMs = current.ms - activeUntilMs;
      // Overlapping items make this negative and NaN never compares true, so
      // only a real pause of at least the threshold reaches the marker.
      if (gapMs >= MERGED_TRACE_IDLE_THRESHOLD_MS) {
        merged.push({
          type: "idle",
          sessionId: current.item.sessionId,
          // The instant the pause BEGAN — the end of the last item still
          // running, not that item's start — so `t + gapMs` lands on the next
          // item and the marker cannot describe an interval it does not span.
          t: new Date(activeUntilMs).toISOString(),
          gapMs,
        });
      }
    }
    activeUntilMs = Math.max(
      activeUntilMs,
      mergedTraceItemEndMs(current.item, current.ms)
    );
    merged.push(current.item);
  }
  merged.push(...tail);
  return { items: merged, unstampedCountBySession };
}

/**
 * The instant a stamped item stops occupying the trace, given its already-parsed
 * start. THE one implementation — `activeIdleSpans` re-derives idle spans from
 * the same instants for the swimlane, on the same tab, so a second copy here
 * could only ever disagree with this builder about the same pause.
 *
 * `tools` is the one variant the contract gives an extent to; every other
 * stamped variant is a point event, so its end IS its start — an absent extent
 * here is zero duration, not an unknown one, and start-to-start is the true
 * pause for it. `subagent` is the one item that genuinely spans wall-clock time
 * without carrying an end; the contract has no field for it, so it stays a
 * point until a producer supplies one.
 *
 * An `endMs` {@link classifyTraceExtentRejection} refuses is discarded rather
 * than trusted, and the item falls back to its own start — the same treatment
 * every point-event variant gets, and exactly the pre-ISS-8720 number. It is
 * never CLAMPED to a plausible-looking instant: a fabricated extent renders as
 * a confident measurement, which is worse than the refusal.
 */
export function mergedTraceItemEndMs(
  item: MergedTraceItem,
  startMs: number
): number {
  if (item.type !== "tools") {
    return startMs;
  }
  const { endMs } = item;
  return classifyTraceExtentRejection(endMs, startMs) === null
    ? endMs
    : startMs;
}

/**
 * The largest instant an ECMAScript `Date` can represent (the ±8.64e15 ms time
 * value range). Past it `new Date(ms)` is an Invalid Date and `.toISOString()`
 * throws, so a stamp beyond this is not a late measurement — it is not an
 * instant at all.
 */
export const MAX_TRACE_INSTANT_MS = 8_640_000_000_000_000;

/**
 * Why a `tools` extent was refused. A CLOSED vocabulary, because it is the
 * group-by facet the server-side report keys on
 * (`apps/api/app/branches/merged-trace-extent-report.ts`) — a reason invented at
 * a call site would land in a bucket nobody queries.
 */
export const TraceExtentRejection = {
  /** `NaN`/`Infinity` — an unparseable source stamp, or an absent field on a version-skewed producer. */
  NotFinite: "not_finite",
  /** A fractional millisecond: an instant this contract counts in whole ms cannot fall between two. */
  FractionalMs: "fractional_ms",
  /** Before the epoch. No branch-trace tool run predates 1970. */
  Negative: "negative",
  /** Past {@link MAX_TRACE_INSTANT_MS} — unrepresentable as a `Date`, and the shape a µs/ns stamp mistaken for ms takes. */
  BeyondRepresentableInstant: "beyond_representable_instant",
  /** Ends before it starts — clock skew, or `Number("")` folding a blank stamp to a measured `0`. */
  BeforeStart: "before_start",
} as const;
export type TraceExtentRejection =
  (typeof TraceExtentRejection)[keyof typeof TraceExtentRejection];

/**
 * Whether a `tools` extent may size a pause, and if not, why. `null` means the
 * value is trustworthy.
 *
 * ISS-8767: since ISS-8720 made `mergedTraceItemEndMs` the ONE definition of
 * where a pause begins, a bad `endMs` no longer mis-sizes one row — it is
 * carried forward as `buildMergedTrace`'s running `activeUntilMs` MAX and as
 * `activeIdleSpans`'s sweep-line cursor, so a single far-future value drives
 * every later `gapMs` negative and NO further idle marker is synthesized for the
 * rest of the trace. The UI then shows "no idle" when the truth is "the data is
 * corrupt". The wire contract only checks `endMs` is a number, and it arrives
 * from a version-skewed Desktop producer, so the check belongs here.
 *
 * This covers the set that is IMPOSSIBLE rather than merely implausible — every
 * member renders as a confident real measurement. It deliberately does NOT
 * bound a finite, representable, far-future instant (a year-9999 stamp): any
 * such cutoff decides what "still running" is allowed to mean, and a tool
 * genuinely running past the last stamped item is legitimate. That horizon is a
 * product decision, tracked on ISS-8767, not an implementation call.
 */
export function classifyTraceExtentRejection(
  endMs: number,
  startMs: number
): TraceExtentRejection | null {
  if (!Number.isFinite(endMs)) {
    return TraceExtentRejection.NotFinite;
  }
  if (!Number.isInteger(endMs)) {
    return TraceExtentRejection.FractionalMs;
  }
  if (endMs < 0) {
    return TraceExtentRejection.Negative;
  }
  // Subsumes the safe-integer ceiling: MAX_TRACE_INSTANT_MS is the tighter of
  // the two, so nothing past `Number.MAX_SAFE_INTEGER` gets through here.
  if (endMs > MAX_TRACE_INSTANT_MS) {
    return TraceExtentRejection.BeyondRepresentableInstant;
  }
  // Last, so a value that is BOTH out of range and pre-start reports the
  // stronger fact. `startMs` may itself be negative, which is why the epoch
  // floor above is a separate check rather than something this one implies.
  if (endMs < startMs) {
    return TraceExtentRejection.BeforeStart;
  }
  return null;
}

/** One refused `tools` extent, as the reporting layer needs to describe it. */
export type UntrustworthyTraceExtent = {
  sessionId: string;
  t: string;
  endMs: number;
  reason: TraceExtentRejection;
};

/**
 * Every `tools` item in a built trace whose extent {@link mergedTraceItemEndMs}
 * refused. PURE — this module is imported by the browser bundle through
 * `packages/app`'s `activeIdleSpans`, where `no-client-debug-logging` bans a
 * log, so detection lives here and the report is emitted by the server-side
 * caller that holds the org (`apps/api/app/branches/branch-trace-service.ts`),
 * exactly as `session-branch-divisor.ts` splits the same concern.
 */
export function untrustworthyTraceExtents(
  items: readonly MergedTraceItem[]
): UntrustworthyTraceExtent[] {
  const refused: UntrustworthyTraceExtent[] = [];
  for (const item of items) {
    if (item.type !== "tools") {
      continue;
    }
    const startMs = Date.parse(item.t);
    // An unstampable `t` never entered the merge, so its extent sized nothing.
    if (Number.isNaN(startMs)) {
      continue;
    }
    const reason = classifyTraceExtentRejection(item.endMs, startMs);
    if (reason !== null) {
      refused.push({
        sessionId: item.sessionId,
        t: item.t,
        endMs: item.endMs,
        reason,
      });
    }
  }
  return refused;
}
