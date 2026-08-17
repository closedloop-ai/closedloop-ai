/**
 * @file artifact-ref-prose-refs.test.ts
 * @description ISS-5764 + ISS-5763 — PR and branch references named in PROSE.
 *
 * Every assertion drives the PRODUCTION entry point (`extractArtifactRefs`), not
 * the finder helpers in isolation, so deleting the pass registration — not just
 * the finders — turns these red.
 *
 * The adjacency fixtures below are transcribed from the real orchestrator
 * session that motivated the ticket (73 sub-agents, 123 transcripts), which
 * reported `prs: []` while its prose named at least eight PRs. Each named form
 * is covered, INCLUDING the markdown table whose only occurrence of "PR" is the
 * column header — the case every "within N characters" window fails.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ArtifactRefConfidence,
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { extractArtifactRefs } from "../src/main/collectors/parsing/artifact-ref-extractor.js";
import type { ArtifactRefRecord } from "../src/main/collectors/parsing/artifact-ref-record.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { makeSession as baseSession } from "./normalized-session-test-utils.js";

const REPO = "closedloop-ai/symphony-alpha";
const NOW = "2026-01-01T12:00:00.000Z";

function makeSession(
  overrides: Partial<NormalizedSession> = {}
): NormalizedSession {
  return baseSession({
    sessionId: "prose-refs-session",
    artifacts: { prs: [], issues: [], repo: REPO },
    ...overrides,
  });
}

/** Build a session whose only content is one assistant message. */
function sessionSaying(text: string): NormalizedSession {
  return makeSession({
    messages: [{ role: "assistant", timestamp: null, text }],
  });
}

function prNumbersOf(refs: ArtifactRefRecord[]): number[] {
  return refs
    .filter((r) => r.targetKind === ArtifactRefTargetKind.PullRequest)
    .map((r) => r.prNumber ?? -1)
    .sort((a, b) => a - b);
}

function branchNamesOf(refs: ArtifactRefRecord[]): string[] {
  return refs
    .filter((r) => r.targetKind === ArtifactRefTargetKind.Branch)
    .map((r) => r.branchName ?? "")
    .sort();
}

// ---------------------------------------------------------------------------
// Adjacency forms — ISS-5764
// ---------------------------------------------------------------------------

