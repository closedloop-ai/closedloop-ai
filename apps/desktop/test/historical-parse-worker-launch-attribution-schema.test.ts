/**
 * ISS-7259: the `harnessLaunchAttribution` half of the historical-parse worker's
 * `.strict()` response boundary.
 *
 * A sibling of `historical-parse-worker-protocol.test.ts` rather than more lines
 * in it: that file is a grandfathered over-size module under the repo's
 * shrink-only rule, and the launch-attribution facet is a self-contained concern
 * with its own bounds.
 *
 * This boundary is INDEPENDENT of the Codex parser's own gate
 * (`depthOrNull` in `packages/lib/harness/codex/codex-launch-attribution.ts`).
 * Both are asserted, because the worker schema is what a version-skewed or
 * non-Codex producer actually has to clear.
 */
import assert from "node:assert/strict";
import { LaunchThreadSource } from "@repo/lib/harness/launch-attribution";
import { test } from "vitest";
import {
  HistoricalParseWorkerResponseType,
  historicalParseWorkerResponseSchema,
} from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import {
  makeSession,
  parsedSessions,
} from "./historical-parse-worker-response-support.js";

function responseWithDepth(sessionId: string, depth: number) {
  return historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession(sessionId),
        harnessLaunchAttribution: {
          threadSource: LaunchThreadSource.Subagent,
          depth,
        },
      },
    ],
  });
}

test("worker boundary rejects a negative harnessLaunchAttribution depth", () => {
  // `depth` originates in transcript JSON the type system does not constrain.
  // The two bad shapes fail very differently, and the quiet one is why this
  // bound is here: a fractional depth was already rejected by `.int()`, but a
  // NEGATIVE integer cleared the boundary and synced as a genuine hierarchy
  // level — a plausible-but-wrong value in the database, worse than a rejection.
  assert.equal(responseWithDepth("worker-negative-depth", -1).success, false);
});

test("worker boundary rejects a fractional harnessLaunchAttribution depth", () => {
  assert.equal(
    responseWithDepth("worker-fractional-depth", 1.5).success,
    false
  );
});

/**
 * ISS-7508: the position pair, which is bounded one notch tighter than `depth`.
 * The two positions are taken as `unknown` because the shapes worth asserting
 * here — a 0, a `null` — are ones a version-skewed or hand-rolled producer can
 * put on the wire and the in-process type cannot forbid.
 */
function responseWithPosition(
  sessionId: string,
  firstAttributedRecordIndex: unknown,
  observedRecordCount: unknown
) {
  return historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession(sessionId),
        harnessLaunchAttribution: {
          threadSource: LaunchThreadSource.Unstated,
          firstAttributedSkill: "cl-produce",
          observedSkillCount: 1,
          firstAttributedRecordIndex,
          observedRecordCount,
        },
      },
    ],
  });
}

test("worker boundary carries a deep attribution position through intact", () => {
  const result = responseWithPosition("worker-deep-position", 251, 381);
  const facet = parsedSessions(result)[0]?.harnessLaunchAttribution;

  // The corpus's normal case (dossier 4eba5e9a first attributes at record 251 of
  // 381), asserted whole: a key-by-key check would stay green if `.strict()`
  // dropped one of the pair, and the pair is what makes either number legible.
  assert.deepEqual(facet, {
    threadSource: LaunchThreadSource.Unstated,
    firstAttributedSkill: "cl-produce",
    observedSkillCount: 1,
    firstAttributedRecordIndex: 251,
    observedRecordCount: 381,
  });
});

test("worker boundary rejects a 0 attribution index, which no 1-based ordinal can be", () => {
  // The quiet failure this bound exists for: 0 clears `.nonnegative()` and syncs
  // as a genuine record position, so a consumer reads "attributed before the
  // transcript began" — plausible, wrong, and indistinguishable from a real
  // value. It is what a producer that computed the ordinal 0-based emits.
  assert.equal(
    responseWithPosition("worker-zero-index", 0, 381).success,
    false
  );
});

