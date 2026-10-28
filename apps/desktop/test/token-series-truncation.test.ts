/**
 * @file token-series-truncation.test.ts
 * @description ISS-7534 — a `tokenSeries` the worker-response budget cut short
 * must not be presentable as a whole one.
 *
 * The clamp shrinks `tokenSeries` and never `tokensByModel`, so before this
 * ticket the series and its own rollup silently disagreed (measured at up to
 * 778x on real sessions) and every consumer summing the series emitted a
 * confident, plausible, wrong total. These cases drive a series PAST the budget
 * — a fixture that fits never reaches the clamp and would prove nothing — and
 * assert the two reconcile exactly.
 *
 * Three boundaries can each drop the signal on its own and are asserted through
 * their production entry points: the clamp that stamps it, the `.strict()`
 * worker response schema (which rejects the WHOLE session, not one unmodelled
 * key), and `buildImportMetadata`, whose blob is what the local `$.tokenSeries`
 * consumers and cloud sync actually read.
 *
 * SCOPE: the SESSION series only. `NormalizedSubagent.tokenSeries` is sliced by
 * the same clamp and is deliberately not marked — parsers fold subagent records
 * into the root series, so the root is always at least as long and the
 * "root whole, subagent cut" case cannot arise; its one reader derives activity
 * phases, never a token total.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { HistoricalParseWorkerLimits } from "../src/main/collectors/engine/historical-parse-worker-limits-and-clamping.js";
import {
  createHistoricalParseWorkerParsedResponse,
  HistoricalParseWorkerResponseType,
  historicalParseWorkerResponseSchema,
} from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import {
  clampSessionsForWorkerResponse,
  fitsResponseBudget,
  summarizeWorkerResponsePayload,
} from "../src/main/collectors/engine/historical-parse-worker-response-budget.js";
import {
  Harness,
  type NormalizedSession,
  type NormalizedTokenRecord,
} from "../src/main/collectors/types.js";
import { buildImportMetadata } from "../src/main/database/import-metadata-builders.js";
import {
  makeSession,
  parsedSessions,
} from "./historical-parse-worker-response-support.js";

const MODEL = "claude-opus-4-20260514";

/**
 * Over the per-array cap AND the response-wide item budget (both 50,000), so the
 * fixture reaches the HALVING strategy rather than stopping at the deterministic
 * pre-slice. The margin is real but narrow enough to be worth stating: the
 * pre-slice caps the series at 50,000, and the session itself is an element of
 * the `sessions` array, so `arrayItems` is 50,001 — over the budget by one, which
 * is what drives the halving loop. The test asserts the outcome rather than
 * trusting this arithmetic.
 */
const RECORD_COUNT = 60_000;

/**
 * Dimensions for the budget-certification case below. Tuned by measurement, not
 * by feel: at these values the pre-fix clamp exits its shrink loop with a
 * payload that fits UNMEASURED, then stamps ~79 bytes per session on top and
 * returns something over the 8MB text cap; the fixed clamp measures the stamps
 * and halves once more. Nearby name lengths (7060-7120, 7280-7340, 7420-7460)
 * behave the same way, so the case is not balanced on a single knife edge.
 */
const BULK_SESSION_COUNT = 1000;
const BULK_RECORD_COUNT = 60;
const BULK_NAME_LENGTH = 7100;

/** Per-record counters. Distinct values so a mixed-up counter cannot pass. */
const PER_RECORD_INPUT = 10;
const PER_RECORD_OUTPUT = 5;
const PER_RECORD_CACHE_READ = 1000;
const PER_RECORD_CACHE_WRITE = 3;

/**
 * The FULL parse's rollup, written out rather than summed, so the reconciliation
 * below is checked against a literal instead of against a second run of the same
 * arithmetic the production code performs.
 */
const FULL_ROLLUP = {
  input: 600_000,
  output: 300_000,
  cacheRead: 60_000_000,
  cacheWrite: 180_000,
} as const;