describe("PR mentions in prose — adjacency forms", () => {
  test("same sentence: vocabulary and number in one sentence", () => {
    const refs = extractArtifactRefs(
      sessionSaying(
        "So a PR touching e2e/** does now gate on the collection job — that landed in #4539."
      ),
      NOW
    );
    assert.deepEqual(prNumbersOf(refs), [4539]);
  });

  test("immediately preceding token: `PR #4710`", () => {
    const refs = extractArtifactRefs(
      sessionSaying("PR #4710 is enqueued."),
      NOW
    );
    assert.deepEqual(prNumbersOf(refs), [4710]);
  });

  test("reverse order: the number precedes the vocabulary", () => {
    const refs = extractArtifactRefs(
      sessionSaying("#4710 is the PR that carries the fix."),
      NOW
    );
    assert.deepEqual(prNumbersOf(refs), [4710]);
  });

  test("plural, same paragraph: `15 PRs raised.` followed by a list", () => {
    const refs = extractArtifactRefs(
      sessionSaying(
        ["15 PRs raised.", "- #4679 lint gate", "- #4678 branch parity"].join(
          "\n"
        )
      ),
      NOW
    );
    assert.deepEqual(prNumbersOf(refs), [4678, 4679]);
  });

  test("parenthetical, same paragraph as the vocabulary", () => {
    const refs = extractArtifactRefs(
      sessionSaying(
        [
          "That lane finished with no branch and no PR of its own.",
          "#4404 merged first, and ISS-5173 (#4403) is the landing dependency.",
        ].join("\n")
      ),
      NOW
    );
    assert.deepEqual(prNumbersOf(refs), [4403, 4404]);
  });

  // The mandatory structural case: the ONLY occurrence of "PR" is the column
  // header, several rows and hundreds of characters away from every number it
  // scopes. A linear proximity window cannot reach it.
  test("markdown table: a `PR` column header scopes its whole column", () => {
    const refs = extractArtifactRefs(
      sessionSaying(
        [
          "Board at cutoff:",
          "",
          "| Ticket | PR | State |",
          "| --- | --- | --- |",
          "| ISS-5601 | #4679 | enqueued |",
          "| ISS-5602 | #4678 | green |",
          "| ISS-5603 | #4680 | blocked |",
          "| ISS-5604 | #4682 | enqueued |",
        ].join("\n")
      ),
      NOW
    );
    assert.deepEqual(prNumbersOf(refs), [4678, 4679, 4680, 4682]);
  });

  test("markdown table: a non-PR column is NOT scoped by the PR header", () => {
    const refs = extractArtifactRefs(
      sessionSaying(
        [
          "| Issue | PR |",
          "| --- | --- |",
          "| #101 | #4679 |",
          "| #102 | #4678 |",
        ].join("\n")
      ),
      NOW
    );
    // #101/#102 sit under `Issue`; only the `PR` column resolves. A block-scope
    // rule would wrongly return all four.
    assert.deepEqual(prNumbersOf(refs), [4678, 4679]);
  });

  test("markdown table: a row naming the vocabulary itself is row-scoped", () => {
    const refs = extractArtifactRefs(
      sessionSaying(
        [
          "| Ticket | Outcome |",
          "| --- | --- |",
          "| ISS-5601 | PR #4710 opened |",
          "| ISS-5602 | rolled back |",
        ].join("\n")
      ),
      NOW
    );
    assert.deepEqual(prNumbersOf(refs), [4710]);
  });
});

describe("PR mentions in prose — precision", () => {
  test("a `#N` with NO PR vocabulary in scope emits nothing", () => {
    const refs = extractArtifactRefs(
      sessionSaying(
        "Item #1234 on the checklist is done, and issue #99 is still open."
      ),
      NOW
    );
    assert.deepEqual(prNumbersOf(refs), []);
  });

  test("vocabulary in a DIFFERENT block does not reach across the blank line", () => {
    const refs = extractArtifactRefs(
      sessionSaying(
        "Raised the PR this morning.\n\nChecklist item #1234 is done."
      ),
      NOW
    );
    assert.deepEqual(prNumbersOf(refs), []);
  });

  test("PR numbers are not width-bounded (3-digit and 5-digit both match)", () => {
    const refs = extractArtifactRefs(
      sessionSaying("PRs #987 and #10432 both landed."),
      NOW
    );
    assert.deepEqual(prNumbersOf(refs), [987, 10_432]);
  });

  test("a mention inside a fenced code block is not prose", () => {
    const refs = extractArtifactRefs(
      sessionSaying(
        ["Ran:", "", "```", "# PR #4710 landed", "```", ""].join("\n")
      ),
      NOW
    );
    assert.deepEqual(prNumbersOf(refs), []);
  });

  test("a repo-qualified mention uses ITS repo, not the session repo", () => {
    const refs = extractArtifactRefs(
      sessionSaying("The upstream PR is closedloop-ai/other-repo#77."),
      NOW
    );
    const pr = refs.find(
      (r) => r.targetKind === ArtifactRefTargetKind.PullRequest
    );
    assert.equal(pr?.repoFullName, "closedloop-ai/other-repo");
    assert.equal(pr?.prNumber, 77);
  });

  test("no full owner/repo session repo → a bare `#N` mints no PR identity", () => {
    const session = makeSession({
      artifacts: { prs: [], issues: [], repo: "symphony-alpha" },
      messages: [
        { role: "assistant", timestamp: null, text: "PR #4710 is enqueued." },
      ],
    });
    assert.deepEqual(prNumbersOf(extractArtifactRefs(session, NOW)), []);
  });

  test("prose refs carry relation=referenced and the prose method/confidence", () => {
    const refs = extractArtifactRefs(
      sessionSaying("PR #4710 is enqueued."),
      NOW
    );
    const pr = refs.find(
      (r) => r.targetKind === ArtifactRefTargetKind.PullRequest
    );
    assert.equal(pr?.relation, ArtifactRefRelation.Referenced);
    assert.equal(pr?.method, ArtifactRefMethod.PrMentionInProse);
    assert.equal(pr?.confidence, ArtifactRefConfidence.PrMentionInProse);
    assert.equal(pr?.isPrimary, false);
  });
});

