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
import { describe, test } from "vitest";
import { fallbackAdapter } from "../src/main/collectors/evidence/adapters/fallback-adapter.js";
import {
  buildEvidenceTimeline,
  categoryMixForToolUses,
  collectDeclared,
  resolveAdapter,
} from "../src/main/collectors/evidence/build-session-evidence.js";
import {
  DeclaredKind,
  EVIDENCE_MODEL_VERSION,
  EvidenceLayer,
  TOOL_CATEGORY_VALUES,
  ToolCategory,
} from "../src/main/collectors/evidence/evidence-model.js";
import { Harness } from "../src/main/collectors/types.js";
import {
  categoryOf,
  sessionWith,
  TS,
  tool,
} from "./evidence-mutation-targets-shared.js";

// Hoisted to module scope (Biome `useTopLevelRegex`): the boundary guard's
// comment-stripper reuses these rather than recompiling the literals per call.
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:])\/\/[^\n]*/g;

test("canonical ToolCategory member set is pinned (guards vocabulary drift)", () => {
  assert.deepEqual(
    [...TOOL_CATEGORY_VALUES],
    [
      "read_search",
      "mutate_code",
      "mutate_document",
      "mutate_scratch",
      "run_command",
      "test_run",
      "git_lifecycle",
      "human_turn",
      "declared_intent",
      "declared_plan",
      "declared_utility",
    ],
    "the abstract category vocabulary is the SSOT FEA-2269 reads; changing it is a versioned, deliberate act"
  );
  assert.equal(TOOL_CATEGORY_VALUES.length, 11);
  // Unchanged vocabulary at v8 — AA-09's test detection changed how `TestRun` is
  // DECIDED, not which categories exist.
  assert.equal(EVIDENCE_MODEL_VERSION, 8);
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
    assert.equal(
      categoryOf(
        Harness.Claude,
        tool("Bash", { input: { command: "gh pr create --fill" } })
      ),
      ToolCategory.GitLifecycle,
      "the lifecycle vocabulary covers `gh pr create`, not only `git` itself"
    );
  });

  test("a tool name inside QUOTED text is looked for, not run", () => {
    // The lifecycle/test vocabularies match against quote-blanked text: a runner
    // named in a search pattern or an echoed label is the subject of a search,
    // not evidence that tests ran. 10 corpus lines fired only on quoted text.
    assert.equal(
      categoryOf(
        Harness.Claude,
        tool("Bash", { input: { command: `grep -rn "pnpm test" .github` } })
      ),
      ToolCategory.ReadSearch,
      "searching for a test command is exploration, not a test run"
    );
    assert.equal(
      categoryOf(
        Harness.Claude,
        tool("Bash", {
          input: { command: `echo "=== find vitest configs ==="` },
        })
      ),
      ToolCategory.ReadSearch
    );
    assert.equal(
      categoryOf(
        Harness.Claude,
        tool("Bash", { input: { command: `rg -n 'git push' docs` } })
      ),
      ToolCategory.ReadSearch,
      "searching for a lifecycle command is not performing one"
    );
    // The unquoted forms must still classify as before.
    assert.equal(
      categoryOf(
        Harness.Claude,
        tool("Bash", { input: { command: "pnpm test --run" } })
      ),
      ToolCategory.TestRun
    );
  });

  test("a test run AFTER a quoted heredoc body still reads as a test run", () => {
    // Regression: the test reader was handed quote-blanked text, but it strips
    // heredoc bodies BEFORE blanking quotes itself. Pre-blanking rewrote the
    // opener's delimiter to a filler word the closing `EOF` could never match, so
    // the body ran to end-of-string and swallowed the real `pnpm test` below it.
    // Only reachable through this production path — the reader's own unit tests
    // pass unblanked input, so they never saw it.
    assert.equal(
      categoryOf(
        Harness.Claude,
        tool("Bash", {
          input: {
            command: `cat > pr-body.md <<'EOF'\nTest plan: ran the suite.\nEOF\npnpm test`,
          },
        })
      ),
      ToolCategory.TestRun,
      "a heredoc body must not swallow the command that follows it"
    );
  });

  test("a bare Skill tool with no skill identifier yields no declared evidence", () => {
    const declaredSignals = collectDeclared(
      sessionWith({ toolUses: [tool("Skill")] }),
      resolveAdapter(Harness.Claude)
    );
    assert.equal(
      declaredSignals.length,
      0,
      'a Skill use with no skillName must not emit a misleading "Skill" record'
    );
  });

  test("Skill + slash command + mcp__ surface as declared evidence, split plan vs inert", () => {
    const declaredSignals = collectDeclared(
      sessionWith({
        slashCommands: [{ name: "/plan", timestamp: TS }],
        toolUses: [
          tool("Skill", { skillName: "code-review" }),
          tool("mcp__closedloop__get-document"),
        ],
      }),
      resolveAdapter(Harness.Claude)
    );
    const kinds = declaredSignals.map((d) => d.kind).sort();
    assert.deepEqual(kinds, ["mcp_call", "skill", "slash_command"]);
    // FEA-4184: `/plan` is a PLAN-specific declaration (DeclaredPlan); the plan
    // gate must see only that one. AA-03: the `code-review` skill and the
    // `get-document` MCP call are NOT positively recognized as work intent, so
    // they fall to the inert `DeclaredUtility` rather than minting a generic
    // `DeclaredIntent` that would stamp `declared` provenance and take the boost.
    const byKind = new Map(declaredSignals.map((d) => [d.kind, d.category]));
    assert.equal(byKind.get("slash_command"), ToolCategory.DeclaredPlan);
    assert.equal(byKind.get("skill"), ToolCategory.DeclaredUtility);
    assert.equal(byKind.get("mcp_call"), ToolCategory.DeclaredUtility);
    assert.equal(
      declaredSignals.filter((d) => d.category === ToolCategory.DeclaredPlan)
        .length,
      1,
      "the plan slash command folds into DeclaredPlan"
    );
    assert.equal(
      declaredSignals.filter((d) => d.category === ToolCategory.DeclaredUtility)
        .length,
      2,
      "the two unrecognized declarations fold into the inert DeclaredUtility"
    );
    assert.equal(
      declaredSignals.filter((d) => d.category === ToolCategory.DeclaredIntent)
        .length,
      0,
      "nothing fabricates generic declared intent"
    );
  });
});

