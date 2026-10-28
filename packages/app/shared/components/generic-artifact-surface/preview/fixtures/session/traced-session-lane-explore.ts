/**
 * @file traced-session-lane-explore.ts
 * @description The session's opening: the operator's prompt reaching the design
 * pack, and the planning subagent that runs before any code is written.
 *
 * Emits the two root-level rows a real transcript opens with, the `/design`
 * command, the `design` skill under it, and the whole `ag-1` planning lane —
 * including the 340-second reasoning stretch with no recorded calls, which is
 * the first of the fixture's two idle gaps.
 *
 * Returns the `design` skill's id, because every later lane hangs off it.
 */

import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import {
  MAIN,
  type TracedSessionRowBuilder,
} from "./traced-session-row-builder";

/** Emit the boot and planning rows. Returns the `design` skill's id. */
export function emitExploreLane({
  emit,
  burst,
}: TracedSessionRowBuilder): string {
  // --- Boot: the operator's prompt reaches the design pack -------------------
  // Two root-level rows before the command, exactly as a real transcript opens.

  emit({
    agent: MAIN,
    kind: AgentComponentInvocationKind.Hook,
    key: "PreToolUse:Bash rtk hook claude",
    at: 0,
    ms: 42,
    ok: true,
    fp: 120,
    detail: { blocking: "false", "exit code": "0" },
  });
  emit({
    agent: MAIN,
    kind: AgentComponentInvocationKind.Tool,
    key: "Bash",
    at: 1000,
    ms: 610,
    ok: true,
    fp: 340,
    detail: { command: "git status --porcelain", "exit code": "0" },
  });

  const commandRoot = emit({
    agent: MAIN,
    kind: AgentComponentInvocationKind.Command,
    key: "/design",
    at: 2000,
    fp: 940,
    detail: { source: "custom" },
  });

  const designSkill = emit({
    parent: commandRoot,
    agent: MAIN,
    kind: AgentComponentInvocationKind.Skill,
    key: "design",
    at: 2100,
    tokens: {
      inputTokens: 24_600,
      outputTokens: 1840,
      cacheReadTokens: 148_400,
      cacheWriteTokens: 6150,
    },
  });

  // Rapid-fire orientation: nine calls inside five seconds.
  burst(designSkill, MAIN, undefined, [
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 2600,
      ms: 140,
      fp: 1820,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 2800,
      ms: 118,
      fp: 2240,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Glob",
      at: 3000,
      ms: 96,
      fp: 640,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Grep",
      at: 3200,
      ms: 210,
      fp: 980,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Grep",
      at: 3500,
      ms: 188,
      fp: 1240,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 3800,
      ms: 132,
      fp: 2960,
    },
    {
      kind: AgentComponentInvocationKind.Mcp,
      key: "context7/resolve-library-id",
      at: 4200,
      ms: 880,
      fp: 620,
    },
    {
      kind: AgentComponentInvocationKind.Mcp,
      key: "context7/query-docs",
      at: 5200,
      ms: 1640,
      fp: 4180,
    },
    {
      kind: AgentComponentInvocationKind.Hook,
      key: "PostToolUse:Read design-asset-audit.mjs",
      at: 7000,
      ms: 55,
      fp: 150,
      detail: { blocking: "false", "exit code": "0" },
    },
  ]);

  // --- Planning lane (ag-1) ---------------------------------------------------

  const planAgent = emit({
    parent: designSkill,
    agent: MAIN,
    kind: AgentComponentInvocationKind.Orchestration,
    key: "Agent",
    at: 130_000,
    ms: 430_000,
    ok: true,
    fp: 210,
    detail: { spawns: "ag-1", "subagent type": "design-planner" },
  });
  const planner = emit({
    parent: planAgent,
    agent: "ag-1",
    parentAgent: MAIN,
    kind: AgentComponentInvocationKind.Subagent,
    key: "design-planner",
    at: 130_400,
    ms: 429_000,
    ok: true,
    tokens: {
      inputTokens: 96_400,
      outputTokens: 8120,
      cacheReadTokens: 578_400,
      cacheWriteTokens: 24_100,
    },
  });

  burst(planner, "ag-1", MAIN, [
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 131_000,
      ms: 124,
      fp: 3180,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 131_400,
      ms: 108,
      fp: 2440,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Grep",
      at: 131_800,
      ms: 246,
      fp: 1520,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Glob",
      at: 132_300,
      ms: 88,
      fp: 710,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 132_700,
      ms: 141,
      fp: 4020,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Grep",
      at: 133_200,
      ms: 203,
      fp: 1180,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 133_800,
      ms: 119,
      fp: 2760,
    },
    {
      kind: AgentComponentInvocationKind.Mcp,
      key: "context7/query-docs",
      at: 134_400,
      ms: 1420,
      fp: 3860,
    },
  ]);

  const briefSkill = emit({
    parent: planner,
    agent: "ag-1",
    parentAgent: MAIN,
    kind: AgentComponentInvocationKind.Skill,
    key: "prototype-brief",
    at: 145_000,
    tokens: {
      inputTokens: 11_400,
      outputTokens: 820,
      cacheReadTokens: 68_400,
    },
  });
  burst(briefSkill, "ag-1", MAIN, [
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 146_000,
      ms: 112,
      fp: 2180,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Grep",
      at: 146_500,
      ms: 176,
      fp: 940,
    },
    {
      kind: AgentComponentInvocationKind.Hook,
      key: "PreToolUse:Write prototype-meta-guard.mjs",
      at: 147_200,
      ms: 47,
      fp: 160,
      detail: { blocking: "true", "exit code": "0", decision: "allow" },
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Write",
      at: 147_600,
      ms: 210,
      fp: 1640,
    },
    {
      kind: AgentComponentInvocationKind.Mcp,
      key: "context7/resolve-library-id",
      at: 148_200,
      ms: 760,
      fp: 540,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 149_400,
      ms: 104,
      fp: 1980,
    },
  ]);

  // A long think with nothing to show for it: the planner's own reasoning stretch
  // between the brief and the handoff is 340 seconds of no recorded calls.
  burst(planner, "ag-1", MAIN, [
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Write",
      at: 492_000,
      ms: 268,
      fp: 5240,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 493_000,
      ms: 116,
      fp: 2040,
    },
    {
      kind: AgentComponentInvocationKind.Orchestration,
      key: "SendMessage",
      at: 520_000,
      ms: 6,
      fp: 90,
      detail: { to: MAIN },
    },
  ]);

  return designSkill;
}
