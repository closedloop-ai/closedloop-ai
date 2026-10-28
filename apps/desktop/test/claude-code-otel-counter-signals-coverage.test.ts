/**
 * ISS-8730 coverage for `claude-code-otel-counter-signals.ts` — the four
 * builders that turn a decoded OTLP attribute bag plus a raw metric data point
 * / log record into a `ClaudeCodeOtelSideTableSignal`, or refuse the point.
 *
 * These are pure functions (no DB, no receiver), so every case here calls the
 * builder directly with an already-decoded `attributes`/`dataPoint` shape —
 * the same shape `claude-code-otel-normalizer.ts` hands them after OTLP
 * decode. This pins behavior at the parse boundary itself: what each builder
 * requires, what it treats as absent-vs-invalid, and where two callers
 * (`counterValueOf` for the two whole-count metrics, `durationValueOf` for
 * `active_time`) deliberately disagree on which oneof member wins.
 *
 * Every refusal case pins CURRENT behavior. None of these are bugs to fix
 * here — see the doc comments on the source functions for why each refusal
 * exists (a plausible-but-wrong value is worse than an absent row).
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { ClaudeCodeOtelAttributeKey } from "../src/main/otel/claude-code-otel-attributes.js";
import {
  activeTimeSignalFrom,
  linesOfCodeSignalFrom,
  sessionStartSignalFrom,
  toolResultSignalFrom,
} from "../src/main/otel/claude-code-otel-counter-signals.js";
import {
  ClaudeCodeActivityType,
  ClaudeCodeOtelSignalType,
} from "../src/main/otel/claude-code-otel-signal-contract.js";
import { unixNano } from "./helpers/claude-code-otel-fixtures.js";

const SESSION_ID = "otel-counter-signal-session";
const MODEL = "claude-sonnet-4-5";
const OBSERVED_AT = "2026-06-18T19:00:31.000Z";
const TOOL_RESULT_AT = "2026-06-18T19:00:35.000Z";
const STAMPED_EVENT_AT = "2026-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// linesOfCodeSignalFrom
// ---------------------------------------------------------------------------

test("linesOfCodeSignalFrom: a well-formed delta point becomes a LinesOfCode signal", () => {
  const signal = linesOfCodeSignalFrom(
    {
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.Model]: MODEL,
      [ClaudeCodeOtelAttributeKey.MeasurementType]: "added",
    },
    { timeUnixNano: unixNano(OBSERVED_AT), asInt: 120 }
  );
  assert.deepEqual(signal, {
    type: ClaudeCodeOtelSignalType.LinesOfCode,
    sessionId: SESSION_ID,
    model: MODEL,
    observedAt: OBSERVED_AT,
    changeType: "added",
    lineCount: 120,
  });
});

test("linesOfCodeSignalFrom: a missing sessionId refuses the point", () => {
  const signal = linesOfCodeSignalFrom(
    {
      [ClaudeCodeOtelAttributeKey.Model]: MODEL,
      [ClaudeCodeOtelAttributeKey.MeasurementType]: "added",
    },
    { timeUnixNano: unixNano(OBSERVED_AT), asInt: 120 }
  );
  assert.equal(signal, null);
});

test("linesOfCodeSignalFrom: a missing model refuses the point", () => {
  const signal = linesOfCodeSignalFrom(
    {
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.MeasurementType]: "added",
    },
    { timeUnixNano: unixNano(OBSERVED_AT), asInt: 120 }
  );
  assert.equal(signal, null);
});

test("linesOfCodeSignalFrom: a missing change_type is refused, not defaulted to 'added'", () => {
  const signal = linesOfCodeSignalFrom(
    {
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.Model]: MODEL,
    },
    { timeUnixNano: unixNano(OBSERVED_AT), asInt: 120 }
  );
  assert.equal(signal, null);
});

test("linesOfCodeSignalFrom: a zero timeUnixNano refuses the point rather than dating it to the epoch", () => {
  const signal = linesOfCodeSignalFrom(
    {
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.Model]: MODEL,
      [ClaudeCodeOtelAttributeKey.MeasurementType]: "added",
    },
    { timeUnixNano: "0", asInt: 120 }
  );
  assert.equal(signal, null);
});

test("linesOfCodeSignalFrom: a fractional line count is refused, not rounded", () => {
  const signal = linesOfCodeSignalFrom(
    {
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.Model]: MODEL,
      [ClaudeCodeOtelAttributeKey.MeasurementType]: "added",
    },
    { timeUnixNano: unixNano(OBSERVED_AT), asDouble: 1.5 }
  );
  assert.equal(signal, null);
});

test("linesOfCodeSignalFrom: a negative line count is refused", () => {
  const signal = linesOfCodeSignalFrom(
    {
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.Model]: MODEL,
      [ClaudeCodeOtelAttributeKey.MeasurementType]: "added",
    },
    { timeUnixNano: unixNano(OBSERVED_AT), asInt: -5 }
  );
  assert.equal(signal, null);
});

test("linesOfCodeSignalFrom: a line count carried as a numeric STRING is still read", () => {
  // Long-encoded proto fields decode to strings (`longs: "String"`), so the
  // oneof reader must accept a numeric string, not only a JS number.
  const signal = linesOfCodeSignalFrom(
    {
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.Model]: MODEL,
      [ClaudeCodeOtelAttributeKey.MeasurementType]: "added",
    },
    { timeUnixNano: unixNano(OBSERVED_AT), asInt: "120" }
  );
  assert.equal(signal?.type, ClaudeCodeOtelSignalType.LinesOfCode);
  assert.equal(
    signal?.type === ClaudeCodeOtelSignalType.LinesOfCode
      ? signal.lineCount
      : undefined,
    120
  );
});

test("linesOfCodeSignalFrom: asInt takes precedence over asDouble when a point carries both", () => {
  // counterValueOf reads asInt FIRST — the opposite order durationValueOf
  // uses for active-time seconds below. Pinning both orders separately so a
  // refactor that accidentally unifies them is caught on whichever side it
  // silently flips.
  const signal = linesOfCodeSignalFrom(
    {
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.Model]: MODEL,
      [ClaudeCodeOtelAttributeKey.MeasurementType]: "added",
    },
    { timeUnixNano: unixNano(OBSERVED_AT), asInt: 42, asDouble: 999 }
  );
  assert.equal(
    signal?.type === ClaudeCodeOtelSignalType.LinesOfCode
      ? signal.lineCount
      : undefined,
    42
  );
});

test("linesOfCodeSignalFrom: a point with neither asInt nor asDouble is refused", () => {
  const signal = linesOfCodeSignalFrom(
    {
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.Model]: MODEL,
      [ClaudeCodeOtelAttributeKey.MeasurementType]: "added",
    },
    { timeUnixNano: unixNano(OBSERVED_AT) }
  );
  assert.equal(signal, null);
});

// ---------------------------------------------------------------------------
// sessionStartSignalFrom
// ---------------------------------------------------------------------------

test("sessionStartSignalFrom: a well-formed delta point becomes a SessionStart signal", () => {
  const signal = sessionStartSignalFrom(
    {
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.StartType]: "resume",
    },
    { timeUnixNano: unixNano(OBSERVED_AT), asInt: 1 }
  );
  assert.deepEqual(signal, {
    type: ClaudeCodeOtelSignalType.SessionStart,
    sessionId: SESSION_ID,
    observedAt: OBSERVED_AT,
    startType: "resume",
    sessionCount: 1,
  });
});

test("sessionStartSignalFrom: a missing start_type is refused, not defaulted to 'fresh'", () => {
  const signal = sessionStartSignalFrom(
    { [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID },
    { timeUnixNano: unixNano(OBSERVED_AT), asInt: 1 }
  );
  assert.equal(signal, null);
});

test("sessionStartSignalFrom: a missing sessionId refuses the point", () => {
  const signal = sessionStartSignalFrom(
    { [ClaudeCodeOtelAttributeKey.StartType]: "resume" },
    { timeUnixNano: unixNano(OBSERVED_AT), asInt: 1 }
  );
  assert.equal(signal, null);
});

test("sessionStartSignalFrom: a non-integer session count is refused", () => {
  const signal = sessionStartSignalFrom(
    {
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.StartType]: "resume",
    },
    { timeUnixNano: unixNano(OBSERVED_AT), asDouble: 1.5 }
  );
  assert.equal(signal, null);
});

test("sessionStartSignalFrom: a session count carried as a numeric STRING is still read", () => {
  const signal = sessionStartSignalFrom(
    {
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.StartType]: "resume",
    },
    { timeUnixNano: unixNano(OBSERVED_AT), asInt: "3" }
  );
  assert.equal(
    signal?.type === ClaudeCodeOtelSignalType.SessionStart
      ? signal.sessionCount
      : undefined,
    3
  );
});

// ---------------------------------------------------------------------------
// toolResultSignalFrom
// ---------------------------------------------------------------------------

function toolResultAttributes(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
    [ClaudeCodeOtelAttributeKey.ToolName]: "Bash",
    ...overrides,
  };
}

test("toolResultSignalFrom: a well-formed record with every optional detail becomes a ToolResult signal", () => {
  const signal = toolResultSignalFrom(
    toolResultAttributes({
      [ClaudeCodeOtelAttributeKey.ToolUseId]: "toolu_01AAA",
      [ClaudeCodeOtelAttributeKey.Success]: "false",
      [ClaudeCodeOtelAttributeKey.ErrorType]: "Error:ENOENT",
      [ClaudeCodeOtelAttributeKey.ToolInputSizeBytes]: 512,
      [ClaudeCodeOtelAttributeKey.ToolResultSizeBytes]: 4096,
      [ClaudeCodeOtelAttributeKey.McpServerScope]: "project",
    }),
    { timeUnixNano: unixNano(TOOL_RESULT_AT) }
  );
  assert.deepEqual(signal, {
    type: ClaudeCodeOtelSignalType.ToolResult,
    sessionId: SESSION_ID,
    toolName: "Bash",
    observedAt: TOOL_RESULT_AT,
    toolUseId: "toolu_01AAA",
    success: false,
    errorType: "Error:ENOENT",
    toolInputSizeBytes: 512,
    toolResultSizeBytes: 4096,
    mcpServerScope: "project",
  });
});

test("toolResultSignalFrom: a missing toolName refuses the record", () => {
  const signal = toolResultSignalFrom(
    { [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID },
    { timeUnixNano: unixNano(TOOL_RESULT_AT) }
  );
  assert.equal(signal, null);
});

test("toolResultSignalFrom: a missing sessionId refuses the record", () => {
  const signal = toolResultSignalFrom(
    { [ClaudeCodeOtelAttributeKey.ToolName]: "Bash" },
    { timeUnixNano: unixNano(TOOL_RESULT_AT) }
  );
  assert.equal(signal, null);
});

test("toolResultSignalFrom: every optional attribute absent still produces a signal with no optional keys", () => {
  // withoutUndefinedValues strips a key rather than storing it holding
  // `undefined` — a producer that names none of these attributes must not
  // materialize them, e.g. as a NULL-holding `success` key that would read
  // as "reported unsuccessful".
  const signal = toolResultSignalFrom(toolResultAttributes(), {
    timeUnixNano: unixNano(TOOL_RESULT_AT),
  });
  assert.ok(signal !== null);
  assert.deepEqual(Object.keys(signal).sort(), [
    "observedAt",
    "sessionId",
    "toolName",
    "type",
  ]);
});

test("toolResultSignalFrom: an unrecognized success spelling refuses the WHOLE record", () => {
  const signal = toolResultSignalFrom(
    toolResultAttributes({ [ClaudeCodeOtelAttributeKey.Success]: "maybe" }),
    { timeUnixNano: unixNano(TOOL_RESULT_AT) }
  );
  assert.equal(signal, null);
});

test("toolResultSignalFrom: a fractional tool_input_size_bytes refuses the whole record", () => {
  const signal = toolResultSignalFrom(
    toolResultAttributes({
      [ClaudeCodeOtelAttributeKey.ToolInputSizeBytes]: 1.5,
    }),
    { timeUnixNano: unixNano(TOOL_RESULT_AT) }
  );
  assert.equal(signal, null);
});

test("toolResultSignalFrom: event.timestamp with an explicit zone wins over the record's timeUnixNano", () => {
  const signal = toolResultSignalFrom(
    toolResultAttributes({
      [ClaudeCodeOtelAttributeKey.EventTimestamp]: STAMPED_EVENT_AT,
    }),
    { timeUnixNano: unixNano(TOOL_RESULT_AT) }
  );
  assert.equal(
    signal?.type === ClaudeCodeOtelSignalType.ToolResult
      ? signal.observedAt
      : undefined,
    STAMPED_EVENT_AT
  );
});

test("toolResultSignalFrom: a zone-less event.timestamp falls back to the record's timeUnixNano", () => {
  const signal = toolResultSignalFrom(
    toolResultAttributes({
      // No trailing Z / offset — ambiguous local time, refused as a source.
      [ClaudeCodeOtelAttributeKey.EventTimestamp]: "2026-01-01T00:00:00.000",
    }),
    { timeUnixNano: unixNano(TOOL_RESULT_AT) }
  );
  assert.equal(
    signal?.type === ClaudeCodeOtelSignalType.ToolResult
      ? signal.observedAt
      : undefined,
    TOOL_RESULT_AT
  );
});

// ---------------------------------------------------------------------------
// activeTimeSignalFrom
// ---------------------------------------------------------------------------

test("activeTimeSignalFrom: a well-formed user delta point becomes an ActiveTime signal", () => {
  const signal = activeTimeSignalFrom(
    {
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.MeasurementType]: ClaudeCodeActivityType.User,
    },
    { timeUnixNano: unixNano(OBSERVED_AT), asInt: 12 }
  );
  assert.deepEqual(signal, {
    type: ClaudeCodeOtelSignalType.ActiveTime,
    sessionId: SESSION_ID,
    observedAt: OBSERVED_AT,
    activityType: ClaudeCodeActivityType.User,
    seconds: 12,
  });
});

test("activeTimeSignalFrom: an unpublished activity type is refused rather than stored as a third bucket", () => {
  const signal = activeTimeSignalFrom(
    {
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.MeasurementType]: "background",
    },
    { timeUnixNano: unixNano(OBSERVED_AT), asInt: 9 }
  );
  assert.equal(signal, null);
});

test("activeTimeSignalFrom: a missing type attribute refuses the point", () => {
  const signal = activeTimeSignalFrom(
    { [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID },
    { timeUnixNano: unixNano(OBSERVED_AT), asInt: 9 }
  );
  assert.equal(signal, null);
});

test("activeTimeSignalFrom: a sub-second duration is accepted, unlike the whole-count counters", () => {
  const signal = activeTimeSignalFrom(
    {
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.MeasurementType]: ClaudeCodeActivityType.Cli,
    },
    { timeUnixNano: unixNano(OBSERVED_AT), asDouble: 0.25 }
  );
  assert.equal(
    signal?.type === ClaudeCodeOtelSignalType.ActiveTime
      ? signal.seconds
      : undefined,
    0.25
  );
});

test("activeTimeSignalFrom: a negative duration is refused", () => {
  const signal = activeTimeSignalFrom(
    {
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.MeasurementType]: ClaudeCodeActivityType.Cli,
    },
    { timeUnixNano: unixNano(OBSERVED_AT), asDouble: -1 }
  );
  assert.equal(signal, null);
});

test("activeTimeSignalFrom: a duration exactly at Number.MAX_SAFE_INTEGER is accepted", () => {
  const signal = activeTimeSignalFrom(
    {
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.MeasurementType]: ClaudeCodeActivityType.Cli,
    },
    {
      timeUnixNano: unixNano(OBSERVED_AT),
      asDouble: Number.MAX_SAFE_INTEGER,
    }
  );
  assert.equal(
    signal?.type === ClaudeCodeOtelSignalType.ActiveTime
      ? signal.seconds
      : undefined,
    Number.MAX_SAFE_INTEGER
  );
});

test("activeTimeSignalFrom: a duration one past Number.MAX_SAFE_INTEGER is refused", () => {
  // Bounded so two such points summed upstream cannot overflow to Infinity
  // past the point where the persistence boundary's own refusal would apply.
  const signal = activeTimeSignalFrom(
    {
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.MeasurementType]: ClaudeCodeActivityType.Cli,
    },
    {
      timeUnixNano: unixNano(OBSERVED_AT),
      asDouble: Number.MAX_SAFE_INTEGER + 1,
    }
  );
  assert.equal(signal, null);
});

test("activeTimeSignalFrom: asDouble takes precedence over asInt when a point carries both", () => {
  // durationValueOf reads asDouble FIRST — the opposite order counterValueOf
  // uses for the whole-count metrics above.
  const signal = activeTimeSignalFrom(
    {
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.MeasurementType]: ClaudeCodeActivityType.Cli,
    },
    { timeUnixNano: unixNano(OBSERVED_AT), asDouble: 5, asInt: 999 }
  );
  assert.equal(
    signal?.type === ClaudeCodeOtelSignalType.ActiveTime
      ? signal.seconds
      : undefined,
    5
  );
});
