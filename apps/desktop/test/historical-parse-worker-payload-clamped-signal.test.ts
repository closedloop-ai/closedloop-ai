/**
 * @file historical-parse-worker-payload-clamped-signal.test.ts
 * @description ISS-5822 regressions for the response-budget clamp SIGNAL
 * (`NormalizedSession.payloadClamped`).
 *
 * ISS-5797 made an oversized payload degrade instead of failing the whole parse
 * job. It did so silently: a consumer could not tell a complete parse from a
 * clamped one. ISS-7534 closed one slice of that (a truncated `tokenSeries`
 * reports its dropped tail) and ISS-5854/ISS-7696 closed another (a DROPPED
 * session is counted and given a resume point). This flag covers what neither
 * does: every other array truncation, the oversized-payload content clamp, and
 * the long-text shrink.
 *
 * Every assertion here is written against the failure mode it has to catch:
 *
 * - Presence is asserted with `Object.hasOwn`, never `=== undefined`. An absent
 *   key and a key the `.strict()` boundary DROPPED both read as `undefined`, so
 *   a value assertion cannot tell "this parse was complete" from "the signal
 *   itself was lost in transit" — which is the exact bug being guarded.
 * - Every positive case is paired with an unclamped sibling in the SAME call.
 *   A flag hardcoded `true`, or one stamped response-wide instead of per
 *   session, passes a lone positive assertion and fails here.
 * - The boundary case does a real structured-clone → `.strict()` parse. The
 *   in-process path skips that schema, so a producer-only test stays green while
 *   the worker silently drops the ENTIRE response and re-drops the source on
 *   every retry.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { HistoricalParseWorkerLimits } from "../src/main/collectors/engine/historical-parse-worker-limits-and-clamping.js";
import {
  createHistoricalParseWorkerParsedResponse,
  HistoricalParseWorkerResponseType,
  historicalParseWorkerResponseSchema,
} from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import { clampSessionsForWorkerResponse } from "../src/main/collectors/engine/historical-parse-worker-response-budget.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import {
  makeSession,
  parsedSessions,
} from "./historical-parse-worker-response-support.js";

const MAX_LONG_TEXT_LENGTH = HistoricalParseWorkerLimits.maxLongTextLength;
const MAX_SESSION_ARRAY_ITEMS =
  HistoricalParseWorkerLimits.maxSessionArrayItems;

test("an unclamped session carries no payloadClamped key at all", () => {
  const { sessions } = clampSessionsForWorkerResponse([makeSession("small")]);

  // `Object.hasOwn`, not `=== undefined`: the omit-never-`false` contract is
  // about the KEY. Serializing `payloadClamped: false` would satisfy a value
  // check while changing the wire shape every older consumer already parses.
  assert.equal(
    Object.hasOwn(sessions[0], "payloadClamped"),
    false,
    "a session the clamp did not touch must not gain the key"
  );
});

test("an untouched session round-trips key-for-key, subagents included", () => {
  // The false-positive guard, and the reason it is shaped as a KEY-SET compare
  // rather than a list of fields. `markPayloadClamped` decides "was this
  // reduced?" with `isDeepStrictEqual`, which counts an own key valued
  // `undefined` as a difference from an absent key — so any clamp helper that
  // writes `field: clamp(input.field)` unconditionally invents a reduction.
  // That is not hypothetical: `clampSubagentPayloads` did exactly that to
  // `task`, and every Claude session carrying a sidecar subagent (which omits
  // `task`) reported itself clamped on a completely healthy parse, moving a
  // MONITORED counter and persisting a false flag into the metadata blob.
  //
  // A per-field assertion would have to be extended by hand for the next
  // optional field. Comparing the whole key set against the input catches all of
  // them, including ones added after this test was written — `toolUses` was the
  // SECOND field caught this way, three lines from the first.
  //
  // The fixture therefore omits EVERY optional a subagent may omit rather than
  // setting them to empty values: an empty array is present, and a present key
  // cannot detect an injected one.
  const session = makeSession("untouched");
  session.subagents = [
    {
      id: "sub-1",
      parentId: "untouched",
      name: "explorer",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
      status: "completed",
    } as unknown as NonNullable<NormalizedSession["subagents"]>[number],
  ];

  const { sessions } = clampSessionsForWorkerResponse([session]);
  const [clamped] = sessions;

  assert.equal(
    Object.hasOwn(clamped, "payloadClamped"),
    false,
    "nothing in this session is over any cap, so no clamp can have occurred"
  );
  assert.deepEqual(
    Object.keys(clamped.subagents?.[0] ?? {}).sort(),
    Object.keys(session.subagents[0]).sort(),
    "a subagent the clamp did not touch must come back with the same KEYS — an injected `undefined` reads as a reduction"
  );
});

test("an array truncated to the per-array cap stamps payloadClamped", () => {
  // Two sessions through ONE call: the oversized one must be flagged and the
  // small one must not. A flag stamped on every session of a response that
  // clamped anything — the easy wrong implementation — fails the second half.
  const oversized: NormalizedSession = {
    ...makeSession("wide"),
    teams: new Array(MAX_SESSION_ARRAY_ITEMS + 1).fill("team"),
  };

  const { sessions } = clampSessionsForWorkerResponse([
    oversized,
    makeSession("narrow"),
  ]);
  const [flagged, untouched] = sessions;

  assert.equal(flagged.payloadClamped, true);
  // Asserted against the INPUT length, not against `MAX_SESSION_ARRAY_ITEMS`:
  // once the response-wide item budget is also breached, `shrinkArraysToBudget`
  // halves the per-array limit below the cap, so pinning the exact surviving
  // count would assert the budget maths rather than the truncation this flag
  // reports. What must hold is that the flag describes a real loss.
  assert.ok(
    flagged.teams.length < oversized.teams.length,
    "the flag must describe a real truncation, not be stamped speculatively"
  );
  assert.ok(flagged.teams.length <= MAX_SESSION_ARRAY_ITEMS);
  assert.equal(
    Object.hasOwn(untouched, "payloadClamped"),
    false,
    "an unclamped session in the same response stays unflagged"
  );
});

test("an oversized long-text field stamps payloadClamped", () => {
  // The content strategies (`clampSessionPayloads` / `shrinkSessionText`) reduce
  // a session without changing any array LENGTH, so a detector built only on
  // array counts scores this as untouched. It is also the ISS-5797 case the
  // ported peer patch missed entirely: a plain capped text field, not a
  // schema-`unknown` one, and one ISS-7534's `tokenSeries` report cannot see.
  const { sessions } = clampSessionsForWorkerResponse([
    { ...makeSession("long-name"), name: "x".repeat(MAX_LONG_TEXT_LENGTH + 1) },
    makeSession("short-name"),
  ]);
  const [flagged, untouched] = sessions;

  assert.equal(flagged.payloadClamped, true);
  assert.ok(
    flagged.name.length <= MAX_LONG_TEXT_LENGTH,
    "the text really was truncated"
  );
  assert.equal(
    Object.hasOwn(untouched, "payloadClamped"),
    false,
    "a session whose text fits keeps the key absent"
  );
});

test("the response-wide halving loop stamps only the sessions it actually shrank", () => {
  // Strategies 2 and 3 — `shrinkArraysToBudget` and the `textCap` halving loop —
  // fire only when the RESPONSE-WIDE budget is still breached after each session
  // is individually within its per-field caps. That is the multi-session case
  // ISS-5797 was filed for, and it reaches the flag through a different
  // injection site than the single-session cases above: `markPayloadClamped`
  // re-wrapping `shrinkSessionText` inside the loop, plus a SECOND
  // `sliceSessionArrays` call with a halved limit. Five names at exactly the
  // per-field cap sum to 10MB against an 8MB budget, so no single session is
  // over-cap and only the aggregate forces the loop.
  const huge = [0, 1, 2, 3, 4].map((index) => ({
    ...makeSession(`huge-${index}`),
    name: "x".repeat(MAX_LONG_TEXT_LENGTH),
  }));

  const { sessions } = clampSessionsForWorkerResponse([
    ...huge,
    makeSession("tiny"),
  ]);

  assert.equal(
    sessions.length,
    huge.length + 1,
    "every session must still fit — this case is about shrinking, not dropping"
  );
  const [tiny] = sessions.slice(huge.length);
  for (const session of sessions.slice(0, huge.length)) {
    assert.equal(
      session.payloadClamped,
      true,
      `${session.sessionId} was shrunk by the budget loop and must say so`
    );
    assert.ok(session.name.length < MAX_LONG_TEXT_LENGTH);
  }
  // The paired negative that makes the loop coverage mean something: the loop
  // re-runs over EVERY session, so a flag stamped by the loop's existence rather
  // than by an actual reduction would light this one up too.
  assert.equal(
    Object.hasOwn(tiny, "payloadClamped"),
    false,
    "a session the halving loop left byte-identical stays unflagged"
  );
});

test("the signal survives a structured clone through the .strict() boundary", () => {
  // The real transport: the worker builds a response, posts it as a structured
  // clone to the main process, and the runner re-validates it against the same
  // `.strict()` schema. Delete `payloadClamped` from that schema and this case
  // goes RED — `safeParse` rejects the WHOLE response, not just the field, so
  // `parsedSessions` throws rather than quietly returning an unflagged session.
  const response = createHistoricalParseWorkerParsedResponse("rq-clamp", [
    {
      ...makeSession("wide"),
      teams: new Array(MAX_SESSION_ARRAY_ITEMS + 1).fill("t"),
    },
    makeSession("narrow"),
  ]);
  assert.equal(
    response.type,
    HistoricalParseWorkerResponseType.Parsed,
    "the producer must not degrade a flagged payload to a Failed envelope"
  );

  const received = parsedSessions(
    historicalParseWorkerResponseSchema.safeParse(structuredClone(response))
  );

  const [flagged, untouched] = received;
  assert.equal(
    flagged.payloadClamped,
    true,
    "the clamp signal must cross the process boundary intact"
  );
  assert.equal(
    Object.hasOwn(untouched, "payloadClamped"),
    false,
    "and omission must cross it too — never arriving as an injected false"
  );
});

test("a payload from an older worker that omits the key still parses", () => {
  // Version skew, the other direction: a Desktop build predating ISS-5822 sends
  // a session with no `payloadClamped`. The boundary must accept it and the
  // consumer must degrade to "not clamped" rather than reject the source.
  const legacy = structuredClone(
    createHistoricalParseWorkerParsedResponse("rq-legacy", [
      makeSession("legacy"),
    ])
  );

  const [session] = parsedSessions(
    historicalParseWorkerResponseSchema.safeParse(legacy)
  );

  assert.equal(Object.hasOwn(session, "payloadClamped"), false);
  assert.equal(session.payloadClamped ?? false, false);
});

test("the boundary rejects payloadClamped: false rather than accepting a falsified absence", () => {
  // `z.literal(true)` is what makes "omitted, never `false`" a contract both
  // sides enforce instead of a convention the producer happens to follow.
  const withFalse = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "rq-false",
    sessions: [{ ...makeSession("falsified"), payloadClamped: false }],
  });

  assert.equal(withFalse.success, false);
});
