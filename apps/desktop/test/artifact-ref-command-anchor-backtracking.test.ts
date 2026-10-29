/**
 * @file artifact-ref-command-anchor-backtracking.test.ts
 * @description ISS-6003 — the `gh pr …` command-position anchor must not
 * backtrack catastrophically, and must still accept the env-assignment prefix it
 * was written for.
 *
 * A db-host CPU profile of a boot import against a real 2 GB store attributed
 * 108,353 ms of 240,679 ms sampled — 45% of the whole process — to one frame:
 * `RegExp: (?:^|[;&|(\n\t])\s*(?:\S+=\S+\s+)*gh\s+pr\s+(?:view|…)`, under
 * `isPrReviewCommand` ← `emitReviewedPrRefs` ← `extractArtifactRefs` ←
 * `buildImportSessionContext`. Two blowups live in that shape, and each fixture
 * below covers one:
 *
 *  - MULTI-EQUALS tokens. `\S+=\S+` can split a token at any of its `=`, so the
 *    repeated group explores the product. Ten `a=b=c=d=e=f=g=h` tokens: 13,521 ms
 *    for one `.test()`.
 *  - A HEREDOC of `KEY=value` lines. The pattern is unanchored, so it restarts at
 *    every newline and the unbounded `*` walked to the end of the input from each
 *    one: 500 lines 7 ms, 8,000 lines 4,617 ms. This is the one real transcripts
 *    hit constantly, and the one that kept the profile pinned after the first fix.
 *
 * These tests read no clock, so they assert nothing about duration — under the
 * old pattern the extractor simply does not return and the suite's own cap fails
 * the run. The accept/reject cases beside them are what stops the guard being
 * satisfiable by a pattern that merely matches nothing.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { GH_PR_CREATE_REGEX } from "../src/main/collectors/parsing/artifact-ref-command-patterns.js";
import { extractArtifactRefs } from "../src/main/collectors/parsing/artifact-ref-extractor.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { makeSession as baseSession } from "./normalized-session-test-utils.js";

const NOW = "2024-01-01T12:00:00.000Z";
const REPO = "closedloop-ai/closedloop-ai";

/**
 * A shell command in the shape real transcripts carry: command-position
 * anchored, then a run of `=`-dense tokens (flags, URLs, and JSON all produce
 * them) that never reaches a `gh pr` subcommand — the FAILING match is the
 * expensive one.
 */
const MULTI_EQUALS_TOKENS = 14;
const MULTI_EQUALS_COMMAND = `\n${Array.from(
  { length: MULTI_EQUALS_TOKENS },
  () => "a=b=c=d=e=f=g=h"
).join(" ")} tail`;

/**
 * The shape real transcripts produce: a heredoc writing assignment-shaped lines.
 * Every newline is a command-position anchor, so an unbounded assignment prefix
 * re-walks the rest of the document from each one.
 */
const HEREDOC_ASSIGNMENT_LINES = 8000;
const HEREDOC_COMMAND = `cat <<EOF\n${Array.from(
  { length: HEREDOC_ASSIGNMENT_LINES },
  (_, i) => `KEY${i}=value${i}`
).join("\n")}\nEOF`;

function makeSession(
  overrides: Partial<NormalizedSession> = {}
): NormalizedSession {
  return baseSession({
    sessionId: "iss6003-backtracking",
    name: "test",
    cwd: null,
    model: null,
    startedAt: "2024-01-01T00:00:00.000Z",
    endedAt: null,
    ...overrides,
  });
}

describe("gh pr command-position anchor", () => {
  for (const [shape, command] of [
    ["=-dense tokens", MULTI_EQUALS_COMMAND],
    ["a heredoc of KEY=value lines", HEREDOC_COMMAND],
  ] as const) {
    test(`${shape}: terminates through the real extractor`, () => {
      const refs = extractArtifactRefs(
        makeSession({
          toolUses: [
            {
              name: "Bash",
              timestamp: null,
              input: { command },
              output: "",
              gitBranch: null,
            },
          ],
        }),
        NOW
      );
      assert.equal(
        refs.filter((r) => r.targetKind === "pull_request").length,
        0,
        "a command that runs no gh pr subcommand yields no PR ref"
      );
    });
  }

  test("still recognizes a review command behind env assignments", () => {
    const refs = extractArtifactRefs(
      makeSession({
        cwd: "/work/closedloop-ai",
        artifacts: { prs: [], issues: [], repo: REPO },
        toolUses: [
          {
            name: "Bash",
            timestamp: null,
            input: {
              command: "\nGH_TOKEN=x PAGER=cat gh pr view 4242 --json title",
            },
            output: "Title: Some reviewed PR\n",
          },
        ],
      }),
      NOW
    );
    const reviewed = refs.find(
      (r) => r.targetKind === "pull_request" && r.prNumber === 4242
    );
    assert.equal(
      reviewed?.relation,
      "reviewed",
      "the env-assignment prefix must not stop the review from being recognized"
    );
  });

  test("an env-assignment VALUE may still carry '=' signs", () => {
    // The narrowed NAME is `[^\s=]+`; the value stays `\S+`, so `A=b=c` is an
    // assignment exactly as it was before. This is the case a name-and-value
    // narrowing would have silently broken.
    assert.ok(GH_PR_CREATE_REGEX.test("\nOPTS=a=b=c gh pr create --fill"));
    assert.ok(GH_PR_CREATE_REGEX.test("\nFOO=1 BAR=2 gh pr create --fill"));
    assert.ok(GH_PR_CREATE_REGEX.test("gh pr create --fill"));
    assert.ok(GH_PR_CREATE_REGEX.test("cd x && gh pr create"));
  });

  test("the env-assignment prefix is bounded, and the bound covers real commands", () => {
    // Eight is the bound; a realistic prefix is one or two.
    const eight = Array.from({ length: 8 }, (_, i) => `K${i}=v${i}`).join(" ");
    assert.ok(
      GH_PR_CREATE_REGEX.test(`\n${eight} gh pr create --fill`),
      "a prefix at the bound must still classify"
    );
    // Past the bound the command no longer classifies. This is the deliberate,
    // documented narrowing that buys the linear scan — asserted so it is a
    // decision on record rather than a silent edge.
    const nine = `${eight} K8=v8`;
    assert.equal(
      GH_PR_CREATE_REGEX.test(`\n${nine} gh pr create --fill`),
      false
    );
  });

  test("the env-assignment NAME may not itself contain '='", () => {
    // This is what pins the `[^\s=]+` narrowing. The two `terminates through
    // the real extractor` cases above cannot: their verdict is the same under
    // both patterns, so they only ever differ in DURATION, and with the `{0,8}`
    // bound in place widening the name back to `\S+` costs 476 ms on the
    // 14-token fixture — comfortably inside the lane's 120 s per-test cap. A
    // deterministic accepted-set assertion has no such headroom to hide in.
    for (const notAnAssignment of [
      "\n=a=b gh pr create --fill",
      "\n==== gh pr create --fill",
    ]) {
      assert.equal(
        GH_PR_CREATE_REGEX.test(notAnAssignment),
        false,
        "a token whose first '=' is at index 0 is not an env assignment"
      );
    }
  });

  test("a space-preceded mention is still not a command", () => {
    assert.equal(
      GH_PR_CREATE_REGEX.test('echo "run gh pr create later"'),
      false
    );
  });
});
