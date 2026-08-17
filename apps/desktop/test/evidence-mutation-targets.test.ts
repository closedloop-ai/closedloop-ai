/**
 * @file evidence-mutation-targets.test.ts
 * @description FEA-4010 (AA-09 C1) end-to-end tests for MUTATION TARGETS through
 * the real adapter boundary: what paths a mutating tool use reports, and which of
 * `MutateCode` / `MutateDocument` / `MutateScratch` it therefore lands in.
 *
 * Split out of `evidence-model.test.ts`, which reached the 1,000-line ceiling.
 * The pure path-taxonomy rules are unit-tested in `mutation-kind.test.ts`; these
 * drive the whole core so the adapter hooks, the Codex envelope parser, and the
 * category refinement are exercised together.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { codexAdapter } from "../src/main/collectors/evidence/adapters/codex-adapter.js";
import { buildSessionEvidence } from "../src/main/collectors/evidence/build-session-evidence.js";
import { ToolCategory } from "../src/main/collectors/evidence/evidence-model.js";
import { Harness } from "../src/main/collectors/types.js";
import {
  categoryOf,
  sessionWith,
  tool,
} from "./evidence-mutation-targets-shared.js";

describe("FEA-4010 (AA-09 C1): apply_patch mutation targets", () => {
  const patch = (...lines: string[]) =>
    ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

  test("a single-file patch yields the path, not the patch blob", () => {
    // Before this fix `mutationTarget` returned a string input verbatim, and a
    // Codex patch IS the input — so 65 of the corpus's 224 mutations (100% of
    // Codex's) stored the whole envelope where a path belongs.
    const evidence = buildSessionEvidence(
      sessionWith({
        toolUses: [
          tool("apply_patch", {
            input: patch(
              "*** Update File: src/app.ts",
              "@@",
              "-const a = 1;",
              "+const a = 2;"
            ),
          }),
        ],
      }),
      Harness.Codex
    );
    assert.deepEqual(evidence.structural.mutationTargets, ["src/app.ts"]);
  });

  test("one patch naming several files yields every path", () => {
    // 8 of 65 corpus patches are multi-file; the largest names 14. A singular
    // return would have kept only the first.
    const evidence = buildSessionEvidence(
      sessionWith({
        toolUses: [
          tool("apply_patch", {
            input: patch(
              "*** Update File: a.ts",
              "+x",
              "*** Add File: b/new.ts",
              "+y",
              "*** Delete File: c/old.ts",
              "*** Move to: d/renamed.ts"
            ),
          }),
        ],
      }),
      Harness.Codex
    );
    assert.deepEqual(evidence.structural.mutationTargets, [
      "a.ts",
      "b/new.ts",
      "c/old.ts",
      "d/renamed.ts",
    ]);
  });

  test("patch CONTENT that looks like a directive is not one", () => {
    // Body lines are always prefixed (`+`/`-`/space), so an added line whose
    // text begins with `***` must not be read as a file directive — otherwise a
    // patch that edits documentation ABOUT the patch format invents paths.
    const evidence = buildSessionEvidence(
      sessionWith({
        toolUses: [
          tool("apply_patch", {
            input: patch(
              "*** Update File: docs/format.md",
              "+*** Update File: not-a-real-path.ts",
              "-*** Delete File: also-not-real.ts",
              " *** Add File: still-not-real.ts"
            ),
          }),
        ],
      }),
      Harness.Codex
    );
    assert.deepEqual(evidence.structural.mutationTargets, ["docs/format.md"]);
  });

  test("the structured {path, patch} shape reports every file the patch names", () => {
    const evidence = buildSessionEvidence(
      sessionWith({
        toolUses: [
          tool("apply_patch", {
            input: {
              path: "utils.ts",
              patch: patch(
                "*** Update File: utils.ts",
                "*** Add File: sibling.ts"
              ),
            },
          }),
        ],
      }),
      Harness.Codex
    );
    assert.deepEqual(evidence.structural.mutationTargets, [
      "utils.ts",
      "sibling.ts",
    ]);
  });

  test("a multi-line NON-patch input names no path at all", () => {
    // The generic fallback previously accepted any string. A path never spans
    // lines, so declining is the honest answer — a consumer can tell "unknown"
    // from a fabricated path.
    const evidence = buildSessionEvidence(
      sessionWith({
        toolUses: [tool("apply_patch", { input: "some\nmultiline\nblob" })],
      }),
      Harness.Codex
    );
    assert.deepEqual(evidence.structural.mutationTargets, []);
  });

  test("a CRLF-captured patch resolves its directives (Windows transcripts)", () => {
    // `\r` is a LINE TERMINATOR to a JS regex, so `.` cannot consume it and `$`
    // (no `m` flag) sits after it: splitting on "\n" alone left the trailing
    // `\r` and the directive pattern matched nothing. The failure was silent and
    // total — `*** Begin Patch` still matched (`\s` accepts `\r`), so the
    // adapter claimed the payload and returned ZERO targets, which
    // `mutationTargetsFor` reads as authoritative and never falls back from. Every
    // mutation in a Windows-captured Codex session collapsed to `MutateCode`,
    // undoing AA-09 C1 for that harness+platform with no error anywhere.
    const lines = [
      "*** Begin Patch",
      "*** Update File: README.md",
      "*** Add File: docs/guide.md",
      "*** End Patch",
    ];
    for (const [label, sep] of [
      ["LF", "\n"],
      ["CRLF", "\r\n"],
    ] as const) {
      const evidence = buildSessionEvidence(
        sessionWith({
          toolUses: [tool("apply_patch", { input: lines.join(sep) })],
        }),
        Harness.Codex
      );
      assert.deepEqual(
        evidence.structural.mutationTargets,
        ["README.md", "docs/guide.md"],
        `${label} directives must resolve identically`
      );
      assert.equal(
        evidence.structural.categoryMix[ToolCategory.MutateDocument],
        1,
        `${label} must reach the document category, not the MutateCode default`
      );
    }
  });

  test("a non-Codex harness keeps resolving through the generic path scan", () => {
    // Generality guard: the envelope parser belongs to the Codex adapter, so
    // another stack's editor tool — different vocabulary, non-JS file — is
    // untouched by any of the above and still reads its own path field.
    const evidence = buildSessionEvidence(
      sessionWith({
        toolUses: [tool("file_edit", { input: { path: "lib/thing.rb" } })],
      }),
      Harness.Cursor
    );
    assert.deepEqual(evidence.structural.mutationTargets, ["lib/thing.rb"]);
  });

  test("a Codex patch envelope arriving on ANOTHER harness is not parsed as one", () => {
    // The parser is adapter-scoped by design: Cursor's `file_edit` never carries
    // this shape, and if a payload ever did, inventing paths from it would be a
    // cross-harness guess. The generic scan declines the multi-line string.
    const evidence = buildSessionEvidence(
      sessionWith({
        toolUses: [
          tool("file_edit", { input: patch("*** Update File: leaked.ts") }),
        ],
      }),
      Harness.Cursor
    );
    assert.deepEqual(evidence.structural.mutationTargets, []);
  });

  test("the target bound holds across a patch that names more files than remain", () => {
    // The cap is re-checked per PATH, not once per tool, so a large patch
    // arriving near the bound cannot overshoot it.
    const files = Array.from(
      { length: 60 },
      (_, i) => `*** Update File: f${i}.ts`
    );
    const evidence = buildSessionEvidence(
      sessionWith({
        toolUses: [tool("apply_patch", { input: patch(...files) })],
      }),
      Harness.Codex
    );
    assert.equal(evidence.structural.mutationTargets.length, 50);
    assert.deepEqual(evidence.structural.mutationTargets[0], "f0.ts");
  });
});

describe("FEA-4010 (AA-09 C1): mutations categorized by target", () => {
  const patch = (...lines: string[]) =>
    ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

  test("a Claude write to its own memory store is scratch, not code", () => {
    // 413572cc: 19 of these against 17 real source edits, all reading as
    // implementation of files the project never contained.
    assert.equal(
      categoryOf(
        Harness.Claude,
        tool("Write", {
          input: {
            file_path:
              "/Users/dev/.claude/projects/-Users-dev-repo/memory/MEMORY.md",
          },
        })
      ),
      ToolCategory.MutateScratch
    );
    // 6c8d9591: the commit-message transient that anchored implement across
    // 10.7 minutes of PR admin and CI triage.
    assert.equal(
      categoryOf(
        Harness.Claude,
        tool("Edit", { input: { file_path: "/tmp/.commit-msg-fea1459" } })
      ),
      ToolCategory.MutateScratch
    );
  });

  test("a source edit under a temp-hosted worktree stays code (the near-miss)", () => {
    // c980bd56 edits real source in a checkout under `/tmp`, and its own `cwd`
    // is `/private/tmp`. Both a temp-prefix rule and an out-of-workspace rule
    // would have demoted this genuine implementation.
    assert.equal(
      categoryOf(
        Harness.Claude,
        tool("Edit", {
          input: {
            file_path:
              "/tmp/nrev/perf-pete-7-cursor/apps/desktop/src/main/collectors/cursor/cursor-parser.ts",
          },
        })
      ),
      ToolCategory.MutateCode
    );
  });

  test("documentation is its own category, and config is not documentation", () => {
    assert.equal(
      categoryOf(
        Harness.Claude,
        tool("Write", { input: { file_path: "/repo/docs/runbook.md" } })
      ),
      ToolCategory.MutateDocument
    );
    assert.equal(
      categoryOf(
        Harness.Claude,
        tool("Edit", {
          input: { file_path: "/repo/.github/workflows/pr-test.yml" },
        })
      ),
      ToolCategory.MutateCode
    );
  });

  test("a Codex patch is categorized from the paths inside the envelope", () => {
    // The blocker and C1 compose: without the envelope parse there is no path to
    // classify, so every Codex mutation would sit on the `MutateCode` default and
    // the taxonomy would be blind in a HARNESS-correlated way.
    assert.equal(
      categoryOf(
        Harness.Codex,
        tool("apply_patch", {
          input: patch("*** Update File: /private/tmp/pr204-body.md"),
        })
      ),
      ToolCategory.MutateScratch
    );
    assert.equal(
      categoryOf(
        Harness.Codex,
        tool("apply_patch", {
          input: patch("*** Update File: /repo/README.md"),
        })
      ),
      ToolCategory.MutateDocument
    );
    // A mixed patch keeps its implement signal: one source file decides.
    assert.equal(
      categoryOf(
        Harness.Codex,
        tool("apply_patch", {
          input: patch(
            "*** Update File: /repo/README.md",
            "*** Update File: /repo/src/main.ts"
          ),
        })
      ),
      ToolCategory.MutateCode
    );
  });

  test("mutationTargets still reports paths of EVERY kind", () => {
    // The aggregate answers "what did this session touch"; scoping it to the
    // code kind would stop it reporting the very paths that motivated the split.
    const evidence = buildSessionEvidence(
      sessionWith({
        toolUses: [
          tool("Write", { input: { file_path: "/repo/src/a.ts" } }),
          tool("Write", { input: { file_path: "/repo/README.md" } }),
          tool("Write", { input: { file_path: "/tmp/.commit-msg-x" } }),
        ],
      }),
      Harness.Claude
    );
    assert.deepEqual(evidence.structural.mutationTargets, [
      "/repo/src/a.ts",
      "/repo/README.md",
      "/tmp/.commit-msg-x",
    ]);
    const { categoryMix } = evidence.structural;
    assert.equal(categoryMix[ToolCategory.MutateCode], 1);
    assert.equal(categoryMix[ToolCategory.MutateDocument], 1);
    assert.equal(categoryMix[ToolCategory.MutateScratch], 1);
  });

  test("a plugin's bookkeeping is scratch on EVERY harness that runs it", () => {
    // The Closedloop code-review plugin writes the same `.closedloop-ai/` tree
    // whether Claude Code or Codex drove it, so this must not be a per-harness
    // rule. One corpus session's entire mutation signal is six such writes and
    // it reported 40% implement; two more log them as implement islands inside
    // declared review walks.
    assert.equal(
      categoryOf(
        Harness.Claude,
        tool("Write", {
          input: {
            file_path: "/repo/.closedloop-ai/code-review/cr-99578/setup.json",
          },
        })
      ),
      ToolCategory.MutateScratch
    );
    assert.equal(
      categoryOf(
        Harness.Codex,
        tool("apply_patch", {
          input: patch(
            "*** Update File: /repo/.closedloop-ai/code-review-threads.json"
          ),
        })
      ),
      ToolCategory.MutateScratch
    );
    // Its user-authored files remain real work on both.
    assert.equal(
      categoryOf(
        Harness.Claude,
        tool("Edit", {
          input: {
            file_path: "/repo/.closedloop-ai/settings/critic-gates.json",
          },
        })
      ),
      ToolCategory.MutateCode
    );
  });

  test("a structured patch keeps BOTH its `path` field and its directives", () => {
    // Returning either side alone suppresses the generic scan that would have
    // read the other, so a source file named only in `path` beside a
    // documentation-only envelope was downgraded to documentation.
    const evidence = buildSessionEvidence(
      sessionWith({
        toolUses: [
          tool("apply_patch", {
            input: {
              path: "src/a.ts",
              patch: patch("*** Update File: README.md"),
            },
          }),
        ],
      }),
      Harness.Codex
    );
    assert.deepEqual(evidence.structural.mutationTargets, [
      "src/a.ts",
      "README.md",
    ]);
    assert.equal(
      evidence.structural.categoryMix[ToolCategory.MutateCode],
      1,
      "the source file must still decide the category"
    );
  });

  test("directives trailing a COMPLETED envelope are not read as part of it", () => {
    // Scanning stops at the terminator. A truncated envelope (no terminator at
    // all) deliberately still yields its captured directives — discarding real
    // mutations to guard a shape the corpus does not contain would trade recall
    // for nothing.
    const evidence = buildSessionEvidence(
      sessionWith({
        toolUses: [
          tool("apply_patch", {
            input: [
              "*** Begin Patch",
              "*** Update File: README.md",
              "*** End Patch",
              "*** Update File: src/injected.ts",
            ].join("\n"),
          }),
        ],
      }),
      Harness.Codex
    );
    assert.deepEqual(evidence.structural.mutationTargets, ["README.md"]);
    assert.equal(
      evidence.structural.categoryMix[ToolCategory.MutateDocument],
      1,
      "a trailing directive must not promote a docs-only patch to source"
    );
    // Truncated mid-patch: the captured directive is still a real mutation.
    const truncated = buildSessionEvidence(
      sessionWith({
        toolUses: [
          tool("apply_patch", {
            input: "*** Begin Patch\n*** Update File: src/a.ts\n+const x = 1;",
          }),
        ],
      }),
      Harness.Codex
    );
    assert.deepEqual(truncated.structural.mutationTargets, ["src/a.ts"]);
  });

  test("an unreadable target keeps the pre-C1 default (fail-safe direction)", () => {
    // No path the extraction can read → `MutateCode`, exactly as before. The
    // refinement can only ever remove an over-claim, never invent one.
    assert.equal(
      categoryOf(Harness.Claude, tool("Write", { input: { unexpected: 1 } })),
      ToolCategory.MutateCode
    );
  });

  test("a structured apply_patch with no USABLE path yields the envelope's directives alone (ISS-5302)", () => {
    // The `{ path, patch }` shape answers with both sides, so the `path` side
    // has to be OMITTED rather than emitted as a blank when the input carries
    // none. A whitespace or multi-line value is the same case: neither is a
    // path, and prepending one puts a non-path where the taxonomy reads an
    // extension — which is how a source edit gets downgraded to documentation.
    for (const input of [
      { patch: patch("*** Update File: src/only-in-patch.ts") },
      { path: "   ", patch: patch("*** Update File: src/only-in-patch.ts") },
      {
        path: "*** Begin Patch\n*** Update File: src/leaked.ts",
        patch: patch("*** Update File: src/only-in-patch.ts"),
      },
    ]) {
      const evidence = buildSessionEvidence(
        sessionWith({ toolUses: [tool("apply_patch", { input })] }),
        Harness.Codex
      );
      assert.deepEqual(
        evidence.structural.mutationTargets,
        ["src/only-in-patch.ts"],
        `no usable path in ${JSON.stringify(input)}`
      );
      assert.equal(
        evidence.structural.categoryMix[ToolCategory.MutateCode],
        1,
        "the envelope's own source file still decides the category"
      );
    }
  });

  test("the Codex adapter declines to answer for a non-mutating tool, so the generic extraction still runs (ISS-5302)", () => {
    // `mutationTargetsFor` treats ANY array the adapter returns — including an
    // empty one — as an answer and stops there. So `[]` for a tool the adapter
    // has no opinion about would SUPPRESS the generic `file_path`/`path` scan
    // for it; `null` is the only value that keeps that fallback reachable.
    assert.ok(codexAdapter.mutationTargets, "the adapter owns this hook");
    assert.equal(
      codexAdapter.mutationTargets(tool("shell", { input: { command: "ls" } })),
      null
    );
    assert.equal(
      codexAdapter.mutationTargets(
        tool("Write", { input: { file_path: "src/a.ts" } })
      ),
      null,
      "a tool name Codex never emits is not this adapter's to answer for"
    );
    // The consequence, through the real core: an `apply_patch` whose payload is
    // not a recognizable envelope also declines, and the generic scan reads the
    // path the adapter would otherwise have hidden.
    const evidence = buildSessionEvidence(
      sessionWith({
        toolUses: [
          tool("apply_patch", { input: { file_path: "src/generic.ts" } }),
        ],
      }),
      Harness.Codex
    );
    assert.deepEqual(evidence.structural.mutationTargets, ["src/generic.ts"]);
  });
});