test("a tokenSeries past the response budget is truncated, and the truncation reconciles it with tokensByModel", () => {
  const session = sessionWithOversizedSeries("over-budget");

  // AC4, asserted rather than assumed: a series that FITS never reaches the
  // halving loop, so a test built on one would pass against the unfixed code.
  assert.ok(
    session.tokenSeries.length >
      HistoricalParseWorkerLimits.maxWorkerResponseArrayItems,
    "the fixture must exceed the response-wide item budget"
  );
  assert.equal(
    fitsResponseBudget([session]),
    false,
    "the fixture must not already satisfy the budget"
  );
  assert.deepEqual(
    sumRecords(session.tokenSeries),
    { ...FULL_ROLLUP },
    "the fixture's own series must sum to the rollup it declares"
  );

  const [clamped] = clampSessionsForWorkerResponse([session]).sessions;

  assert.ok(clamped);
  assert.ok(
    clamped.tokenSeries.length < RECORD_COUNT,
    "the budget must actually have truncated the series"
  );
  // Below the pre-slice floor, not merely below the input: this pins that the
  // HALVING loop ran, so the truncation under test is the multi-round strategy
  // and not just the one deterministic slice at `maxSessionArrayItems`.
  assert.ok(
    clamped.tokenSeries.length <
      HistoricalParseWorkerLimits.maxSessionArrayItems,
    "the halving strategy must have reduced the series below the per-array cap"
  );
  assert.ok(
    clamped.tokenSeries.length > 0,
    "truncation degrades the series, it does not empty it"
  );
  const truncation = clamped.tokenSeriesTruncation;
  assert.ok(
    truncation,
    "a truncated series must carry its truncation, or its consumers under-count in silence"
  );

  // Conservation: nothing was invented and nothing went unaccounted for.
  assert.equal(
    truncation.droppedRecords + clamped.tokenSeries.length,
    RECORD_COUNT
  );

  // The equation the ticket exists for. `tokensByModel` is untouched by the
  // clamp, so the kept series plus the reported drop must close back onto it —
  // against the hand-written rollup, not against a re-sum of the fixture.
  const kept = sumRecords(clamped.tokenSeries);
  assert.deepEqual(
    {
      input: kept.input + truncation.droppedTokens.input,
      output: kept.output + truncation.droppedTokens.output,
      cacheRead: kept.cacheRead + truncation.droppedTokens.cacheRead,
      cacheWrite: kept.cacheWrite + truncation.droppedTokens.cacheWrite,
    },
    { ...FULL_ROLLUP },
    "kept series + dropped tail must equal the rollup the clamp never shrank"
  );
  assert.deepEqual(
    clamped.tokensByModel[MODEL],
    { ...FULL_ROLLUP },
    "the rollup itself must stay the FULL parse — recomputing it from the clamped series would make both numbers wrong and agreeing"
  );
});

test("the clamp's own truncation report is inside the budget it certifies", () => {
  // The report is ~79 bytes of object keys per truncated session, and
  // `summarizeWorkerResponsePayload` counts key bytes. Stamping it AFTER the
  // shrink loop exited would leave the clamp returning a payload bigger than the
  // one it measured — and the response schema re-runs that same measurement, so
  // the overflow would come back as a Failed envelope for the WHOLE source
  // instead of the truncated-but-delivered parse the clamp exists to produce.
  // The fixture must land where the TEXT budget is the binding one and is
  // near-saturated, because the report costs text bytes and no array items —
  // measured, these dimensions make the two implementations disagree (the
  // pre-fix clamp returns an over-budget payload here, the fixed one shrinks one
  // further round and fits).
  const sessions = Array.from({ length: BULK_SESSION_COUNT }, (_, index) => ({
    ...sessionWithSeries(`bulk-${index}`, BULK_RECORD_COUNT),
    name: "x".repeat(BULK_NAME_LENGTH),
  }));
  assert.equal(
    fitsResponseBudget(sessions),
    false,
    "the fixture must drive the shrink loop, not sail under it"
  );

  const clamped = clampSessionsForWorkerResponse(sessions).sessions;

  assert.ok(
    clamped.some((session) => session.tokenSeriesTruncation),
    "at least one session must actually be stamped, or this proves nothing"
  );
  // Guard the fixture's own relevance: if a future field shifts the byte
  // accounting far from the cap, the reports stop being material and this case
  // would keep passing while proving nothing. Fail loudly instead so it is
  // retuned rather than silently decaying into a no-op.
  assert.ok(
    summarizeWorkerResponsePayload(clamped).textBytes >
      HistoricalParseWorkerLimits.maxWorkerResponseTextBytes - 500_000,
    "the fixture must sit near the text cap, where the reports' own bytes decide the outcome"
  );
  assert.equal(
    fitsResponseBudget(clamped),
    true,
    "what the clamp returns — reports included — must satisfy the budget it checked"
  );
  // The contract end to end: the schema re-measures, so a stamped response must
  // still validate as Parsed rather than degrade to a Failed envelope.
  assert.equal(
    createHistoricalParseWorkerParsedResponse("rq-7534-bulk", sessions).type,
    HistoricalParseWorkerResponseType.Parsed
  );
});

