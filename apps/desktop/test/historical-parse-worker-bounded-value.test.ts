/**
 * @file historical-parse-worker-bounded-value.test.ts
 * @description ISS-5797 (porting closedloop-ai/closedloop-ai#61). The producer
 * clamp must bound schema-`unknown` payload CONTENT, not just array lengths, so
 * one oversized tool-use payload cannot fail the whole parse job and re-fail the
 * same source on every collector cycle.
 *
 * The last test is the anti-drift half: it executes the clamp against an
 * out-of-bounds value for EVERY field the coverage tables in
 * `historical-parse-worker-bounded-value.ts` claim to bound, so a table entry
 * that lies about the clamp's behavior fails here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLAMPED_KEY_SUFFIX_HEADROOM,
  clampUnknownValue,
  SESSION_UNKNOWN_PAYLOAD_COVERAGE,
  SESSION_USAGE_EXTRAS_UNKNOWN_PAYLOAD_COVERAGE,
  SUBAGENT_UNKNOWN_PAYLOAD_COVERAGE,
  TOOL_USE_UNKNOWN_PAYLOAD_COVERAGE,
  TRUNCATED_TEXT_SUFFIX,
  TRUNCATED_UNKNOWN_VALUE,
  UnknownPayloadCoverage,
} from "../src/main/collectors/engine/historical-parse-worker-bounded-value.js";
import { HistoricalParseWorkerLimits } from "../src/main/collectors/engine/historical-parse-worker-limits.js";
import {
  createHistoricalParseWorkerParsedResponse,
  HistoricalParseWorkerResponseType,
  historicalParseWorkerResponseSchema,
} from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import { clampSessionsForWorkerResponse } from "../src/main/collectors/engine/historical-parse-worker-response-budget.js";
import {
  NormalizedDefinitionKind,
  type NormalizedDefinitionSnapshot,
  type NormalizedSession,
} from "../src/main/collectors/types.js";
import { makeSession } from "./historical-parse-worker-response-support.js";

const OVER_LONG_TEXT = "x".repeat(
  HistoricalParseWorkerLimits.maxLongTextLength + 1
);
const OVER_LONG_KEY = "k".repeat(
  HistoricalParseWorkerLimits.maxShortTextLength + 1
);

test("clampSessionsForWorkerResponse bounds oversized unknown payloads to a valid response", () => {
  // Raw, the session is rejected by the response schema — the failure operators
  // saw in the wild ("sessions.0.toolUses.N.input:custom:Invalid input").
  assert.equal(
    historicalParseWorkerResponseSchema.safeParse({
      type: HistoricalParseWorkerResponseType.Parsed,
      requestId: "historical-parse-1",
      sessions: [makeUnboundedPayloadSession("unbounded-payloads")],
    }).success,
    false
  );

  // Clamped, the same session yields a response that validates.
  const clamped = clampSessionsForWorkerResponse([
    makeUnboundedPayloadSession("unbounded-payloads"),
  ]);
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: clamped,
  });

  assert.equal(result.success, true);
  // Every tool use survives with degraded payloads instead of failing the job.
  const [session] = clamped;
  assert.equal(session?.toolUses.length, 3);
  const clampedContent = (session?.toolUses[0]?.input as { content: string })
    .content;
  assert.ok(
    Buffer.byteLength(clampedContent) <=
      HistoricalParseWorkerLimits.maxLongTextLength
  );
  assert.ok(clampedContent.startsWith("xxx"));
  assert.ok(
    Array.isArray(session?.toolUses[1]?.output) &&
      session.toolUses[1].output.length <=
        HistoricalParseWorkerLimits.maxUnknownArrayItems
  );
  // In-bounds fields on the same tool uses pass through untouched.
  assert.equal(session?.toolUses[1]?.name, "Bash");
  // The subagent's oversized input and non-finite metadata are bounded too.
  const subagent = session?.subagents?.[0];
  assert.equal(subagent?.toolUses?.length, 1);
  assert.equal(subagent?.metadata?.elapsedMs, null);
});

test("clampUnknownValue degrades each out-of-bounds shape to its documented form", () => {
  // Asserted on the exact clamped VALUE, not merely on schema acceptance: a
  // blunt "return null for anything out of bounds" rewrite would still satisfy
  // the validator, so only these pin the intended degradation.
  assert.equal(
    clampUnknownValue(Number.POSITIVE_INFINITY, 0),
    null,
    "a non-finite number becomes null"
  );
  assert.equal(
    Buffer.byteLength(clampUnknownValue(OVER_LONG_TEXT, 0) as string),
    HistoricalParseWorkerLimits.maxLongTextLength,
    "an oversized string truncates to the byte cap"
  );
  assert.equal(
    (clampUnknownValue(makeOverLongArray(), 0) as unknown[]).length,
    HistoricalParseWorkerLimits.maxUnknownArrayItems,
    "an oversized array drops trailing entries"
  );
  assert.equal(
    Object.keys(clampUnknownValue(makeOverWideRecord(), 0) as object).length,
    HistoricalParseWorkerLimits.maxUnknownObjectKeys,
    "an over-wide record drops trailing keys"
  );

  // The depth cap collapses the container the validator would reject wholesale,
  // and leaves every level above it intact.
  let atDepth = clampUnknownValue(makeOverDeepValue(), 0);
  for (
    let depth = 0;
    depth < HistoricalParseWorkerLimits.maxUnknownDepth;
    depth++
  ) {
    atDepth = (atDepth as { nested: unknown }).nested;
  }
  assert.equal(atDepth, TRUNCATED_UNKNOWN_VALUE);

  // Values with no bounded representation collapse to the same marker rather
  // than failing the job — reachable because `input`/`output`/`metadata` are
  // `unknown` and several parser adapters populate them.
  assert.equal(clampUnknownValue(new Date(), 0), TRUNCATED_UNKNOWN_VALUE);
  assert.equal(clampUnknownValue(new Map(), 0), TRUNCATED_UNKNOWN_VALUE);
  assert.equal(clampUnknownValue(undefined, 0), TRUNCATED_UNKNOWN_VALUE);
  assert.equal(
    clampUnknownValue(() => "x", 0),
    TRUNCATED_UNKNOWN_VALUE
  );
  // An object with a null prototype is a plain record and is clamped normally.
  const nullProto = Object.assign(Object.create(null), { a: 1 });
  assert.deepEqual(clampUnknownValue(nullProto, 0), nullProto);
});

test("clamping a record keeps truncated keys distinct and codepoint-clean", () => {
  // Two keys sharing an over-long prefix truncate to the same string. Under
  // `Object.fromEntries` last-wins that silently DROPS a value, so the clamp
  // disambiguates instead.
  const sharedPrefix = "k".repeat(
    HistoricalParseWorkerLimits.maxShortTextLength
  );
  const clamped = clampUnknownValue(
    { [`${sharedPrefix}alpha`]: 1, [`${sharedPrefix}beta`]: 2 },
    0
  ) as Record<string, unknown>;

  assert.equal(
    Object.keys(clamped).length,
    2,
    "a truncation collision must not swallow the second value"
  );
  assert.deepEqual(Object.values(clamped).sort(), [1, 2]);
  for (const key of Object.keys(clamped)) {
    assert.ok(key.length <= HistoricalParseWorkerLimits.maxShortTextLength);
  }

  // Truncating mid-surrogate would leave a lone high surrogate in persisted text.
  const surrogateKey = `${"k".repeat(
    HistoricalParseWorkerLimits.maxShortTextLength - 1
  )}😀tail`;
  const [surrogateClamped] = Object.keys(
    clampUnknownValue({ [surrogateKey]: 1 }, 0) as Record<string, unknown>
  );
  const lastUnit = (surrogateClamped as string).charCodeAt(
    (surrogateClamped as string).length - 1
  );
  assert.ok(
    !(lastUnit >= 0xd8_00 && lastUnit <= 0xdb_ff),
    "clamped key must not end on a lone high surrogate"
  );
});

test("a colliding key stays well-formed at the DISAMBIGUATION boundary too", () => {
  // wongk review: the key clamp guarded its own 8192-unit boundary, but the
  // collision path then re-sliced the same key at 8187 with no guard. A key
  // whose astral character straddles THAT boundary came back as a lone high
  // surrogate — the exact corruption the first guard exists to prevent, one
  // slice later. Both keys below are identical through the first 8192 units, so
  // they collide and the second one takes the disambiguation path.
  const boundary =
    HistoricalParseWorkerLimits.maxShortTextLength -
    CLAMPED_KEY_SUFFIX_HEADROOM;
  const shared = `${"k".repeat(boundary - 1)}😀${"m".repeat(
    HistoricalParseWorkerLimits.maxShortTextLength
  )}`;

  const clamped = clampUnknownValue(
    { [`${shared}a`]: 1, [`${shared}b`]: 2 },
    0
  ) as Record<string, unknown>;

  assert.equal(Object.keys(clamped).length, 2);
  for (const key of Object.keys(clamped)) {
    assert.equal(
      hasLoneSurrogate(key),
      false,
      `clamped key must not contain a lone surrogate: ${key.length} units`
    );
  }
});

/**
 * True when any UTF-16 code unit in `text` is an unpaired surrogate. Written out
 * rather than using `String#isWellFormed`, which this project's `lib` target
 * predates.
 */
