/**
 * ISS-8730 — pins the CURRENT behavior of `aggregateCounterSignals` and
 * `refuseLogSignalCollisions` (`../src/main/otel/claude-code-otel-signal-reduction.ts`)
 * directly, without going through the OTLP receiver/normalizer pipeline the
 * sibling `claude-code-otel-normalization-integrity.test.ts` drives.
 *
 * Two of the eight collision guards (`mcp_server_connection`, `plugin_event`)
 * use `neverProvablyOneRecord`, which refuses EVERY colliding pair, including
 * two byte-identical records — unlike every other guard, where an identical
 * repeat collapses silently. That asymmetry is intentional per the source's
 * own doc comments (the only real discriminator on those two tables can be
 * redacted by the producer), so it is pinned here rather than "fixed".
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type ClaudeCodeActiveTimeSignal,
  ClaudeCodeActivityType,
  type ClaudeCodeApiRequestSignal,
  type ClaudeCodeAuthEventSignal,
  type ClaudeCodeCostUsageSignal,
  type ClaudeCodeErrorEventSignal,
  ClaudeCodeErrorKind,
  type ClaudeCodeLinesOfCodeSignal,
  type ClaudeCodeMcpServerConnectionSignal,
  type ClaudeCodeOtelSideTableSignal,
  ClaudeCodeOtelSignalType,
  ClaudeCodePermissionDecision,
  type ClaudeCodePermissionDecisionSignal,
  type ClaudeCodePermissionModeChangeSignal,
  ClaudeCodePermissionSource,
  type ClaudeCodePluginEventSignal,
  ClaudeCodePluginLifecycle,
  type ClaudeCodeSessionStartSignal,
  type ClaudeCodeToolResultSignal,
} from "../src/main/otel/claude-code-otel-signal-contract.js";
import {
  aggregateCounterSignals,
  refuseLogSignalCollisions,
} from "../src/main/otel/claude-code-otel-signal-reduction.js";

const SESSION_ID = "session-1";
const MODEL = "claude-opus-5";
const COST_AT = "2026-06-18T19:00:00.000Z";
const LOC_AT = "2026-06-18T19:00:05.000Z";
const SESSION_START_AT = "2026-06-18T19:00:10.000Z";
const ACTIVE_TIME_AT = "2026-06-18T19:00:15.000Z";
const API_REQUEST_STARTED_AT = "2026-06-18T19:00:20.000Z";
const PERMISSION_DECISION_AT = "2026-06-18T19:00:25.000Z";
const ERROR_EVENT_AT = "2026-06-18T19:00:30.000Z";
const PERMISSION_MODE_CHANGE_AT = "2026-06-18T19:00:35.000Z";
const MCP_CONNECTION_AT = "2026-06-18T19:00:40.000Z";
const AUTH_EVENT_AT = "2026-06-18T19:00:45.000Z";
const PLUGIN_EVENT_AT = "2026-06-18T19:00:50.000Z";
const TOOL_RESULT_AT = "2026-06-18T19:00:55.000Z";

function costSignal(
  overrides: Partial<ClaudeCodeCostUsageSignal> = {}
): ClaudeCodeCostUsageSignal {
  return {
    type: ClaudeCodeOtelSignalType.CostUsage,
    sessionId: SESSION_ID,
    model: MODEL,
    observedAt: COST_AT,
    costUsd: 1,
    ...overrides,
  };
}

function locSignal(
  overrides: Partial<ClaudeCodeLinesOfCodeSignal> = {}
): ClaudeCodeLinesOfCodeSignal {
  return {
    type: ClaudeCodeOtelSignalType.LinesOfCode,
    sessionId: SESSION_ID,
    model: MODEL,
    observedAt: LOC_AT,
    changeType: "added",
    lineCount: 1,
    ...overrides,
  };
}

function sessionStartSignal(
  overrides: Partial<ClaudeCodeSessionStartSignal> = {}
): ClaudeCodeSessionStartSignal {
  return {
    type: ClaudeCodeOtelSignalType.SessionStart,
    sessionId: SESSION_ID,
    observedAt: SESSION_START_AT,
    startType: "fresh",
    sessionCount: 1,
    ...overrides,
  };
}

function activeTimeSignal(
  overrides: Partial<ClaudeCodeActiveTimeSignal> = {}
): ClaudeCodeActiveTimeSignal {
  return {
    type: ClaudeCodeOtelSignalType.ActiveTime,
    sessionId: SESSION_ID,
    observedAt: ACTIVE_TIME_AT,
    activityType: ClaudeCodeActivityType.Cli,
    seconds: 1,
    ...overrides,
  };
}

function apiRequestSignal(
  overrides: Partial<ClaudeCodeApiRequestSignal> = {}
): ClaudeCodeApiRequestSignal {
  return {
    type: ClaudeCodeOtelSignalType.ApiRequest,
    sessionId: SESSION_ID,
    model: MODEL,
    startedAt: API_REQUEST_STARTED_AT,
    durationMs: 100,
    costUsd: 0.5,
    costUsdMicros: 500_000,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...overrides,
  };
}

function permissionDecisionSignal(
  overrides: Partial<ClaudeCodePermissionDecisionSignal> = {}
): ClaudeCodePermissionDecisionSignal {
  return {
    type: ClaudeCodeOtelSignalType.PermissionDecision,
    sessionId: SESSION_ID,
    toolName: "Bash",
    observedAt: PERMISSION_DECISION_AT,
    decision: ClaudeCodePermissionDecision.Allow,
    source: ClaudeCodePermissionSource.Config,
    ...overrides,
  };
}

function errorEventSignal(
  overrides: Partial<ClaudeCodeErrorEventSignal> = {}
): ClaudeCodeErrorEventSignal {
  return {
    type: ClaudeCodeOtelSignalType.ErrorEvent,
    sessionId: SESSION_ID,
    errorKind: ClaudeCodeErrorKind.ApiError,
    observedAt: ERROR_EVENT_AT,
    attempt: 1,
    requestId: "req-1",
    model: MODEL,
    statusCode: 500,
    errorCategory: "server_error",
    durationMs: 120,
    ...overrides,
  };
}

function permissionModeChangeSignal(
  overrides: Partial<ClaudeCodePermissionModeChangeSignal> = {}
): ClaudeCodePermissionModeChangeSignal {
  return {
    type: ClaudeCodeOtelSignalType.PermissionModeChange,
    sessionId: SESSION_ID,
    observedAt: PERMISSION_MODE_CHANGE_AT,
    fromMode: "default",
    toMode: "acceptEdits",
    trigger: "hook",
    ...overrides,
  };
}

function mcpConnectionSignal(
  overrides: Partial<ClaudeCodeMcpServerConnectionSignal> = {}
): ClaudeCodeMcpServerConnectionSignal {
  return {
    type: ClaudeCodeOtelSignalType.McpServerConnection,
    sessionId: SESSION_ID,
    observedAt: MCP_CONNECTION_AT,
    status: "connected",
    transportType: "stdio",
    serverScope: "user",
    durationMs: 50,
    isPlugin: false,
    ...overrides,
  };
}

function authEventSignal(
  overrides: Partial<ClaudeCodeAuthEventSignal> = {}
): ClaudeCodeAuthEventSignal {
  return {
    type: ClaudeCodeOtelSignalType.AuthEvent,
    sessionId: SESSION_ID,
    observedAt: AUTH_EVENT_AT,
    action: "login",
    authMethod: "oauth",
    success: true,
    ...overrides,
  };
}

function pluginEventSignal(
  overrides: Partial<ClaudeCodePluginEventSignal> = {}
): ClaudeCodePluginEventSignal {
  return {
    type: ClaudeCodeOtelSignalType.PluginEvent,
    sessionId: SESSION_ID,
    observedAt: PLUGIN_EVENT_AT,
    lifecycle: ClaudeCodePluginLifecycle.Loaded,
    pluginName: "my-plugin",
    pluginVersion: "1.0.0",
    marketplaceName: "official-marketplace",
    ...overrides,
  };
}

function toolResultSignal(
  overrides: Partial<ClaudeCodeToolResultSignal> = {}
): ClaudeCodeToolResultSignal {
  return {
    type: ClaudeCodeOtelSignalType.ToolResult,
    sessionId: SESSION_ID,
    observedAt: TOOL_RESULT_AT,
    toolName: "Bash",
    toolUseId: "toolu_01AAA",
    success: true,
    toolInputSizeBytes: 100,
    toolResultSizeBytes: 200,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// aggregateCounterSignals
// ---------------------------------------------------------------------------

test("aggregateCounterSignals: sums cost signals that share the natural key", () => {
  const first = costSignal({ costUsd: 1.25 });
  const second = costSignal({ costUsd: 2.75 });

  const result = aggregateCounterSignals([first, second]);

  assert.equal(result.length, 1);
  assert.equal(result[0]?.type, ClaudeCodeOtelSignalType.CostUsage);
  assert.equal((result[0] as ClaudeCodeCostUsageSignal).costUsd, 4);
});

test("aggregateCounterSignals: keeps cost signals with different component attribution as separate rows", () => {
  // ISS-7352 item E: agent.name is identity-bearing on this table, so two
  // points differing only in attribution are two components' spend, not one
  // series reported twice — they must NOT be summed.
  const first = costSignal({ agentName: "agent-a", costUsd: 1 });
  const second = costSignal({ agentName: "agent-b", costUsd: 2 });

  const result = aggregateCounterSignals([first, second]);

  assert.equal(result.length, 2);
  assert.equal(result[0], first);
  assert.equal(result[1], second);
});

test("aggregateCounterSignals: merging cost points drops a disagreeing non-identity dimension and keeps an agreeing one", () => {
  const first = costSignal({ costUsd: 1, speed: "fast", effort: "high" });
  const second = costSignal({ costUsd: 2, speed: "slow", effort: "high" });

  const result = aggregateCounterSignals([first, second]);
  const merged = result[0] as ClaudeCodeCostUsageSignal;

  assert.equal(result.length, 1);
  assert.equal(merged.costUsd, 3);
  assert.equal(Object.hasOwn(merged, "speed"), false);
  assert.equal(merged.effort, "high");
});

test("aggregateCounterSignals: sums lines-of-code signals sharing model/date/changeType, keeps a different changeType separate", () => {
  const added1 = locSignal({ changeType: "added", lineCount: 100 });
  const removed = locSignal({ changeType: "removed", lineCount: 20 });
  const added2 = locSignal({ changeType: "added", lineCount: 50 });

  const result = aggregateCounterSignals([added1, removed, added2]);

  assert.equal(result.length, 2);
  assert.equal((result[0] as ClaudeCodeLinesOfCodeSignal).lineCount, 150);
  assert.equal(result[1], removed);
});

test("aggregateCounterSignals: sums session-start signals sharing sessionId/date/startType", () => {
  const first = sessionStartSignal({ sessionCount: 1 });
  const second = sessionStartSignal({ sessionCount: 2 });

  const result = aggregateCounterSignals([first, second]);

  assert.equal(result.length, 1);
  assert.equal((result[0] as ClaudeCodeSessionStartSignal).sessionCount, 3);
});

test("aggregateCounterSignals: sums active-time signals sharing sessionId/date/activityType", () => {
  const first = activeTimeSignal({ seconds: 30.5 });
  const second = activeTimeSignal({ seconds: 15.25 });

  const result = aggregateCounterSignals([first, second]);

  assert.equal(result.length, 1);
  assert.equal((result[0] as ClaudeCodeActiveTimeSignal).seconds, 45.75);
});

test("aggregateCounterSignals: passes non-counter signals through untouched, even when they collide on their OWN key", () => {
  // api_request is a LOG signal, not one of the four delta counters this
  // function reduces, so two colliding api_request signals are NOT deduped or
  // merged here — that is refuseLogSignalCollisions's job on a separate pass.
  const first = apiRequestSignal({ durationMs: 100 });
  const second = apiRequestSignal({ durationMs: 200 });
  const errorEvent = errorEventSignal();

  const result = aggregateCounterSignals([first, second, errorEvent]);

  assert.equal(result.length, 3);
  assert.equal(result[0], first);
  assert.equal(result[1], second);
  assert.equal(result[2], errorEvent);
});

test("aggregateCounterSignals: aggregates each counter family independently in one batch, preserving survivor order", () => {
  const cost1 = costSignal({ costUsd: 10 });
  const loc1 = locSignal({ changeType: "added", lineCount: 100 });
  const apiReq = apiRequestSignal();
  const cost2 = costSignal({ costUsd: 5 });
  const start1 = sessionStartSignal({ sessionCount: 1 });
  const loc2 = locSignal({ changeType: "added", lineCount: 50 });
  const active1 = activeTimeSignal({ seconds: 30 });
  const start2 = sessionStartSignal({ sessionCount: 2 });
  const active2 = activeTimeSignal({ seconds: 15 });
  const errorEvent = errorEventSignal();

  const result = aggregateCounterSignals([
    cost1,
    loc1,
    apiReq,
    cost2,
    start1,
    loc2,
    active1,
    start2,
    active2,
    errorEvent,
  ]);

  assert.equal(result.length, 6);
  assert.equal(result[0]?.type, ClaudeCodeOtelSignalType.CostUsage);
  assert.equal((result[0] as ClaudeCodeCostUsageSignal).costUsd, 15);
  assert.equal(result[1]?.type, ClaudeCodeOtelSignalType.LinesOfCode);
  assert.equal((result[1] as ClaudeCodeLinesOfCodeSignal).lineCount, 150);
  assert.equal(result[2], apiReq);
  assert.equal(result[3]?.type, ClaudeCodeOtelSignalType.SessionStart);
  assert.equal((result[3] as ClaudeCodeSessionStartSignal).sessionCount, 3);
  assert.equal(result[4]?.type, ClaudeCodeOtelSignalType.ActiveTime);
  assert.equal((result[4] as ClaudeCodeActiveTimeSignal).seconds, 45);
  assert.equal(result[5], errorEvent);
});

// ---------------------------------------------------------------------------
// refuseLogSignalCollisions
// ---------------------------------------------------------------------------

test("refuseLogSignalCollisions: identical repeated api_request collapses silently; a measurement-differing collision is refused", () => {
  const original = apiRequestSignal({ durationMs: 100 });
  const identicalRepeat = apiRequestSignal({ durationMs: 100 });
  const collapsed = refuseLogSignalCollisions([original, identicalRepeat]);
  assert.equal(collapsed.signals.length, 1);
  assert.equal(collapsed.refused, 0);

  const differing = apiRequestSignal({ durationMs: 200 });
  const refused = refuseLogSignalCollisions([original, differing]);
  assert.equal(refused.signals.length, 1);
  assert.equal(refused.signals[0], original);
  assert.equal(refused.refused, 1);
});

test("refuseLogSignalCollisions: identical repeated permission_decision collapses silently; a decision-differing collision is refused", () => {
  const allow = permissionDecisionSignal({
    decision: ClaudeCodePermissionDecision.Allow,
  });
  const identicalRepeat = permissionDecisionSignal({
    decision: ClaudeCodePermissionDecision.Allow,
  });
  const collapsed = refuseLogSignalCollisions([allow, identicalRepeat]);
  assert.equal(collapsed.signals.length, 1);
  assert.equal(collapsed.refused, 0);

  const deny = permissionDecisionSignal({
    decision: ClaudeCodePermissionDecision.Deny,
  });
  const refused = refuseLogSignalCollisions([allow, deny]);
  assert.equal(refused.signals.length, 1);
  assert.equal(refused.signals[0], allow);
  assert.equal(refused.refused, 1);
});

test("refuseLogSignalCollisions: identical repeated error_event collapses silently; a taxonomy-differing collision is refused", () => {
  const original = errorEventSignal({ statusCode: 500 });
  const identicalRepeat = errorEventSignal({ statusCode: 500 });
  const collapsed = refuseLogSignalCollisions([original, identicalRepeat]);
  assert.equal(collapsed.signals.length, 1);
  assert.equal(collapsed.refused, 0);

  // Same occurrence key (attempt/requestId unchanged), different statusCode.
  const differing = errorEventSignal({ statusCode: 503 });
  const refused = refuseLogSignalCollisions([original, differing]);
  assert.equal(refused.signals.length, 1);
  assert.equal(refused.signals[0], original);
  assert.equal(refused.refused, 1);
});

test("refuseLogSignalCollisions: identical repeated permission_mode_change collapses silently; a trigger-differing collision on the SAME transition is refused", () => {
  // trigger is deliberately excluded from the natural key (nullable columns
  // break the SQLite UNIQUE index), so two transitions that agree on
  // fromMode/toMode/observedAt but differ on trigger are two distinct facts
  // reported in one millisecond — the exact bug ISS-7352 review caught.
  const original = permissionModeChangeSignal({ trigger: "hook" });
  const identicalRepeat = permissionModeChangeSignal({ trigger: "hook" });
  const collapsed = refuseLogSignalCollisions([original, identicalRepeat]);
  assert.equal(collapsed.signals.length, 1);
  assert.equal(collapsed.refused, 0);

  const differing = permissionModeChangeSignal({ trigger: "keyboard" });
  const refused = refuseLogSignalCollisions([original, differing]);
  assert.equal(refused.signals.length, 1);
  assert.equal(refused.signals[0], original);
  assert.equal(refused.refused, 1);
});

test("refuseLogSignalCollisions: always refuses a colliding mcp_server_connection, even a byte-identical one", () => {
  // Pinning current behavior, not endorsing it: mcp_server_connection's only
  // real discriminator (server_name) can be redacted by the producer, so
  // neverProvablyOneRecord treats EVERY collision as unprovable — unlike the
  // guards above, an identical repeat does NOT collapse silently here.
  const first = mcpConnectionSignal();
  const identicalRepeat = mcpConnectionSignal();

  const { signals, refused } = refuseLogSignalCollisions([
    first,
    identicalRepeat,
  ]);

  assert.equal(signals.length, 1);
  assert.equal(signals[0], first);
  assert.equal(refused, 1);
});

test("refuseLogSignalCollisions: always refuses a colliding plugin_event, even a byte-identical one", () => {
  // Same posture as mcp_server_connection above: plugin.name is redacted to
  // "third-party" (or omitted) by default, so a collision here is never
  // provably one plugin reported twice.
  const first = pluginEventSignal();
  const identicalRepeat = pluginEventSignal();

  const { signals, refused } = refuseLogSignalCollisions([
    first,
    identicalRepeat,
  ]);

  assert.equal(signals.length, 1);
  assert.equal(signals[0], first);
  assert.equal(refused, 1);
});

test("refuseLogSignalCollisions: identical repeated auth_event collapses silently", () => {
  // auth_event's key already folds in every other attribute the event
  // carries (authOccurrenceKeyOf), so two signals that collide on the key
  // agree on everything by construction — the guard's isSame is `() => true`
  // and a differing collision is structurally unreachable, unlike the other
  // guards with real comparators above.
  const first = authEventSignal();
  const identicalRepeat = authEventSignal();

  const { signals, refused } = refuseLogSignalCollisions([
    first,
    identicalRepeat,
  ]);

  assert.equal(signals.length, 1);
  assert.equal(signals[0], first);
  assert.equal(refused, 0);
});

test("refuseLogSignalCollisions: identical repeated tool_result collapses silently; an outcome-differing collision is refused", () => {
  const original = toolResultSignal({ success: true });
  const identicalRepeat = toolResultSignal({ success: true });
  const collapsed = refuseLogSignalCollisions([original, identicalRepeat]);
  assert.equal(collapsed.signals.length, 1);
  assert.equal(collapsed.refused, 0);

  const differing = toolResultSignal({ success: false, errorType: "timeout" });
  const refused = refuseLogSignalCollisions([original, differing]);
  assert.equal(refused.signals.length, 1);
  assert.equal(refused.signals[0], original);
  assert.equal(refused.refused, 1);
});

test("refuseLogSignalCollisions: passes every signal through untouched when nothing collides, including the counter types no guard targets", () => {
  const signals: ClaudeCodeOtelSideTableSignal[] = [
    costSignal(),
    locSignal(),
    sessionStartSignal(),
    activeTimeSignal(),
    apiRequestSignal(),
    permissionDecisionSignal(),
    errorEventSignal(),
    permissionModeChangeSignal(),
    mcpConnectionSignal(),
    authEventSignal(),
    pluginEventSignal(),
    toolResultSignal(),
  ];

  const { signals: result, refused } = refuseLogSignalCollisions(signals);

  assert.equal(result.length, signals.length);
  assert.equal(refused, 0);
  for (const [index, signal] of signals.entries()) {
    assert.equal(result[index], signal);
  }
});

test("refuseLogSignalCollisions: preserves survivor order and accumulates the refused count across guards applied in sequence", () => {
  const apiReq = apiRequestSignal();
  const apiReqDup = apiRequestSignal();
  const allow = permissionDecisionSignal({
    decision: ClaudeCodePermissionDecision.Allow,
  });
  const toolResult = toolResultSignal();
  const deny = permissionDecisionSignal({
    decision: ClaudeCodePermissionDecision.Deny,
  });
  // Deliberately OUTCOME-DIFFERING, not a byte-identical repeat. A repeat
  // collapses silently at `refused: 0`, so a batch whose only refusal comes
  // from the permission guard totals 1 either way — and `refused` swapped for
  // `Math.max(refused, result.refused)` would still report 1. Two refusals
  // from two DIFFERENT guards is what makes the total say "accumulated".
  const toolResultDup = toolResultSignal({
    success: false,
    errorType: "timeout",
  });
  const errorEvent = errorEventSignal();

  const { signals, refused } = refuseLogSignalCollisions([
    apiReq,
    apiReqDup,
    allow,
    toolResult,
    deny,
    toolResultDup,
    errorEvent,
  ]);

  assert.deepEqual(signals, [apiReq, allow, toolResult, errorEvent]);
  // 1 from the permission guard (allow vs deny) + 1 from the tool-result guard.
  assert.equal(refused, 2);
});
