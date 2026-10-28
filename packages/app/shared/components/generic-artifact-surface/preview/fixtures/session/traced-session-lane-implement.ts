/**
 * @file traced-session-lane-implement.ts
 * @description The implementation fan-out: an engineer lead (`ag-2`) and the
 * four shards it spawns (`ag-3`..`ag-6`).
 *
 * This is the lane the chart's overlap treatment exists for. The four shards'
 * measured extents sum to far more than the parent's own span, so `selfMs` has
 * to come off the UNION of the children rather than their sum — and a reader
 * who cannot see the overlap has no way to know which number is honest.
 *
 * It also carries two of the fixture's five failures, both at depth 7 — the
 * deepest failures in the session: one shard's test run
 * fails while its three siblings pass through the same stretch cleanly, and one
 * `Edit` fails and is retried to success ninety seconds later as a separate row.
 */

import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import {
  MAIN,
  type Step,
  type TracedSessionRowBuilder,
} from "./traced-session-row-builder";

type Shard = {
  agent: string;
  surface: string;
  spawnAt: number;
  durationMs: number;
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  body: readonly Step[];
};

const SHARDS: readonly Shard[] = [
  {
    agent: "ag-3",
    surface: "list shell",
    spawnAt: 700_000,
    durationMs: 960_000,
    tokens: {
      inputTokens: 88_300,
      outputTokens: 7940,
      cacheReadTokens: 529_800,
      cacheWriteTokens: 22_075,
    },
    body: [
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Read",
        at: 702_000,
        ms: 132,
        fp: 3260,
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Grep",
        at: 704_000,
        ms: 214,
        fp: 1420,
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Edit",
        at: 712_000,
        ms: 1840,
        fp: 2180,
      },
      {
        kind: AgentComponentInvocationKind.Hook,
        key: "PostToolUse:Edit biome-check.sh",
        at: 715_000,
        ms: 940,
        fp: 380,
        detail: { blocking: "false", "exit code": "0" },
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Bash",
        at: 720_000,
        ms: 62_000,
        fp: 2940,
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Read",
        at: 790_000,
        ms: 118,
        fp: 2040,
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Edit",
        at: 795_000,
        ms: 1620,
        fp: 1880,
      },
      {
        kind: AgentComponentInvocationKind.Mcp,
        key: "context7/query-docs",
        at: 840_000,
        ms: 1180,
        fp: 3240,
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Edit",
        at: 1_180_000,
        ms: 1440,
        fp: 1760,
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Bash",
        at: 1_420_000,
        ms: 84_000,
        fp: 3120,
      },
      {
        kind: AgentComponentInvocationKind.Orchestration,
        key: "SendMessage",
        at: 1_640_000,
        ms: 5,
        fp: 80,
        detail: { to: "ag-2" },
      },
    ],
  },
  {
    agent: "ag-4",
    surface: "detail shell",
    spawnAt: 702_500,
    durationMs: 905_000,
    tokens: {
      inputTokens: 76_500,
      outputTokens: 6210,
      cacheReadTokens: 459_000,
      cacheWriteTokens: 19_125,
    },
    body: [
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Read",
        at: 704_500,
        ms: 141,
        fp: 3840,
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Read",
        at: 705_200,
        ms: 126,
        fp: 2620,
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Glob",
        at: 706_000,
        ms: 84,
        fp: 580,
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Edit",
        at: 726_000,
        ms: 2040,
        fp: 2460,
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Edit",
        at: 880_000,
        ms: 1780,
        fp: 2210,
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Bash",
        at: 940_000,
        ms: 71_000,
        fp: 3480,
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Read",
        at: 1_120_000,
        ms: 133,
        fp: 2340,
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Edit",
        at: 1_310_000,
        ms: 1520,
        fp: 1940,
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Bash",
        at: 1_500_000,
        ms: 58_000,
        fp: 2760,
      },
    ],
  },
  {
    agent: "ag-5",
    surface: "empty and error states",
    spawnAt: 705_000,
    durationMs: 870_000,
    tokens: {
      inputTokens: 69_400,
      outputTokens: 5880,
      cacheReadTokens: 416_400,
      cacheWriteTokens: 17_350,
    },
    body: [
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Read",
        at: 707_000,
        ms: 129,
        fp: 2980,
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Grep",
        at: 708_000,
        ms: 192,
        fp: 1060,
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Edit",
        at: 745_000,
        ms: 1680,
        fp: 2120,
      },
      // The failure the siblings do not have. Three shards pass through this
      // same stretch cleanly, which is the comparison a debugger needs.
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Bash",
        at: 860_000,
        ms: 41_000,
        ok: false,
        fp: 6840,
        detail: {
          command: "pnpm --filter prototypes test",
          "exit code": "1",
          error: "2 failing assertions in the empty-state suite",
        },
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Read",
        at: 905_000,
        ms: 116,
        fp: 2180,
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Edit",
        at: 960_000,
        ms: 1590,
        fp: 1820,
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Bash",
        at: 1_020_000,
        ms: 44_000,
        fp: 3040,
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Edit",
        at: 1_260_000,
        ms: 1370,
        fp: 1680,
      },
      {
        kind: AgentComponentInvocationKind.Orchestration,
        key: "SendMessage",
        at: 1_550_000,
        ms: 5,
        fp: 80,
        detail: { to: "ag-2" },
      },
    ],
  },
  {
    agent: "ag-6",
    surface: "filter and sort controls",
    spawnAt: 707_500,
    durationMs: 830_000,
    tokens: {
      inputTokens: 61_200,
      outputTokens: 4930,
      cacheReadTokens: 367_200,
      cacheWriteTokens: 15_300,
    },
    body: [
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Read",
        at: 709_500,
        ms: 135,
        fp: 3120,
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Glob",
        at: 710_500,
        ms: 79,
        fp: 540,
      },
      // Fails, then the same call succeeds ninety seconds later. The pair is
      // the shape a retry actually leaves behind: two rows, not one flag.
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Edit",
        at: 768_000,
        ms: 1260,
        ok: false,
        fp: 1440,
        detail: {
          file: "filters/artifact-filter-bar.tsx",
          error: "old_string matched 3 times",
          decision: "reject",
        },
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Read",
        at: 790_000,
        ms: 121,
        fp: 2680,
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Edit",
        at: 858_000,
        ms: 1410,
        fp: 1520,
        detail: {
          file: "filters/artifact-filter-bar.tsx",
          decision: "accept",
          retry: "1",
        },
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Bash",
        at: 900_000,
        ms: 52_000,
        fp: 2880,
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Edit",
        at: 1_140_000,
        ms: 1330,
        fp: 1620,
      },
      {
        kind: AgentComponentInvocationKind.Tool,
        key: "Read",
        at: 1_390_000,
        ms: 109,
        fp: 1960,
      },
    ],
  },
] as const;