function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    const isHigh = unit >= 0xd8_00 && unit <= 0xdb_ff;
    const isLow = unit >= 0xdc_00 && unit <= 0xdf_ff;
    if (isHigh) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc_00 && next <= 0xdf_ff)) {
        return true;
      }
      index++;
    } else if (isLow) {
      return true;
    }
  }
  return false;
}

test("a plain long-text field is measured in the units its schema measures", () => {
  // wongk review: the plain fields are validated by `z.string().max()`, which
  // counts UTF-16 CODE UNITS, but this clamp measured UTF-8 BYTES. A
  // schema-VALID 1.1M-character string of `é` (1.1M code units, 2.2M bytes) was
  // therefore truncated by the producer even though the consumer would have
  // accepted it whole — content destroyed to satisfy a bound that was never
  // going to reject it.
  const accented = "é".repeat(1_100_000);
  assert.ok(
    accented.length <= HistoricalParseWorkerLimits.maxLongTextLength &&
      Buffer.byteLength(accented) >
        HistoricalParseWorkerLimits.maxLongTextLength,
    "fixture must be schema-valid by code units and over the cap by bytes"
  );

  const [clamped] = clampSessionsForWorkerResponse([
    { ...makeSession("accented"), name: accented },
  ]);

  assert.equal(clamped?.name, accented, "a schema-valid field is left alone");

  // The unknown payloads keep their BYTE measure, because that is what
  // `isBoundedUnknownValue` — the predicate the consumer schema enforces —
  // measures. Each clamp matches the bound it has to satisfy.
  const clampedUnknown = clampUnknownValue(accented, 0) as string;
  assert.ok(
    Buffer.byteLength(clampedUnknown) <=
      HistoricalParseWorkerLimits.maxLongTextLength
  );
  assert.notEqual(clampedUnknown, accented);
});

