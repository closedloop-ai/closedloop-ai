/**
 * Response-wide budget enforcement for the historical-parse worker boundary
 * (ISS-5797).
 *
 * Extracted from `historical-parse-worker-protocol.ts` so that module keeps the
 * schema and envelope code and this one owns the single question "does the whole
 * response fit through the boundary, and if not, what is the largest thing that
 * does?". Its counterpart is `historical-parse-worker-limits-and-clamping.ts`, which
 * answers the same question for ONE value.
 *
 * The four strategies below are applied in order of how little they cost the
 * data, and each one only runs when the cheaper ones left the payload over
 * budget:
 *
 *   1. Cap the session COUNT, then trim every detail array to the per-array cap.
 *   2. Clamp payload CONTENT (`clampSessionPayloads`), then halve the per-array
 *      limit until the response-wide item + text budgets fit.
 *   3. Halve the long-text cap and re-shrink every string (`shrinkSessionText`),
 *      down to the identifier-width floor.
 *   4. ISS-5854: drop whole SESSIONS from the tail until the response fits.
 *      Last because it is the only strategy that defers a record rather than
 *      degrading one, and it runs only where (1)-(3) cannot help at all —
 *      a payload over budget on session count with every value already at its
 *      floor. ISS-7696: what it removes is reported as a RESUME POINT, not only
 *      as a count, so a later pass can ask for the suffix; see
 *      {@link dropSessionsToBudget}.
 *
 * After (4) the only payload still over budget is one whose FIRST session alone
 * cannot be represented, which the schema rejects as before.
 *
 * ISS-5822: (1)-(3) DEGRADE a session that still ships, so each stamps
 * {@link NormalizedSession.payloadClamped} on the sessions it actually reduced.
 * (4) removes sessions whole and is reported by `droppedSessions`/`resumeAfter`
 * instead — a survivor's payload is intact and must not be flagged for a
 * neighbour's loss.
 */

import { isDeepStrictEqual } from "node:util";
import { isPlainRecord } from "@repo/lib/security/plain-record";
import type {
  NormalizedSession,
  NormalizedTokenRecord,
  NormalizedTokenSeriesTruncation,
} from "../types.js";
import {
  clampSessionPayloads,
  HistoricalParseWorkerLimits,
  MIN_RESPONSE_TEXT_CAP,
  shrinkSessionText,
} from "./historical-parse-worker-limits-and-clamping.js";

const MAX_WORKER_SESSIONS_PER_SOURCE =
  HistoricalParseWorkerLimits.maxWorkerSessionsPerSource;
const MAX_SESSION_ARRAY_ITEMS =
  HistoricalParseWorkerLimits.maxSessionArrayItems;
const MAX_LONG_TEXT_LENGTH = HistoricalParseWorkerLimits.maxLongTextLength;

/**
 * Reduce a parsed session list to something the response schema accepts.
 *
 * ISS-5854 closed the last gap: the value-level strategies stop at the
 * identifier-width floor, so a response could still exceed the budget on session
 * COUNT alone and the whole source degraded to a Failed envelope that re-failed
 * every collector cycle — the source never imported at all. Measured on the
 * production path (which stamps `endedOnUnrecoveredError` on every session
 * first), an all-text-empty session costs 432 bytes and saturates the 8MB budget
 * at ~18,500, and a merely REALISTIC session — a name, a cwd, a model, a branch,
 * two timestamps, nothing oversized — costs 647 and saturates at ~12,300, while
 * `maxWorkerSessionsPerSource` allows 50,000.
 *
 * That measurement is why the cap is not simply lowered to a "safe" number:
 * there is no constant that works, because the saturation point is a function of
 * session CONTENT. Only dropping to the actual budget makes the limit honest, so
 * {@link dropSessionsToBudget} keeps the largest prefix that fits.
 *
 * The original objection to dropping — that it presents a subset as if it were
 * the whole parse — is answered by the count reaching the response and the
 * monitored path rather than by declining to drop; see
 * `createHistoricalParseWorkerParsedResponse`.
 */
