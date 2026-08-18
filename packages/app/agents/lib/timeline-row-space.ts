/**
 * FEA-4252: coordinate the two `_row` spaces the session-detail view juggles.
 *
 * The Session Timeline (cost bars, event dots, limit dots) computes its jump
 * rows from the DB-backed `session.turnItems` projection, while the trace that
 * actually renders on the web is the parsed cloud transcript (FEA-2718 removed
 * the DB turn-text trace). The two projections mint their strong ids from
 * DIFFERENT pipelines (the cloud parser from the transcript `uuid`/`promptId`;
 * the DB projection from `externalEventId`/metadata `userTurnId`), and id-less
 * assistant `say` turns carry no strong id at all, so on a real web session most
 * turns do NOT share a `transcriptIdentity` across the two — and even when they
 * do, a divergent event set (a stale/partial upload, or the DB dropping rows the
 * parser keeps) assigns the same turn a DIFFERENT `_row` in each. This module
 * owns the row translation both directions — strong id, then nearest-time, then
 * the weak `externalAgentId` group tag — so a timeline click lands on the turn
 * the reader pointed at (or its closest neighbor) and the "you are here" marker
 * stays on it.
 *
 * Extracted from `agent-session-detail-view.tsx` (a grandfathered oversize file)
 * so the coordination lives in one small, unit-tested place.
 */

import type {
  TranscriptTurnIdentity,
  TurnItem,
} from "@repo/api/src/types/agent-session";

/**
 * The pair of row-space translators the transcript panel publishes to the
 * detail view, plus whether the rendered trace has any rows yet.
 *
 * - `toRendered` maps a Session Timeline jump row (source `session.turnItems`
 *   space) forward into the rendered `_row` space — the clicked turn's exact
 *   counterpart when one exists, otherwise its nearest-in-time neighbor — or
 *   `null` only when the rendered trace has no landable row to correlate against
 *   at all (a skeleton, or the clicked turn carries no usable timestamp and no
 *   shared id), in which case the caller skips the jump.
 * - `toTrace` maps a rendered row back into the source space for the "you are
 *   here" marker.
 * - `hasRenderedRows` is `false` while the trace is still a skeleton, so the
 *   timeline can disable its bars/dots rather than promise navigation that lands
 *   nowhere.
 */
export type TraceRowTranslators = {
  toRendered: (sourceRow: number) => number | null;
  toTrace: (renderedRow: number) => number;
  hasRenderedRows: boolean;
};

/**
 * Options controlling how a source ↔ rendered translation resolves.
 *
 * - `allowNearestTime` (default `true`): whether the coarse nearest-in-time
 *   correlation is permitted when no strong id matches. It is turned OFF when the
 *   rendered trace is NOT the timeline's own conversation — a `subagent:{id}`
 *   sidechain rendered while the Session Timeline stays keyed to the root
 *   `session.turnItems`. There the two projections describe DIFFERENT
 *   conversations, so their timestamps are unrelated; a root prompt with no strong
 *   id would otherwise nearest-time onto whatever subagent row is closest in
 *   wall-clock time — an unrelated turn. With nearest-time off, only a shared
 *   STRONG per-turn id (a subagent summary row genuinely present in both, which is
 *   file-agnostic) can bind, and everything else correctly skips the jump.
 */
export type TraceRowTranslationOptions = {
  allowNearestTime?: boolean;
};

/**
 * The producer-minted identity fields that uniquely name a single logical turn
 * or tool. A match on any one of these is authoritative. `externalAgentId` is
 * DELIBERATELY excluded: the projection copies it onto every tool event owned by
 * a subagent AND onto the subagent summary, so it is a GROUP tag, not a turn
 * identity — matching on it can bind to an earlier tool group. It is handled in a
 * later, weaker pass.
 */
const STRONG_IDENTITY_FIELDS = [
  "eventId",
  "providerToolUseId",
  "userTurnId",
  "agentId",
] as const;

