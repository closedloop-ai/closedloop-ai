/**
 * @file evidence-model.test.ts
 * @description FEA-2268 tests for the vendor-neutral evidence model: the
 * canonical abstract-category set is pinned; each harness adapter maps its real
 * concrete tool names to abstract categories; declared/structural/linguistic
 * layers are produced; unknown harnesses/tools degrade to structural-only
 * without throwing; and a source-shape boundary guard proves no harness tool-name
 * literal leaks into the harness-blind core (the anti-over-fitting mandate).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { buildSessionEvidence } from "../src/main/collectors/evidence/build-session-evidence.js";
import {
  EVIDENCE_MODEL_VERSION,
  TOOL_CATEGORY_VALUES,
  ToolCategory,
} from "../src/main/collectors/evidence/evidence-model.js";
import {
  createNormalizedSession,
  Harness,
  type NormalizedSession,
  type NormalizedToolUse,
} from "../src/main/collectors/types.js";

const TS = "2026-06-07T00:00:00.000Z";

// Hoisted to module scope (Biome `useTopLevelRegex`): the boundary guard's
// comment-stripper reuses these rather than recompiling the literals per call.
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:])\/\/[^\n]*/g;

function tool(
  name: string,
  extra?: Partial<NormalizedToolUse>
): NormalizedToolUse {
  return { name, timestamp: TS, ...extra };
}

function sessionWith(
  overrides?: Partial<NormalizedSession>
): NormalizedSession {
  return createNormalizedSession({ sessionId: "s", ...overrides });
}

/** The category a single tool lands in, run through the full harness-blind core. */
function categoryOf(
  harness: Harness,
  t: NormalizedToolUse
): ToolCategory | null {
  const mix = buildSessionEvidence(sessionWith({ toolUses: [t] }), harness)
    .structural.categoryMix;
  const hit = TOOL_CATEGORY_VALUES.filter(
    (c) =>
      c !== ToolCategory.HumanTurn &&
      c !== ToolCategory.DeclaredIntent &&
      mix[c] > 0
  );
  return hit.length === 1 ? hit[0] : null;
}

test("canonical ToolCategory member set is pinned (guards vocabulary drift)", () => {
  assert.deepEqual(
    [...TOOL_CATEGORY_VALUES],
    [
      "read_search",
      "mutate_code",
      "run_command",
      "test_run",
      "git_lifecycle",
      "human_turn",
      "declared_intent",
    ],
    "the abstract category vocabulary is the SSOT FEA-2269 reads; changing it is a versioned, deliberate act"
  );
  assert.equal(TOOL_CATEGORY_VALUES.length, 7);
  assert.equal(EVIDENCE_MODEL_VERSION, 1);
});

describe("Claude adapter", () => {
  test("Read/Grep/Glob → ReadSearch; Edit/Write → MutateCode; Bash → RunCommand", () => {
    assert.equal(
      categoryOf(Harness.Claude, tool("Read")),
      ToolCategory.ReadSearch
    );
    assert.equal(
      categoryOf(Harness.Claude, tool("Grep")),
      ToolCategory.ReadSearch
    );
    assert.equal(
      categoryOf(Harness.Claude, tool("Edit")),
      ToolCategory.MutateCode
    );
    assert.equal(
      categoryOf(Harness.Claude, tool("Write")),
      ToolCategory.MutateCode
    );
    assert.equal(
      categoryOf(Harness.Claude, tool("Bash")),
      ToolCategory.RunCommand
    );
  });

  test("Bash refines to TestRun / GitLifecycle from command text", () => {
    assert.equal(
      categoryOf(
        Harness.Claude,
        tool("Bash", { input: { command: "pnpm test --run" } })
      ),
      ToolCategory.TestRun
    );
    assert.equal(
      categoryOf(
        Harness.Claude,
        tool("Bash", { input: { command: "git commit -m 'x'" } })
      ),
      ToolCategory.GitLifecycle
    );
    // Git lifecycle is checked before the test-runner keyword: a commit whose
    // message merely names a test runner is still a lifecycle action.
    assert.equal(
      categoryOf(
        Harness.Claude,
        tool("Bash", { input: { command: 'git commit -m "fix jest flake"' } })
      ),
      ToolCategory.GitLifecycle,
      "a git command is not reclassified as a test run by a keyword in its message"
    );
  });

  test("a bare Skill tool with no skill identifier yields no declared evidence", () => {
    const evidence = buildSessionEvidence(
      sessionWith({ toolUses: [tool("Skill")] }),
      Harness.Claude
    );
    assert.equal(
      evidence.declared.length,
      0,
      'a Skill use with no skillName must not emit a misleading "Skill" record'
    );
  });

  test("Skill + slash command + mcp__ surface as declared evidence", () => {
    const evidence = buildSessionEvidence(
      sessionWith({
        slashCommands: [{ name: "/plan", timestamp: TS }],
        toolUses: [
          tool("Skill", { skillName: "code-review" }),
          tool("mcp__closedloop__get-document"),
        ],
      }),
      Harness.Claude
    );
    const kinds = evidence.declared.map((d) => d.kind).sort();
    assert.deepEqual(kinds, ["mcp_call", "skill", "slash_command"]);
    // Every declared item maps to the DeclaredIntent category.
    assert.ok(
      evidence.declared.every((d) => d.category === ToolCategory.DeclaredIntent)
    );
    assert.equal(
      evidence.structural.categoryMix[ToolCategory.DeclaredIntent],
      3,
      "categoryMix folds the declared-signal count"
    );
  });
});