export function clampSessionsForWorkerResponse(
  sessions: NormalizedSession[]
): ClampedWorkerSessions {
  // ISS-5797 (whitlockk review): trim array LENGTHS to the per-array cap BEFORE the
  // content clamp. `clampSessionPayloads` walks and byte-counts every element it
  // is handed, so clamping first meant a 200k-entry `toolUses` array was fully
  // traversed only for the slice below to discard the tail — a bound whose cost
  // is O(unbounded input) is not much of a bound. Slicing first makes the clamp's
  // work O(maxSessionArrayItems), and the result is identical because both
  // operations are element-wise and order-preserving.
  const limited = sessions
    .slice(0, MAX_WORKER_SESSIONS_PER_SOURCE)
    .map((session) => sliceSessionArrays(session, MAX_SESSION_ARRAY_ITEMS));
  let clamped = limited.map((session) =>
    markPayloadClamped(session, clampSessionPayloads(session))
  );
  let working = shrinkArraysToBudget(clamped, sessions);
  // ISS-5797 (whitlockk review): the loop above only shrinks ARRAYS. Five sessions
  // each carrying a 2MB `name` still exceed the 8MB aggregate budget once the
  // per-array limit reaches zero, which produced the Failed envelope and retried
  // the source forever. Fixed fields need their own strategy.
  let textCap: number = MAX_LONG_TEXT_LENGTH;
  while (textCap > MIN_RESPONSE_TEXT_CAP && !fitsResponseBudget(working)) {
    textCap = Math.max(MIN_RESPONSE_TEXT_CAP, Math.floor(textCap / 2));
    clamped = limited.map((session) =>
      markPayloadClamped(
        session,
        shrinkSessionText(clampSessionPayloads(session), textCap)
      )
    );
    working = shrinkArraysToBudget(clamped, sessions);
  }
  // ISS-7696: the ORIGINAL length, not `working`'s. The session-COUNT cap above
  // has already removed a suffix that `dropSessionsToBudget` will never see, and
  // one resume point has to cover both removals or a source past
  // `maxWorkerSessionsPerSource` resumes at the wrong place.
  return dropSessionsToBudget(working, sessions.length);
}

/** True when `sessions` satisfy both response-wide budgets. */
export function fitsResponseBudget(sessions: NormalizedSession[]): boolean {
  return fitsResponseSummary(summarizeWorkerResponsePayload(sessions));
}

/**
 * The budget predicate itself, over an already-computed summary.
 *
 * Extracted so {@link dropSessionsToBudget} can accumulate per session without
 * restating the thresholds. Two copies of "what fits" could drift apart, and the
 * direction that would hurt is OVER-dropping: a stale copy here would discard
 * user sessions the schema would have accepted, and report them as a real loss
 * on the monitored event.
 */
function fitsResponseSummary(summary: {
  arrayItems: number;
  textBytes: number;
}): boolean {
  return (
    summary.arrayItems <=
      HistoricalParseWorkerLimits.maxWorkerResponseArrayItems &&
    summary.textBytes <= HistoricalParseWorkerLimits.maxWorkerResponseTextBytes
  );
}

export function summarizeWorkerResponsePayload(value: unknown): {
  arrayItems: number;
  textBytes: number;
} {
  if (typeof value === "string") {
    return { arrayItems: 0, textBytes: Buffer.byteLength(value) };
  }
  if (Array.isArray(value)) {
    return value.reduce(
      (summary, item) => {
        const child = summarizeWorkerResponsePayload(item);
        return {
          arrayItems: summary.arrayItems + 1 + child.arrayItems,
          textBytes: summary.textBytes + child.textBytes,
        };
      },
      { arrayItems: 0, textBytes: 0 }
    );
  }
  if (isPlainRecord(value)) {
    return Object.entries(value).reduce(
      (summary, [key, item]) => {
        const child = summarizeWorkerResponsePayload(item);
        return {
          arrayItems: summary.arrayItems + child.arrayItems,
          textBytes:
            summary.textBytes + Buffer.byteLength(key) + child.textBytes,
        };
      },
      { arrayItems: 0, textBytes: 0 }
    );
  }
  return { arrayItems: 0, textBytes: 0 };
}

/**
 * Halve the per-array limit until the response-wide item + text budgets fit.
 * Bounded by log2(maxSessionArrayItems); limit 0 empties every detail array,
 * so this terminates whether or not the budgets are reachable.
 *
 * ISS-7534: every candidate is STAMPED before it is measured. The truncation
 * report is itself ~79 bytes of object keys per truncated session, and
 * `summarizeWorkerResponsePayload` counts key bytes — so stamping after the
 * loop exited would leave the clamp certifying a payload smaller than the one
 * it returns, and the response schema re-runs the same measurement. That gap
 * turns a degraded-but-delivered parse into a Failed envelope for the whole
 * source, which is the opposite of what this file exists to prevent. Measuring
 * the stamped candidate keeps `fitsResponseBudget` honest about what ships.
 */
