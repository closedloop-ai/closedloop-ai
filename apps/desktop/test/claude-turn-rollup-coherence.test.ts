/**
 * @file claude-turn-rollup-coherence.test.ts
 * @description ISS-7737. A session's token rollup and its stated turn count
 * describe DIFFERENT populations on a delegating session, and nothing executable
 * said so until this file.
 *
 * `assistantMessages` is snapshotted from the parent transcript alone
 * (parse-claude.ts `deriveSessionUsage`, deliberately — see the ClaudeSessionUsage
 * docstring), while `tokensByModel` / `tokenSeries` are folded across every
 * `subagents/agent-*.jsonl` file beside it (claude-parser.ts `processAgentFiles`).
 * Session 795c67ae folded 710 subagent transcripts: 1,016 stated turns against
 * 38,844 billable round-trips, a 38x population gap. Dividing that session's
 * 7,994,296,736 cache-read tokens by its 1,016 stated turns yields 7,868,402
 * "per turn", which reads as corrupt data. It is not: re-deriving all four
 * counters from the raw transcripts reproduced the stored rollup exactly
 * (8,260,678,836 tokens). Only the denominator was ever wrong.
 *
 * "Billable" is load-bearing in that number. The session holds 38,871 dedup
 * keys, but `claude-usage.ts` skips `<synthetic>` turns outright — nobody was
 * charged for them — so 27 of those keys never reach the totals. A denominator
 * that counts them is 27 turns too large and is not the population the rollup
 * sums. The last test below pins that exclusion to the fold rather than to a
 * constant copied into this docstring.
 *
 * The invariant below needs no context-window constant: a rollup divided by a
 * turn count must not exceed the LARGEST SINGLE round-trip that rollup actually
 * contains. That ceiling is read from the session's own per-round-trip series,
 * so it cannot drift as models and context windows change.
 *
 * `rollupReconciles` is asserted BEFORE the exact populations are pinned, on
 * purpose. Pinning `assistantMessages` and `tokenSeries.length` first would make
 * those equalities throw on any regression and leave the ratio check unreachable
 * — green for a reason that has nothing to do with the contract this file exists
 * to hold.
 */
import assert from "node:assert/strict";
import { SYNTHETIC_MODEL } from "@repo/lib/harness/claude/parse-claude-accumulator";
import { test } from "vitest";
import { parseSessionFile as parseClaudeFile } from "../src/main/collectors/claude/claude-parser.js";
import { writeClaudeTranscript } from "./normalized-session-test-utils.js";

const MODEL = "claude-opus-4-5";
/** Per-round-trip cache read, in the range a real ~200K context re-read sits. */
const CACHE_READ_PER_ROUND_TRIP = 200_000;
const SUBAGENT_FILES = 4;
const RECORDS_PER_SUBAGENT_FILE = 10;
const PARENT_ROUND_TRIPS = 2;
const FOLDED_ROUND_TRIPS =
  PARENT_ROUND_TRIPS + SUBAGENT_FILES * RECORDS_PER_SUBAGENT_FILE;

type RoundTripSeries = ReadonlyArray<{ cacheRead: number }>;

/**
 * Whether a token rollup reconciles against a stated turn count.
 *
 * The two figures are divisible only if the implied per-turn value fits inside
 * the biggest round-trip the rollup is actually made of. A denominator drawn
 * from a smaller population inflates that quotient past the ceiling, which is
 * the shape ISS-7737 turned on. Degenerate inputs need no guard: an empty series
 * makes the ceiling `-Infinity` and a zero turn count makes the quotient
 * `Infinity` or `NaN`, and neither compares `<=` true.
 */
function rollupReconciles(
  totalCacheRead: number,
  statedTurns: number,
  series: RoundTripSeries
): boolean {
  const largestRoundTrip = Math.max(...series.map((entry) => entry.cacheRead));
  return totalCacheRead / statedTurns <= largestRoundTrip;
}

/** One billable assistant round-trip, uniquely keyed so dedup keeps it. */
function assistantRecord(id: string, minute: number): unknown {
  return billableLine(id, `msg-${id}`, `req-${id}`, minute);
}

