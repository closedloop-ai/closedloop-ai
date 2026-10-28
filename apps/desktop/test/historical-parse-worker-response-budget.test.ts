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
import { test } from "vitest";
import {
  HistoricalParseWorkerLimits,
  MIN_RESPONSE_TEXT_CAP,
  shrinkSessionText,
} from "../src/main/collectors/engine/historical-parse-worker-limits-and-clamping.js";
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
import {
  makeSession,
  parsedSessions,
} from "./historical-parse-worker-response-support.js";

const MAX_LONG_TEXT_LENGTH = HistoricalParseWorkerLimits.maxLongTextLength;
const MAX_SHORT_TEXT_LENGTH = HistoricalParseWorkerLimits.maxShortTextLength;
const MAX_SESSION_ARRAY_ITEMS =
  HistoricalParseWorkerLimits.maxSessionArrayItems;
const MAX_UNKNOWN_OBJECT_KEYS =
  HistoricalParseWorkerLimits.maxUnknownObjectKeys;

/**
 * ISS-5854: enough sessions to saturate the 8MB budget on COUNT alone, where
 * "alone" means no value-level strategy can reclaim a single byte.
 *
 * Each carries a `name` of {@link COUNT_BOUND_NAME_LENGTH}, which is BELOW
 * `MIN_RESPONSE_TEXT_CAP` (8192) — the floor the text strategy stops at — so
 * `shrinkSessionText` provably never shortens it, and the arrays are empty so
 * the array strategy has nothing to slice. That is the same defeat as the
 * ticket's all-text-empty corpus, reached with ~1,100 sessions instead of
 * ~17,000: the clamp rebuilds every session ~128 times across its halving
 * loops, so the session count IS this suite's runtime, and the 17,000-session
 * version took 126s under parallel CI load and breached the per-test timeout.
 *
 * Both numbers are asserted, never trusted: the test checks the fixture starts
 * over budget AND that the name survives the clamp unshortened.
 */
const COUNT_BOUND_SESSIONS = 1100;
const COUNT_BOUND_NAME_LENGTH = 8000;