/** Emit the implementation fan-out under the `design` skill. */
export function emitImplementLane(
  { emit, burst }: TracedSessionRowBuilder,
  designSkill: string
): void {
  // --- IDLE 560s -> 680s. Nothing ran. The axis should show it. ---------------

  // --- Implementation fan-out (ag-2 lead, ag-3..ag-6 shards) ------------------

  const implAgent = emit({
    parent: designSkill,
    agent: MAIN,
    kind: AgentComponentInvocationKind.Orchestration,
    key: "Agent",
    at: 680_000,
    ms: 1_020_000,
    ok: true,
    fp: 260,
    detail: { spawns: "ag-2", "subagent type": "design-engineer" },
  });
  const engineer = emit({
    parent: implAgent,
    agent: "ag-2",
    parentAgent: MAIN,
    kind: AgentComponentInvocationKind.Subagent,
    key: "design-engineer",
    at: 680_500,
    ms: 1_018_000,
    ok: true,
    tokens: {
      inputTokens: 142_800,
      outputTokens: 12_640,
      cacheReadTokens: 856_800,
      cacheWriteTokens: 35_700,
    },
  });

  burst(engineer, "ag-2", MAIN, [
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 681_000,
      ms: 138,
      fp: 3420,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Grep",
      at: 681_500,
      ms: 224,
      fp: 1680,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 682_100,
      ms: 127,
      fp: 2880,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Glob",
      at: 682_600,
      ms: 91,
      fp: 620,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 683_200,
      ms: 149,
      fp: 4160,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Grep",
      at: 690_000,
      ms: 198,
      fp: 1340,
    },
    {
      kind: AgentComponentInvocationKind.Tool,
      key: "Read",
      at: 693_000,
      ms: 122,
      fp: 2260,
    },
  ]);

  const componentize = emit({
    parent: engineer,
    agent: "ag-2",
    parentAgent: MAIN,
    kind: AgentComponentInvocationKind.Skill,
    key: "componentize-prototype",
    at: 695_000,
    tokens: {
      inputTokens: 18_200,
      outputTokens: 1460,
      cacheReadTokens: 109_200,
      cacheWriteTokens: 4550,
    },
  });

  /**
   * The four concurrent shards.
   *
   * Their spawn instants are 2.5 seconds apart and their measured extents run to
   * within two minutes of each other, so for roughly fourteen minutes all four
   * are live at once. That is deliberate: summing the four durations gives more
   * than fifty minutes against a parent that occupied sixteen, and a reader who
   * cannot see the overlap has no way to know which number is the honest one.
   */
  for (const shard of SHARDS) {
    const spawn = emit({
      parent: componentize,
      agent: "ag-2",
      parentAgent: MAIN,
      kind: AgentComponentInvocationKind.Orchestration,
      key: "Agent",
      at: shard.spawnAt,
      ms: shard.durationMs,
      ok: true,
      fp: 220,
      detail: { spawns: shard.agent, shard: shard.surface },
    });
    const shardRoot = emit({
      parent: spawn,
      agent: shard.agent,
      parentAgent: "ag-2",
      kind: AgentComponentInvocationKind.Subagent,
      key: "design-engineer",
      at: shard.spawnAt + 400,
      ms: shard.durationMs - 2000,
      ok: true,
      tokens: shard.tokens,
      detail: { shard: shard.surface },
    });
    burst(shardRoot, shard.agent, "ag-2", shard.body);
  }

  burst(componentize, "ag-2", MAIN, [
    {
      kind: AgentComponentInvocationKind.Hook,
      key: "PostToolUse:Edit catalog-import-check.mjs",
      at: 1_665_000,
      ms: 1120,
      fp: 420,
      detail: { blocking: "false", "exit code": "0" },
    },
    {
      kind: AgentComponentInvocationKind.Orchestration,
      key: "SendMessage",
      at: 1_668_000,
      ms: 6,
      fp: 90,
      detail: { to: MAIN },
    },
  ]);
  burst(engineer, "ag-2", MAIN, [
    {
      kind: AgentComponentInvocationKind.Orchestration,
      key: "Monitor",
      at: 1_690_000,
      ms: 4,
      fp: 70,
      detail: { watch: "shard completion" },
    },
  ]);
}
