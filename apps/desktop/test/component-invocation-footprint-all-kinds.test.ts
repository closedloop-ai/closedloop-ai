/**
 * @file component-invocation-footprint-all-kinds.test.ts
 * @description ISS-10736: `footprint_tokens` was zero corpus-wide across all
 * 457,224 invocation rows because NOTHING COMPUTED IT — the candidate type had
 * no member and the row writer's explicit column list never named the column.
 * This suite drives the production derivation entry point and asserts every one
 * of the seven `AgentComponentInvocationKind` members now carries a footprint
 * counted from the source its declaration names.
 *
 * Every kind's source text is a DIFFERENT length, so a producer that wired the
 * wrong text onto a kind — or fanned one kind's value across the others — fails
 * here rather than passing on a fixture where every expected number is the same.
 */
import assert from "node:assert/strict";
import { AgentComponentInvocationUsageMeasurement } from "@repo/api/src/types/agent-component-invocation";
import { describe, test } from "vitest";
import { deriveAgentComponentInvocationCandidates } from "../src/main/database/component-invocations.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-09-23T12:00:00.000Z";
const MAIN_AGENT = "main-agent";
const TS = "2026-09-23T11:00:00.000Z";

/* Distinct expected values per kind, so a producer that wires one kind's text
   onto another is observable rather than silently agreeing.

   The `output` strings are deliberately SHORTER than the counts beside them:
   `output` is the byte-capped prefix the parser stored, while
   `outputFootprintTokens` was counted over the whole payload before the cap. A
   producer that re-derived the footprint from the stored `output` would yield a
   different (smaller) number and redden — which is the under-statement this
   architecture exists to prevent (`NormalizedToolUse.outputFootprintTokens`). */
const TOOL_RESULT_PREFIX = "t".repeat(8); // would count 2, not 10
const MCP_RESULT_PREFIX = "m".repeat(8); // would count 2, not 20
const ORCHESTRATION_RESULT_PREFIX = "o".repeat(8); // would count 2, not 30
const SUBAGENT_RETURN_PREFIX = "g".repeat(8); // would count 2, not 60
/* Definition bodies are NOT capped anywhere, so these are the real text and the
   expected count is taken over them: 160/4 = 40 and 200/4 = 50. */
const SKILL_BODY = "s".repeat(160);
const COMMAND_BODY = "c".repeat(200);
const HOOK_STDOUT_TOKENS = 70;

function snapshot(kind: string, normalizedName: string, content: string) {
  return { kind, normalizedName, content } as never;
}

function sevenKindSession() {
  return makeSession({
    sessionId: "footprint-session",
    messages: [{ role: "human", timestamp: TS, text: "hello" }],
    toolUses: [
      {
        name: "Read",
        normalizedName: "Read",
        kind: "builtin",
        timestamp: TS,
        id: "toolu_read",
        outputFootprintTokens: 10,
        output: TOOL_RESULT_PREFIX,
      },
      {
        name: "mcp__server__call",
        normalizedName: "mcp__server__call",
        kind: "mcp",
        mcpServer: "server",
        timestamp: TS,
        id: "toolu_mcp",
        outputFootprintTokens: 20,
        output: MCP_RESULT_PREFIX,
      },
      {
        name: "TodoWrite",
        normalizedName: "TodoWrite",
        kind: "harness",
        timestamp: TS,
        id: "toolu_orch",
        outputFootprintTokens: 30,
        output: ORCHESTRATION_RESULT_PREFIX,
      },
      {
        name: "Task",
        normalizedName: "Task",
        kind: "builtin",
        timestamp: TS,
        id: "toolu_task",
        input: { subagent_type: "review-soul" },
        outputFootprintTokens: 60,
        output: SUBAGENT_RETURN_PREFIX,
      },
    ],
    skills: [
      {
        name: "logical-qa",
        normalizedName: "logical-qa",
        timestamp: TS,
        providerToolUseId: "toolu_skill",
        definitionSnapshot: snapshot("skill", "logical-qa", SKILL_BODY),
      },
    ],
    slashCommands: [
      {
        name: "design",
        normalizedName: "design",
        timestamp: TS,
        definitionSnapshot: snapshot("command", "design", COMMAND_BODY),
      },
    ],
    hooks: [
      {
        name: "PreToolUse:Bash",
        event: "PreToolUse",
        command: "node hook.js",
        succeeded: true,
        timestamp: TS,
        stdoutFootprintTokens: HOOK_STDOUT_TOKENS,
      },
    ],
  } as never);
}