/**
 * Translate a jump target expressed in the source (`session.turnItems`) `_row`
 * space into the rendered trace's `_row` space.
 *
 * Resolution order (FEA-4252), weakest signal never winning ahead of a stronger:
 *  1. A shared STRONG `transcriptIdentity` — the rendered row that owns the SAME
 *     logical turn as `sourceRow` (exact, per-turn).
 *  2. When no strong id correlates, the rendered row whose timestamp is NEAREST
 *     the clicked turn's instant. The two projections mint their strong ids from
 *     DIFFERENT pipelines (the cloud parser from the transcript `uuid`/`promptId`;
 *     the DB projection from `externalEventId`/metadata `userTurnId`), and id-less
 *     assistant `say` turns carry no strong id at all, so an exact-identity-only
 *     translation silently returned `null` for the COMMON web case — and the
 *     caller then skipped the jump, so a dot/column click scrolled NOWHERE. Both
 *     projections stamp real timestamps, so nearest-time lands on the right turn
 *     (or its closest neighbor) instead of nothing.
 *  3. Only when neither a strong id nor a usable timestamp resolves, the weak
 *     `externalAgentId` GROUP tag — a same-subagent row is still better than
 *     skipping. It runs LAST (after nearest-time) on purpose: the tag names a
 *     whole subagent, so an earlier tool row owned by the same subagent shares it
 *     with the clicked turn, and letting it win would bind the jump to that
 *     earlier row instead of the correct instant.
 *
 * Returns `null` only when the rendered trace has no landable row to correlate
 * against at all — a skeleton, or the clicked turn carries no usable timestamp
 * and shares no id — so the caller skips a jump that could not scroll anywhere.
 *
 * When the two projections coincide (desktop renders `session.turnItems` itself,
 * or an aligned web session by reference) the translation is a no-op — the raw
 * `sourceRow` is returned — so the existing scroll never regresses.
 */
export function translateTraceRowToRendered(
  sourceRow: number,
  sourceItems: readonly TurnItem[],
  renderedItems: readonly TurnItem[],
  options?: TraceRowTranslationOptions
): number | null {
  if (sourceItems === renderedItems) {
    return sourceRow;
  }
  const identities = collectTraceRowIdentities(sourceItems, sourceRow);
  const byStrongId =
    identities.length > 0
      ? findRenderedRowByStrongIdentity(renderedItems, identities)
      : null;
  if (byStrongId !== null) {
    return byStrongId;
  }
  // When the rendered trace is a different conversation than the timeline's source
  // (a subagent sidechain vs the root projection), their instants are unrelated,
  // so nearest-time would land on an unrelated row. Only the file-agnostic strong
  // id (handled above) is trustworthy there; skip the coarse fallbacks.
  if (options?.allowNearestTime === false) {
    return null;
  }
  // Nearest-time runs BEFORE the `externalAgentId` group-tag pass on purpose. The
  // group tag names a whole subagent, not one turn, so an earlier tool row owned
  // by the same subagent (e.g. before a failed retry) carries the same tag as the
  // clicked turn; letting it win would bind the jump to that earlier tool row and
  // never reach the timestamp fallback. Equal length does NOT rescue us either —
  // a cloud-only preamble that offsets every rendered row while a different
  // DB-only event keeps the counts equal leaves the projections the same length
  // but with every shared turn shifted, so returning the raw `sourceRow` would
  // scroll to an unrelated turn (or a nonexistent `data-row`). Reference equality
  // (handled above) is the only sound structural signal; otherwise the real
  // instant both projections stamp lands on the clicked turn (or its closest
  // neighbor) regardless of how the two projections are sized.
  const byTime = findRenderedRowByNearestTime(
    sourceItems,
    sourceRow,
    renderedItems
  );
  if (byTime !== null) {
    return byTime;
  }
  // Only when neither a strong id nor a usable timestamp resolves do we fall back
  // to the weak group tag, so a same-subagent row is still better than skipping.
  return identities.length > 0
    ? findRenderedRowByGroupTag(renderedItems, identities)
    : null;
}

/**
 * Translate a rendered-space row (what the scroll handler reports and a jump
 * lands on) BACK into the source `session.turnItems` space, so the timeline's
 * "you are here" marker — which measures the active row against bucket `tl0`
 * values keyed to `session.turnItems._row` — stays on the turn the reader is
 * actually looking at. Inverse of {@link translateTraceRowToRendered}: identity
 * first, then nearest-time (see that function for why identity alone misses on
 * the web), falling back to the original row so the marker still points
 * somewhere sensible rather than vanishing.
 */