test("every truncation this module performs is marked in the value itself", () => {
  // codex review: a clamp that silently shortens a value and then lets the
  // response be accepted persists partial content as though it were complete,
  // and no downstream consumer can tell the difference. Each shape says so.
  const truncatedText = clampUnknownValue(OVER_LONG_TEXT, 0) as string;
  assert.ok(
    truncatedText.endsWith(TRUNCATED_TEXT_SUFFIX),
    "a shortened string carries the truncation marker"
  );
  assert.equal(
    OVER_LONG_TEXT.startsWith(truncatedText),
    false,
    "a shortened string must not be indistinguishable from a complete prefix"
  );
  assert.ok(
    Buffer.byteLength(truncatedText) <=
      HistoricalParseWorkerLimits.maxLongTextLength,
    "the marker is spent INSIDE the cap, not added on top of it"
  );

  const truncatedArray = clampUnknownValue(makeOverLongArray(), 0) as unknown[];
  assert.equal(
    truncatedArray.at(-1),
    TRUNCATED_UNKNOWN_VALUE,
    "a dropped array tail is marked in the last slot"
  );
  assert.equal(
    truncatedArray.length,
    HistoricalParseWorkerLimits.maxUnknownArrayItems
  );

  const truncatedRecord = clampUnknownValue(makeOverWideRecord(), 0) as Record<
    string,
    unknown
  >;
  assert.equal(
    truncatedRecord[TRUNCATED_UNKNOWN_VALUE],
    TRUNCATED_UNKNOWN_VALUE,
    "a dropped record tail is marked with a reserved entry"
  );
  assert.equal(
    Object.keys(truncatedRecord).length,
    HistoricalParseWorkerLimits.maxUnknownObjectKeys
  );

  // An in-bounds value is untouched: the marker must never appear on complete
  // content, or it stops meaning anything.
  assert.equal(clampUnknownValue("short", 0), "short");
  assert.deepEqual(clampUnknownValue([1, 2, 3], 0), [1, 2, 3]);
});

