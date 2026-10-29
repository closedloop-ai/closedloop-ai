import assert from "node:assert/strict";
import {
  TokenCostBasis,
  TokenCostCompleteness,
  TokenCostCompletenessReason,
  TokenSourceIdentityAvailability,
} from "@repo/api/src/types/token-cost-provenance";
import { test } from "vitest";
import { HistoricalParseWorkerLimits } from "../src/main/collectors/engine/historical-parse-worker-limits-and-clamping.js";
import {
  HistoricalParseWorkerResponseType,
  historicalParseWorkerResponseSchema,
} from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import { parsedSessions } from "./historical-parse-worker-response-support.js";
import { makeSession } from "./normalized-session-test-utils.js";

test("historical worker strictly round-trips token provenance and cost completeness", () => {
  const base = makeSession({ sessionId: "worker-token-provenance-session" });
  const tokenRecord = {
    timestamp: "2026-06-07T10:00:05.000Z",
    model: "provider-neutral-model",
    input: 0,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    transportId: "transport-token-1",
    sourceIdentity: {
      availability: TokenSourceIdentityAvailability.Available,
      scheme: "synthetic-source-v1",
      sourceRecordIds: ["source-b", "source-a"],
    },
    costSummary: {
      completeness: TokenCostCompleteness.Partial,
      reason: TokenCostCompletenessReason.ClassificationIncomplete,
      subtotalUsd: 2.5,
      lanes: [
        {
          basis: TokenCostBasis.SubscriptionEquivalent,
          subtotalUsd: 1.5,
        },
        { basis: TokenCostBasis.ApiEstimated, subtotalUsd: 1 },
      ],
    },
  };
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [{ ...base, tokenSeries: [tokenRecord] }],
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(parsedSessions(result)[0]?.tokenSeries, [tokenRecord]);
  }
});

test("historical worker rejects unmodelled token-record keys", () => {
  const base = makeSession({
    sessionId: "worker-token-provenance-unknown-key",
  });
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...base,
        tokenSeries: [
          {
            ...base.tokenSeries[0],
            unexpectedProvenance: "must-not-strip",
          },
        ],
      },
    ],
  });

  assert.equal(result.success, false);
});

/**
 * ISS-8565. `tokensByModel` used `z.record`, which validates an own `__proto__`
 * key and then loses it assigning onto its plain-object result. This is the
 * boundary the boot import and every full catch-up sweep cross, so the whole
 * session's spend was deleted here even after the collector folds started
 * preserving it — no throw, no issue, `result.success` true.
 *
 * The fixture builds the key with `JSON.parse`, which DEFINES it exactly as the
 * real worker hop does. A quoted `"__proto__"` in an object literal is the
 * prototype-setter form and would create no own key, so the fixture itself
 * would drop it before the schema ever saw it.
 */
test("historical worker round-trips a tokensByModel key named __proto__", () => {
  const base = makeSession({ sessionId: "worker-tokens-by-model-proto" });
  const tokensByModel = JSON.parse(
    '{"__proto__":{"input":1000,"output":500,"cacheRead":0,"cacheWrite":0},"gpt-5":{"input":7,"output":3,"cacheRead":0,"cacheWrite":0}}'
  );

  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [{ ...base, tokensByModel }],
  });

  assert.equal(result.success, true);
  if (result.success) {
    const parsed = parsedSessions(result)[0]?.tokensByModel;
    // Asserting the key SET, not just success: the drop this pins was silent
    // and left `success` true, so a success-only assertion is the false green.
    assert.deepEqual(Object.keys(parsed ?? {}).sort(), ["__proto__", "gpt-5"]);
    // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
    assert.equal(parsed?.__proto__?.input, 1000);
    // The 1500 tokens the drop was destroying, and the prototype consumers
    // expect back — a null-prototype escape hatch would break spreads.
    assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  }
});

/**
 * ISS-8565 (marisolashgrove review). `subagentSchema.tokensByModel` sat four lines
 * over from the session-level map on the same defective `z.record`, so the
 * session-level fix alone left this half of the boundary dropping the key.
 * `opencode-subagent-fold.ts:101` copies the CHILD's `tokensByModel` onto the
 * subagent verbatim, so it is a real producer, not a theoretical one.
 */
