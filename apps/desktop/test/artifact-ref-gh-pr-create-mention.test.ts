/**
 * @file artifact-ref-gh-pr-create-mention.test.ts
 * @description ISS-8336: a `gh pr create` a session only MENTIONED must never
 * mint a record, at any of the three sites the extractor gates on that command.
 *
 * Driven end to end through `extractArtifactRefs`, never against the regex: a
 * regex-level test stays green while a call site keeps using a private copy,
 * which is exactly how the second, unanchored spelling survived here.
 *
 * Every mention case is paired with a REAL invocation of the same fixture shape
 * that MUST still produce its record. Without that sibling, "no branch" is also
 * satisfied by an extractor that threw, returned early, or got an empty fixture.
 *
 * The accepted/rejected commands below are written as independent literals on
 * purpose — deriving them from the pattern under test would make the test agree
 * with whatever the pattern currently does.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { extractArtifactRefs } from "../src/main/collectors/parsing/artifact-ref-extractor.js";
import { makeSession, NOW } from "./artifact-ref-session-fixture.js";

function refsFor(command: string, output?: string) {
  const session = makeSession({
    toolUses: [{ name: "Bash", timestamp: NOW, input: { command }, output }],
  });
  return extractArtifactRefs(session, NOW);
}

function branchNamesFor(command: string, output?: string): string[] {
  return refsFor(command, output)
    .filter((r) => r.targetKind === "branch")
    .map((r) => r.branchName ?? "");
}

/** gh's own success line, the strongest created-PR head evidence (FEA-2531). */
const GH_CREATE_OUTPUT = "Creating pull request for feat/from-output into main";

const PR_URL_OUTPUT =
  "https://github.com/closedloop-ai/closedloop-ai/pull/4242";

describe("ISS-8336: a mentioned `gh pr create` mints no record", () => {
  // Site 1 of 3 — `isPrCreateCommand`, which decides `created` vs `referenced`
  // for a PR URL seen in a tool use's output.
  test("doc-line mention carrying a PR URL is referenced, not created", () => {
    const mentioned = refsFor(
      "echo Reminder: gh pr create when the branch is ready",
      PR_URL_OUTPUT
    ).filter((r) => r.targetKind === "pull_request");
    assert.equal(mentioned.length, 1);
    assert.equal(mentioned[0]?.relation, "referenced");

    const invoked = refsFor("gh pr create --fill", PR_URL_OUTPUT).filter(
      (r) => r.targetKind === "pull_request"
    );
    assert.equal(invoked.length, 1);
    assert.equal(invoked[0]?.relation, "created");
  });

  // Site 2 of 3 — the `--head` flag branch, read straight out of the command.
  test("doc-line mention with a --head flag mints no branch", () => {
    assert.deepEqual(
      branchNamesFor("echo Reminder: gh pr create --head feat/never-created"),
      []
    );
    assert.deepEqual(
      branchNamesFor("gh pr create --head feat/really-created"),
      ["feat/really-created"]
    );
  });

  // Same site, the shape quote-stripping cannot reach: a heredoc body is not a
  // quoted span, so at ISS-8336 only the command-position anchor rejected it —
  // and it rejected this one only because the mention is SPACE-PRECEDED. The
  // LINE-INITIAL body line was the residual gap, and ISS-8473 closed it one
  // layer earlier by neutralizing the body itself, so both now mint nothing for
  // different reasons. The heredoc half of that fix is covered in
  // `artifact-ref-shell-quotes.test.ts`; asserted here too because this is the
  // site whose anchor used to be the only thing standing between a runbook and
  // a fabricated branch record.
  test("a heredoc body naming a --head flag mints no branch, indented or not", () => {
    assert.deepEqual(
      branchNamesFor(
        "cat > RUNBOOK.md <<EOF\nThen run gh pr create --head feat/from-a-runbook\nEOF"
      ),
      []
    );
    assert.deepEqual(
      branchNamesFor(
        "cat > RUNBOOK.md <<EOF\ngh pr create --head feat/line-initial\nEOF"
      ),
      []
    );
    // The sibling: the SAME multi-line fixture shape, with the invocation
    // line-anchored after the heredoc instead of inside it.
    assert.deepEqual(
      branchNamesFor(
        "cat > RUNBOOK.md <<EOF\nnotes\nEOF\ngh pr create --head feat/after-a-runbook"
      ),
      ["feat/after-a-runbook"]
    );
  });

  // Site 3 of 3 — the branch named by `gh pr create`'s OUTPUT.
  test("doc-line mention whose output names a head ref mints no branch", () => {
    assert.deepEqual(
      branchNamesFor("echo Reminder: gh pr create", GH_CREATE_OUTPUT),
      []
    );
    assert.deepEqual(branchNamesFor("gh pr create --fill", GH_CREATE_OUTPUT), [
      "feat/from-output",
    ]);
  });

  // The stricter gate can only be trusted if it still admits the invocation
  // shapes transcripts actually contain. Each is written as an independent
  // literal rather than derived from the pattern under test.
  test("real invocation shapes still mint their branch", () => {
    const shapes: readonly [string, string, string[]][] = [
      ["bare", "gh pr create --head feat/bare", ["feat/bare"]],
      [
        "env prefix",
        "GH_TOKEN=x PAGER=cat gh pr create --head feat/env",
        ["feat/env"],
      ],
      [
        "cd chain",
        "cd /w/tree && gh pr create --head feat/chained",
        ["feat/chained"],
      ],
      [
        // The push names `feat/pushed` on its own, so both branches are real
        // evidence and both must survive.
        "after a push",
        "git push -u origin feat/pushed; gh pr create --head feat/semi",
        ["feat/pushed", "feat/semi"],
      ],
      [
        "newline",
        "git add -A\ngh pr create --head feat/newline",
        ["feat/newline"],
      ],
      [
        "irregular spacing",
        "gh   pr   create --head feat/spaced",
        ["feat/spaced"],
      ],
    ];
    for (const [label, command, expected] of shapes) {
      assert.deepEqual(branchNamesFor(command), expected, label);
    }
  });

  // ISS-8336 NARROWING, pinned so it cannot change by accident. A wrapper word
  // before `gh` is not an env assignment and is not a separator, so the
  // command-position anchor rejects it — and no shape rule can tell
  // `rtk gh pr create` from `echo gh pr create`, because both are a bare word
  // followed by the command. `isPrCreateCommand` has been anchored since
  // FEA-2270, so a wrapper-prefixed invocation already produced no `created` PR
  // relation; this makes branch minting agree with it. Whether the canonical
  // anchor should learn about wrapper prefixes is a repo-wide question raised on
  // ISS-8336, not a decision this test blesses.
  test("wrapper-prefixed invocation mints no branch (known narrowing)", () => {
    assert.deepEqual(
      branchNamesFor("rtk gh pr create --head feat/wrapped"),
      []
    );
  });
});