// ---------------------------------------------------------------------------
// Branch mentions — precision over recall
// ---------------------------------------------------------------------------

describe("branch mentions in prose", () => {
  test("branch-shaped token adjacent to branch vocabulary resolves", () => {
    const refs = extractArtifactRefs(
      sessionSaying(
        "I pushed `fix/iss-5708-dispatch-accepted` and opened a PR."
      ),
      NOW
    );
    assert.deepEqual(branchNamesOf(refs), ["fix/iss-5708-dispatch-accepted"]);
  });

  test("branch shape with NO branch vocabulary in scope emits nothing", () => {
    const refs = extractArtifactRefs(
      sessionSaying("The label feat/grid-parity is on the board."),
      NOW
    );
    assert.deepEqual(branchNamesOf(refs), []);
  });

  test("a deep directory path is not a branch even with vocabulary present", () => {
    const refs = extractArtifactRefs(
      sessionSaying(
        "I checked out the branch and read docs/runbooks/merge-queue-operations for the rules."
      ),
      NOW
    );
    assert.deepEqual(branchNamesOf(refs), []);
  });

  test("a two-segment path with a file extension is not a branch", () => {
    const refs = extractArtifactRefs(
      sessionSaying("On that branch I edited docs/plan.md and fix/notes.txt."),
      NOW
    );
    assert.deepEqual(branchNamesOf(refs), []);
  });

  test("a non-namespaced `<user>/<slug>` token is deliberately not recognized", () => {
    const refs = extractArtifactRefs(
      sessionSaying("I pushed mikea/some-work to origin."),
      NOW
    );
    assert.deepEqual(branchNamesOf(refs), []);
  });

  test("a bare branch name is not minted without the namespaced shape", () => {
    const refs = extractArtifactRefs(
      sessionSaying("I checked out the branch main and then feat/real-work."),
      NOW
    );
    assert.deepEqual(branchNamesOf(refs), ["feat/real-work"]);
  });

  test("branch prose refs are referenced, never created or workspace", () => {
    const refs = extractArtifactRefs(
      sessionSaying("That work sits on the branch `feat/real-work`."),
      NOW
    );
    const branch = refs.find(
      (r) => r.targetKind === ArtifactRefTargetKind.Branch
    );
    assert.equal(branch?.relation, ArtifactRefRelation.Referenced);
    assert.equal(branch?.method, ArtifactRefMethod.BranchMentionInProse);
    assert.equal(
      branch?.confidence,
      ArtifactRefConfidence.BranchMentionInProse
    );
  });
});

// ---------------------------------------------------------------------------
// Sidecar reach — ISS-5763
// ---------------------------------------------------------------------------

