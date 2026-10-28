/**
 * @file traced-session-lane-review.ts
 * @description The session's close: the visual-QA pass (`ag-10`), the copy pass
 * (`ag-11`), the wrap-up leaves back at the root, and the two rows that cannot
 * be placed on the axis at all.
 *
 * The QA subagent carries the fifth and last of the fixture's failures, and
 * its only failing
 * TRANSPORT — an MCP call that times out and is retried — so the inspector has
 * a failure of each kind to read differently.
 *
 * The wrap-up rows are deliberately NOT under the command: a session does not
 * end inside the tree it opened, and a chart that only ever draws one deep
 * spine hides that.
 */

import {
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import {
  MAIN,
  type TracedSessionRowBuilder,
} from "./traced-session-row-builder";

/** Emit the review lane, the wrap-up leaves, and the two unplaced rows. */
export function emitReviewLane(
  { emit, burst }: TracedSessionRowBuilder,
  designSkill: string
): void {
  // --- IDLE 3,000s -> 3,100s. The second gap. ---------------------------------

  // --- Review lane (ag-10 visual QA, ag-11 copy) ------------------------------

  const visualQa = emit({
    parent: designSkill,
    agent: MAIN,
    kind: AgentComponentInvocationKind.Skill,
    key: "visual-qa",
    at: 3_100_000,
    tokens: {
      inputTokens: 21_400,
      outputTokens: 1680,
      cacheReadTokens: 128_400,
      cacheWriteTokens: 5350,
    },
  });

  const qaAgent = emit({
    parent: visualQa,
    agent: MAIN,
    kind: AgentComponentInvocationKind.Orchestration,
    key: "Agent",
    at: 3_105_000,
    ms: 430_000,
    ok: true,
    fp: 230,
    detail: { spawns: "ag-10", "subagent type": "visual-qa-critic" },
  });
  const qaCritic = emit({
    parent: qaAgent,
    agent: "ag-10",
    parentAgent: MAIN,
    kind: AgentComponentInvocationKind.Subagent,
    key: "visual-qa-critic",
    at: 3_105_400,
    ms: 428_000,
    ok: true,
    tokens: {
      inputTokens: 63_200,
      outputTokens: 4960,
      cacheReadTokens: 379_200,
      cacheWriteTokens: 15_800,
    },
  });
  // Rapid fire: eleven calls inside thirty seconds, most of them MCP.
  burst(qaCritic, "ag-10", MAIN, [
    {
      kind: AgentComponentInvocationKind.Mcp,
      key: "gstack/navigate",
      at: 3_106_000,
      ms: 2140,
      fp: 640,
    },
    {
      kind: AgentComponentInvocationKind.Mcp,
      key: "gstack/screenshot",
      at: 3_109_000,
      ms: 1820,
      fp: 1240,
    },
    {
      kind: AgentComponentInvocationKind.Mcp,
      key: "gstack/snapshot",
      at: 3_112_000,
      ms: 960,
      fp: 4820,
    },
    {
      kind: AgentComponentInvocationKind.Mcp,
      key: "gstack/click",
      at: 3_114_000,
      ms: 540,
      fp: 320,
    },
    {
      kind: AgentComponentInvocationKind.Mcp,
      key: "gstack/screenshot",
      at: 3_116_000,
      ms: 1760,
      fp: 1180,
    },
    // An MCP call that fails: the transport class the other failures do not cover.
    {
      kind: AgentComponentInvocationKind.Mcp,
      key: "gstack/resize",
      at: 3_119_000,
      ms: 4200,
      ok: false,
      fp: 280,
      detail: { error: "viewport 390x844 not applied before timeout" },
    },
    {
      kind: AgentComponentInvocationKind.Mcp,
      key: "gstack/resize",
      at: 3_124_000,
      ms: 1340,
      fp: 290,
      detail: { retry: "1" },
    },
    {
      kind: AgentComponentInvocationKind.Mcp,
      key: "gstack/screenshot",
      at: 3_127_000,
      ms: 1690,
      fp: 1210,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 3_130_000,
      ms: 121,
      fp: 2340,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Grep",
      at: 3_131_000,
      ms: 194,
      fp: 1080,
    },
    {
      kind: AgentComponentInvocationKind.Hook,
      key: "PostToolUse:Read design-asset-audit.mjs",
      at: 3_133_000,
      ms: 58,
      fp: 150,
      detail: { blocking: "false", "exit code": "0" },
    },
  ]);
  burst(qaCritic, "ag-10", MAIN, [
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Write",
      at: 3_380_000,
      ms: 262,
      fp: 5680,
    },
    {
      kind: AgentComponentInvocationKind.Orchestration,
      key: "SendMessage",
      at: 3_520_000,
      ms: 6,
      fp: 90,
      detail: { to: MAIN },
    },
  ]);

  const writerAgent = emit({
    parent: visualQa,
    agent: MAIN,
    kind: AgentComponentInvocationKind.Orchestration,
    key: "Agent",
    at: 3_545_000,
    ms: 120_000,
    ok: true,
    fp: 190,
    detail: { spawns: "ag-11", "subagent type": "ux-writer" },
  });
  const writer = emit({
    parent: writerAgent,
    agent: "ag-11",
    parentAgent: MAIN,
    kind: AgentComponentInvocationKind.Subagent,
    key: "ux-writer",
    at: 3_545_400,
    ms: 118_000,
    ok: true,
    tokens: {
      inputTokens: 27_500,
      outputTokens: 2140,
      cacheReadTokens: 165_000,
      cacheWriteTokens: 6875,
    },
  });
  // Eight calls in twenty seconds, then nothing for eighty.
  burst(writer, "ag-11", MAIN, [
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Grep",
      at: 3_546_000,
      ms: 172,
      fp: 1220,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 3_547_000,
      ms: 109,
      fp: 1940,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Edit",
      at: 3_549_000,
      ms: 1180,
      fp: 940,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Edit",
      at: 3_551_000,
      ms: 1040,
      fp: 880,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 3_553_000,
      ms: 102,
      fp: 1760,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Edit",
      at: 3_555_000,
      ms: 1120,
      fp: 910,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Edit",
      at: 3_557_000,
      ms: 1080,
      fp: 870,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Grep",
      at: 3_560_000,
      ms: 166,
      fp: 1040,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Write",
      at: 3_640_000,
      ms: 218,
      fp: 3140,
    },
  ]);
  burst(visualQa, MAIN, undefined, [
    {
      kind: AgentComponentInvocationKind.Hook,
      key: "PostToolUse:Edit biome-check.sh",
      at: 3_670_000,
      ms: 1040,
      fp: 380,
      detail: { blocking: "false", "exit code": "0" },
    },
  ]);

  // --- Wrap-up: shallow leaves back at the root -------------------------------
  // Not under the command. A session does not end inside the tree it opened, and
  // a chart that only ever draws one deep spine hides that.

  emit({
    agent: MAIN,
    kind: AgentComponentInvocationKind.Tool,
    key: "Edit",
    at: 3_700_000,
    ms: 1680,
    ok: true,
    fp: 1450,
    detail: { decision: "accept", language: "TypeScript" },
  });
  emit({
    agent: MAIN,
    kind: AgentComponentInvocationKind.Tool,
    key: "Bash",
    at: 3_706_000,
    ms: 7400,
    ok: true,
    fp: 2260,
    detail: { command: "git add -A && git commit", "exit code": "0" },
  });
  emit({
    agent: MAIN,
    kind: AgentComponentInvocationKind.Orchestration,
    key: "SendMessage",
    at: 3_715_000,
    ms: 6,
    ok: true,
    fp: 90,
    detail: { to: "main" },
  });
  emit({
    agent: MAIN,
    kind: AgentComponentInvocationKind.Orchestration,
    key: "ScheduleWakeup",
    at: 3_718_000,
    ms: 3,
    ok: true,
    fp: 60,
    detail: { "delay s": "1800" },
  });

  // A minimal harness proved these two calls happened without recording when.
  // They cannot be placed on the axis and are NOT dropped: the unplaced strip
  // renders them by their ordinal.
  emit({
    agent: MAIN,
    kind: AgentComponentInvocationKind.Mcp,
    key: "context7/query-docs",
    at: null,
    fp: 480,
    attribution: AgentComponentInvocationAttributionStatus.Unresolved,
  });
  emit({
    agent: MAIN,
    kind: AgentComponentInvocationKind.Hook,
    key: "SessionEnd:transcript-flush.mjs",
    at: null,
    fp: 140,
    attribution: AgentComponentInvocationAttributionStatus.Unresolved,
  });
}