test("subagent metadata is bounded by entry count, not only by key length", () => {
  // `metadata` is a Zod `z.record`, which has no entry-count cap; nothing else
  // bounds it either (sliceSessionArrays skips it, and the response-wide budget
  // counts array elements, not record entries). Every sibling unknown record is
  // capped at 250, so this one is too.
  const session = makeSession("wide-metadata");
  session.subagents = [
    {
      id: "agent-1",
      name: "Researcher",
      metadata: Object.fromEntries(
        Array.from({ length: 5000 }, (_, index) => [`k${index}`, true])
      ),
    },
  ];

  const [clamped] = clampSessionsForWorkerResponse([session]);

  assert.equal(
    Object.keys(clamped?.subagents?.[0]?.metadata ?? {}).length,
    HistoricalParseWorkerLimits.maxUnknownObjectKeys
  );
});

test("createHistoricalParseWorkerParsedResponse keeps sessions with oversized unknown payloads", () => {
  const response = createHistoricalParseWorkerParsedResponse(
    "historical-parse-1",
    [makeUnboundedPayloadSession("unbounded-payloads")]
  );

  assert.equal(response.type, HistoricalParseWorkerResponseType.Parsed);
});

test("clampSessionsForWorkerResponse leaves already-bounded sessions unchanged", () => {
  const session = makeSession("bounded");
  session.teams = [{ name: "core" }];
  session.compactions = [{ at: "2026-06-07T12:00:00.000Z" }];
  session.toolUses = [
    {
      name: "Read",
      timestamp: "2026-06-07T12:00:00.000Z",
      input: { path: "/workspace/project/a.ts" },
      output: "ok",
    },
  ];

  const [clamped] = clampSessionsForWorkerResponse([session]);

  // Bounded payloads pass through BY REFERENCE, so the common case allocates
  // nothing and no truncation marker can reach a downstream consumer.
  assert.equal(clamped?.teams[0], session.teams[0]);
  assert.equal(clamped?.compactions[0], session.compactions[0]);
  assert.equal(clamped?.toolUses[0], session.toolUses[0]);
});

test("every field the coverage tables mark as bounded is actually clamped", () => {
  // FEA-3701 guard, runtime half: the tables are compile-time declarations, so
  // this proves each declared field is genuinely degraded by the production
  // clamp rather than merely labelled.
  const boundedFields = [
    ...coveredFields("session", SESSION_UNKNOWN_PAYLOAD_COVERAGE),
    ...coveredFields(
      "usageExtras",
      SESSION_USAGE_EXTRAS_UNKNOWN_PAYLOAD_COVERAGE
    ),
    ...coveredFields("toolUse", TOOL_USE_UNKNOWN_PAYLOAD_COVERAGE),
    ...coveredFields("subagent", SUBAGENT_UNKNOWN_PAYLOAD_COVERAGE),
  ].sort();

  // Every table entry that claims coverage has at least one planted
  // out-of-bounds case. A planter may add a `:variant` suffix to cover a second
  // way the same field can go out of bounds.
  const plantedFields = [
    ...new Set(
      Object.keys(UNBOUNDED_FIELD_PLANTERS).map(
        (name) => name.split(":")[0] as string
      )
    ),
  ].sort();
  assert.deepEqual(
    boundedFields,
    plantedFields,
    "a coverage-table field gained or lost bounded status without a planted case here"
  );

  for (const [field, plant] of Object.entries(UNBOUNDED_FIELD_PLANTERS)) {
    const raw = makeSession(`unbounded-${field}`);
    plant(raw);
    assert.equal(
      historicalParseWorkerResponseSchema.safeParse({
        type: HistoricalParseWorkerResponseType.Parsed,
        requestId: "historical-parse-1",
        sessions: [raw],
      }).success,
      false,
      `${field}: the planted value should be rejected before clamping`
    );

    const planted = makeSession(`unbounded-${field}`);
    plant(planted);
    assert.equal(
      historicalParseWorkerResponseSchema.safeParse({
        type: HistoricalParseWorkerResponseType.Parsed,
        requestId: "historical-parse-1",
        sessions: clampSessionsForWorkerResponse([planted]),
      }).success,
      true,
      `${field}: the clamp did not bound this field`
    );
  }
});

/**
 * Owner-qualified names of the fields a coverage table claims the clamp bounds
 * (directly or nested). Qualified because `toolUses` appears on both the session
 * and the subagent table and they are separately clamped.
 */