function footprintByRow(): Record<string, number | null> {
  const candidates = deriveAgentComponentInvocationCandidates(
    sevenKindSession(),
    MAIN_AGENT,
    NOW
  );
  /* Keyed by kind AND component, not kind alone: `Task` yields both a `tool`
     candidate and the `subagent` it spawned, so a kind-only map silently lets a
     later row overwrite an earlier one and hides a wrong value. */
  return Object.fromEntries(
    candidates
      .map(
        (candidate) =>
          [
            `${candidate.componentKind}/${candidate.componentKey}`,
            candidate.footprintTokens,
          ] as const
      )
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

function kindsWithFootprint(): string[] {
  return [
    ...new Set(
      deriveAgentComponentInvocationCandidates(
        sevenKindSession(),
        MAIN_AGENT,
        NOW
      )
        .filter((candidate) => candidate.footprintTokens !== null)
        .map((candidate) => candidate.componentKind)
    ),
  ].sort();
}

describe("ISS-10736 footprint capture across all seven invocation kinds", () => {
  test("every kind carries the footprint its declaration names", () => {
    /* Expected values are spelled out as literals rather than derived from
       AGENT_COMPONENT_FOOTPRINT_SOURCE: a table built from the const under test
       agrees with that const's own mistakes. Each number is distinct, so a
       producer that wired one kind's text onto another fails here. */
    assert.deepEqual(footprintByRow(), {
      "command//design": 50,
      "hook/PreToolUse:Bash node hook.js": 70,
      "mcp/server": 20,
      "orchestration/TodoWrite": 30,
      "skill/logical-qa": 40,
      "subagent/review-soul": 60,
      "tool/Read": 10,
      // The delegating call's result IS the subagent's returned text, counted
      // once on the `subagent` row above. Counting it here too would double
      // every delegation in the first per-session footprint aggregate.
      "tool/Task": null,
    });
  });

  test("no kind is left without a footprint", () => {
    /* The member list is a NON-CIRCULAR literal: a fixture built from
       AgentComponentInvocationKind would stay green if a kind were deleted from
       the union, which is the regression this assertion exists to catch. */
    assert.deepEqual(kindsWithFootprint(), [
      "command",
      "hook",
      "mcp",
      "orchestration",
      "skill",
      "subagent",
      "tool",
    ]);
  });

  test("a derived footprint is labelled estimated, never measured", () => {
    const candidates = deriveAgentComponentInvocationCandidates(
      sevenKindSession(),
      MAIN_AGENT,
      NOW
    );
    for (const candidate of candidates) {
      // The delegating `tool/Task` row carries no footprint (its result belongs
      // to the `subagent` row), so it carries no label either — a label about
      // no telemetry is what the boundary rejects.
      const expected =
        candidate.footprintTokens === null
          ? null
          : AgentComponentInvocationUsageMeasurement.Estimated;
      assert.equal(
        candidate.usageMeasurement,
        expected,
        `${candidate.componentKind} must label its footprint`
      );
    }
  });

  test("a kind whose source text is absent stores NULL, not a zero", () => {
    const candidates = deriveAgentComponentInvocationCandidates(
      makeSession({
        sessionId: "absent-footprint-session",
        messages: [{ role: "human", timestamp: TS, text: "hello" }],
        toolUses: [
          {
            name: "Read",
            normalizedName: "Read",
            kind: "builtin",
            timestamp: TS,
            id: "toolu_no_result",
          },
        ],
        hooks: [
          {
            name: "PreToolUse:Bash",
            event: "PreToolUse",
            command: "node hook.js",
            succeeded: true,
            timestamp: TS,
          },
        ],
      } as never),
      MAIN_AGENT,
      NOW
    );
    assert.ok(candidates.length >= 2);
    for (const candidate of candidates) {
      assert.equal(
        candidate.footprintTokens,
        null,
        `${candidate.componentKind} with no captured source must stay NULL`
      );
      // The label describes telemetry; with none on the row it must not appear.
      assert.equal(candidate.usageMeasurement, null);
    }
  });

  test("a corrupt pre-counted footprint is refused rather than persisted", () => {
    const candidates = deriveAgentComponentInvocationCandidates(
      makeSession({
        sessionId: "corrupt-footprint-session",
        messages: [{ role: "human", timestamp: TS, text: "hello" }],
        toolUses: [
          {
            name: "Read",
            normalizedName: "Read",
            kind: "builtin",
            timestamp: TS,
            id: "toolu_fractional",
            outputFootprintTokens: 1.5,
          },
          {
            name: "Grep",
            normalizedName: "Grep",
            kind: "builtin",
            timestamp: TS,
            id: "toolu_negative",
            outputFootprintTokens: -1,
          },
          {
            name: "Glob",
            normalizedName: "Glob",
            kind: "builtin",
            timestamp: TS,
            id: "toolu_huge",
            outputFootprintTokens: Number.MAX_SAFE_INTEGER + 2,
          },
        ],
      } as never),
      MAIN_AGENT,
      NOW
    );
    assert.equal(candidates.length, 3);
    for (const candidate of candidates) {
      assert.equal(candidate.footprintTokens, null);
    }
  });
});
