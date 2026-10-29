/**
 * @file artifact-ref-branch-path-arguments.test.ts
 * @description ISS-8751 (lower-severity siblings of the commit-summary defect):
 * `git worktree add --detach <path>` and `git checkout <file>` name a PATH, not
 * a branch, and neither may mint a branch artifact.
 *
 * Both are READ methods, so unlike the commit-summary phantom they never reached
 * the Branches surface or drew token attribution — but both were persisted.
 *
 * Lives in its own file rather than in `artifact-ref-extractor.test.ts`, which is
 * a grandfathered offender the repo's file-size rule forbids growing.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { extractArtifactRefs } from "../src/main/collectors/parsing/artifact-ref-extractor.js";
import { makeSession, NOW } from "./artifact-ref-session-fixture.js";

/**
 * Every branch name below was captured from the golden corpus by the pre-fix
 * regexes. All 15 are real; only the two phantoms in the tests below are not.
 */
const REAL_CORPUS_CHECKOUT_BRANCHES = [
  "main",
  "bot/nightly-testing-tina-2026-06-15",
  "bench/e2e-runner-size-fea-2172",
  "feature/FEA-1224",
  "ci/pause-arm-shadow-fea-2172",
  "kaitoc/pro-32-total-tokens",
  "docs/prework-checklist-install-verify",
];

function branchNamesFrom(command: string, output = ""): string[] {
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

describe("git worktree add --detach (ISS-8751)", () => {
  test("a detached worktree add mints nothing", () => {
    // Verbatim from dossier 3870c244. The leading `\S+` path slot ate the FLAG,
    // so the capture landed on the destination path and `isValidBranchName` had
    // no rule against a leading `/`.
    assert.deepEqual(
      branchNamesFrom(
        "git worktree add --detach /tmp/nrev-emergent-emma-1-93305 origin/bot/nightly-emergent-emma-2026-06-30"
      ),
      []
    );
  });

  test("a detached add with a RELATIVE destination also mints nothing", () => {
    // The leading-slash validator rule cannot catch this one, which is why the
    // `--detach` skip carries the contract rather than the validator alone.
    assert.deepEqual(branchNamesFrom("git worktree add --detach scratch"), []);
  });

  test("a normal worktree add still mints its branch", () => {
    assert.deepEqual(
      branchNamesFrom(
        "git worktree add ../example-infrastructure-desktop-jwt-secret -b desktop-session-jwt-secret"
      ),
      ["desktop-session-jwt-secret"]
    );
  });

  test("a flag-first worktree add still mints its branch", () => {
    assert.deepEqual(branchNamesFrom("git worktree add -b worktree-pln-1772"), [
      "worktree-pln-1772",
    ]);
  });
});

describe("git checkout of a path (ISS-8751)", () => {
  test("restoring a file mints nothing", () => {
    // Verbatim from dossier f04b2b82. `pnpm-lock.yaml` is a syntactically LEGAL
    // git branch name, so no validator can reject it — the shape has to be
    // rejected where the ambiguity lives.
    assert.deepEqual(branchNamesFrom("git checkout pnpm-lock.yaml"), []);
  });

  test("every real corpus branch still mints", () => {
    for (const branch of REAL_CORPUS_CHECKOUT_BRANCHES) {
      assert.deepEqual(
        branchNamesFrom(`git checkout ${branch}`),
        [branch],
        `${branch} must survive the path-argument rejection`
      );
    }
  });

  test("a numeric-suffixed branch is not mistaken for a file", () => {
    // The rejection matches an ALPHABETIC extension only, so a version-shaped
    // branch keeps working.
    assert.deepEqual(branchNamesFrom("git checkout release/2.0"), [
      "release/2.0",
    ]);
  });
});