test("a session whose series fits the budget carries no truncation key at all", () => {
  // The positive sibling. Omission is the contract, not a zeroed object: an
  // untruncated session must serialize exactly as it did before ISS-7534, so no
  // metadata blob, golden snapshot, or DATA_REVISION moves.
  const session = sessionWithSeries("fits", 3);
  assert.equal(
    fitsResponseBudget([session]),
    true,
    "this fixture must NOT reach the clamp, or it proves the wrong thing"
  );

  const [clamped] = clampSessionsForWorkerResponse([session]).sessions;

  assert.ok(clamped);
  assert.equal(clamped.tokenSeries.length, 3, "a fitting series is untouched");
  assert.equal(
    Object.hasOwn(clamped, "tokenSeriesTruncation"),
    false,
    "the key must be ABSENT, not present-and-undefined, so JSON.stringify omits it"
  );
});

test("the truncation crosses the strict worker response boundary with its session", () => {
  // `.strict()` rejects the WHOLE session on one unmodelled key, so a field the
  // clamp stamps but the schema does not know would drop the session entirely —
  // and a version-skewed worker that stamps nothing must still validate.
  const response = createHistoricalParseWorkerParsedResponse("rq-7534", [
    sessionWithOversizedSeries("over-budget-wire"),
  ]);

  assert.equal(response.type, HistoricalParseWorkerResponseType.Parsed);
  const [delivered] = parsedSessions(
    historicalParseWorkerResponseSchema.safeParse(response)
  );
  assert.ok(delivered?.tokenSeriesTruncation);
  assert.ok(delivered.tokenSeriesTruncation.droppedRecords > 0);

  // Version skew: a pre-ISS-7534 worker omits the field entirely.
  const legacy = parsedSessions(
    historicalParseWorkerResponseSchema.safeParse({
      type: HistoricalParseWorkerResponseType.Parsed,
      requestId: "rq-7534-legacy",
      sessions: [makeSession("pre-iss-7534")],
    })
  );
  assert.equal(legacy[0]?.tokenSeriesTruncation, undefined);

  // A report of zero describes a truncation that did not happen, so the wire
  // rejects it rather than letting a miscounted caller publish a false "clean".
  assert.equal(
    historicalParseWorkerResponseSchema.safeParse({
      type: HistoricalParseWorkerResponseType.Parsed,
      requestId: "rq-7534-zero",
      sessions: [
        {
          ...makeSession("zero-drop"),
          tokenSeriesTruncation: {
            droppedRecords: 0,
            droppedTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
      ],
    }).success,
    false
  );
});

test("the metadata blob carries the truncation beside the truncated series", () => {
  // `$.tokenSeries` is what `turn-buckets.ts`, `session-analytics-rollup.ts`,
  // and the per-subagent attribution built on them read. Without the key in
  // THIS blob they sum a truncated series and report it as a total.
  const [clamped] = clampSessionsForWorkerResponse([
    sessionWithOversizedSeries("blob"),
  ]).sessions;
  assert.ok(clamped?.tokenSeriesTruncation);

  const blob = JSON.parse(buildImportMetadata(clamped, Harness.Claude)) as {
    tokenSeriesTruncation?: unknown;
  };

  assert.deepEqual(blob.tokenSeriesTruncation, clamped.tokenSeriesTruncation);

  // …and stays absent for a session that was never truncated, so those blobs
  // remain byte-identical to pre-ISS-7534.
  const untruncated = JSON.parse(
    buildImportMetadata(sessionWithSeries("blob-fits", 2), Harness.Claude)
  ) as Record<string, unknown>;
  assert.equal(Object.hasOwn(untruncated, "tokenSeriesTruncation"), false);
});

/** A session whose series is over budget and whose rollup covers all of it. */
function sessionWithOversizedSeries(sessionId: string): NormalizedSession {
  return sessionWithSeries(sessionId, RECORD_COUNT);
}

function sessionWithSeries(
  sessionId: string,
  recordCount: number
): NormalizedSession {
  const tokenSeries: NormalizedTokenRecord[] = [];
  for (let index = 0; index < recordCount; index++) {
    tokenSeries.push({
      timestamp: "2026-08-21T12:00:00.000Z",
      model: MODEL,
      input: PER_RECORD_INPUT,
      output: PER_RECORD_OUTPUT,
      cacheRead: PER_RECORD_CACHE_READ,
      cacheWrite: PER_RECORD_CACHE_WRITE,
    });
  }
  return {
    ...makeSession(sessionId),
    tokenSeries,
    tokensByModel: {
      [MODEL]: {
        input: PER_RECORD_INPUT * recordCount,
        output: PER_RECORD_OUTPUT * recordCount,
        cacheRead: PER_RECORD_CACHE_READ * recordCount,
        cacheWrite: PER_RECORD_CACHE_WRITE * recordCount,
      },
    },
  };
}

function sumRecords(records: readonly NormalizedTokenRecord[]): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const record of records) {
    total.input += record.input;
    total.output += record.output;
    total.cacheRead += record.cacheRead;
    total.cacheWrite += record.cacheWrite;
  }
  return total;
}
