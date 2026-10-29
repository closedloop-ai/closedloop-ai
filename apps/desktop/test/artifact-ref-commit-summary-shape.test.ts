/**
 * @file artifact-ref-commit-summary-shape.test.ts
 * @description ISS-8751: the `git commit` branch pass must key on the real
 * summary-line shape `[<branch> <sha>]`, not on "a bracket followed by a token
 * whose successor starts with a hex digit".
 *
 * Lives in its own file rather than in `artifact-ref-extractor.test.ts`, which is
 * a grandfathered 3.2k-line offender the repo's file-size rule forbids growing.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { extractArtifactRefs } from "../src/main/collectors/parsing/artifact-ref-extractor.js";
import { makeSession, NOW } from "./artifact-ref-session-fixture.js";

/** Every bracketed line below was taken verbatim from the golden corpus. */
const REAL_CORPUS_NOISE = [
  "[lc diagnostics: errors=0, warnings=0, other=0, omitted_lines=238]",
  "[Errno 2] No such file or directory",
  "[List any hygiene findings from deterministic checks]",
  "[Some commands were truncated]",
  "[full diff: rtk git diff --no-compact]",
];

function branchNamesFrom(command: string, output: string): string[] {
  const refs = extractArtifactRefs(
    makeSession({
      toolUses: [{ name: "Bash", timestamp: NOW, input: { command }, output }],
    }),
    NOW
  );
  // `?? "<unnamed>"` rather than a filter: a branch ref minted WITHOUT a name is
  // still a minted branch ref, and must fail the "mints nothing" assertions
  // instead of being silently dropped.
  return refs
    .filter((r) => r.targetKind === "branch")
    .map((r) => r.branchName ?? "<unnamed>");
}

describe("git commit summary-line shape (ISS-8751)", () => {
  test("a real summary line still mints its branch", () => {
    assert.deepEqual(
      branchNamesFrom(
        'git commit -m "real"',
        "[feat/fea-1684 abc1234] real\n 1 file changed"
      ),
      ["feat/fea-1684"]
    );
  });

  test("a quiet commit whose output carries only a tool banner mints nothing", () => {
    // The exact shape that put a phantom `lc` branch in the store: `-q` suppresses
    // git's own summary line, leaving the harness banner as the only bracketed
    // text, and `d` of "diagnostics" is a hex digit.
    assert.deepEqual(
      branchNamesFrom(
        "git add package.json && git commit -q",
        "[lc diagnostics: errors=0, warnings=0, other=0, omitted_lines=238]"
      ),
      []
    );
  });

  for (const line of REAL_CORPUS_NOISE) {
    test(`bracketed log line mints no branch: ${line.slice(0, 40)}`, () => {
      assert.deepEqual(branchNamesFrom('git commit -m "work"', line), []);
    });
  }

  test("noise alongside a real summary line leaves only the real branch", () => {
    assert.deepEqual(
      branchNamesFrom(
        'git commit -m "real"',
        [
          "[Errno 2] No such file or directory",
          "[main abc1234] real",
          "[lc diagnostics: errors=0]",
        ].join("\n")
      ),
      ["main"]
    );
  });

  test("detached HEAD and root-commit summaries still mint no branch", () => {
    assert.deepEqual(
      branchNamesFrom(
        'git commit -m "detached"',
        "[detached HEAD abc1234] detached"
      ),
      []
    );
    assert.deepEqual(
      branchNamesFrom(
        'git commit -m "first"',
        "[main (root-commit) abc1234] first"
      ),
      []
    );
  });

  test("a short hex run is not a sha", () => {
    // Six hex characters is below git's 7-char abbreviation floor, so this is a
    // log line and not a summary. The pre-ISS-8751 shape accepted it.
    assert.deepEqual(
      branchNamesFrom('git commit -m "work"', "[tag abc123] not a commit"),
      []
    );
  });

  test("the branch pass is never narrower than the commit pass", () => {
    // GIT_COMMIT_SUMMARY_RE alt A additionally requires a non-empty subject. A
    // summary line without one must still mint a branch, so no commit can exist
    // with no branch row to resolve onto.
    assert.deepEqual(branchNamesFrom('git commit -m ""', "[feat/x abc1234]"), [
      "feat/x",
    ]);
  });
});