describe("Codex adapter", () => {
  test("shell → RunCommand; apply_patch → MutateCode; mcpServer → declared McpCall", () => {
    assert.equal(
      categoryOf(Harness.Codex, tool("shell", { input: { command: "ls" } })),
      ToolCategory.RunCommand
    );
    assert.equal(
      categoryOf(Harness.Codex, tool("apply_patch")),
      ToolCategory.MutateCode
    );
    const evidence = buildSessionEvidence(
      sessionWith({
        toolUses: [
          tool("closedloop__get-document", {
            mcpServer: "closedloop",
            mcpMethod: "get-document",
          }),
        ],
      }),
      Harness.Codex
    );
    assert.equal(evidence.declared.length, 1);
    assert.equal(evidence.declared[0].kind, "mcp_call");
    assert.equal(evidence.declared[0].name, "closedloop__get-document");
  });
});

describe("Cursor adapter", () => {
  test('"file_edit" → MutateCode; default "tool" → null', () => {
    assert.equal(
      categoryOf(Harness.Cursor, tool("file_edit")),
      ToolCategory.MutateCode
    );
    assert.equal(categoryOf(Harness.Cursor, tool("tool")), null);
  });
});

describe("Copilot adapter (canonical low-signal degrade case)", () => {
  test('"copilot_tool" → null; session still carries humanTurnDensity', () => {
    assert.equal(categoryOf(Harness.Copilot, tool("copilot_tool")), null);
    const evidence = buildSessionEvidence(
      sessionWith({
        userMessages: 4,
        assistantMessages: 6,
        toolUses: [tool("copilot_tool")],
      }),
      Harness.Copilot
    );
    assert.deepEqual(evidence.structural.humanTurnDensity, {
      humanTurns: 4,
      totalTurns: 10,
    });
    assert.equal(evidence.structural.categoryMix[ToolCategory.HumanTurn], 4);
  });
});

describe("OpenCode adapter", () => {
  test("patch / diffDelta → MutateCode; default → null", () => {
    assert.equal(
      categoryOf(Harness.OpenCode, tool("patch")),
      ToolCategory.MutateCode
    );
    assert.equal(
      categoryOf(
        Harness.OpenCode,
        tool("opencode_tool", { diffDelta: { add: 3, del: 1 } })
      ),
      ToolCategory.MutateCode,
      "a generic-named tool with a normalized diffDelta is a mutation"
    );
    assert.equal(categoryOf(Harness.OpenCode, tool("opencode_tool")), null);
  });
});

test("structural git-lifecycle + mutation targets + branches aggregate", () => {
  const evidence = buildSessionEvidence(
    sessionWith({
      toolUses: [
        tool("Edit", { input: { file_path: "a.ts" }, gitBranch: "feat/x" }),
        tool("Edit", { input: { file_path: "a.ts" } }), // dedup target
        tool("Bash", { input: { command: "git commit -m y" } }),
        tool("Bash", { input: { command: "gh pr create --fill" } }),
      ],
    }),
    Harness.Claude
  );
  assert.deepEqual(evidence.structural.mutationTargets, ["a.ts"]);
  assert.equal(evidence.structural.gitLifecycle.commits, 1);
  assert.equal(evidence.structural.gitLifecycle.prsCreated, 1);
  assert.deepEqual(evidence.structural.gitLifecycle.branchesTouched, [
    "feat/x",
  ]);
});

test("branchesTouched is capped to bound untrusted-input growth", () => {
  const toolUses = Array.from({ length: 60 }, (_, i) =>
    tool("Edit", { input: { file_path: `f${i}.ts` }, gitBranch: `b${i}` })
  );
  const evidence = buildSessionEvidence(
    sessionWith({ toolUses }),
    Harness.Claude
  );
  assert.equal(
    evidence.structural.gitLifecycle.branchesTouched.length,
    50,
    "branchesTouched caps at MAX_BRANCHES_TOUCHED like mutationTargets"
  );
  assert.equal(evidence.structural.mutationTargets.length, 50);
});