describe("sub-agent sidecar reach", () => {
  test("a PR named only in a SIDECAR sub-agent's tool input surfaces on the parent", () => {
    const session = makeSession({
      messages: [
        { role: "assistant", timestamp: null, text: "Delegating the sweep." },
      ],
      subagents: [
        {
          id: "agent-a",
          name: "lane-1",
          toolUses: [
            {
              id: "toolu_sidecar_1",
              name: "Write",
              timestamp: null,
              input: {
                file_path: "/tmp/pr-body.md",
                content: "## Summary\nFollows up on PR #4682.",
              },
            },
          ],
        },
      ],
    });
    assert.deepEqual(prNumbersOf(extractArtifactRefs(session, NOW)), [4682]);
  });

  test("a sub-agent's final report (delegation tool OUTPUT) is scanned as prose", () => {
    const session = makeSession({
      toolUses: [
        {
          id: "toolu_task_1",
          name: "Task",
          timestamp: null,
          input: { prompt: "sweep the board" },
          output: "Done. Raised PR #4539 and left #4404 alone.",
        },
      ],
    });
    assert.deepEqual(
      prNumbersOf(extractArtifactRefs(session, NOW)),
      [4404, 4539]
    );
  });

  test("a PR reachable from BOTH the sidecar and the parent counts exactly once", () => {
    const shared = {
      id: "toolu_dual_1",
      name: "Write",
      timestamp: null,
      input: { content: "Rebasing onto PR #4682." },
    };
    const session = makeSession({
      messages: [
        { role: "assistant", timestamp: null, text: "PR #4682 is the base." },
      ],
      // The Claude parser DUAL-PUSHES an in-line sidechain tool use to both
      // arrays as the same object; `collectSessionToolUses` dedupes on its id.
      toolUses: [shared],
      subagents: [{ id: "agent-a", name: "lane-1", toolUses: [shared] }],
    });
    const prRefs = extractArtifactRefs(session, NOW).filter(
      (r) => r.targetKind === ArtifactRefTargetKind.PullRequest
    );
    assert.equal(prRefs.length, 1);
    assert.equal(prRefs[0].prNumber, 4682);
  });

  test("a SHELL tool's command text is not re-read as prose", () => {
    const session = makeSession({
      toolUses: [
        {
          id: "toolu_shell_1",
          name: "Bash",
          timestamp: null,
          // Names the vocabulary and a number, but it is a command, not prose:
          // the command passes own it, and re-reading it here would mint a
          // duplicate weaker ref for a PR this session merely viewed.
          input: { command: "echo 'the PR is #4710'" },
        },
      ],
    });
    assert.deepEqual(prNumbersOf(extractArtifactRefs(session, NOW)), []);
  });
});

// ---------------------------------------------------------------------------
// The dangerous interaction: a prose mention must never weaken real evidence
// ---------------------------------------------------------------------------