export function translateRenderedRowToTrace(
  renderedRow: number,
  sourceItems: readonly TurnItem[],
  renderedItems: readonly TurnItem[],
  options?: TraceRowTranslationOptions
): number {
  if (sourceItems === renderedItems) {
    return renderedRow;
  }
  const identities = collectTraceRowIdentities(renderedItems, renderedRow);
  const byStrongId =
    identities.length > 0
      ? findRenderedRowByStrongIdentity(sourceItems, identities)
      : null;
  if (byStrongId !== null) {
    return byStrongId;
  }
  // Same cross-conversation guard as the forward translator: with the rendered
  // trace on a different file than the source, only the strong id is trustworthy;
  // fall back to the raw row so the "you are here" marker still points somewhere.
  if (options?.allowNearestTime === false) {
    return renderedRow;
  }
  // Same staged order as the forward translator: strong id, then nearest-time,
  // then the weak `externalAgentId` group tag, so a same-subagent earlier row
  // cannot win ahead of the real instant. Falls back to the original row so the
  // "you are here" marker still points somewhere sensible rather than vanishing.
  const byTime = findRenderedRowByNearestTime(
    renderedItems,
    renderedRow,
    sourceItems
  );
  if (byTime !== null) {
    return byTime;
  }
  const byGroup =
    identities.length > 0
      ? findRenderedRowByGroupTag(sourceItems, identities)
      : null;
  return byGroup ?? renderedRow;
}

/**
 * Every identity carried by the item whose `_row` equals `row` — its own
 * `transcriptIdentity` plus, for a tools turn, each inner tool's identity (the
 * shared id often lives on the tool, not the turn). Mirrors the matching in
 * `resolveTranscriptInvocationAnchorRow`.
 */
export function collectTraceRowIdentities(
  items: readonly TurnItem[],
  row: number
): TranscriptTurnIdentity[] {
  for (const item of items) {
    if ("_row" in item && item._row === row) {
      return traceItemIdentities(item);
    }
  }
  return [];
}

/** The row-bearing identities on a single turn (top-level + inner tools). */
export function traceItemIdentities(item: TurnItem): TranscriptTurnIdentity[] {
  const identities: TranscriptTurnIdentity[] = [];
  if ("transcriptIdentity" in item && item.transcriptIdentity) {
    identities.push(item.transcriptIdentity);
  }
  if (item.type === "tools") {
    for (const tool of item.items) {
      if (tool.transcriptIdentity) {
        identities.push(tool.transcriptIdentity);
      }
    }
  }
  return identities;
}

/**
 * The rendered row that shares a STRONG per-turn producer id (eventId /
 * providerToolUseId / userTurnId / agentId) with one of `identities`, scanned
 * across ALL rows. This is the authoritative, exact-per-turn pass and is the ONLY
 * identity signal the translators trust ahead of the timestamp fallback.
 *
 * The `timestamp` + `timestampOrdinal` pair is DELIBERATELY not used here.
 * `timestampOrdinal` is minted per projection as a positional running counter
 * over same-instant rows (`agent-session-detail-projection.ts`), so under the
 * very DB-vs-cloud divergence this translation exists to correct, two same-instant
 * id-less rows (e.g. assistant `say` turns) can be assigned different ordinals in
 * each projection. Matching on it would silently land a jump on the wrong turn.
 * The general {@link transcriptIdentitiesMatch} still exposes the ordinal pass for
 * same-projection callers where the ordinals are comparable.
 *
 * Returns `null` when no strong id matches so the caller can run nearest-time.
 */
function findRenderedRowByStrongIdentity(
  items: readonly TurnItem[],
  identities: readonly TranscriptTurnIdentity[]
): number | null {
  return findRowMatching(items, identities, strongIdentityMatch);
}

/**
 * The rendered row that shares the (group-level) `externalAgentId` tag with one
 * of `identities`. This is a WEAK last resort: the tag binds a whole subagent's
 * rows, not a single turn, so an earlier tool row owned by the same subagent
 * carries the same tag as the clicked turn. The translators run this AFTER the
 * nearest-time fallback so the real instant wins over a same-subagent earlier
 * row; it only decides cases where no strong id AND no usable timestamp exist.
 *
 * Returns `null` when nothing shares the group tag so the caller can skip the jump.
 */
function findRenderedRowByGroupTag(
  items: readonly TurnItem[],
  identities: readonly TranscriptTurnIdentity[]
): number | null {
  return findRowMatching(items, identities, externalAgentGroupMatch);
}

/** The first item whose identities satisfy `predicate` against `identities`. */
function findRowMatching(
  items: readonly TurnItem[],
  identities: readonly TranscriptTurnIdentity[],
  predicate: (
    candidate: TranscriptTurnIdentity,
    target: TranscriptTurnIdentity
  ) => boolean
): number | null {
  for (const item of items) {
    if (!("_row" in item)) {
      continue;
    }
    const candidates = traceItemIdentities(item);
    const matches = candidates.some((candidate) =>
      identities.some((identity) => predicate(candidate, identity))
    );
    if (matches) {
      return item._row;
    }
  }
  return null;
}