/** An assistant line with explicitly chosen dedup identity. */
function billableLine(
  lineId: string,
  messageId: string,
  requestId: string,
  minute: number
): unknown {
  return {
    type: "assistant",
    timestamp: `2026-08-16T10:${String(minute).padStart(2, "0")}:00.000Z`,
    uuid: `uuid-${lineId}`,
    requestId,
    message: {
      id: messageId,
      model: MODEL,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: CACHE_READ_PER_ROUND_TRIP,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: "text", text: lineId }],
    },
  };
}

/** A turn nobody was charged for: same shape, `<synthetic>` model. */
function syntheticRecord(id: string, minute: number): unknown {
  const line = billableLine(id, `msg-${id}`, `req-${id}`, minute) as {
    message: { model: string };
  };
  line.message.model = SYNTHETIC_MODEL;
  return line;
}

function openingUserLine(): unknown {
  return { type: "user", timestamp: "2026-08-16T10:00:00.000Z", cwd: "/test" };
}

function roundTripSeries(parsed: {
  tokenSeries: ReadonlyArray<{ cacheRead?: number }>;
}): RoundTripSeries {
  return parsed.tokenSeries.map((entry) => ({
    cacheRead: entry.cacheRead ?? 0,
  }));
}

/** The 795c67ae shape in miniature: a small parent, many subagent FILES. */
function delegatingSubagentFiles(): Record<string, unknown[]> {
  const files: Record<string, unknown[]> = {};
  for (let file = 0; file < SUBAGENT_FILES; file++) {
    files[`f${file}`] = Array.from(
      { length: RECORDS_PER_SUBAGENT_FILE },
      (_, index) => assistantRecord(`s${file}-${index}`, 10 + index)
    );
  }
  return files;
}

test("non-delegating session: the rollup reconciles against its stated turn count", async () => {
  const filePath = writeClaudeTranscript("sess-no-delegation", [
    openingUserLine(),
    assistantRecord("p1", 1),
    assistantRecord("p2", 2),
    assistantRecord("p3", 3),
  ]);

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);

  // The positive sibling: with no fold, the stated turn count IS the rollup's
  // population, so the same predicate that rejects the delegating case accepts
  // this one. Asserted before any exact value is pinned, same as below.
  const totalCacheRead = parsed.tokensByModel[MODEL]?.cacheRead ?? 0;
  assert.equal(
    rollupReconciles(
      totalCacheRead,
      parsed.assistantMessages,
      roundTripSeries(parsed)
    ),
    true,
    "a non-delegating session's rollup must reconcile against its stated turn count"
  );

  assert.equal(parsed.assistantMessages, 3);
  assert.equal(parsed.tokenSeries.length, 3);
  assert.equal(totalCacheRead, 3 * CACHE_READ_PER_ROUND_TRIP);
});

test("delegating session: the rollup does NOT reconcile against stated turns, and DOES against its own round-trip population", async () => {
  const filePath = writeClaudeTranscript(
    "sess-delegating",
    [openingUserLine(), assistantRecord("p1", 1), assistantRecord("p2", 2)],
    { subagents: delegatingSubagentFiles() }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);

  const totalCacheRead = parsed.tokensByModel[MODEL]?.cacheRead ?? 0;
  const series = roundTripSeries(parsed);

  // THE CATCH, asserted first so this predicate is what actually detects a
  // regression in either population. Dividing the folded rollup by the
  // parent-only turn count implies a per-turn context larger than any round-trip
  // in the session ever was. Restoring the fold to the turn count, or dropping
  // the fold from the rollup, makes this read `true` and fails here.
  assert.equal(
    rollupReconciles(totalCacheRead, parsed.assistantMessages, series),
    false,
    "dividing a subagent-folded rollup by parent-only turns must not read as coherent"
  );
  // Positive sibling on the same predicate: the reconciling denominator is the
  // population the rollup actually spans.
  assert.equal(
    rollupReconciles(totalCacheRead, parsed.tokenSeries.length, series),
    true,
    "the rollup must reconcile against its own round-trip population"
  );

  // Now name the two populations the predicate just distinguished.
  assert.equal(
    parsed.assistantMessages,
    PARENT_ROUND_TRIPS,
    "stated turns count the PARENT transcript only"
  );
  assert.equal(
    parsed.tokenSeries.length,
    FOLDED_ROUND_TRIPS,
    "the token rollup spans parent + every folded subagent round-trip"
  );
  assert.equal(
    totalCacheRead,
    FOLDED_ROUND_TRIPS * CACHE_READ_PER_ROUND_TRIP,
    "every folded round-trip is billed exactly once"
  );
});