test("historical worker round-trips a subagent tokensByModel key named __proto__", () => {
  const base = makeSession({ sessionId: "worker-subagent-tokens-proto" });
  const tokensByModel = JSON.parse(
    '{"__proto__":{"input":40,"output":20,"cacheRead":0,"cacheWrite":0},"gpt-5":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0}}'
  );

  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...base,
        subagents: [
          {
            id: "subagent-proto",
            name: "child-lane",
            tokensByModel,
          },
        ],
      },
    ],
  });

  assert.equal(result.success, true);
  if (result.success) {
    const parsed = parsedSessions(result)[0]?.subagents?.[0]?.tokensByModel;
    // The key SET, not `success`: the drop left `success` true, so asserting
    // the parse succeeded is the false green here.
    assert.deepEqual(Object.keys(parsed ?? {}).sort(), ["__proto__", "gpt-5"]);
    // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
    assert.equal(parsed?.__proto__?.input, 40);
    assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  }
});

/**
 * ISS-10177. `subagentSchema.metadata` sat sixteen lines below the
 * `tokensByModel` map that ISS-8565 converted, still on `z.record` — so the
 * fix that pinned the sibling above left this neighbour dropping the key. Same
 * silent shape: the entry validates, then vanishes assigning onto a plain
 * object, with `result.success` true and no issue raised.
 *
 * The fixture builds the key with `JSON.parse` for the same reason the
 * `tokensByModel` fixtures above do — a quoted `"__proto__"` in an object
 * literal is the prototype-setter form and creates no own key at all.
 */
test("historical worker round-trips a subagent metadata key named __proto__", () => {
  const base = makeSession({ sessionId: "worker-subagent-metadata-proto" });
  const metadata = JSON.parse('{"__proto__":{"deep":1},"keep":"value"}');

  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...base,
        subagents: [
          { id: "subagent-meta-proto", name: "child-lane", metadata },
        ],
      },
    ],
  });

  assert.equal(result.success, true);
  if (result.success) {
    const parsed = parsedSessions(result)[0]?.subagents?.[0]?.metadata;
    // The key SET, not `success` — the drop this pins left `success` true.
    assert.deepEqual(Object.keys(parsed ?? {}).sort(), ["__proto__", "keep"]);
    // biome-ignore lint/suspicious/noProto: ISS-10177 regression — the hostile key IS the subject under test
    assert.deepEqual(parsed?.__proto__, { deep: 1 });
    // Consumers spread this blob, so it must come back normally-prototyped.
    assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  }
});

/**
 * ISS-10177 preserved the ISS-5797 bounds (whitlockk review) rather than trading one
 * silent defect for another: the swap changed only the CONTAINER, and neither
 * `z.record` nor `protoSafeRecord` caps anything on its own. Both bounds are
 * asserted here because the change touched the code that carries them — a
 * "bounds preserved" claim with no failing case behind it pins nothing.
 */
test("subagent metadata still enforces the ISS-5797 key and entry-count bounds", () => {
  const base = makeSession({ sessionId: "worker-subagent-metadata-bounds" });

  const overlongKey = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...base,
        subagents: [
          {
            id: "subagent-long-key",
            name: "child-lane",
            metadata: {
              ["k".repeat(HistoricalParseWorkerLimits.maxShortTextLength + 1)]:
                1,
            },
          },
        ],
      },
    ],
  });
  assert.equal(overlongKey.success, false);

  const tooManyEntries = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...base,
        subagents: [
          {
            id: "subagent-many-entries",
            name: "child-lane",
            metadata: Object.fromEntries(
              Array.from(
                {
                  length: HistoricalParseWorkerLimits.maxUnknownObjectKeys + 1,
                },
                (_, i) => [`k${i}`, i]
              )
            ),
          },
        ],
      },
    ],
  });
  assert.equal(tooManyEntries.success, false);
});