/** Whether two identities share a strong per-turn producer id. */
function strongIdentityMatch(
  left: TranscriptTurnIdentity,
  right: TranscriptTurnIdentity
): boolean {
  return STRONG_IDENTITY_FIELDS.some((field) =>
    idsEqual(left[field], right[field])
  );
}

/** Whether two identities carry the exact same timestamp + ordinal pair. */
function timestampOrdinalMatch(
  left: TranscriptTurnIdentity,
  right: TranscriptTurnIdentity
): boolean {
  return (
    left.timestamp !== undefined &&
    left.timestamp === right.timestamp &&
    left.timestampOrdinal !== undefined &&
    left.timestampOrdinal === right.timestampOrdinal
  );
}

/** Whether two identities share the (group-level) `externalAgentId` tag. */
function externalAgentGroupMatch(
  left: TranscriptTurnIdentity,
  right: TranscriptTurnIdentity
): boolean {
  return idsEqual(left.externalAgentId, right.externalAgentId);
}

/**
 * Whether two projected identities describe the same logical turn, in one
 * boolean for callers that do not need the staged ordering (invocation-anchor
 * style matching). Strong producer id first, then exact timestamp + ordinal,
 * then the `externalAgentId` group tag as a last resort.
 */
export function transcriptIdentitiesMatch(
  left: TranscriptTurnIdentity | null | undefined,
  right: TranscriptTurnIdentity | null | undefined
): boolean {
  if (!(left && right)) {
    return false;
  }
  return (
    strongIdentityMatch(left, right) ||
    timestampOrdinalMatch(left, right) ||
    externalAgentGroupMatch(left, right)
  );
}

/** Two id fields match only when both are present and equal (never undefined). */
function idsEqual(
  left: string | undefined,
  right: string | undefined
): boolean {
  return left !== undefined && left === right;
}

/**
 * The default coordination for a session whose two projections coincide
 * (desktop, or before the panel has published its rendered snapshot): every
 * translation is the identity, and the timeline treats itself as live.
 */
export const IDENTITY_TRACE_ROW_TRANSLATORS: TraceRowTranslators = {
  toRendered: (sourceRow) => sourceRow,
  toTrace: (renderedRow) => renderedRow,
  hasRenderedRows: true,
};

/**
 * Build the row-space translators for a concrete source ↔ rendered projection
 * pair. Snapshots both arrays so the returned translators stay aligned with
 * whatever the panel was painting when it published them.
 */
export function buildTraceRowTranslators(
  sourceItems: readonly TurnItem[],
  renderedItems: readonly TurnItem[],
  options?: TraceRowTranslationOptions
): TraceRowTranslators {
  return {
    toRendered: (sourceRow) =>
      translateTraceRowToRendered(
        sourceRow,
        sourceItems,
        renderedItems,
        options
      ),
    toTrace: (renderedRow) =>
      translateRenderedRowToTrace(
        renderedRow,
        sourceItems,
        renderedItems,
        options
      ),
    hasRenderedRows: renderedItems.length > 0,
  };
}

/**
 * The `_row`-bearing target item whose `_row` equals `row`, or `null` when no
 * such row exists (an out-of-range or `end`/`idle`-only sentinel). Only rows
 * that render a scroll target carry `_row`.
 */
function findItemByRow(
  items: readonly TurnItem[],
  row: number
): TurnItem | null {
  for (const item of items) {
    if ("_row" in item && item._row === row) {
      return item;
    }
  }
  return null;
}

/**
 * The turn instant in epoch ms, or `null` when the row carries no usable time.
 * Prefers the precomputed `tMs` and falls back to parsing the ISO `t` so a row
 * that only carries the string still correlates.
 *
 * A Unix-epoch value (`0` / `1970-01-01T00:00:00.000Z`) is treated as "no usable
 * time", not a real instant. Some producers encode a MISSING tool/subagent
 * timestamp as epoch 0 (a synthetic sentinel), and `Number.isFinite(0)` is `true`,
 * so without this guard nearest-time would treat the sentinel as a genuine 1970
 * instant and bind an older timestamp-less row to whatever row is "closest" to
 * epoch — the wrong-position bug FEA-4252 exists to prevent. Rejecting epoch here
 * lets that row fall through to the weaker `externalAgentId` group tag (or skip)
 * instead of a spurious nearest-time match.
 */