function shrinkArraysToBudget(
  clamped: NormalizedSession[],
  originals: NormalizedSession[]
): NormalizedSession[] {
  let limit: number = MAX_SESSION_ARRAY_ITEMS;
  let working = stampTokenSeriesTruncations(clamped, originals);
  while (limit > 0 && !fitsResponseBudget(working)) {
    limit = limit > 1 ? Math.floor(limit / 2) : 0;
    working = stampTokenSeriesTruncations(
      clamped.map((session) => sliceSessionArrays(session, limit)),
      originals
    );
  }
  return working;
}

/**
 * ISS-5854: keep the largest PREFIX of `sessions` that satisfies both
 * response-wide budgets, once every value-level strategy has already run.
 *
 * Prefix order, not a new ranking. `slice(0, maxWorkerSessionsPerSource)` above
 * already drops the tail when a source exceeds the session cap, so this reuses
 * the rule the boundary has always applied instead of inventing a "least
 * valuable session" judgement no one specified.
 *
 * Costs are accumulated per session rather than re-measuring the whole list per
 * candidate, which keeps this O(sessions) — a bound whose own cost is
 * O(n^2) over a 50,000-session source is not much of a bound (the ISS-5797
 * lesson, applied to the strategy that closes ISS-5797's residual). Each
 * session is measured by wrapping it in a one-element array and asking
 * {@link summarizeWorkerResponsePayload}, whose per-element accounting then
 * composes by addition — so the array-slot rule is stated once, where it is
 * owned, rather than re-derived here where it could drift.
 *
 * Returns the input UNCHANGED when not even the first session fits alone: there
 * is then nothing honest to send, and the pre-existing Failed envelope is the
 * right outcome rather than an empty list that would read as "this source has no
 * sessions".
 *
 * ISS-7696: what is left out is reported as a RESUME POINT rather than only as a
 * count. A count says a suffix was lost; an index says where to ask for it, and
 * the caller no longer has to re-derive that index from a "the clamp only ever
 * removes from the tail" assumption stated in prose here and applied over there.
 * `parsedLength` is the length BEFORE the session-count cap in
 * {@link clampSessionsForWorkerResponse}, so one index covers both removals.
 */
function dropSessionsToBudget(
  sessions: NormalizedSession[],
  parsedLength: number
): ClampedWorkerSessions {
  if (fitsResponseBudget(sessions)) {
    return withResumePoint(sessions, parsedLength);
  }
  const running = { arrayItems: 0, textBytes: 0 };
  for (const [index, session] of sessions.entries()) {
    const cost = summarizeWorkerResponsePayload([session]);
    running.arrayItems += cost.arrayItems;
    running.textBytes += cost.textBytes;
    if (!fitsResponseSummary(running)) {
      return withResumePoint(
        index === 0 ? sessions : sessions.slice(0, index),
        parsedLength
      );
    }
  }
  return withResumePoint(sessions, parsedLength);
}

/**
 * ISS-7696: pair a carried list with the index of the first session it leaves
 * out, or with nothing when it leaves none out.
 *
 * Every strategy in this module is an order-preserving PREFIX operation, so the
 * number of sessions carried IS the index of the first one that is not — which
 * is why one number can stand for both "how many arrived" and "where to resume".
 */
function withResumePoint(
  carried: NormalizedSession[],
  parsedLength: number
): ClampedWorkerSessions {
  return carried.length < parsedLength
    ? { sessions: carried, resumeFromIndex: carried.length }
    : { sessions: carried };
}

/**
 * ISS-7534: record on each candidate what the budget cut off its `tokenSeries`.
 *
 * Measured against the ORIGINAL input rather than any intermediate, so the
 * session-count clamp and both array strategies are all accounted for.
 * `originals` is only ever prefix-sliced, so index i of a candidate list is
 * index i of the input.
 */
function stampTokenSeriesTruncations(
  candidates: NormalizedSession[],
  originals: NormalizedSession[]
): NormalizedSession[] {
  return candidates.map((session, index) =>
    withTokenSeriesTruncation(session, originals[index]?.tokenSeries)
  );
}