function coveredFields(owner: string, table: Record<string, string>): string[] {
  return Object.entries(table)
    .filter(([, coverage]) => coverage !== UnknownPayloadCoverage.None)
    .map(([field]) => `${owner}.${field}`);
}

function makeOverLongToolUseInput(): { content: string } {
  return { content: OVER_LONG_TEXT };
}

/**
 * A record chain exactly ONE level past the depth cap: `levels` records wrap a
 * leaf, so the outermost sits at depth 0 and the leaf at depth `levels`. With
 * `levels = maxUnknownDepth + 1` the leaf is the first thing the validator
 * rejects, which pins the exact boundary rather than "very deep nesting".
 */
function makeOverDeepValue(): unknown {
  let value: unknown = "leaf";
  for (let i = 0; i < HistoricalParseWorkerLimits.maxUnknownDepth + 1; i++) {
    value = { nested: value };
  }
  return value;
}

function makeOverLongArray(): number[] {
  return Array.from(
    { length: HistoricalParseWorkerLimits.maxUnknownArrayItems + 1 },
    (_, index) => index
  );
}

function makeOverWideRecord(): Record<string, number> {
  return Object.fromEntries(
    Array.from(
      { length: HistoricalParseWorkerLimits.maxUnknownObjectKeys + 1 },
      (_, index) => [`key-${index}`, index]
    )
  );
}

/**
 * One out-of-bounds value per field the coverage tables claim to bound. Nested
 * markers (`toolUses`, `subagents`, `usageExtras`) are planted through the
 * concrete leaf they delegate to.
 */
const UNBOUNDED_FIELD_PLANTERS: Record<
  string,
  (session: NormalizedSession) => void