function turnItemMs(item: TurnItem): number | null {
  if ("tMs" in item && Number.isFinite(item.tMs)) {
    return isEpochSentinel(item.tMs) ? null : item.tMs;
  }
  if ("t" in item && typeof item.t === "string") {
    const parsed = Date.parse(item.t);
    if (!Number.isFinite(parsed) || isEpochSentinel(parsed)) {
      return null;
    }
    return parsed;
  }
  return null;
}

/**
 * Whether an epoch-ms value is the Unix-epoch sentinel (`0`) some producers emit
 * for a missing timestamp. A real agent turn is never stamped at 1970, so this is
 * a safe "no usable time" signal rather than a plausible instant.
 */
function isEpochSentinel(ms: number): boolean {
  return ms === 0;
}

/**
 * The maximum wall-clock gap (ms) between the clicked turn's instant and the
 * candidate rendered row before nearest-time refuses to bind them. The two
 * projections describe the SAME conversation, so a genuine counterpart is stamped
 * within seconds even allowing for parser/clock skew and same-instant coalescing;
 * a candidate an hour away is a DIFFERENT turn (a stale trace missing the clicked
 * turn's tail, or an unrelated subagent sidechain), and binding to it is exactly
 * the wrong-position bug FEA-4252 fixes. Ten minutes is deliberately generous —
 * it accepts the closest neighbor of a dropped turn while rejecting a jump to an
 * unrelated region of a divergent trace.
 */
const NEAREST_TIME_MAX_DISTANCE_MS = 10 * 60 * 1000;

/**
 * The `_row` of the target-projection turn whose instant is NEAREST the
 * `sourceRow`'s instant — the coarse correlation used when no `transcriptIdentity`
 * is shared across the two projections (the common web case; see
 * {@link translateTraceRowToRendered}). Both projections stamp real timestamps,
 * so nearest-time lands on the clicked turn — or, when the exact turn is absent,
 * its closest plausibly-near neighbor — instead of skipping the jump entirely.
 *
 * Two guards keep this from reintroducing the wrong-position bug it exists to
 * cure:
 *  - A PLAUSIBILITY bound: a candidate more than {@link NEAREST_TIME_MAX_DISTANCE_MS}
 *    from the clicked instant is rejected. A stale trace missing the clicked turn's
 *    later tail would otherwise bind the click to the last surviving (far-earlier)
 *    row, and a subagent sidechain to an unrelated turn — both the same wrong scroll
 *    FEA-4252 is meant to prevent. Better to return `null` (skip, or fall to the
 *    group tag) than to scroll confidently to the wrong turn.
 *  - An AMBIGUITY guard: when two candidate rows are exactly equidistant from the
 *    clicked instant (a tie), there is no principled way to pick one — the
 *    per-projection `timestampOrdinal` is meaningless across projections — so we
 *    return `null` rather than silently taking the first row and (potentially)
 *    landing one turn off.
 *
 * Returns `null` when neither side carries a usable timestamp, the target has no
 * `_row`-bearing rows at all, no candidate is within the plausibility bound, or
 * the nearest candidate is an unresolvable tie — so the caller can decide the
 * ultimate fallback (a skeleton trace, the weak group tag, or the untranslated row
 * for the "you are here" marker).
 */
function findRenderedRowByNearestTime(
  sourceItems: readonly TurnItem[],
  sourceRow: number,
  targetItems: readonly TurnItem[]
): number | null {
  const source = findItemByRow(sourceItems, sourceRow);
  const sourceMs = source ? turnItemMs(source) : null;
  if (sourceMs === null) {
    return null;
  }
  let nearestRow: number | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  let nearestIsTie = false;
  for (const item of targetItems) {
    if (!("_row" in item)) {
      continue;
    }
    const ms = turnItemMs(item);
    if (ms === null) {
      continue;
    }
    const distance = Math.abs(ms - sourceMs);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestRow = item._row;
      nearestIsTie = false;
    } else if (distance === nearestDistance) {
      // A second row exactly as close as the current best: the nearest instant is
      // ambiguous. Record the tie; if nothing strictly closer displaces it, we
      // refuse to guess rather than land one turn off.
      nearestIsTie = true;
    }
  }
  if (nearestRow === null || nearestDistance > NEAREST_TIME_MAX_DISTANCE_MS) {
    return null;
  }
  return nearestIsTie ? null : nearestRow;
}