test("a fixed long-text field on several sessions is shrunk to the response budget", () => {
  // The case whitlockk named: five sessions each carrying a name at exactly the
  // per-field cap sum to 10MB against an 8MB response budget. `sliceSessionArrays`
  // cannot touch a scalar field, so before the fixed-field strategy the halving
  // loop ran to limit 0, still failed the budget, and the whole parse job became
  // a Failed envelope that re-failed the same source on every collector cycle.
  const sessions = [0, 1, 2, 3, 4].map((index) => ({
    ...makeSession(`big-name-${index}`),
    name: "x".repeat(MAX_LONG_TEXT_LENGTH),
  }));

  const clamped = clampSessionsForWorkerResponse(sessions).sessions;

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
  // This is a response-budget invariant, not an envelope-schema invariant:
  // long-text payload fields must shrink into a parsed response instead of
  // turning the whole source into a nonfatal failed envelope.
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

test("a source over budget on session COUNT alone delivers its prefix instead of failing whole", () => {
  // ISS-5854. No value-level strategy can reach this — the arrays are empty and
  // the name sits below the text floor — so it is the session COUNT that
  // saturates the 8MB budget. Before
  // the drop, the response degraded to a Failed envelope and the source
  // imported NOTHING, on every collector cycle, forever.
  const sessions = Array.from({ length: COUNT_BOUND_SESSIONS }, (_, index) => ({
    ...makeSession(`count-bound-${index}`),
    name: "n".repeat(COUNT_BOUND_NAME_LENGTH),
  }));
  assert.equal(
    fitsResponseBudget(sessions),
    false,
    "the fixture must be over budget on count alone, or it proves nothing"
  );
  assert.ok(
    COUNT_BOUND_NAME_LENGTH < MIN_RESPONSE_TEXT_CAP,
    "the name must sit below the text floor, or the text strategy could reclaim bytes and this would not be a COUNT-bound payload"
  );

  // ISS-5822: the one reduction `payloadClamped` deliberately does not cover.
  // A dropped session cannot carry a flag, and flagging the SURVIVORS instead
  // would be a lie — their own payloads are intact, and the loss gets its own
  // report (`droppedSessions`, below). Asserted from the clamp directly and
  // BEFORE the envelope assertions: a false flag also inflates the payload, so
  // checked later it would be masked by a budget failure rather than named.
  // Folded into this test because building a COUNT-bound payload is its cost.
  for (const survivor of clampSessionsForWorkerResponse(sessions).sessions) {
    assert.equal(
      Object.hasOwn(survivor, "payloadClamped"),
      false,
      "a session that survived intact must not be flagged for its neighbour's loss"
    );
  }

  const response = createHistoricalParseWorkerParsedResponse(
    "rq-5854",
    sessions
  );

  assert.equal(
    response.type,
    HistoricalParseWorkerResponseType.Parsed,
    "the source must import its prefix rather than degrade to a Failed envelope"
  );
  const delivered = parsedSessions(
    historicalParseWorkerResponseSchema.safeParse(response)
  );
  assert.ok(
    delivered.length > 0 && delivered.length < COUNT_BOUND_SESSIONS,
    `expected a partial prefix, got ${delivered.length} of ${COUNT_BOUND_SESSIONS}`
  );
  // The drop is STATED, not inferred. A subset arriving with no count is the
  // silent data loss this ticket exists to stop.
  assert.equal(
    response.type === HistoricalParseWorkerResponseType.Parsed
      ? response.droppedSessions
      : undefined,
    COUNT_BOUND_SESSIONS - delivered.length,
    "the response must say exactly how many sessions it dropped"
  );
  assert.equal(fitsResponseBudget(delivered), true);
  assert.equal(
    delivered[0]?.name.length,
    COUNT_BOUND_NAME_LENGTH,
    "the text strategy must have reclaimed nothing — otherwise this payload was not COUNT-bound"
  );

  // The equality above is algebraically guaranteed by the production formula
  // (`input.length - output.length`), so on its own it cannot tell a TIGHT drop
  // from an over-eager one — halving, or dropping in fixed chunks, would satisfy
  // it too. Minimality is therefore checked independently, against the budget
  // predicate and the clamp's OWN input.
  //
  // Deliberately measured through `clampSessionsForWorkerResponse` rather than
  // through the response: the response path stamps `endedOnUnrecoveredError` on
  // every session before clamping, so `delivered` and `sessions` are two
  // different byte bases and a prefix of one says nothing about the other.
  const clamped = clampSessionsForWorkerResponse(sessions).sessions;
  assert.ok(clamped.length > 0 && clamped.length < COUNT_BOUND_SESSIONS);
  assert.equal(
    fitsResponseBudget(sessions.slice(0, clamped.length + 1)),
    false,
    "the retained prefix must be MAXIMAL — one more session must not have fit"
  );
});

test("a response that fits carries no dropped-session count at all", () => {
  // The positive sibling. Omission is the contract: a healthy parse must not
  // ship a `droppedSessions: 0`, or the monitored path fires on every source.
  const response = createHistoricalParseWorkerParsedResponse("rq-5854-fits", [
    makeSession("fits-a"),
    makeSession("fits-b"),
  ]);

  assert.equal(response.type, HistoricalParseWorkerResponseType.Parsed);
  assert.equal(
    Object.hasOwn(response, "droppedSessions"),
    false,
    "the key must be ABSENT, not present-and-zero"
  );
  // ...and a wire-level zero is rejected rather than accepted as a false clean.
  assert.equal(
    historicalParseWorkerResponseSchema.safeParse({
      type: HistoricalParseWorkerResponseType.Parsed,
      requestId: "rq-5854-zero",
      sessions: [makeSession("zero-drop")],
      droppedSessions: 0,
    }).success,
    false
  );
});

test("the clamp's output satisfies the response budget for every defeat it can fix", () => {
  // The assertion a reviewer asked for on #4734 and the lane correctly declined
  // to add, because session count alone could defeat every strategy. It holds
  // now for each defeat the clamp CAN fix. It is deliberately not called
  // "unconditional": one documented residual survives, and claiming otherwise in
  // a test name would be the same false-completeness this ticket is about — the
  // residual gets its own case below, and the session-count case gets the
  // dedicated test above rather than a second 21,000-session build here.
  const adversarial: Record<string, NormalizedSession[]> = {
    "oversized long text": [0, 1, 2, 3, 4].map((index) => ({
      ...makeSession(`big-name-${index}`),
      name: "x".repeat(MAX_LONG_TEXT_LENGTH),
    })),
    "wide detail arrays": [
      {
        ...makeSession("wide"),
        messageTimestamps: Array.from(
          { length: MAX_SESSION_ARRAY_ITEMS + 5000 },
          () => "2026-08-21T12:00:00.000Z"
        ),
      },
    ],
  };

  for (const [label, sessions] of Object.entries(adversarial)) {
    assert.equal(
      fitsResponseBudget(sessions),
      false,
      `${label}: fixture must start over budget`
    );
    assert.equal(
      fitsResponseBudget(clampSessionsForWorkerResponse(sessions).sessions),
      true,
      `${label}: the clamp must return a payload the response schema accepts`
    );
  }
});

test("the one defeat the clamp cannot fix degrades to a Failed envelope, not a corrupt Parsed one", () => {
  // The documented residual: `dropSessionsToBudget` returns its input unchanged
  // when not even the FIRST session fits, because an empty list would read as
  // "this source has no sessions". `tokensByModel` is a `z.record` with no
  // entry-count cap and NO clamp touches it — not `clampSessionPayloads`, not
  // `sliceSessionArrays` — so one session can carry a map big enough to blow the
  // response budget on its own. That makes the residual reachable rather than
  // theoretical, and the contract is that it fails honestly.
  // Few entries with LONG keys, not many short ones: the summarizer counts key
  // bytes, and each key stays under the short-text cap so the schema's per-key
  // limit is not what rejects this. Measured at 8,838,971 bytes against the 8MB
  // budget — over by a real margin, and ~100x cheaper to build and walk than the
  // equivalent made of many short keys.
  const tokensByModel: NormalizedSession["tokensByModel"] = {};
  for (let index = 0; index < 1100; index++) {
    tokensByModel[`m${index}-${"k".repeat(8000)}`] = {
      input: 1,
      output: 1,
      cacheRead: 1,
      cacheWrite: 1,
    };
  }
  const session: NormalizedSession = {
    ...makeSession("single-session-too-big"),
    tokensByModel,
  };
  assert.equal(
    fitsResponseBudget([session]),
    false,
    "one session must be over budget on its own, or this proves nothing"
  );

  const clamped = clampSessionsForWorkerResponse([session]).sessions;

  assert.equal(
    clamped.length,
    1,
    "the input is returned unchanged — an empty list would claim the source is empty"
  );
  assert.equal(
    createHistoricalParseWorkerParsedResponse("rq-residual", [session]).type,
    HistoricalParseWorkerResponseType.Failed,
    "an unrepresentable response must fail honestly rather than ship over budget"
  );
});

test("the consumer schema rejects a metadata record over the entry cap", () => {
  // The producer clamps to this cap, but a malformed or version-skewed worker
  // message is exactly the input the producer never touched. `z.record` caps
  // neither key count nor entry count on its own, so hundreds of thousands of
  // small entries passed the boundary untouched (whitlockk review).
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

test("ISS-7258 detail arrays degrade instead of failing the whole source", () => {
  // cr-57285. `worktreeEntries` and `usageExtras.efforts` were counted by
  // `summarizeWorkerResponsePayload` but reachable by no cut in
  // `sliceSessionArrays`, so an oversized list left the payload over budget with
  // nothing able to shrink it and the ENTIRE source failed as
  // parser_output_validation. Revert either cut and this returns a Failed
  // envelope, which is the mutation the case exists to kill.
  const overCap = MAX_SESSION_ARRAY_ITEMS + 10_000;
  const base = makeSession("iss-7258-detail-arrays");
  const session: NormalizedSession = {
    ...base,
    worktreeEntries: Array.from({ length: overCap }, (_, index) => ({
      worktreePath: `/workspace/worktrees/wt-${index}`,
      worktreeName: `wt-${index}`,
      worktreeBranch: `feat/branch-${index}`,
      originalCwd: "/workspace/project",
      preEnterOriginalCwd: "/workspace/project",
      enteredExisting: true as const,
    })),
    usageExtras: {
      ...base.usageExtras,
      efforts: Array.from({ length: overCap }, (_, index) => `tier-${index}`),
    },
  };

  const response = createHistoricalParseWorkerParsedResponse("rq-7258-arrays", [
    session,
  ]);

  assert.equal(
    response.type,
    HistoricalParseWorkerResponseType.Parsed,
    "an oversized ISS-7258 detail array must truncate, not fail the whole source"
  );
  const [delivered] = parsedSessions(
    historicalParseWorkerResponseSchema.safeParse(response)
  );
  assert.ok(
    (delivered?.worktreeEntries?.length ?? 0) < overCap,
    "worktreeEntries must have been cut"
  );
  assert.ok(
    (delivered?.usageExtras.efforts?.length ?? 0) < overCap,
    "usageExtras.efforts must have been cut"
  );
});

test("the ISS-7258 cuts do not add their keys to a session that omits them", () => {
  // The omission half, and the reason neither cut uses `cutOptional`:
  // `summarizeWorkerResponsePayload` charges `Buffer.byteLength(key)` for a key
  // whose value is `undefined` exactly as for a real one, so writing these two
  // unconditionally taxes EVERY session 22 bytes and shrinks the maximal prefix
  // the count-bound clamp can retain. Asserting `in` rather than a value,
  // because `undefined` and absent read identically through a value check.
  const base = makeSession("iss-7258-omitted");
  assert.equal("worktreeEntries" in base, false, "fixture must omit it");

  const [clamped] = clampSessionsForWorkerResponse([base]).sessions;

  assert.equal(
    "worktreeEntries" in (clamped ?? {}),
    false,
    "the clamp must not mint a worktreeEntries key on a session without one"
  );
  assert.equal(
    "efforts" in (clamped?.usageExtras ?? {}),
    false,
    "the clamp must not mint an efforts key on a session without one"
  );
});
