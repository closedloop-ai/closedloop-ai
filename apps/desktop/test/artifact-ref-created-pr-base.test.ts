/**
 * @file artifact-ref-created-pr-base.test.ts
 * @description ISS-8175 — the BASE ref a `created` pull-request ref carries.
 *
 * Its own file rather than more of `artifact-ref-extractor.test.ts`: that suite
 * is already far past the 1,000-line ceiling and grandfathered shrink-only, and
 * this is a distinct contract (what evidence may name a PR's base) rather than
 * more head-branch resolution.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { extractArtifactRefs } from "../src/main/collectors/parsing/artifact-ref-extractor.js";
import { makeSession, NOW } from "./artifact-ref-session-fixture.js";

const PR_URL = "https://github.com/closedloop-ai/closedloop-ai/pull/2320";
const GH_CREATE_OUTPUT =
  "Creating pull request for feat/fea-2531 into release/2026-08 in closedloop-ai/closedloop-ai";

describe("ISS-8175: a created PR ref carries the base gh named", () => {
  // gh prints head AND base on one line of its create output. The head half is
  // already read (FEA-2531); the base half is the only base evidence a local
  // clone holds for a PR it opened.
  test("reads the base from gh's own create output line", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          gitBranch: "main",
          input: { command: "gh pr create --title x --body-file /tmp/b.md" },
          output: `${GH_CREATE_OUTPUT}\n${PR_URL}\n`,
        },
      ],
    });
    const created = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "pull_request" && r.relation === "created"
    );
    assert.equal(created?.baseRef, "release/2026-08");
  });

  // A base belongs to one pull request, and only to the one this session opened.
  // A PR already named in the command's INPUT is `referenced`, not `created`
  // (the create line in the output belongs to a DIFFERENT PR), so it must carry
  // no base — an absent base is the honest unknown the cloud read already serves
  // (ISS-8155). Drop the created-only gate and this ref borrows that line's base.
  test("omits baseRef for a referenced PR sharing a create tool-use", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          gitBranch: "main",
          input: {
            command: `gh pr create --title "follow-up to ${PR_URL}" --body y`,
          },
          output: `${GH_CREATE_OUTPUT}\n${PR_URL}\n`,
        },
      ],
    });
    const notCreated = extractArtifactRefs(session, NOW).filter(
      (r) => r.targetKind === "pull_request" && r.relation !== "created"
    );
    assert.ok(notCreated.length > 0);
    for (const ref of notCreated) {
      assert.equal("baseRef" in ref, false);
    }
  });

  // One tool-use can open a STACK — `gh pr create … && gh pr create …` — and
  // every URL in that output becomes its own created ref. gh's lines do not say
  // which PR they describe, so binding the first line's base to both would give
  // the child PR a base gh never reported for it. Both get the honest unknown.
  test("omits baseRef when one tool-use opened PRs onto different bases", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          gitBranch: "main",
          input: {
            command: "gh pr create --title a && gh pr create --title b",
          },
          output: [
            "Creating pull request for feat/a into main in closedloop-ai/closedloop-ai",
            PR_URL,
            "Creating pull request for feat/b into feat/a in closedloop-ai/closedloop-ai",
            `${PR_URL.replace("2320", "2321")}\n`,
          ].join("\n"),
        },
      ],
    });
    const created = extractArtifactRefs(session, NOW).filter(
      (r) => r.targetKind === "pull_request" && r.relation === "created"
    );
    assert.equal(created.length, 2);
    for (const ref of created) {
      assert.equal("baseRef" in ref, false);
    }
  });

  // Two PRs raised onto the SAME base is not ambiguous — gh named one answer.
  test("keeps the base when one tool-use opened PRs onto the same base", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          gitBranch: "main",
          input: {
            command: "gh pr create --title a && gh pr create --title b",
          },
          output: [
            "Creating pull request for feat/a into main in closedloop-ai/closedloop-ai",
            PR_URL,
            "Creating pull request for feat/b into main in closedloop-ai/closedloop-ai",
            `${PR_URL.replace("2320", "2321")}\n`,
          ].join("\n"),
        },
      ],
    });
    const created = extractArtifactRefs(session, NOW).filter(
      (r) => r.targetKind === "pull_request" && r.relation === "created"
    );
    assert.equal(created.length, 2);
    for (const ref of created) {
      assert.equal(ref.baseRef, "main");
    }
  });

  // Review (ISS-8175): a create tool-use marks EVERY output-only PR URL
  // `created`, not just the one it opened. Echoing the parent PR of a stack puts
  // a second URL in that output — no `gh pr` subcommand claims it, so it is not
  // `reviewed` either — and it becomes a second `created` ref behind gh's ONE
  // create line. Binding that line's base to it would hand a merely-referenced
  // PR DesktopPullRequestBase provenance. One create line per created ref, or no
  // base is bound at all. Drop the count check and PR 456 reads "release/2026-08".
  test("omits baseRef when a create tool-use also output a PR it did not open", () => {
    const otherPrUrl = PR_URL.replace("2320", "456");
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          gitBranch: "main",
          input: {
            command:
              'gh pr create --title x --body y && echo "stacked on $PARENT_PR"',
          },
          output: `${GH_CREATE_OUTPUT}\n${PR_URL}\nstacked on ${otherPrUrl}\n`,
        },
      ],
    });
    const prRefs = extractArtifactRefs(session, NOW).filter(
      (r) => r.targetKind === "pull_request"
    );
    // Both URLs really do come back `created` today — that classification is
    // FEA-2531's and untouched here. What must not happen is either of them
    // carrying a base gh named for only one PR.
    assert.equal(prRefs.length, 2);
    for (const ref of prRefs) {
      assert.equal(ref.relation, "created");
      assert.equal("baseRef" in ref, false);
    }
  });

  // A create whose output gh never printed (a non-shell harness record, a
  // truncated capture) must not fall back to a neighbouring branch write the way
  // the HEAD resolution deliberately does.
  test("omits baseRef when the create output names no base", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          gitBranch: "feat/fea-2531",
          input: { command: "gh pr create --title x --body y" },
          output: `${PR_URL}\n`,
        },
      ],
    });
    const created = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "pull_request" && r.relation === "created"
    );
    assert.ok(created);
    assert.equal("baseRef" in created, false);
  });
});
