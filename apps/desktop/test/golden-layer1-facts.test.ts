/**
 * ISS-4499 unit tests for the Layer-1 fact machinery (golden-layer1-facts.ts):
 * new fact builders, the harness-conditional required-facts policy, the strict
 * new-block Zod validation, and seeded-drift fail-closed coverage proving the
 * wiring cannot silently skip a field. Synthetic fixtures only — no corpus
 * reads.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/main/collectors/types.js";
import {
  cacheWriteTtlFacts,
  checkFact,
  computeEndedOnUnrecoveredError,
  type DossierExpectations,
  type Layer1Fact,
  missingRequiredFacts,
  PARSE_QUALITY_FACTS,
  type ParsedSessionView,
  SESSION_CLASSIFICATION_FACTS,
  toolResultFacts,
  USAGE_EXTRAS_FACTS,
  validateNewExpectationBlocks,
} from "./golden/golden-layer1-facts.js";

const SESSION_ID = "test-session";

const ENTRYPOINT_KEY = /session\.entrypoint/;
const PERMISSION_MODE_KEY = /session\.permission_mode/;
const ENDED_ON_ERROR_KEY = /session\.ended_on_unrecovered_error/;
const SESSION_ERROR_RECORDS_KEY = /tool_results\.session_error_records/;
const MALFORMED_LINES_KEY = /parse_quality\.malformed_lines/;
const MALFORMED_RATE_LIMITS_KEY = /parse_quality\.malformed_rate_limits/;
const TTL_FIVE_M_KEY = /cache_write_ttl\.five_m/;
const TTL_ONE_H_KEY = /cache_write_ttl\.one_h/;
const REASONING_KEY = /usage_extras\.reasoning_output_tokens/;
const TTL_CONSERVATION_KEY = /cache_write_ttl conservation/;

function failuresFor(
  facts: Layer1Fact[],
  exp: DossierExpectations,
  view: ParsedSessionView
): string[] {
  const diagnostics: string[] = [];
  const failures: string[] = [];
  for (const fact of facts) {
    checkFact(SESSION_ID, fact, exp, view, diagnostics, failures);
  }
  return failures;
}

function baseExpectations(): DossierExpectations {
  return {
    harness: Harness.Claude,
    session: {
      status: "completed",
      billing_mode: "unknown",
      primary_model: "claude-opus-4",
      models_used: ["claude-opus-4"],
      lifecycle: {
        fresh: true,
        resumed: false,
        forked: false,
        compacted: false,
        interrupted: false,
      },
      entrypoint: "cli",
      permission_mode: "default",
      ended_on_unrecovered_error: false,
    },
    turns: { total: 4, user: 1, assistant: 2, tool_result: 1 },
    tokens_by_model: {
      "claude-opus-4": {
        input: 10,
        output: 20,
        cache_read: 5,
        cache_write: 100,
        cache_write_ttl: { five_m: 40, one_h: 60 },
      },
    },
    cost: { total: 0, metered_total: 0 },
    subagents: { count: 0, attributed: [] },
    activity: {
      tools: [{ name: "Bash", count: 2 }],
      commands: [],
      thinking_blocks: 0,
    },
    pr_lifecycle: { observed: false },
    tool_results: {
      total: 2,
      errors: 1,
      session_error_records: 1,
      by_tool: [{ name: "Bash", with_output: 2, errors: 1 }],
    },
    parse_quality: {
      total_lines: 10,
      malformed_lines: 0,
      truncated_final_line: false,
      unknown_records: 0,
      orphaned_tool_outputs: 0,
      ambiguous_tool_outputs: 0,
    },
    usage_extras: { reasoning_output_tokens: 0, web_search_requests: 0 },
    notes: "synthetic fixture",
  };
}

function baseView(): ParsedSessionView {
  return {
    entrypoint: "cli",
    permissionMode: "default",
    endedOnUnrecoveredErrorComputed: false,
    toolUses: [
      { name: "Bash", subagentId: null, output: "ok", isError: false },
      { name: "Bash", subagentId: null, output: "boom", isError: true },
      // Child tool use — must be excluded by the parent-only filter even
      // though it has an output and an error flag.
      { name: "Bash", subagentId: "child-1", output: "child", isError: true },
    ],
    toolResultErrors: [{ message: "boom" }],
    parseQuality: {
      totalLines: 10,
      malformedLines: 0,
      truncatedFinalLine: false,
    },
    tokensByModel: {
      "claude-opus-4": {
        input: 10,
        output: 20,
        cacheRead: 5,
        cacheWrite: 100,
        cacheWriteTtl: { fiveM: 40, oneH: 60 },
      },
    },
    capturedUsageExtras: { reasoningOutputTokens: 0, webSearchRequests: 0 },
  };
}

test("session classification facts pass on a matching view", () => {
  assert.deepEqual(
    failuresFor(SESSION_CLASSIFICATION_FACTS, baseExpectations(), baseView()),
    []
  );
});

test("seeded drift: changed entrypoint fails citing session.entrypoint", () => {
  const view = { ...baseView(), entrypoint: "sdk" };
  const failures = failuresFor(
    SESSION_CLASSIFICATION_FACTS,
    baseExpectations(),
    view
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], ENTRYPOINT_KEY);
});

test("permission_mode: explicit null oracle asserts against null parser value", () => {
  const exp = baseExpectations();
  exp.session = { ...exp.session, permission_mode: null };
  const view = { ...baseView(), permissionMode: null };
  assert.deepEqual(failuresFor(SESSION_CLASSIFICATION_FACTS, exp, view), []);
  // Drift: parser reports a mode where the oracle pinned null.
  const drifted = { ...baseView(), permissionMode: "default" };
  const failures = failuresFor(SESSION_CLASSIFICATION_FACTS, exp, drifted);
  assert.equal(failures.length, 1);
  assert.match(failures[0], PERMISSION_MODE_KEY);
});

test("seeded drift: flipped failed-run signal fails citing session.ended_on_unrecovered_error", () => {
  const view = { ...baseView(), endedOnUnrecoveredErrorComputed: true };
  const failures = failuresFor(
    SESSION_CLASSIFICATION_FACTS,
    baseExpectations(),
    view
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], ENDED_ON_ERROR_KEY);
});

test("computeEndedOnUnrecoveredError preserves a parser-set flag (full OR-formula)", () => {
  // Flag set, derivation says false (assistant after the error) — the flag wins.
  assert.equal(
    computeEndedOnUnrecoveredError({
      endedOnUnrecoveredError: true,
      apiErrors: [{ timestamp: "2026-01-01T00:00:00Z" }],
      messages: [
        { role: "assistant", timestamp: "2026-01-01T01:00:00Z", text: "ok" },
      ],
    }),
    true
  );
});

test("computeEndedOnUnrecoveredError derives when no flag is set", () => {
  // Error at/after the last assistant message → unrecovered.
  assert.equal(
    computeEndedOnUnrecoveredError({
      apiErrors: [{ timestamp: "2026-01-01T02:00:00Z" }],
      messages: [
        { role: "assistant", timestamp: "2026-01-01T01:00:00Z", text: "ok" },
      ],
    }),
    true
  );
  // Assistant recovered after the error → not a failure.
  assert.equal(
    computeEndedOnUnrecoveredError({
      apiErrors: [{ timestamp: "2026-01-01T00:30:00Z" }],
      messages: [
        { role: "assistant", timestamp: "2026-01-01T01:00:00Z", text: "ok" },
      ],
    }),
    false
  );
  // No errors at all → false.
  assert.equal(
    computeEndedOnUnrecoveredError({ apiErrors: [], messages: [] }),
    false
  );
});

test("tool_results facts pass on a matching view and filter to the parent transcript", () => {
  const exp = baseExpectations();
  assert.deepEqual(failuresFor(toolResultFacts(exp), exp, baseView()), []);
});

test("seeded drift: dropped tool output fails citing tool_results.total", () => {
  const exp = baseExpectations();
  const view = baseView();
  view.toolUses = [
    { name: "Bash", subagentId: null }, // output key gone
    { name: "Bash", subagentId: null, output: "boom", isError: true },
    { name: "Bash", subagentId: "child-1", output: "child", isError: true },
  ];
  const failures = failuresFor(toolResultFacts(exp), exp, view);
  assert.ok(failures.some((f) => f.includes("tool_results.total")));
  assert.ok(
    failures.some((f) => f.includes("tool_results.by_tool[Bash].with_output"))
  );
});

test("seeded drift: flipped isError fails citing tool_results.errors", () => {
  const exp = baseExpectations();
  const view = baseView();
  view.toolUses = [
    { name: "Bash", subagentId: null, output: "ok", isError: false },
    { name: "Bash", subagentId: null, output: "boom", isError: false },
    { name: "Bash", subagentId: "child-1", output: "child", isError: true },
  ];
  const failures = failuresFor(toolResultFacts(exp), exp, view);
  assert.ok(failures.some((f) => f.includes("tool_results.errors")));
  assert.ok(
    failures.some((f) => f.includes("tool_results.by_tool[Bash].errors"))
  );
});

test("seeded drift: session_error_records length mismatch fails", () => {
  const exp = baseExpectations();
  const view = { ...baseView(), toolResultErrors: [] };
  const failures = failuresFor(toolResultFacts(exp), exp, view);
  assert.equal(failures.length, 1);
  assert.match(failures[0], SESSION_ERROR_RECORDS_KEY);
});

test("parse_quality facts: parser-omitted optional counters read as 0", () => {
  // View's parseQuality omits unknownRecords/orphaned/ambiguous — absent ≡ 0.
  assert.deepEqual(
    failuresFor(PARSE_QUALITY_FACTS, baseExpectations(), baseView()),
    []
  );
});

test("seeded drift: changed malformed_lines fails citing parse_quality.malformed_lines", () => {
  const view = baseView();
  view.parseQuality = { ...view.parseQuality, malformedLines: 3 };
  const failures = failuresFor(PARSE_QUALITY_FACTS, baseExpectations(), view);
  assert.equal(failures.length, 1);
  assert.match(failures[0], MALFORMED_LINES_KEY);
});

test("codex malformed_rate_limits asserts when the oracle pins it", () => {
  const exp = baseExpectations();
  exp.parse_quality = { ...exp.parse_quality, malformed_rate_limits: 0 };
  assert.deepEqual(failuresFor(PARSE_QUALITY_FACTS, exp, baseView()), []);
  const view = baseView();
  view.parseQuality = { ...view.parseQuality, malformedRateLimits: 2 };
  const failures = failuresFor(PARSE_QUALITY_FACTS, exp, view);
  assert.equal(failures.length, 1);
  assert.match(failures[0], MALFORMED_RATE_LIMITS_KEY);
});

test("cache_write_ttl facts pass on a matching split", () => {
  const exp = baseExpectations();
  assert.deepEqual(failuresFor(cacheWriteTtlFacts(exp), exp, baseView()), []);
});

test("populated cache_write_ttl oracle vs absent parser split FAILS (never skips)", () => {
  const exp = baseExpectations();
  const view = baseView();
  view.tokensByModel = {
    "claude-opus-4": { input: 10, output: 20, cacheRead: 5, cacheWrite: 100 },
  };
  const failures = failuresFor(cacheWriteTtlFacts(exp), exp, view);
  assert.equal(failures.length, 2);
  assert.match(failures[0], TTL_FIVE_M_KEY);
  assert.match(failures[1], TTL_ONE_H_KEY);
});

test("seeded drift: altered TTL split fails citing the changed leg", () => {
  const exp = baseExpectations();
  const view = baseView();
  view.tokensByModel = {
    "claude-opus-4": {
      input: 10,
      output: 20,
      cacheRead: 5,
      cacheWrite: 100,
      cacheWriteTtl: { fiveM: 100, oneH: 0 },
    },
  };
  const failures = failuresFor(cacheWriteTtlFacts(exp), exp, view);
  assert.equal(failures.length, 2);
  assert.ok(failures.every((f) => f.includes("cache_write_ttl")));
});

test("usage_extras facts read the pre-normalize capture; absent capture reads as 0", () => {
  const exp = baseExpectations();
  assert.deepEqual(failuresFor(USAGE_EXTRAS_FACTS, exp, baseView()), []);
  const noCapture = { ...baseView(), capturedUsageExtras: undefined };
  assert.deepEqual(failuresFor(USAGE_EXTRAS_FACTS, exp, noCapture), []);
});

test("seeded drift: changed reasoning_output_tokens fails citing usage_extras", () => {
  const exp = baseExpectations();
  exp.usage_extras = { reasoning_output_tokens: 500, web_search_requests: 0 };
  const view = baseView();
  view.capturedUsageExtras = {
    reasoningOutputTokens: 400,
    webSearchRequests: 0,
  };
  const failures = failuresFor(USAGE_EXTRAS_FACTS, exp, view);
  assert.equal(failures.length, 1);
  assert.match(failures[0], REASONING_KEY);
});

test("missingRequiredFacts: complete claude dossier passes with hasNormalized", () => {
  assert.deepEqual(
    missingRequiredFacts(baseExpectations(), {
      hasNormalized: true,
      harness: Harness.Claude,
    }),
    []
  );
});

test("missingRequiredFacts: new-block requirements exempt when normalized is null", () => {
  const exp = baseExpectations();
  exp.session = {
    status: "completed",
    billing_mode: "unknown",
    primary_model: null,
    models_used: [],
    lifecycle: {
      fresh: true,
      resumed: false,
      forked: false,
      compacted: false,
      interrupted: false,
    },
  };
  exp.tool_results = undefined;
  exp.parse_quality = undefined;
  exp.usage_extras = undefined;
  assert.deepEqual(
    missingRequiredFacts(exp, {
      hasNormalized: false,
      harness: Harness.OpenCode,
    }),
    []
  );
  // The SAME dossier with a normalized session must flag every new block.
  const missing = missingRequiredFacts(exp, {
    hasNormalized: true,
    harness: Harness.OpenCode,
  });
  assert.ok(missing.includes("session.entrypoint"));
  assert.ok(missing.includes("session.permission_mode (key present)"));
  assert.ok(missing.includes("session.ended_on_unrecovered_error"));
  assert.ok(missing.includes("tool_results block"));
  assert.ok(missing.includes("usage_extras block"));
});

test("missingRequiredFacts: permission_mode demands the key, accepts explicit null", () => {
  const exp = baseExpectations();
  exp.session = { ...exp.session, permission_mode: null };
  assert.deepEqual(
    missingRequiredFacts(exp, { hasNormalized: true, harness: Harness.Claude }),
    []
  );
  const withoutKey = baseExpectations();
  const { permission_mode: _dropped, ...sessionRest } =
    withoutKey.session ?? {};
  withoutKey.session = sessionRest;
  const missing = missingRequiredFacts(withoutKey, {
    hasNormalized: true,
    harness: Harness.Claude,
  });
  assert.ok(missing.includes("session.permission_mode (key present)"));
});

test("missingRequiredFacts: codex requires parse_quality.malformed_rate_limits", () => {
  const exp = baseExpectations();
  exp.harness = Harness.Codex;
  exp.session = { ...exp.session, permission_mode: null };
  exp.tokens_by_model = { "gpt-5.2-codex": { input: 1, output: 2 } };
  const missing = missingRequiredFacts(exp, {
    hasNormalized: true,
    harness: Harness.Codex,
  });
  assert.deepEqual(missing, ["parse_quality.malformed_rate_limits"]);
  exp.parse_quality = { ...exp.parse_quality, malformed_rate_limits: 0 };
  assert.deepEqual(
    missingRequiredFacts(exp, { hasNormalized: true, harness: Harness.Codex }),
    []
  );
});

test("missingRequiredFacts: claude TTL conservation five_m+one_h==cache_write", () => {
  const exp = baseExpectations();
  exp.tokens_by_model = {
    "claude-opus-4": {
      input: 10,
      output: 20,
      cache_write: 100,
      cache_write_ttl: { five_m: 40, one_h: 50 },
    },
  };
  const missing = missingRequiredFacts(exp, {
    hasNormalized: true,
    harness: Harness.Claude,
  });
  assert.equal(missing.length, 1);
  assert.match(missing[0], TTL_CONSERVATION_KEY);
});

test("missingRequiredFacts: claude cache_write>0 without a TTL block is flagged", () => {
  const exp = baseExpectations();
  exp.tokens_by_model = {
    "claude-opus-4": { input: 10, output: 20, cache_write: 100 },
  };
  const missing = missingRequiredFacts(exp, {
    hasNormalized: true,
    harness: Harness.Claude,
  });
  assert.deepEqual(missing, ["tokens_by_model[claude-opus-4].cache_write_ttl"]);
});

test("validateNewExpectationBlocks: a complete dossier validates", () => {
  assert.deepEqual(validateNewExpectationBlocks(baseExpectations()), []);
});

test("validateNewExpectationBlocks: typo'd key inside tool_results is rejected", () => {
  const exp = baseExpectations() as Record<string, unknown>;
  exp.tool_results = {
    total: 2,
    errors: 1,
    session_error_records: 1,
    by_tool: [{ name: "Bash", with_ouput: 2, errors: 1 }],
  };
  const issues = validateNewExpectationBlocks(exp);
  assert.ok(issues.length > 0);
  assert.ok(issues.some((i) => i.includes("by_tool")));
});

test("validateNewExpectationBlocks: unknown key inside parse_quality is rejected", () => {
  const exp = baseExpectations() as Record<string, unknown>;
  exp.parse_quality = {
    total_lines: 10,
    malformed_lines: 0,
    truncated_final_line: false,
    truncated_final_lines: true,
  };
  const issues = validateNewExpectationBlocks(exp);
  assert.ok(issues.some((i) => i.includes("parse_quality")));
});

test("validateNewExpectationBlocks: unknown key inside usage_extras is rejected", () => {
  const exp = baseExpectations() as Record<string, unknown>;
  exp.usage_extras = {
    reasoning_output_tokens: 0,
    web_search_requests: 0,
    web_search_request: 1,
  };
  assert.ok(validateNewExpectationBlocks(exp).length > 0);
});

test("validateNewExpectationBlocks: unknown key inside cache_write_ttl is rejected", () => {
  const exp = baseExpectations() as Record<string, unknown>;
  exp.tokens_by_model = {
    "claude-opus-4": {
      cache_write: 100,
      cache_write_ttl: { five_m: 40, one_h: 60, one_d: 0 },
    },
  };
  assert.ok(validateNewExpectationBlocks(exp).length > 0);
});

test("validateNewExpectationBlocks: mistyped new session key is rejected, legacy keys pass through", () => {
  const exp = baseExpectations() as Record<string, unknown>;
  exp.session = {
    status: "completed",
    some_legacy_extra: "tolerated",
    entrypoint: 42,
  };
  const issues = validateNewExpectationBlocks(exp);
  assert.ok(issues.some((i) => i.includes("entrypoint")));
  // Legacy/unknown keys alone are tolerated (required-facts owns their policy).
  exp.session = { status: "completed", some_legacy_extra: "tolerated" };
  assert.deepEqual(validateNewExpectationBlocks(exp), []);
});