> = {
  "session.teams": (session) => {
    session.teams = [makeOverWideRecord()];
  },
  "session.compactions": (session) => {
    session.compactions = [makeOverDeepValue()];
  },
  "session.usageExtras": (session) => {
    session.usageExtras.service_tiers = [makeOverLongArray()];
  },
  "usageExtras.service_tiers": (session) => {
    session.usageExtras.service_tiers = [makeOverWideRecord()];
  },
  "usageExtras.speeds": (session) => {
    session.usageExtras.speeds = [makeOverDeepValue()];
  },
  "usageExtras.inference_geos": (session) => {
    session.usageExtras.inference_geos = [Number.POSITIVE_INFINITY];
  },
  "session.toolUses": (session) => {
    session.toolUses = [
      {
        name: "Write",
        timestamp: "2026-06-07T12:00:00.000Z",
        input: makeOverLongToolUseInput(),
      },
    ];
  },
  "toolUse.input": (session) => {
    session.toolUses = [
      {
        name: "Bash",
        timestamp: "2026-06-07T12:00:00.000Z",
        input: makeOverDeepValue(),
      },
    ];
  },
  "toolUse.output": (session) => {
    session.toolUses = [
      {
        name: "Bash",
        timestamp: "2026-06-07T12:00:00.000Z",
        // A value with no bounded representation, not merely an oversized one.
        output: new Date("2026-06-07T12:00:00.000Z"),
      },
    ];
  },
  "session.subagents": (session) => {
    session.subagents = [
      {
        id: "agent-1",
        name: "Researcher",
        toolUses: [
          {
            name: "Read",
            timestamp: "2026-06-07T12:00:30.000Z",
            input: makeOverLongToolUseInput(),
          },
        ],
      },
    ];
  },
  "subagent.toolUses": (session) => {
    session.subagents = [
      {
        id: "agent-1",
        name: "Researcher",
        toolUses: [
          {
            name: "Bash",
            timestamp: "2026-06-07T12:00:30.000Z",
            output: makeOverLongArray(),
          },
        ],
      },
    ];
  },
  "subagent.metadata": (session) => {
    session.subagents = [
      {
        id: "agent-1",
        name: "Researcher",
        metadata: { elapsedMs: Number.POSITIVE_INFINITY },
      },
    ];
  },
  // `metadata` is the one unknown-carrying field whose outer container is a Zod
  // `z.record`, so its KEYS are bounded by the schema rather than by
  // `isBoundedUnknownValue`. Planted separately from the bad-value case above,
  // which would not exercise the key bound at all.
  "subagent.metadata:key": (session) => {
    session.subagents = [
      {
        id: "agent-1",
        name: "Researcher",
        metadata: { [OVER_LONG_KEY]: 1 },
      },
    ];
  },
  // ISS-5797 second half: the capped LONG-TEXT fields. These are plain
  // `z.string().max(maxLongTextLength)` in the response schema, so an oversized
  // one fails the same `.strict()` response wholesale — the identical defect
  // through a different field. Verified reachable before the fix: an oversized
  // `messages[].text` was rejected with `sessions.0.messages.0.text:too_big`.
  "session.name": (session) => {
    session.name = OVER_LONG_TEXT;
  },
  "session.messages": (session) => {
    session.messages = [
      {
        role: "assistant",
        text: OVER_LONG_TEXT,
        timestamp: "2026-06-07T12:00:00.000Z",
      },
    ];
  },
  "session.apiErrors": (session) => {
    session.apiErrors = [
      { message: OVER_LONG_TEXT, timestamp: "2026-06-07T12:00:00.000Z" },
    ];
  },
  "session.toolResultErrors": (session) => {
    session.toolResultErrors = [
      { content: OVER_LONG_TEXT, timestamp: "2026-06-07T12:00:00.000Z" },
    ];
  },
  "session.plans": (session) => {
    session.plans = [
      { content: OVER_LONG_TEXT, timestamp: "2026-06-07T12:00:00.000Z" },
    ];
  },
  "session.hooks": (session) => {
    session.hooks = [
      {
        name: "PreToolUse",
        event: "PreToolUse",
        command: OVER_LONG_TEXT,
        succeeded: true,
        timestamp: "2026-06-07T12:00:00.000Z",
      },
    ];
  },
  "session.prLinks": (session) => {
    session.prLinks = [{ number: "1", url: OVER_LONG_TEXT }];
  },
  "session.artifacts": (session) => {
    session.artifacts = {
      ...session.artifacts,
      prs: [{ number: "1", url: OVER_LONG_TEXT }],
    };
  },
  "session.slashCommands": (session) => {
    session.slashCommands = [
      {
        name: "design",
        timestamp: "2026-06-07T12:00:00.000Z",
        definitionSnapshot: makeOverLongDefinitionSnapshot(),
      },
    ];
  },
  "session.skills": (session) => {
    session.skills = [
      {
        name: "live-vqa-harness",
        timestamp: "2026-06-07T12:00:00.000Z",
        definitionSnapshot: makeOverLongDefinitionSnapshot(),
      },
    ];
  },
  "toolUse.definitionSnapshot": (session) => {
    session.toolUses = [
      {
        name: "Skill",
        timestamp: "2026-06-07T12:00:00.000Z",
        definitionSnapshot: makeOverLongDefinitionSnapshot(),
      },
    ];
  },
  "subagent.task": (session) => {
    session.subagents = [
      { id: "agent-1", name: "Researcher", task: OVER_LONG_TEXT },
    ];
  },
  "subagent.definitionSnapshot": (session) => {
    session.subagents = [
      {
        id: "agent-1",
        name: "Researcher",
        definitionSnapshot: makeOverLongDefinitionSnapshot(),
      },
    ];
  },
};

function makeOverLongDefinitionSnapshot(): NormalizedDefinitionSnapshot {
  return {
    kind: NormalizedDefinitionKind.Skill,
    rawName: "big",
    normalizedName: "big",
    content: OVER_LONG_TEXT,
    capturedAt: "2026-06-07T12:00:00.000Z",
  };
}

function makeUnboundedPayloadSession(sessionId: string): NormalizedSession {
  const session = makeSession(sessionId);
  session.toolUses = [
    {
      name: "Write",
      timestamp: "2026-06-07T12:00:00.000Z",
      input: makeOverLongToolUseInput(),
    },
    {
      name: "Bash",
      timestamp: "2026-06-07T12:00:01.000Z",
      input: makeOverDeepValue(),
      output: makeOverLongArray(),
    },
    {
      name: "Read",
      timestamp: "2026-06-07T12:00:02.000Z",
      input: makeOverWideRecord(),
    },
  ];
  session.subagents = [
    {
      id: "agent-1",
      name: "Researcher",
      toolUses: [
        {
          name: "Read",
          timestamp: "2026-06-07T12:00:30.000Z",
          input: makeOverLongToolUseInput(),
        },
      ],
      metadata: { elapsedMs: Number.POSITIVE_INFINITY },
    },
  ];
  return session;
}
