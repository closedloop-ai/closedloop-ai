/**
 * @file artifact-ref-shared-scan.test.ts
 * @description ISS-5934 — the artifact-ref extract pass must derive each piece
 * of per-session work ONCE.
 *
 * The emitted refs are unchanged by design, so every assertion here pins the
 * MECHANISM rather than the output (the output is already covered by
 * `artifact-ref-extractor.test.ts` and `artifact-ref-prose-refs.test.ts`, both
 * of which stay green as the regression net):
 *
 *  1. `collectSessionToolUses` — which re-materializes the parent's tool uses
 *     plus every sidecar sub-agent's and rebuilds a `Set` of parent tool-use ids
 *     — ran four to five times per session. It is counted here through a
 *     `session.subagents` accessor, the one property it reads exactly once per
 *     call and the only property nothing else in the extract path touches.
 *  2. The prose finders no longer normalize: they take the blocks `proseBlocks`
 *     produced, so a text is stripped and block-split once per entry instead of
 *     once per vocabulary. A finder that re-ran the stripper would swallow the
 *     fixtures below, whose leading fence marker only survives BECAUSE the
 *     normalization already happened.
 *
 * The PR-url sweep's third pass over `[...inputTexts, ...outputTexts]` is
 * derived from the two lists now, so its assertion is the ORDER and dedup of the
 * emitted refs — the only observable the concatenation ever produced.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { extractArtifactRefs } from "../src/main/collectors/parsing/artifact-ref-extractor.js";
import {
  findProseBranchNames,
  findProsePrMentions,
  proseBlocks,
} from "../src/main/collectors/parsing/artifact-ref-prose-refs.js";
import type { ArtifactRefRecord } from "../src/main/collectors/parsing/artifact-ref-record.js";
import { collectSessionToolUses } from "../src/main/collectors/parsing/session-tool-uses.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { makeSession as baseSession } from "./normalized-session-test-utils.js";

const NOW = "2026-01-01T12:00:00.000Z";
const REPO = "closedloop-ai/symphony-alpha";

function makeSession(
  overrides: Partial<NormalizedSession> = {}
): NormalizedSession {
  return baseSession({
    sessionId: "iss-5934-session",
    artifacts: { prs: [], issues: [], repo: REPO },
    ...overrides,
  });
}

/**
 * A session that counts reads of `subagents`. `collectSessionToolUses` reads it
 * exactly once per call (`session.subagents ?? []`), so the read count IS the
 * call count for the whole extract.
 */
function countingSubagentReads(session: NormalizedSession): {
  session: NormalizedSession;
  reads: () => number;
} {
  const subagents = session.subagents;
  let reads = 0;
  Object.defineProperty(session, "subagents", {
    configurable: true,
    get() {
      reads++;
      return subagents;
    },
  });
  return { session, reads: () => reads };
}

/** A session with enough shape to drive the PR, commit, branch and prose passes. */
function fanOutSession(): NormalizedSession {
  return makeSession({
    messages: [
      {
        role: "assistant",
        timestamp: null,
        text: "Raised PR #4710 off branch feat/iss-5934-shared-scan.",
      },
    ],
    toolUses: [
      {
        name: "Bash",
        timestamp: null,
        id: "toolu_parent_1",
        input: { command: "git commit -m 'work'" },
        output: "[main abc1234] work",
      },
    ],
    subagents: [
      {
        id: "agent-1",
        name: "sub",
        toolUses: [
          {
            name: "Bash",
            timestamp: null,
            id: "toolu_sub_1",
            input: {
              command: "gh pr create --head feat/iss-5934-shared-scan",
            },
            output: `https://github.com/${REPO}/pull/4710`,
          },
        ],
      },
    ],
  });
}

function prNumbersInOrder(refs: ArtifactRefRecord[]): number[] {
  return refs
    .filter((r) => r.targetKind === ArtifactRefTargetKind.PullRequest)
    .map((r) => r.prNumber ?? -1);
}

describe("ISS-5934 — per-session work is derived once", () => {
  test("collectSessionToolUses reads the session once per call", () => {
    const { session, reads } = countingSubagentReads(fanOutSession());

    collectSessionToolUses(session);

    assert.equal(reads(), 1);
  });

  test("extractArtifactRefs collects the tool-use stream exactly once", () => {
    const { session, reads } = countingSubagentReads(fanOutSession());

    const refs = extractArtifactRefs(session, NOW);

    // One walk for the whole extract — the PR, commit, branch, created-PR
    // head-resolver and prose passes all read the same threaded list.
    assert.equal(reads(), 1);
    // Sanity: the passes that consume it actually ran on the sidecar's work.
    assert.ok(
      refs.some(
        (r) =>
          r.targetKind === ArtifactRefTargetKind.PullRequest &&
          r.prNumber === 4710
      )
    );
  });

  test("the PR-url sweep keeps input-first order and dedups across both lists", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: null,
          input: { command: `echo https://github.com/${REPO}/pull/11` },
          // 11 repeats the input hit; 22 is output-only. The removed third
          // sweep over the concatenated texts produced exactly this: the input
          // hits, then the output hits it had not already seen.
          output: `see https://github.com/${REPO}/pull/22 and https://github.com/${REPO}/pull/11`,
        },
      ],
    });

    assert.deepEqual(
      prNumbersInOrder(extractArtifactRefs(session, NOW)),
      [11, 22]
    );
  });
});

describe("ISS-5934 — prose entries are normalized once", () => {
  test("proseBlocks strips fenced code and splits on blank lines", () => {
    const blocks = proseBlocks(
      "PR #4710 is the base.\n```\nnot prose\n```\n\nBranch `feat/iss-5934-shared-scan` is pushed."
    );

    assert.deepEqual(blocks, [
      "PR #4710 is the base.",
      "Branch feat/iss-5934-shared-scan is pushed.",
    ]);
  });

  test("findProsePrMentions does not re-normalize the blocks it is given", () => {
    // A block whose first line is a fence marker is only reachable because
    // normalization already ran. Re-running the stripper here would open an
    // unterminated fence and swallow the rest of the block.
    const mentions = findProsePrMentions(["```\nPR #4710 is the base."]);

    assert.deepEqual(mentions, [{ prNumber: 4710 }]);
  });

  test("findProseBranchNames does not re-normalize the blocks it is given", () => {
    const branches = findProseBranchNames([
      "```\nPushed the branch feat/iss-5934-shared-scan.",
    ]);

    assert.deepEqual(branches, ["feat/iss-5934-shared-scan"]);
  });

  test("both finders read the same blocks for one prose entry", () => {
    const blocks = proseBlocks(
      "Raised PR #4710 off branch feat/iss-5934-shared-scan."
    );

    assert.deepEqual(findProsePrMentions(blocks), [{ prNumber: 4710 }]);
    assert.deepEqual(findProseBranchNames(blocks), [
      "feat/iss-5934-shared-scan",
    ]);
  });
});
