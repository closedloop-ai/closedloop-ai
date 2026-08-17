/**
 * Response-wide budget enforcement for the historical-parse worker boundary
 * (ISS-5797).
 *
 * Extracted from `historical-parse-worker-protocol.ts` so that module keeps the
 * schema and envelope code and this one owns the single question "does the whole
 * response fit through the boundary, and if not, what is the largest thing that
 * does?". Its counterpart is `historical-parse-worker-bounded-value.ts`, which
 * answers the same question for ONE value.
 *
 * The three strategies below are applied in order of how little they cost the
 * data, and each one only runs when the cheaper ones left the payload over
 * budget:
 *
 *   1. Cap the session COUNT, then trim every detail array to the per-array cap.
 *   2. Clamp payload CONTENT (`clampSessionPayloads`), then halve the per-array
 *      limit until the response-wide item + text budgets fit.
 *   3. Halve the long-text cap and re-shrink every string (`shrinkSessionText`),
 *      down to the identifier-width floor.
 *
 * Anything still over budget after (3) is a response that cannot be represented
 * at all, and the schema rejects it — see the note on {@link
 * clampSessionsForWorkerResponse}.
 */

import type { NormalizedSession } from "../types.js";
import {
  clampSessionPayloads,
  isPlainRecord,
  MIN_RESPONSE_TEXT_CAP,
  shrinkSessionText,
} from "./historical-parse-worker-bounded-value.js";
import { HistoricalParseWorkerLimits } from "./historical-parse-worker-limits.js";

const MAX_WORKER_SESSIONS_PER_SOURCE =
  HistoricalParseWorkerLimits.maxWorkerSessionsPerSource;
const MAX_SESSION_ARRAY_ITEMS =
  HistoricalParseWorkerLimits.maxSessionArrayItems;
const MAX_LONG_TEXT_LENGTH = HistoricalParseWorkerLimits.maxLongTextLength;

/**
 * Reduce a parsed session list to something the response schema accepts.
 *
 * KNOWN RESIDUAL LIMIT: the strategies stop at the identifier-width floor, so a
 * response can still exceed the budget on session COUNT alone. An all-text-empty
 * session costs ~406 bytes in field names, so roughly 19,700 sessions saturate
 * the 8MB text budget while `maxWorkerSessionsPerSource` allows 50,000. Such a
 * source degrades to the pre-existing Failed envelope rather than being silently
 * cut down to a subset of sessions presented as the whole parse — dropping whole
 * sessions is a data-loss decision this boundary is not entitled to make on its
 * own.
 */
export function clampSessionsForWorkerResponse(
  sessions: NormalizedSession[]
): NormalizedSession[] {
  // ISS-5797 (wongk review): trim array LENGTHS to the per-array cap BEFORE the
  // content clamp. `clampSessionPayloads` walks and byte-counts every element it
  // is handed, so clamping first meant a 200k-entry `toolUses` array was fully
  // traversed only for the slice below to discard the tail — a bound whose cost
  // is O(unbounded input) is not much of a bound. Slicing first makes the clamp's
  // work O(maxSessionArrayItems), and the result is identical because both
  // operations are element-wise and order-preserving.
  const limited = sessions
    .slice(0, MAX_WORKER_SESSIONS_PER_SOURCE)
    .map((session) => sliceSessionArrays(session, MAX_SESSION_ARRAY_ITEMS));
  let clamped = limited.map((session) => clampSessionPayloads(session));
  let working = shrinkArraysToBudget(clamped);
  // ISS-5797 (wongk review): the loop above only shrinks ARRAYS. Five sessions
  // each carrying a 2MB `name` still exceed the 8MB aggregate budget once the
  // per-array limit reaches zero, which produced the Failed envelope and retried
  // the source forever. Fixed fields need their own strategy.
  let textCap: number = MAX_LONG_TEXT_LENGTH;
  while (textCap > MIN_RESPONSE_TEXT_CAP && !fitsResponseBudget(working)) {
    textCap = Math.max(MIN_RESPONSE_TEXT_CAP, Math.floor(textCap / 2));
    clamped = limited.map((session) =>
      shrinkSessionText(clampSessionPayloads(session), textCap)
    );
    working = shrinkArraysToBudget(clamped);
  }
  return working;
}

/** True when `sessions` satisfy both response-wide budgets. */
export function fitsResponseBudget(sessions: NormalizedSession[]): boolean {
  const summary = summarizeWorkerResponsePayload(sessions);
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
 */
function shrinkArraysToBudget(
  clamped: NormalizedSession[]
): NormalizedSession[] {
  let limit: number = MAX_SESSION_ARRAY_ITEMS;
  let working = clamped;
  while (limit > 0 && !fitsResponseBudget(working)) {
    limit = limit > 1 ? Math.floor(limit / 2) : 0;
    working = clamped.map((session) => sliceSessionArrays(session, limit));
  }
  return working;
}

function sliceSessionArrays(
  session: NormalizedSession,
  limit: number
): NormalizedSession {
  const sliced: NormalizedSession = {
    ...session,
    teams: session.teams.slice(0, limit),
    messageTimestamps: session.messageTimestamps.slice(0, limit),
    toolUses: session.toolUses.slice(0, limit),
    plans: session.plans?.slice(0, limit),
    compactions: session.compactions.slice(0, limit),
    apiErrors: session.apiErrors.slice(0, limit),
    turnDurations: session.turnDurations.slice(0, limit),
    toolResultErrors: session.toolResultErrors.slice(0, limit),
    usageExtras: {
      ...session.usageExtras,
      service_tiers: session.usageExtras.service_tiers.slice(0, limit),
      speeds: session.usageExtras.speeds.slice(0, limit),
      inference_geos: session.usageExtras.inference_geos.slice(0, limit),
    },
    messages: session.messages.slice(0, limit),
    tokenSeries: session.tokenSeries.slice(0, limit),
    slashCommands: session.slashCommands.slice(0, limit),
    skills: session.skills.slice(0, limit),
    // FEA-4093: clamp hooks with the other detail arrays so an oversized hook
    // list degrades to truncated detail instead of leaving the payload over the
    // item/byte budget and failing the whole source as parser_output_validation.
    hooks: session.hooks.slice(0, limit),
    artifacts: {
      ...session.artifacts,
      prs: session.artifacts.prs.slice(0, limit),
      issues: session.artifacts.issues.slice(0, limit),
    },
    prLinks: session.prLinks.slice(0, limit),
  };
  if (session.subagents) {
    sliced.subagents = session.subagents.slice(0, limit).map((subagent) => ({
      ...subagent,
      toolUses: subagent.toolUses?.slice(0, limit),
      tokenSeries: subagent.tokenSeries?.slice(0, limit),
    }));
  }
  // FEA-3526: clamp the optional Codex snapshot array only when present, so a
  // session that omits it round-trips without an injected `undefined` key
  // (matching the `subagents` idiom above).
  if (session.codexLastTokenUsage) {
    sliced.codexLastTokenUsage = session.codexLastTokenUsage.slice(0, limit);
  }
  return sliced;
}