test("worker boundary rejects a 0 observed record count on a facet that named a skill", () => {
  // Its sibling bound: a transcript that attributed a nameable skill carried at
  // least the one record that stated it, so a 0 denominator contradicts the
  // member it is co-present with.
  assert.equal(responseWithPosition("worker-zero-count", 1, 0).success, false);
});

test("worker boundary rejects a null position rather than persisting it", () => {
  // The facet's contract is OMISSION, never `null` — a `null` here is a producer
  // that broke it, and `.nullable()` would let "we did not capture it" and "the
  // harness said nothing" become the same stored value. Both members are checked
  // because a schema is edited one line at a time.
  assert.equal(
    responseWithPosition("worker-null-index", null, 381).success,
    false
  );
  assert.equal(
    responseWithPosition("worker-null-count", 251, null).success,
    false
  );
});

/**
 * ISS-7508: the same facet, but with the position members SPREAD rather than
 * assigned, so a case can leave one of the pair genuinely ABSENT — the shape
 * `responseWithPosition` above cannot express, because assigning `undefined`
 * still sets the key.
 */
function responseWithPositionFacet(
  sessionId: string,
  position: Record<string, unknown>
) {
  return historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession(sessionId),
        harnessLaunchAttribution: {
          threadSource: LaunchThreadSource.Unstated,
          firstAttributedSkill: "cl-produce",
          observedSkillCount: 1,
          ...position,
        },
      },
    ],
  });
}

test("worker boundary rejects an attribution index past its own record count", () => {
  // The joint impossibility no per-field bound can see: 251 and 3 each clear
  // `.positive()`, and together they position an attribution past the end of the
  // transcript it was drawn from. `HarnessLaunchAttribution` states
  // `firstAttributedRecordIndex <= observedRecordCount` always holds — before
  // the cross-field check this payload was ACCEPTED and synced, and a consumer
  // read it as a late attribution in a 3-record session.
  assert.equal(
    responseWithPosition("worker-index-past-count", 251, 3).success,
    false
  );
});

test("worker boundary accepts an attribution on the final record", () => {
  // The boundary case the rejection above must not swallow: index === count is
  // a real transcript whose only attributed record was its last, so a check
  // written with `>=` would reject a legitimate corpus shape.
  assert.equal(
    responseWithPosition("worker-index-equals-count", 381, 381).success,
    true
  );
});

test("worker boundary rejects a position stated on one side only", () => {
  // A version-skewed or hand-rolled producer can put half the pair on the wire;
  // the in-process type cannot forbid it, and this is an IPC boundary. An index
  // with no denominator is unreadable (251 is late in 381 records and early in
  // 4000), and a denominator with no index asserts a scan whose result is
  // missing. Both halves are asserted because a schema is edited one line at a
  // time.
  assert.equal(
    responseWithPositionFacet("worker-index-only", {
      firstAttributedRecordIndex: 251,
    }).success,
    false
  );
  assert.equal(
    responseWithPositionFacet("worker-count-only", {
      observedRecordCount: 381,
    }).success,
    false
  );
});

test("worker boundary accepts a facet that states neither position member", () => {
  // Codex never populates the pair, and every Claude session that attributed no
  // nameable skill drops it whole. Omitting both must stay valid, or the
  // pair check would reject the majority of the corpus.
  assert.equal(
    responseWithPositionFacet("worker-no-position", {}).success,
    true
  );
});

test("worker boundary accepts a harnessLaunchAttribution depth of 0", () => {
  // The tightened bound must not swallow a real root depth: 0 is a legitimate
  // hierarchy level, so a gate rejecting it would be a regression, not a fix.
  const result = responseWithDepth("worker-zero-depth", 0);

  assert.equal(result.success, true);
  assert.equal(
    parsedSessions(result)[0]?.harnessLaunchAttribution?.depth,
    0,
    "a depth of 0 must survive the .strict() boundary intact"
  );
});