function sliceSessionArrays(
  session: NormalizedSession,
  limit: number
): NormalizedSession {
  // ISS-5822: every truncation this function performs is a payload reduction the
  // consumer has to be told about. Routing all of them through `cut` derives the
  // detection from the SAME list that does the slicing — a second
  // hand-maintained list of "arrays that can truncate" would drift the day a new
  // detail array is added here.
  let truncated = false;
  const cut = <Item>(items: Item[]): Item[] => {
    if (items.length > limit) {
      truncated = true;
    }
    return items.slice(0, limit);
  };
  const cutOptional = <Item>(items: Item[] | undefined): Item[] | undefined =>
    items === undefined ? undefined : cut(items);
  const sliced: NormalizedSession = {
    ...session,
    teams: cut(session.teams),
    messageTimestamps: cut(session.messageTimestamps),
    toolUses: cut(session.toolUses),
    ...(session.mcpCallEvidence === undefined
      ? {}
      : { mcpCallEvidence: cut(session.mcpCallEvidence) }),
    plans: cutOptional(session.plans),
    compactions: cut(session.compactions),
    apiErrors: cut(session.apiErrors),
    turnDurations: cut(session.turnDurations),
    toolResultErrors: cut(session.toolResultErrors),
    // ISS-7258 (cr-57285): both of the fields below are detail arrays that
    // `summarizeWorkerResponsePayload` counts generically, so omitting them from
    // `cut` is exactly the drift the comment above predicts — the budget counts
    // them, nothing can shrink them, and an over-budget response fails the whole
    // source as parser_output_validation instead of truncating a detail list.
    // Same reason FEA-4093 brought `hooks` into this list.
    // Spread-when-present, NOT `cutOptional`: `summarizeWorkerResponsePayload`
    // charges `Buffer.byteLength(key)` for every key a record carries, counting
    // one whose value is `undefined` exactly like a real one. Writing these two
    // keys unconditionally therefore adds 22 bytes to EVERY session and shrinks
    // the maximal prefix the count-bound clamp can retain — which
    // `historical-parse-worker-response-budget.test.ts` catches as a
    // no-longer-maximal retained prefix.
    ...(session.worktreeEntries === undefined
      ? {}
      : { worktreeEntries: cut(session.worktreeEntries) }),
    usageExtras: {
      ...session.usageExtras,
      service_tiers: cut(session.usageExtras.service_tiers),
      speeds: cut(session.usageExtras.speeds),
      inference_geos: cut(session.usageExtras.inference_geos),
      ...(session.usageExtras.efforts === undefined
        ? {}
        : { efforts: cut(session.usageExtras.efforts) }),
    },
    messages: cut(session.messages),
    tokenSeries: cut(session.tokenSeries),
    slashCommands: cut(session.slashCommands),
    skills: cut(session.skills),
    // FEA-4093: clamp hooks with the other detail arrays so an oversized hook
    // list degrades to truncated detail instead of leaving the payload over the
    // item/byte budget and failing the whole source as parser_output_validation.
    hooks: cut(session.hooks),
    artifacts: {
      ...session.artifacts,
      prs: cut(session.artifacts.prs),
      issues: cut(session.artifacts.issues),
    },
    prLinks: cut(session.prLinks),
  };
  if (session.subagents) {
    // ISS-5822: both arrays are spread CONDITIONALLY, for the same reason
    // `clampSubagentPayloads` spreads `task` that way — `toolUses: undefined`
    // written onto a subagent that has no `toolUses` is an own key the input did
    // not have, and `markPayloadClamped` reads a shape difference as a
    // reduction. It also stops an absent optional going over the wire as an
    // injected `undefined` key, which the repo's omit-don't-null rule wants
    // anyway.
    sliced.subagents = cut(session.subagents).map((subagent) => ({
      ...subagent,
      ...(subagent.toolUses === undefined
        ? {}
        : { toolUses: cut(subagent.toolUses) }),
      ...(subagent.tokenSeries === undefined
        ? {}
        : { tokenSeries: cut(subagent.tokenSeries) }),
    }));
  }
  // FEA-3526: clamp the optional Codex snapshot array only when present, so a
  // session that omits it round-trips without an injected `undefined` key
  // (matching the `subagents` idiom above).
  if (session.codexLastTokenUsage) {
    sliced.codexLastTokenUsage = cut(session.codexLastTokenUsage);
  }
  if (truncated) {
    sliced.payloadClamped = true;
  }
  return sliced;
}

