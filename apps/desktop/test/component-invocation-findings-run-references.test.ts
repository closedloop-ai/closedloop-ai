/**
 * @file component-invocation-findings-run-references.test.ts
 * @description ISS-11238 review (#7978): WHICH run directories a session is
 * allowed to name, and where each one resolves to.
 *
 * A focused sibling of `component-invocations-findings-attribution.test.ts`,
 * which drives the whole importer. These cases pin the reference scan itself,
 * because both of its failure modes are silent: a relative prefix thrown away
 * reads a same-named run out of the wrong tree, and a run named only in a search
 * tool's OUTPUT attributes a checkout's whole review history to one session.
 * Neither shows up as an error — each produces a confident wrong number.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "vitest";
import { codeReviewEnvelopePathsInSession } from "../src/main/database/component-invocation-findings-attribution.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-09-26T12:00:00.000Z";
const CWD = path.join(path.sep, "repos", "closedloop-ai");

/**
 * The same set of paths, named either as the session's own `Read` inputs (one
 * tool use each, the way a session that worked in those directories records it)
 * or as one search tool's OUTPUT listing (the way a `Glob` records directories
 * the session never touched).
 */
function sessionNaming(paths: readonly string[], where: "input" | "output") {
  const base = {
    sessionId: "session-11238-references",
    cwd: CWD,
    startedAt: NOW,
    endedAt: "2026-09-26T12:30:00.000Z",
  };
  if (where === "input") {
    return makeSession({
      ...base,
      toolUses: paths.map((file, index) => ({
        id: `toolu_read_${index}`,
        providerToolUseId: `toolu_read_${index}`,
        name: "Read",
        kind: "builtin" as const,
        timestamp: NOW,
        input: { file_path: file },
      })),
    });
  }
  return makeSession({
    ...base,
    toolUses: [
      {
        id: "toolu_glob",
        providerToolUseId: "toolu_glob",
        name: "Glob",
        kind: "builtin" as const,
        timestamp: NOW,
        input: { pattern: "review_result.json" },
        output: paths.join("\n"),
      },
    ],
  });
}

function filesNamedIn(
  paths: readonly string[],
  where: "input" | "output"
): string[] {
  return [
    ...codeReviewEnvelopePathsInSession(sessionNaming(paths, where), CWD),
  ];
}

describe("ISS-11238 code-review run references", () => {
  test("a relative prefix resolves against the cwd instead of being discarded", () => {
    const nested = path.join(
      "sub",
      "pkg",
      ".closedloop-ai",
      "code-review",
      "cr-1",
      "review_result.json"
    );
    assert.deepEqual(filesNamedIn([nested], "input"), [path.join(CWD, nested)]);
  });

  test("an absolute prefix is read where the session said it was", () => {
    const otherTree = path.join(
      path.sep,
      "repos",
      "other-worktree",
      ".closedloop-ai",
      "code-review",
      "cr-1",
      "review_result.json"
    );
    assert.deepEqual(filesNamedIn([otherTree], "input"), [otherTree]);
  });

  test("a run named only in a tool output is not minted, while the same path in an input is", () => {
    const enumerated = [
      path.join(
        CWD,
        "old",
        ".closedloop-ai",
        "code-review",
        "cr-99",
        "review_result.json"
      ),
      path.join(
        CWD,
        "older",
        ".closedloop-ai",
        "code-review",
        "cr-98",
        "review_result.json"
      ),
    ];
    // PRESENT when the session itself named the paths...
    assert.deepEqual(filesNamedIn(enumerated, "input").length, 2);
    // ...and ABSENT when a search tool merely listed it. The pair is what makes
    // the absence meaningful: a scan that resolved nothing would satisfy the
    // empty assertion on its own.
    assert.deepEqual(filesNamedIn(enumerated, "output"), []);
  });

  // ISS-10911: the scan runs synchronously on the store thread inside the
  // writer transaction. A leading `[^…]*` capture re-scanned the rest of each
  // separator-free run from every start position, so this 256 KB payload held
  // the thread for about two minutes. The run shares its token with a reference,
  // so skipping marker-free tokens cannot be what keeps it fast. Linear, it is
  // milliseconds; the timeout is the ceiling it misses by orders of magnitude,
  // never a latency budget.
  test("a reference inside a large separator-free payload still resolves", {
    timeout: 30_000,
  }, () => {
    const reference = path.join(
      "sub",
      ".closedloop-ai",
      "code-review",
      "cr-7",
      "review_result.json"
    );
    const session = makeSession({
      sessionId: "session-10911-payload",
      cwd: CWD,
      startedAt: NOW,
      endedAt: "2026-09-26T12:30:00.000Z",
      toolUses: [
        {
          id: "toolu_write",
          providerToolUseId: "toolu_write",
          name: "Write",
          kind: "builtin" as const,
          timestamp: NOW,
          input: {
            file_path: reference,
            content: `${reference}/${"QUJD".repeat(65_536)}`,
          },
        },
      ],
    });
    assert.deepEqual(
      [...codeReviewEnvelopePathsInSession(session, CWD)],
      [path.join(CWD, reference)]
    );
  });

  // ISS-10911 review (tamsinb on #8030): the old single regex's greedy prefix
  // settled on the LAST reference in a token. Taking the first match instead
  // would read cr-1 under `a/` here.
  test("two references in one token resolve to the last, under the whole prefix before it", () => {
    const outer = path.join("a", ".closedloop-ai", "code-review", "cr-1", "b");
    const token = path.join(outer, ".closedloop-ai", "code-review", "cr-2");
    assert.deepEqual(filesNamedIn([token], "input"), [
      path.join(CWD, token, "review_result.json"),
    ]);
  });
});