describe("prose mentions never downgrade stronger evidence", () => {
  test("a prose mention of an AUTHORED PR leaves the created ref intact", () => {
    const session = makeSession({
      toolUses: [
        {
          id: "toolu_create_1",
          name: "Bash",
          timestamp: null,
          input: { command: "gh pr create --title 'x' --body 'y'" },
          output: `https://github.com/${REPO}/pull/4710`,
        },
      ],
      messages: [
        {
          role: "assistant",
          timestamp: null,
          text: "Opened PR #4710 — it is enqueued now.",
        },
      ],
    });
    const prRefs = extractArtifactRefs(session, NOW).filter(
      (r) =>
        r.targetKind === ArtifactRefTargetKind.PullRequest &&
        r.prNumber === 4710
    );
    const created = prRefs.find(
      (r) => r.relation === ArtifactRefRelation.Created
    );
    assert.ok(created, "the authored PR ref must survive the prose mention");
    // The authoring record keeps its own method and confidence — the prose
    // mention neither replaced it nor rewrote its evidence.
    assert.notEqual(created.method, ArtifactRefMethod.PrMentionInProse);
    assert.notEqual(created.confidence, ArtifactRefConfidence.PrMentionInProse);
    // …and the prose mention, if present at all, is a SEPARATE `referenced`
    // record, so the cloud's Authored-wins purge precedence is untouched.
    for (const ref of prRefs) {
      if (ref.confidence === ArtifactRefConfidence.PrMentionInProse) {
        assert.equal(ref.relation, ArtifactRefRelation.Referenced);
      }
    }
  });

  test("a URL-derived referenced ref outranks a prose mention of the same PR", () => {
    const session = makeSession({
      toolUses: [
        {
          id: "toolu_read_1",
          name: "Read",
          timestamp: null,
          input: { file_path: `https://github.com/${REPO}/pull/4710` },
        },
      ],
      messages: [
        { role: "assistant", timestamp: null, text: "PR #4710 is enqueued." },
      ],
    });
    const referenced = extractArtifactRefs(session, NOW).filter(
      (r) =>
        r.targetKind === ArtifactRefTargetKind.PullRequest &&
        r.prNumber === 4710 &&
        r.relation === ArtifactRefRelation.Referenced
    );
    assert.equal(referenced.length, 1);
    assert.equal(referenced[0].confidence, ArtifactRefConfidence.UrlMatch);
  });

  test("a prose mention of a PUSHED branch leaves the created ref intact", () => {
    const session = makeSession({
      toolUses: [
        {
          id: "toolu_push_1",
          name: "Bash",
          timestamp: null,
          input: { command: "git push origin feat/real-work" },
        },
      ],
      messages: [
        {
          role: "assistant",
          timestamp: null,
          text: "Pushed the branch `feat/real-work`.",
        },
      ],
    });
    const branchRefs = extractArtifactRefs(session, NOW).filter(
      (r) =>
        r.targetKind === ArtifactRefTargetKind.Branch &&
        r.branchName === "feat/real-work"
    );
    const created = branchRefs.find(
      (r) => r.relation === ArtifactRefRelation.Created
    );
    assert.ok(created, "the pushed branch ref must survive the prose mention");
    assert.notEqual(
      created.confidence,
      ArtifactRefConfidence.BranchMentionInProse
    );
  });
});

describe("branch mentions — measured false-positive controls", () => {
  // Each input below is a real shape from the local-corpus measurement that the
  // first cut of this heuristic wrongly minted as a branch.
  const proseAlternations = [
    "On that branch I had to fix/rebut the finding.",
    "The branch work was refactor/hardening only.",
    "Pushed after the docs/design review.",
    "An upper-case FEAT/PRD split is not a branch, even on a pushed branch.",
    "Placeholder branches like feat/a and feature/x are documentation, not refs.",
  ];
  for (const text of proseAlternations) {
    test(`no branch minted from: ${text.slice(0, 40)}…`, () => {
      assert.deepEqual(
        branchNamesOf(extractArtifactRefs(sessionSaying(text), NOW)),
        []
      );
    });
  }

  test("a genuinely described branch still resolves alongside them", () => {
    const refs = extractArtifactRefs(
      sessionSaying("I pushed feature/FEA-1316 and fix/iss-5708-dispatch."),
      NOW
    );
    assert.deepEqual(branchNamesOf(refs), [
      "feature/FEA-1316",
      "fix/iss-5708-dispatch",
    ]);
  });
});