/**
 * ISS-5822: stamp {@link NormalizedSession.payloadClamped} when the CONTENT
 * strategies (`clampSessionPayloads` / `shrinkSessionText`) actually reduced
 * `before` into `after`.
 *
 * Exact comparison rather than a size heuristic on purpose. Byte or item COUNTS
 * are not a sound clamp detector: `truncateMarkedCodeUnits` keeps its marker
 * inside the cap, so a marginal truncation can leave the UTF-8 byte total
 * unchanged while genuinely dropping content, and a size-delta test would score
 * that as "not clamped". `isDeepStrictEqual` short-circuits on reference
 * equality at every level and the clamp helpers pass unchanged leaves through by
 * reference, so the common untouched-session path stays cheap. Both operands are
 * already array-capped by {@link sliceSessionArrays}, so this never walks the
 * unbounded parser output the ISS-5797 review moved the slice ahead of.
 *
 * Array truncation is stamped by {@link sliceSessionArrays} itself, which knows
 * it for free from the lengths it already compares. The flag is monotonic —
 * every later step preserves it through its `...session` spread — so an
 * already-flagged session skips the comparison entirely.
 *
 * INVARIANT THIS DEPENDS ON: the clamp helpers must preserve an optional field's
 * KEY PRESENCE, not merely its value. `isDeepStrictEqual` counts an own key
 * valued `undefined` as a difference from an absent key, so a helper that writes
 * `field: clamp(input.field)` unconditionally reports a reduction that never
 * happened — which is how `clampSubagentPayloads` made every Claude session with
 * a sidecar subagent flag itself. `an untouched session round-trips key-for-key`
 * in `historical-parse-worker-payload-clamped-signal.test.ts` is what holds the
 * line for every optional field at once; keep it green rather than adding a
 * per-field case here.
 */
function markPayloadClamped(
  before: NormalizedSession,
  after: NormalizedSession
): NormalizedSession {
  if (after.payloadClamped === true) {
    return after;
  }
  if (isDeepStrictEqual(before, after)) {
    return after;
  }
  return { ...after, payloadClamped: true };
}

/**
 * ISS-7534: stamp `tokenSeriesTruncation` when the budget cut the series short.
 *
 * The key is OMITTED — never written as a zeroed object — when the series
 * survived whole, so an untruncated session serializes exactly as it did before
 * this ticket and no existing metadata blob or golden snapshot moves.
 */
function withTokenSeriesTruncation(
  session: NormalizedSession,
  originalSeries: readonly NormalizedTokenRecord[] | undefined
): NormalizedSession {
  const droppedRecords = Math.max(
    0,
    (originalSeries?.length ?? 0) - session.tokenSeries.length
  );
  if (!(originalSeries && droppedRecords > 0)) {
    return session;
  }
  // Every strategy that touches `tokenSeries` is a PREFIX slice and nothing
  // else rewrites it (`tokenSeries` is `UnknownPayloadCoverage.None`, so the
  // content clamp and the text shrink both pass it through), which is what
  // makes the removed tail exactly this suffix rather than an estimate.
  return {
    ...session,
    tokenSeriesTruncation: {
      droppedRecords,
      droppedTokens: sumTokenRecords(
        originalSeries.slice(session.tokenSeries.length)
      ),
    },
  };
}

/**
 * ISS-7696: what the response budget can carry, and where the rest begins.
 *
 * `resumeFromIndex` is an index INTO THE LIST THE CLAMP WAS HANDED, not into the
 * whole source — a resumed pass hands the clamp a window, and the caller that
 * knows the window's offset re-bases it. It is ABSENT, never zero, when every
 * session fits: a resume point of "0" would describe a source that has not
 * started, and callers key their continuation on the field's presence.
 */
export type ClampedWorkerSessions = {
  sessions: NormalizedSession[];
  resumeFromIndex?: number;
};

/** The four canonical counters carried by `records`. */
function sumTokenRecords(
  records: readonly NormalizedTokenRecord[]
): NormalizedTokenSeriesTruncation["droppedTokens"] {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const record of records) {
    total.input += record.input;
    total.output += record.output;
    total.cacheRead += record.cacheRead;
    total.cacheWrite += record.cacheWrite;
  }
  return total;
}
