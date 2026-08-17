/**
 * @file historical-parse-worker-response-budget.test.ts
 * @description ISS-5797 review regressions for the RESPONSE-WIDE budget
 * strategies in `historical-parse-worker-response-budget.ts`.
 *
 * Every case here is an adversarial payload, not a typical one. A clamp that is
 * only ever exercised with well-formed medium input proves nothing about the
 * bound it claims to enforce, and each of these reproduces a specific defect a
 * reviewer named: a fixed field the array loop could never shrink, a clamp whose
 * cost was O(parsed input) rather than O(cap), and a `z.record` the consumer
 * schema left entirely uncapped.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MIN_RESPONSE_TEXT_CAP,
  shrinkSessionText,
} from "../src/main/collectors/engine/historical-parse-worker-bounded-value.js";
import { HistoricalParseWorkerLimits } from "../src/main/collectors/engine/historical-parse-worker-limits.js";
import {
  createHistoricalParseWorkerParsedResponse,
  HistoricalParseWorkerResponseType,
  historicalParseWorkerResponseSchema,
} from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import {
  clampSessionsForWorkerResponse,
  fitsResponseBudget,
} from "../src/main/collectors/engine/historical-parse-worker-response-budget.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { makeSession } from "./historical-parse-worker-response-support.js";

const MAX_LONG_TEXT_LENGTH = HistoricalParseWorkerLimits.maxLongTextLength;
const MAX_SHORT_TEXT_LENGTH = HistoricalParseWorkerLimits.maxShortTextLength;
const MAX_SESSION_ARRAY_ITEMS =
  HistoricalParseWorkerLimits.maxSessionArrayItems;
const MAX_UNKNOWN_OBJECT_KEYS =
  HistoricalParseWorkerLimits.maxUnknownObjectKeys;

test("a fixed long-text field on several sessions is shrunk to the response budget", () => {
  // The case wongk named: five sessions each carrying a name at exactly the
  // per-field cap sum to 10MB against an 8MB response budget. `sliceSessionArrays`
  // cannot touch a scalar field, so before the fixed-field strategy the halving
  // loop ran to limit 0, still failed the budget, and the whole parse job became
  // a Failed envelope that re-failed the same source on every collector cycle.
  const sessions = [0, 1, 2, 3, 4].map((index) => ({
    ...makeSession(`big-name-${index}`),
    name: "x".repeat(MAX_LONG_TEXT_LENGTH),
  }));

  const clamped = clampSessionsForWorkerResponse(sessions);

  assert.equal(
    fitsResponseBudget(clamped),
    true,
    "the returned sessions must satisfy the response-wide budget"
  );
  assert.equal(
    clamped.length,
    5,
    "no session is dropped to make the payload fit"
  );
  const response = createHistoricalParseWorkerParsedResponse("rq-1", sessions);
  assert.equal(response.type, HistoricalParseWorkerResponseType.Parsed);
});

test("the fixed-field strategy floors at identifier width", () => {
  // The strategy stops at the short-text cap on purpose: shortening `sessionId`
  // or `cwd` would not degrade a payload, it would merge two distinct sessions.
  // Asserted at the floor itself rather than through the pipeline, because a
  // payload large enough to drive the pipeline TO the floor is a 16k-session
  // fixture whose cost buys nothing this does not already pin.
  const session: NormalizedSession = {
    ...makeSession("identity"),
    cwd: `/repo/${"d".repeat(MAX_SHORT_TEXT_LENGTH - 6)}`,
    name: "x".repeat(MAX_LONG_TEXT_LENGTH),
  };

  const shrunk = shrinkSessionText(session, MIN_RESPONSE_TEXT_CAP);

  assert.equal(shrunk.sessionId, "identity");
  assert.equal(
    shrunk.cwd,
    session.cwd,
    "a field at exactly the short-text cap is left whole"
  );
  assert.ok(
    (shrunk.name?.length ?? 0) <= MIN_RESPONSE_TEXT_CAP,
    "a long-text field IS shrunk at the floor"
  );
});

test("an oversized long-text field no longer fails the whole response", () => {
  // Moved out of `historical-parse-worker-protocol.test.ts` (codex review): that
  // suite is in the shrink-only grandfather override, so an ISS-5797 regression
  // belongs in a focused sibling. Its counterpart there — the still-unclamped
  // SHORT-capped field that exercises the offending-field diagnostic — stays.
  const response = createHistoricalParseWorkerParsedResponse("rq-2", [
    {
      ...makeSession("oversized-name"),
      name: "x".repeat(MAX_LONG_TEXT_LENGTH + 1),
    },
  ]);

  assert.equal(response.type, HistoricalParseWorkerResponseType.Parsed);
});

test("session arrays are trimmed to the cap before their content is clamped", () => {
  // The clamp used to walk and byte-count every element of the PARSED array and
  // only then hand it to `sliceSessionArrays`, so a malformed transcript could
  // make the bound's own cost unbounded. Counting element reads is the
  // behavioral assertion — a timing assertion would be flaky and is banned.
  const overCap = MAX_SESSION_ARRAY_ITEMS + 10_000;
  const counter = { reads: 0 };
  const session: NormalizedSession = {
    ...makeSession("wide-arrays"),
    teams: countingArray(overCap, counter, "team"),
  };

  clampSessionsForWorkerResponse([session]);

  assert.ok(
    counter.reads <= MAX_SESSION_ARRAY_ITEMS,
    `expected at most ${MAX_SESSION_ARRAY_ITEMS} element reads, got ${counter.reads}`
  );
});

test("the consumer schema rejects a metadata record over the entry cap", () => {
  // The producer clamps to this cap, but a malformed or version-skewed worker
  // message is exactly the input the producer never touched. `z.record` caps
  // neither key count nor entry count on its own, so hundreds of thousands of
  // small entries passed the boundary untouched (wongk review).
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "rq-3",
    sessions: [makeSessionWithMetadata(MAX_UNKNOWN_OBJECT_KEYS + 1)],
  });

  assert.equal(result.success, false);

  // The cap itself still validates, so this is a bound and not a ban.
  assert.equal(
    historicalParseWorkerResponseSchema.safeParse({
      type: HistoricalParseWorkerResponseType.Parsed,
      requestId: "rq-3",
      sessions: [makeSessionWithMetadata(MAX_UNKNOWN_OBJECT_KEYS)],
    }).success,
    true
  );
});

/** A session whose one subagent carries `entryCount` metadata entries. */
function makeSessionWithMetadata(entryCount: number): NormalizedSession {
  const metadata: Record<string, unknown> = {};
  for (let index = 0; index < entryCount; index++) {
    metadata[`k${index}`] = index;
  }
  const session = makeSession("metadata-heavy");
  session.subagents = [
    {
      id: "agent-1",
      name: "Researcher",
      metadata,
    },
  ];
  return session;
}

/**
 * An array whose elements are read through counting getters, so a test can
 * assert HOW MANY elements a bound actually touched. `slice` reads only the
 * indices it keeps, so the counter separates "sliced then clamped" from
 * "clamped then sliced" without measuring wall-clock time.
 */
function countingArray(
  length: number,
  counter: { reads: number },
  value: unknown
): unknown[] {
  const array = new Array<unknown>(length);
  for (let index = 0; index < length; index++) {
    Object.defineProperty(array, index, {
      enumerable: true,
      configurable: true,
      get() {
        counter.reads++;
        return value;
      },
    });
  }
  return array;
}