describe("regressions found in review", () => {
  test("CRLF line endings do not collapse block scoping", () => {
    // Transcripts are JSONL from external harnesses and carry pasted Windows
    // content. `\n[ \t]*\n` never matches `\r\n\r\n`, so before normalization
    // the whole message became ONE block and every precision guarantee died.
    const refs = extractArtifactRefs(
      sessionSaying("Raised the PR this morning.\r\n\r\nChecklist item #1234."),
      NOW
    );
    assert.deepEqual(prNumbersOf(refs), []);
  });

  test("CRLF still resolves a genuine mention", () => {
    const refs = extractArtifactRefs(
      sessionSaying(
        "Board:\r\n\r\n| Ticket | PR |\r\n| --- | --- |\r\n| A | #4679 |"
      ),
      NOW
    );
    assert.deepEqual(prNumbersOf(refs), [4679]);
  });

  test("prose above a table in the same block is still scoped", () => {
    // The table branch used to `continue`, discarding every line above the
    // header — losing the most basic adjacency form purely because a table
    // happened to follow it.
    const refs = extractArtifactRefs(
      sessionSaying(
        [
          "PR #4710 is the base. Board:",
          "| Ticket | State |",
          "| --- | --- |",
          "| ISS-1 | green |",
        ].join("\n")
      ),
      NOW
    );
    assert.deepEqual(prNumbersOf(refs), [4710]);
  });

  test("prose below a table in the same block is still scoped", () => {
    const refs = extractArtifactRefs(
      sessionSaying(
        [
          "| Ticket | State |",
          "| --- | --- |",
          "| ISS-1 | green |",
          "That PR is #4710.",
        ].join("\n")
      ),
      NOW
    );
    assert.deepEqual(prNumbersOf(refs), [4710]);
  });

  test("a described slug WITH a file extension is still rejected", () => {
    // The original fixture used `docs/plan.md`, whose slug has no digit or
    // hyphen — so it died at the described-slug gate and the extension gate was
    // never reached. This one clears every earlier gate.
    const refs = extractArtifactRefs(
      sessionSaying("On that branch I edited docs/iss-5764-notes.md."),
      NOW
    );
    assert.deepEqual(branchNamesOf(refs), []);
  });

  test("an upper-case namespace with a described slug is still rejected", () => {
    // `DOCS/skill-docs` clears the described-slug gate (it has a hyphen), so it
    // genuinely exercises the lower-case namespace rule rather than passing for
    // an unrelated reason.
    const refs = extractArtifactRefs(
      sessionSaying("I pushed DOCS/skill-docs and Feature/FEA-1316 today."),
      NOW
    );
    assert.deepEqual(branchNamesOf(refs), []);
  });

  test("`#0` is not a pull request", () => {
    const refs = extractArtifactRefs(
      sessionSaying("The PR list is #0 and #4710."),
      NOW
    );
    assert.deepEqual(prNumbersOf(refs), [4710]);
  });
});

