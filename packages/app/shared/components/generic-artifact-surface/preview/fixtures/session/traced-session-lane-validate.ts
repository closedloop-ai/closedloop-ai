/**
 * @file traced-session-lane-validate.ts
 * @description The validation lane: a design critic (`ag-7`), the test engineer
 * it spawns (`ag-8`), and the review-soul pass below that (`ag-9`).
 *
 * This lane owns the fixture's DEPTH — its leaves sit ten and eleven levels
 * down, against the planning lane's six — and two of the fixture's five
 * failures: a
 * `dagger call check` that fails and is retried to success eleven minutes
 * later, and the one hook in the session that BLOCKS a call from running at all
 * rather than reporting on one that did.
 *
 * It also holds the longest single span in the session, which is the stretch a
 * reader opening this tab is usually trying to find.
 */

import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import {
  MAIN,
  type TracedSessionRowBuilder,
} from "./traced-session-row-builder";

/** Emit the validation lane under the `design` skill. */
export function emitValidateLane(
  { emit, burst }: TracedSessionRowBuilder,
  designSkill: string
): void {
  // --- Validation lane (ag-7 critic, ag-8 tests, ag-9 review soul) ------------

  const validateAgent = emit({
    parent: designSkill,
    agent: MAIN,
    kind: AgentComponentInvocationKind.Orchestration,
    key: "Agent",
    at: 1_760_000,
    ms: 1_240_000,
    ok: true,
    fp: 240,
    detail: { spawns: "ag-7", "subagent type": "design-critic" },
  });
  const critic = emit({
    parent: validateAgent,
    agent: "ag-7",
    parentAgent: MAIN,
    kind: AgentComponentInvocationKind.Subagent,
    key: "design-critic",
    at: 1_760_500,
    ms: 1_238_000,
    ok: true,
    tokens: {
      inputTokens: 118_600,
      outputTokens: 10_240,
      cacheReadTokens: 711_600,
      cacheWriteTokens: 29_650,
    },
  });

  burst(critic, "ag-7", MAIN, [
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 1_761_000,
      ms: 128,
      fp: 3640,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 1_762_000,
      ms: 117,
      fp: 2480,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Grep",
      at: 1_763_000,
      ms: 205,
      fp: 1320,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 1_764_000,
      ms: 143,
      fp: 4280,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Glob",
      at: 1_765_000,
      ms: 86,
      fp: 600,
    },
  ]);

  const localCi = emit({
    parent: critic,
    agent: "ag-7",
    parentAgent: MAIN,
    kind: AgentComponentInvocationKind.Skill,
    key: "local-ci",
    at: 1_770_000,
    tokens: {
      inputTokens: 9180,
      outputTokens: 640,
      cacheReadTokens: 55_080,
    },
  });

  burst(localCi, "ag-7", MAIN, [
    {
      kind: AgentComponentInvocationKind.Hook,
      key: "PreToolUse:Bash logical-qa-bash-policy.mjs",
      at: 1_770_600,
      ms: 38,
      fp: 160,
      detail: { blocking: "true", "exit code": "0", decision: "allow" },
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Bash",
      at: 1_771_000,
      ms: 110_000,
      ok: false,
      fp: 9240,
      detail: {
        command: "dagger call check",
        "exit code": "1",
        error: "typecheck failed in apps/prototypes (3 errors)",
      },
    },
    // A hook that BLOCKS. The one gate in the session that stopped a call from
    // running at all, rather than reporting on one that did.
    {
      kind: AgentComponentInvocationKind.Hook,
      key: "PreToolUse:Bash logical-qa-bash-policy.mjs",
      at: 1_882_000,
      ms: 62,
      ok: false,
      fp: 210,
      detail: {
        blocking: "true",
        "exit code": "2",
        decision: "deny",
        error: "install must be run with a frozen lockfile",
      },
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Bash",
      at: 1_883_000,
      ms: 48_000,
      fp: 2180,
      detail: { command: "pnpm install --frozen-lockfile", "exit code": "0" },
    },
  ]);

  const testAgent = emit({
    parent: localCi,
    agent: "ag-7",
    parentAgent: MAIN,
    kind: AgentComponentInvocationKind.Orchestration,
    key: "Agent",
    at: 1_935_000,
    ms: 300_000,
    ok: true,
    fp: 200,
    detail: { spawns: "ag-8", "subagent type": "test-engineer" },
  });
  const testEngineer = emit({
    parent: testAgent,
    agent: "ag-8",
    parentAgent: "ag-7",
    kind: AgentComponentInvocationKind.Subagent,
    key: "test-engineer",
    at: 1_935_400,
    ms: 298_000,
    ok: true,
    tokens: {
      inputTokens: 54_300,
      outputTokens: 4460,
      cacheReadTokens: 325_800,
      cacheWriteTokens: 13_575,
    },
  });
  burst(testEngineer, "ag-8", "ag-7", [
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 1_936_000,
      ms: 124,
      fp: 2840,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Grep",
      at: 1_936_600,
      ms: 187,
      fp: 1140,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Write",
      at: 1_940_000,
      ms: 246,
      fp: 3260,
    },
  ]);

  const frankenstein = emit({
    parent: testEngineer,
    agent: "ag-8",
    parentAgent: "ag-7",
    kind: AgentComponentInvocationKind.Skill,
    key: "frankenstein",
    at: 1_960_000,
    tokens: {
      inputTokens: 12_900,
      outputTokens: 980,
      cacheReadTokens: 77_400,
      cacheWriteTokens: 3225,
    },
  });
  burst(frankenstein, "ag-8", "ag-7", [
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 1_961_000,
      ms: 111,
      fp: 2060,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Edit",
      at: 1_964_000,
      ms: 1480,
      fp: 1740,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Bash",
      at: 1_970_000,
      ms: 34_000,
      fp: 4120,
    },
  ]);

  const reviewAgent = emit({
    parent: frankenstein,
    agent: "ag-8",
    parentAgent: "ag-7",
    kind: AgentComponentInvocationKind.Orchestration,
    key: "Agent",
    at: 2_020_000,
    ms: 180_000,
    ok: true,
    fp: 190,
    detail: { spawns: "ag-9", "subagent type": "review-soul" },
  });
  const reviewSoul = emit({
    parent: reviewAgent,
    agent: "ag-9",
    parentAgent: "ag-8",
    kind: AgentComponentInvocationKind.Subagent,
    key: "review-soul",
    at: 2_020_400,
    ms: 178_000,
    ok: true,
    tokens: {
      inputTokens: 38_700,
      outputTokens: 3120,
      cacheReadTokens: 232_200,
      cacheWriteTokens: 9675,
    },
  });
  // The deepest rows in the session: level ten and eleven.
  burst(reviewSoul, "ag-9", "ag-8", [
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 2_022_000,
      ms: 95,
      fp: 1980,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Grep",
      at: 2_024_000,
      ms: 168,
      fp: 1040,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 2_060_000,
      ms: 107,
      fp: 2240,
    },
    {
      kind: AgentComponentInvocationKind.Hook,
      key: "PostToolUse:Read review-soul-audit.mjs",
      at: 2_090_000,
      ms: 51,
      fp: 170,
      detail: { blocking: "false", "exit code": "0" },
    },
    {
      kind: AgentComponentInvocationKind.Orchestration,
      key: "SendMessage",
      at: 2_180_000,
      ms: 5,
      fp: 80,
      detail: { to: "ag-8" },
    },
  ]);

  // The retry of the call that failed at 1,771,000 — and the longest single span
  // in the session. Eleven and a half minutes on one tool call is exactly the
  // stretch a reader is trying to find when they open this tab.
  burst(localCi, "ag-7", MAIN, [
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Bash",
      at: 2_240_000,
      ms: 690_000,
      fp: 11_480,
      detail: {
        command: "dagger call check",
        "exit code": "0",
        retry: "1",
      },
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 2_935_000,
      ms: 113,
      fp: 2120,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Grep",
      at: 2_936_000,
      ms: 179,
      fp: 980,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Bash",
      at: 2_937_000,
      ms: 9000,
      fp: 1840,
      detail: { command: "pnpm exec biome check", "exit code": "0" },
    },
  ]);
  burst(critic, "ag-7", MAIN, [
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Write",
      at: 2_990_000,
      ms: 284,
      fp: 6120,
    },
    {
      kind: AgentComponentInvocationKind.Orchestration,
      key: "SendMessage",
      at: 2_994_000,
      ms: 6,
      fp: 90,
      detail: { to: MAIN },
    },
  ]);
}