test("a synthetic turn is in neither population: it inflates no denominator and bills nothing", async () => {
  // ISS-7737's own near-miss. The reconciling denominator is the BILLABLE
  // round-trip count, and `<synthetic>` turns are skipped before billing
  // (claude-usage.ts). Counting them yields a denominator larger than the
  // population the rollup actually sums — the same class of error, one step down.
  const withoutSynthetic = await parseClaudeFile(
    writeClaudeTranscript(
      "sess-no-synthetic",
      [openingUserLine(), assistantRecord("p1", 1)],
      { subagents: { a: [assistantRecord("s1", 5)] } }
    )
  );
  const withSynthetic = await parseClaudeFile(
    writeClaudeTranscript(
      "sess-with-synthetic",
      [
        openingUserLine(),
        assistantRecord("p1", 1),
        syntheticRecord("p-syn", 2),
      ],
      {
        subagents: {
          a: [assistantRecord("s1", 5), syntheticRecord("s-syn", 6)],
        },
      }
    )
  );
  assert.ok(withoutSynthetic);
  assert.ok(withSynthetic);

  // Adding a synthetic turn to BOTH the parent and a subagent file must move
  // neither population: not the stated turn count, not the billable round-trip
  // count, and not the token totals.
  //
  // The stated-turn half is asserted because excluding a synthetic turn from
  // BILLING while counting it as a TURN is precisely the denominator mismatch
  // this file exists to police, one step down from the parent/fold gap above.
  // Both counters descend from the one dedup map (`deriveSessionUsage`), and
  // that shared origin is the contract — a regression that splits them, counting
  // `<synthetic>` into the turn count while the fold still skips it, moves this
  // equality and nothing else in this test.
  assert.equal(
    withSynthetic.assistantMessages,
    withoutSynthetic.assistantMessages,
    "a synthetic turn must not enter the stated turn count"
  );
  // Pinned so the equality above cannot be satisfied by both sides collapsing:
  // the parent authored one billable turn either way.
  assert.equal(
    withoutSynthetic.assistantMessages,
    1,
    "the parent's one billable turn is the stated count both sides must hold"
  );
  assert.equal(
    withSynthetic.tokenSeries.length,
    withoutSynthetic.tokenSeries.length,
    "a synthetic turn must not enter the billable round-trip population"
  );
  assert.equal(
    withSynthetic.tokensByModel[MODEL]?.cacheRead ?? 0,
    withoutSynthetic.tokensByModel[MODEL]?.cacheRead ?? 0,
    "a synthetic turn must contribute no tokens"
  );
  assert.equal(
    withSynthetic.tokensByModel[SYNTHETIC_MODEL],
    undefined,
    "a synthetic turn must not open a model row of its own"
  );
});

test("a round-trip written into both the parent and a subagent file is billed once", async () => {
  // The fold walks many files; `billedKeys` is what stops a turn present in two
  // of them from inflating BOTH the rollup and the round-trip population — which
  // would fake the very incoherence this file polices.
  const shared = billableLine("parent-copy", "msg-shared", "req-shared", 1);
  const subagentCopy = billableLine("sub-copy", "msg-shared", "req-shared", 2);
  const filePath = writeClaudeTranscript(
    "sess-collided-round-trip",
    [openingUserLine(), shared],
    { subagents: { a: [subagentCopy, assistantRecord("s-unique", 3)] } }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);

  // Two distinct round-trips exist across three records: the shared one and the
  // subagent's own. The collided copy must not add a third.
  assert.equal(
    parsed.tokenSeries.length,
    2,
    "a dedup-key collision across files must not inflate the round-trip population"
  );
  assert.equal(
    parsed.tokensByModel[MODEL]?.cacheRead ?? 0,
    2 * CACHE_READ_PER_ROUND_TRIP,
    "a collided round-trip must be billed once, not once per file"
  );
  assert.equal(
    parsed.assistantMessages,
    1,
    "the parent's own turn count is unchanged by the fold"
  );
});