describe("session repo resolution for bare `#N`", () => {
  /** A session whose `artifacts.repo` is a bare CWD basename, as in real data. */
  function bareRepoSession(
    overrides: Partial<NormalizedSession> = {}
  ): NormalizedSession {
    return baseSession({
      sessionId: "bare-repo-session",
      artifacts: { prs: [], issues: [], repo: "symphony-alpha" },
      ...overrides,
    });
  }

  test("tier 2: a repo proved by an earlier pass resolves a bare `#N`", () => {
    const session = bareRepoSession({
      toolUses: [
        {
          id: "t1",
          name: "Read",
          timestamp: null,
          input: { file_path: `https://github.com/${REPO}/pull/12` },
        },
      ],
      messages: [
        { role: "assistant", timestamp: null, text: "PR #4710 is enqueued." },
      ],
    });
    const pr = extractArtifactRefs(session, NOW).find(
      (r) =>
        r.targetKind === ArtifactRefTargetKind.PullRequest &&
        r.prNumber === 4710
    );
    assert.equal(pr?.repoFullName, REPO);
  });

  test("tier 3: a harness prLinks record resolves a bare `#N`", () => {
    const session = bareRepoSession({
      prLinks: [
        {
          number: "12",
          repo: REPO,
          url: `https://github.com/${REPO}/pull/12`,
        },
      ],
      messages: [
        { role: "assistant", timestamp: null, text: "PR #4710 is enqueued." },
      ],
    });
    const pr = extractArtifactRefs(session, NOW).find(
      (r) =>
        r.targetKind === ArtifactRefTargetKind.PullRequest &&
        r.prNumber === 4710
    );
    assert.equal(pr?.repoFullName, REPO);
  });

  // The falsification case: ONE incidental upstream URL used to capture every
  // bare `#N` and every prose branch in the session, because an exact tie fell
  // to the byte-order tie-break and `anthropics/…` sorts before `closedloop-ai/…`.
  test("a foreign repo read during the session never wins over the session's own", () => {
    const session = bareRepoSession({
      toolUses: [
        {
          id: "t1",
          name: "Read",
          timestamp: null,
          input: {
            urls: [
              "https://github.com/anthropics/claude-code/pull/1",
              "https://github.com/anthropics/claude-code/pull/2",
              "https://github.com/anthropics/claude-code/pull/3",
              `https://github.com/${REPO}/pull/9`,
            ],
          },
        },
      ],
      messages: [
        {
          role: "assistant",
          timestamp: null,
          text: "Our PR #4710 is enqueued. I also pushed branch feat/iss-4710-fix.",
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const pr = refs.find(
      (r) =>
        r.targetKind === ArtifactRefTargetKind.PullRequest &&
        r.prNumber === 4710
    );
    const branch = refs.find(
      (r) =>
        r.targetKind === ArtifactRefTargetKind.Branch &&
        r.branchName === "feat/iss-4710-fix"
    );
    assert.equal(pr?.repoFullName, REPO);
    assert.equal(branch?.repoFullName, REPO);
  });

  // Review falsification (wongk, #4723): preferring a basename-matching
  // candidate only fixed the TIE. With no matching candidate at all the vote
  // still ran and handed the session's own bare `#N`s to the foreign repo
  // outright — one incidental upstream URL was enough, no tie required.
  test("a foreign repo the session only read never captures a bare `#N`", () => {
    const session = bareRepoSession({
      toolUses: [
        {
          id: "t1",
          name: "Read",
          timestamp: null,
          input: { url: "https://github.com/anthropics/claude-code/pull/1" },
        },
      ],
      messages: [
        {
          role: "assistant",
          timestamp: null,
          text: "Our PR #4710 is enqueued. I also pushed branch feat/iss-4710-fix.",
        },
      ],
    });

    const refs = extractArtifactRefs(session, NOW);

    // The URL the session READ still earns its own command-derived ref — that
    // is the foreign repo speaking for itself, and is correct.
    assert.equal(
      refs.find(
        (r) =>
          r.targetKind === ArtifactRefTargetKind.PullRequest &&
          r.prNumber === 1 &&
          r.method !== ArtifactRefMethod.PrMentionInProse
      )?.repoFullName,
      "anthropics/claude-code"
    );
    // The MENTION is unattributable, so no prose PR ref is minted for it at
    // all — NOT one minted under `anthropics/claude-code`.
    assert.deepEqual(
      refs.filter((r) => r.method === ArtifactRefMethod.PrMentionInProse),
      []
    );
    // Same veto on the branch side: present locally, but with no guessed repo.
    const branch = refs.find(
      (r) =>
        r.targetKind === ArtifactRefTargetKind.Branch &&
        r.branchName === "feat/iss-4710-fix"
    );
    assert.equal(branch?.repoFullName, undefined);
  });

  // The other direction, and the reason the mismatch is a THRESHOLD and not a
  // flat `null`: a worktree/pool directory basename names no repo at all, and
  // the corpus is full of them (`west-monroe`, `lyon`, `atlanta`, `tmp`,
  // `testuser5`). Rejecting every unnamed basename deletes their real refs.
  test("a worktree basename still resolves the repo the session worked in", () => {
    const session = baseSession({
      sessionId: "worktree-session",
      artifacts: { prs: [], issues: [], repo: "lane-9" },
      toolUses: [
        {
          id: "t1",
          name: "Read",
          timestamp: null,
          input: {
            urls: [
              `https://github.com/${REPO}/pull/12`,
              `https://github.com/${REPO}/pull/13`,
            ],
          },
        },
      ],
      messages: [
        { role: "assistant", timestamp: null, text: "PR #4710 is enqueued." },
      ],
    });
    const pr = extractArtifactRefs(session, NOW).find(
      (r) =>
        r.targetKind === ArtifactRefTargetKind.PullRequest &&
        r.prNumber === 4710
    );
    assert.equal(pr?.repoFullName, REPO);
  });

  // The other direction — the threshold must not swallow the session's own repo.
  test("a session that declared no repo still resolves its attested one", () => {
    const session = baseSession({
      sessionId: "no-declared-repo-session",
      artifacts: { prs: [], issues: [], repo: null },
      toolUses: [
        {
          id: "t1",
          name: "Read",
          timestamp: null,
          input: { file_path: `https://github.com/${REPO}/pull/12` },
        },
      ],
      messages: [
        { role: "assistant", timestamp: null, text: "PR #4710 is enqueued." },
      ],
    });
    const pr = extractArtifactRefs(session, NOW).find(
      (r) =>
        r.targetKind === ArtifactRefTargetKind.PullRequest &&
        r.prNumber === 4710
    );
    assert.equal(pr?.repoFullName, REPO);
  });

  test("with no resolvable repo at all, a prose branch carries none", () => {
    const session = bareRepoSession({
      messages: [
        {
          role: "assistant",
          timestamp: null,
          text: "I pushed branch feat/iss-4710-fix.",
        },
      ],
    });
    const branch = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === ArtifactRefTargetKind.Branch
    );
    // Present locally, but with no fabricated repo — the cloud creates a BRANCH
    // artifact keyed on repositoryFullName and never defers, so a guessed name
    // would be permanent.
    assert.equal(branch?.repoFullName, undefined);
  });
});

describe("prose and command evidence coexist as distinct records", () => {
  test("an authored PR keeps its own record AND gains a separate mention", () => {
    const session = makeSession({
      toolUses: [
        {
          id: "toolu_create_2",
          name: "Bash",
          timestamp: null,
          input: { command: "gh pr create --title 'x' --body 'y'" },
          output: `https://github.com/${REPO}/pull/4710`,
        },
      ],
      messages: [
        { role: "assistant", timestamp: null, text: "Opened PR #4710." },
      ],
    });
    const triples = extractArtifactRefs(session, NOW)
      .filter(
        (r) =>
          r.targetKind === ArtifactRefTargetKind.PullRequest &&
          r.prNumber === 4710
      )
      .map((r) => `${r.relation}|${r.method}|${r.confidence}`)
      .sort();

    // Pinning BOTH exact triples is what makes this catch the mutation the
    // earlier version could not: flipping the prose relation to `created` would
    // collapse these to one row and fail here, where an existence-only check on
    // the authored ref stayed green.
    assert.deepEqual(triples, [
      `${ArtifactRefRelation.Created}|${ArtifactRefMethod.PrCreateOutput}|${ArtifactRefConfidence.UrlMatch}`,
      `${ArtifactRefRelation.Referenced}|${ArtifactRefMethod.PrMentionInProse}|${ArtifactRefConfidence.PrMentionInProse}`,
    ]);
  });

  test("a checked-out branch keeps its workspace record AND gains a mention", () => {
    const session = makeSession({
      toolUses: [
        {
          id: "toolu_co_1",
          name: "Bash",
          timestamp: null,
          input: { command: "git checkout feat/iss-1234-mine" },
        },
      ],
      messages: [
        {
          role: "assistant",
          timestamp: null,
          text: "I checked out branch feat/iss-1234-mine.",
        },
      ],
    });
    const triples = extractArtifactRefs(session, NOW)
      .filter(
        (r) =>
          r.targetKind === ArtifactRefTargetKind.Branch &&
          r.branchName === "feat/iss-1234-mine"
      )
      .map((r) => `${r.relation}|${r.confidence}`)
      .sort();

    assert.deepEqual(triples, [
      `${ArtifactRefRelation.Referenced}|${ArtifactRefConfidence.BranchMentionInProse}`,
      `${ArtifactRefRelation.Workspace}|${ArtifactRefConfidence.UrlMatch}`,
    ]);
  });
});