describe("Codex adapter", () => {
  test("shell → RunCommand; apply_patch → MutateCode; mcpServer → declared McpCall", () => {
    // An UNREADABLE command keeps the adapter's base `RunCommand` — that is what
    // this assertion is about (the adapter maps the `shell` tool name into the
    // RunCommand family), so it uses a command the core cannot classify.
    assert.equal(
      categoryOf(
        Harness.Codex,
        tool("shell", { input: { command: "./scripts/deploy.sh --prod" } })
      ),
      ToolCategory.RunCommand
    );
    // AA-04: the same adapter category refines to `ReadSearch` when the command
    // text is confidently read-only — shell investigation is exploration.
    assert.equal(
      categoryOf(Harness.Codex, tool("shell", { input: { command: "ls" } })),
      ToolCategory.ReadSearch
    );
    assert.equal(
      categoryOf(Harness.Codex, tool("apply_patch")),
      ToolCategory.MutateCode
    );
    const declaredSignals = collectDeclared(
      sessionWith({
        toolUses: [
          tool("closedloop__get-document", {
            mcpServer: "closedloop",
            mcpMethod: "get-document",
          }),
        ],
      }),
      resolveAdapter(Harness.Codex)
    );
    assert.equal(declaredSignals.length, 1);
    assert.equal(declaredSignals[0].kind, "mcp_call");
    assert.equal(declaredSignals[0].name, "closedloop__get-document");
  });

  test("the MCP declaration name falls back cleanly when either half of the signal is absent (ISS-5302)", () => {
    // `mcp_tool_call_begin` is the only Codex event carrying the structured
    // `mcpServer`/`mcpMethod` pair. Both halves are independently optional, and
    // each fallback has to name the call in a form the declared layer can group
    // on — a trailing `__` or a dropped declaration would make the same MCP
    // server read as two different things, or as absent.
    const serverOnly = collectDeclared(
      sessionWith({
        toolUses: [tool("closedloop", { mcpServer: "closedloop" })],
      }),
      resolveAdapter(Harness.Codex)
    );
    assert.equal(serverOnly.length, 1);
    assert.equal(serverOnly[0].kind, DeclaredKind.McpCall);
    assert.equal(
      serverOnly[0].name,
      "closedloop",
      "no method → the server alone, never a dangling '__' separator"
    );

    // No structured server at all: the `mcp__server__method` display name is
    // the only signal, and it is what names the declaration.
    const nameOnly = collectDeclared(
      sessionWith({ toolUses: [tool("mcp__closedloop__ping")] }),
      resolveAdapter(Harness.Codex)
    );
    assert.equal(nameOnly.length, 1);
    assert.equal(nameOnly[0].kind, DeclaredKind.McpCall);
    assert.equal(nameOnly[0].name, "mcp__closedloop__ping");
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
  test('"copilot_tool" → null; the human turn is still the session\'s evidence', () => {
    assert.equal(categoryOf(Harness.Copilot, tool("copilot_tool")), null);
    // Nothing Copilot named is recognizable, so the human-turn layer is all the
    // timeline has — and it still gets drawn rather than the session coming
    // back empty.
    const timeline = buildEvidenceTimeline(
      sessionWith({
        messages: [{ role: "human", timestamp: TS, text: null }],
        toolUses: [tool("copilot_tool")],
      }),
      Harness.Copilot
    );
    assert.deepEqual(
      timeline.map((unit) => unit.category),
      [ToolCategory.HumanTurn]
    );
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

test("unknown harness degrades to structural-only and never throws", () => {
  const session = sessionWith({
    messages: [{ role: "human", timestamp: TS, text: null }],
    toolUses: [
      tool("Bash", { input: { command: "git commit -m z" } }),
      tool("mcp__closedloop__ping"),
    ],
  });
  const unknown = "future-harness" as Harness;
  // An unknown harness resolves to the generic fallback rather than `undefined`,
  // which is what keeps every path below from throwing.
  assert.equal(resolveAdapter(unknown), fallbackAdapter);
  const build = () => buildEvidenceTimeline(session, unknown);
  assert.doesNotThrow(build);
  // No adapter named `Bash`, so it contributes no structural category at all —
  // not a mis-categorized one.
  assert.deepEqual(
    build()
      .filter((unit) => unit.layer === EvidenceLayer.Structural)
      .map((unit) => unit.category),
    [ToolCategory.HumanTurn],
    "the harness-agnostic human turn survives; the unrecognized tool adds nothing"
  );
  // And the harness-agnostic `mcp__` naming convention still declares.
  const declaredSignals = collectDeclared(session, resolveAdapter(unknown));
  assert.equal(declaredSignals.length, 1);
  assert.equal(declaredSignals[0].kind, DeclaredKind.McpCall);
});

test("unknown tool in a known harness categorizes to null without error", () => {
  const mix = categoryMixForToolUses(
    [tool("TotallyMadeUpTool")],
    Harness.Claude
  );
  for (const category of TOOL_CATEGORY_VALUES) {
    if (category !== ToolCategory.HumanTurn) {
      assert.equal(
        mix[category],
        0,
        `${category} stays zero for an unrecognized tool`
      );
    }
  }
});

test("totality: an empty session yields well-formed, empty evidence", () => {
  const empty = sessionWith();
  assert.deepEqual(buildEvidenceTimeline(empty, Harness.Claude), []);
  assert.deepEqual(collectDeclared(empty, resolveAdapter(Harness.Claude)), []);
  const mix = categoryMixForToolUses(empty.toolUses, Harness.Claude);
  for (const category of TOOL_CATEGORY_VALUES) {
    assert.equal(mix[category], 0, `${category} is present and zero`);
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

// ── AA-03: declared signals are recognized, never assumed ─────────────────────

describe("AA-03 declared-signal categories", () => {
  test("unrecognized commands/skills/MCP calls are INERT, not declared intent", () => {
    // The corpus offenders: an auth command, a model switch, plugin management,
    // and work-tracking bookkeeping. None declares anything about the work.
    const declaredSignals = collectDeclared(
      sessionWith({
        slashCommands: [
          { name: "/login", timestamp: TS },
          { name: "/model", timestamp: TS },
          { name: "/plugin", timestamp: TS },
        ],
        toolUses: [tool("mcp__closedloop__update-document")],
      }),
      resolveAdapter(Harness.Claude)
    );
    assert.ok(
      declaredSignals.every((d) => d.category === ToolCategory.DeclaredUtility),
      `every unrecognized declaration is inert, got ${JSON.stringify(declaredSignals.map((d) => d.category))}`
    );
    assert.equal(
      declaredSignals.filter((d) => d.category === ToolCategory.DeclaredIntent)
        .length,
      0
    );
    assert.equal(
      declaredSignals.filter((d) => d.category === ToolCategory.DeclaredPlan)
        .length,
      0
    );
    assert.equal(
      declaredSignals.filter((d) => d.category === ToolCategory.DeclaredUtility)
        .length,
      4
    );
  });

  test("inert declarations STILL anchor the timeline (AA-01 idle detection is preserved)", () => {
    // eca0b151's shape: the session's ONLY records are two utility commands ~22 min
    // apart. Making them inert must not erase them from the timeline — the dead gap
    // between them is only discoverable because they still anchor time.
    const later = "2026-06-07T00:22:00.000Z";
    const timeline = buildEvidenceTimeline(
      sessionWith({
        slashCommands: [
          { name: "/plugin", timestamp: TS },
          { name: "/plugin", timestamp: later },
        ],
      }),
      Harness.Claude
    );
    assert.deepEqual(
      timeline.map((u) => u.ms),
      [Date.parse(TS), Date.parse(later)],
      "inert declarations are still emitted as time anchors"
    );
    assert.ok(
      timeline.every((u) => u.category === ToolCategory.DeclaredUtility),
      "…carrying the inert category"
    );
  });

  // Non-Closedloop-shaped fixture (PLN-1490 generality acceptance): a
  // JIRA/Sentry/Terraform shop whose command vocabulary shares nothing with ours.
  // Run across two harnesses so the rule is shown to key on a cross-harness plan
  // cue, never on one organization's command names or one adapter's behavior.
  // (Copilot surfaces MCP declarations only; Claude also surfaces skills — hence
  // the per-harness inert count.)
  for (const { harness, inert } of [
    { harness: Harness.Copilot, inert: 4 },
    { harness: Harness.Claude, inert: 5 },
  ]) {
    test(`generality: a different org's stack classifies identically (${harness})`, () => {
      const declaredSignals = collectDeclared(
        sessionWith({
          slashCommands: [
            { name: "/auth-refresh", timestamp: TS },
            { name: "/set-region", timestamp: TS },
            { name: "/create-plan", timestamp: TS },
          ],
          toolUses: [
            tool("mcp__jira__transition_issue"),
            tool("mcp__sentry__list_issues"),
            tool("Skill", { skillName: "terraform-deploy-runbook" }),
          ],
        }),
        resolveAdapter(harness)
      );
      assert.equal(
        declaredSignals.filter((d) => d.category === ToolCategory.DeclaredPlan)
          .length,
        1,
        "the plan command is recognized in any vocabulary"
      );
      assert.equal(
        declaredSignals.filter(
          (d) => d.category === ToolCategory.DeclaredUtility
        ).length,
        inert,
        "auth, region-switch and tracker signals are all inert"
      );
      assert.equal(
        declaredSignals.filter(
          (d) => d.category === ToolCategory.DeclaredIntent
        ).length,
        0,
        "nothing fabricates generic declared intent for an unfamiliar stack"
      );
    });
  }
});