test("trace-phase sources fold into declared evidence", () => {
  const evidence = buildSessionEvidence(
    sessionWith({ toolUses: [tool("Read")] }),
    Harness.Claude,
    {
      tracePhaseSources: [
        {
          sourceType: "explicit",
          phaseKey: "implement",
          label: "Implement",
          startedAt: TS,
          endedAt: null,
        },
      ],
    }
  );
  const tracePhase = evidence.declared.find((d) => d.kind === "trace_phase");
  assert.ok(tracePhase, "the declared layer surfaces the trace phase");
  assert.equal(tracePhase?.name, "Implement");
});

test("unknown harness degrades to structural-only and never throws", () => {
  const build = () =>
    buildSessionEvidence(
      sessionWith({
        userMessages: 2,
        assistantMessages: 1,
        toolUses: [
          tool("Bash", { input: { command: "git commit -m z" } }),
          tool("mcp__closedloop__ping"),
        ],
      }),
      "future-harness" as Harness
    );
  assert.doesNotThrow(build);
  const evidence = build();
  assert.equal(evidence.harnessKnown, false);
  // No adapter categorized the Bash tool → no structural tool categories.
  assert.equal(evidence.structural.categoryMix[ToolCategory.RunCommand], 0);
  assert.equal(evidence.structural.categoryMix[ToolCategory.GitLifecycle], 0);
  // But harness-agnostic signals survive: humanTurnDensity + the mcp__ convention.
  assert.equal(evidence.structural.humanTurnDensity.humanTurns, 2);
  assert.equal(evidence.declared.length, 1);
  assert.equal(evidence.declared[0].kind, "mcp_call");
});

test("unknown tool in a known harness categorizes to null without error", () => {
  const evidence = buildSessionEvidence(
    sessionWith({ toolUses: [tool("TotallyMadeUpTool")] }),
    Harness.Claude
  );
  for (const category of TOOL_CATEGORY_VALUES) {
    if (category !== ToolCategory.HumanTurn) {
      assert.equal(
        evidence.structural.categoryMix[category],
        0,
        `${category} stays zero for an unrecognized tool`
      );
    }
  }
});

test("totality: an empty session yields well-formed, empty evidence", () => {
  const evidence = buildSessionEvidence(sessionWith(), Harness.Claude);
  assert.equal(evidence.declared.length, 0);
  assert.deepEqual(evidence.linguistic, []);
  assert.deepEqual(evidence.structural.mutationTargets, []);
  assert.deepEqual(evidence.structural.gitLifecycle, {
    commits: 0,
    branchesTouched: [],
    prsCreated: 0,
  });
  for (const category of TOOL_CATEGORY_VALUES) {
    assert.equal(evidence.structural.categoryMix[category], 0);
  }
});

describe("anti-over-fitting boundary guard", () => {
  const MAIN_DIR = join(import.meta.dirname, "..", "src", "main", "collectors");
  // Distinctive concrete harness tool-name literals that must appear ONLY in
  // adapters, never in the harness-blind core. (`mcp__`/`skillName` are
  // cross-harness conventions and are intentionally excluded.)
  const VENDOR_TOOL_NAMES = [
    "Bash",
    "Grep",
    "Glob",
    "MultiEdit",
    "NotebookEdit",
    "apply_patch",
    "exec_command",
    "local_shell_call",
    "file_edit",
    "copilot_tool",
    "opencode_tool",
  ];

  // Strip comments so the guard checks executable source, not the doc comments
  // that legitimately cite these names as examples.
  function stripComments(src: string): string {
    return src.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");
  }

  function coreSource(file: string): string {
    return stripComments(
      readFileSync(join(MAIN_DIR, "evidence", file), "utf8")
    );
  }

  test("the harness-blind core references no concrete harness tool name", () => {
    for (const file of ["evidence-model.ts", "build-session-evidence.ts"]) {
      const src = coreSource(file);
      for (const vendorName of VENDOR_TOOL_NAMES) {
        assert.ok(
          !src.includes(vendorName),
          `${file} must not reference the harness tool name "${vendorName}" — it belongs only in adapters/`
        );
      }
    }
  });

  test("each adapter owns its harness vocabulary (vendor strings live here)", () => {
    const adapter = (file: string): string =>
      readFileSync(join(MAIN_DIR, "evidence", "adapters", file), "utf8");
    assert.ok(adapter("claude-adapter.ts").includes("Bash"));
    assert.ok(adapter("codex-adapter.ts").includes("apply_patch"));
    assert.ok(adapter("cursor-adapter.ts").includes("file_edit"));
    assert.ok(adapter("opencode-adapter.ts").includes("opencode_tool"));
  });
});
