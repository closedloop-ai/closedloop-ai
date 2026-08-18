import { describe, expect, it } from "vitest";
import {
  type CodexDiffAccumulator,
  extractDiffFilePaths,
  mergeDiffDelta,
} from "./codex-diff-stats";
import { parseCodexRollout } from "./parse-codex";

/** A Codex apply_patch envelope editing one file with the given +/- line bodies. */
function patch(filePath: string, added: string[], removed: string[]): string {
  const body = [
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");
  return `*** Begin Patch\n*** Update File: ${filePath}\n@@\n${body}\n*** End Patch\n`;
}

/** A `response_item` custom_tool_call carrying an apply_patch, as Codex emits. */
function applyPatchLine(callId: string, ts: string, input: string): string {
  return JSON.stringify({
    type: "response_item",
    timestamp: ts,
    payload: {
      type: "custom_tool_call",
      status: "completed",
      call_id: callId,
      name: "apply_patch",
      input,
    },
  });
}

const META_LINES = [
  JSON.stringify({
    type: "session_meta",
    timestamp: "2026-07-29T12:00:00.000Z",
    payload: { cwd: "/workspace/proj", cli_version: "1.2.3" },
  }),
  JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-29T12:00:00.500Z",
    payload: { model: "gpt-5-codex" },
  }),
];

describe("extractDiffFilePaths", () => {
  it("extracts the path from a Codex Update/Add/Delete File header", () => {
    expect(
      extractDiffFilePaths(
        "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch\n"
      )
    ).toEqual(["src/a.ts"]);
    expect(extractDiffFilePaths("*** Add File: src/new.ts\n+hello\n")).toEqual([
      "src/new.ts",
    ]);
    expect(extractDiffFilePaths("*** Delete File: src/gone.ts\n")).toEqual([
      "src/gone.ts",
    ]);
  });

  it("matches Codex + unified headers in a CRLF (Windows) patch", () => {
    // shafty023 CR: a `\r\n` rollout must not miss every `*** … File:` directive
    // (which would rebuild the session with filesChanged: 0). Splitting on
    // /\r?\n/ drops the trailing \r so the header regex still matches.
    expect(
      extractDiffFilePaths(
        "*** Begin Patch\r\n*** Update File: src/a.ts\r\n@@\r\n-old\r\n+new\r\n*** End Patch\r\n"
      )
    ).toEqual(["src/a.ts"]);
    // Unified headers too: the \r must not leak into the captured path.
    expect(
      extractDiffFilePaths(
        "--- a/src/b.ts\r\n+++ b/src/b.ts\r\n-old\r\n+new\r\n"
      )
    ).toEqual(["src/b.ts"]);
  });

  it("normalizes a unified-diff header pair to the prefix-stripped path", () => {
    // The `a/`/`b/` git diff prefix is stripped so it matches the Codex
    // envelope's bare `src/a.ts`, not the raw `a/src/a.ts` header string.
    expect(
      extractDiffFilePaths("--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n")
    ).toEqual(["src/a.ts"]);
  });

  it("gives a Codex envelope and a unified diff for the same file one identity", () => {
    // wongk CR: a mixed-format session must NOT count src/a.ts twice.
    const acc: CodexDiffAccumulator = {
      diffStats: null,
      diffFiles: new Set<string>(),
    };
    mergeDiffDelta(acc, "*** Update File: src/a.ts\n@@\n+x\n");
    mergeDiffDelta(acc, "--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n");
    expect(acc.diffStats?.filesChanged).toBe(1);
  });

  it("keeps added files distinct despite the shared /dev/null old header", () => {
    // wongk CR: every unified ADD has `--- /dev/null`; pick the real +++ side
    // so two added files don't collapse to a single /dev/null entry.
    expect(
      extractDiffFilePaths(
        "--- /dev/null\n+++ b/src/new1.ts\n+a\n--- /dev/null\n+++ b/src/new2.ts\n+b\n"
      )
    ).toEqual(["src/new1.ts", "src/new2.ts"]);
  });

  it("uses the old side when a delete's new header is /dev/null", () => {
    expect(
      extractDiffFilePaths("--- a/src/gone.ts\n+++ /dev/null\n-bye\n")
    ).toEqual(["src/gone.ts"]);
  });

  it("returns one entry per header occurrence (dedup is the caller's job)", () => {
    // Two headers naming the same path → two entries; the Set in the accumulator
    // collapses them.
    expect(
      extractDiffFilePaths(
        "*** Update File: src/a.ts\n@@\n+x\n*** Update File: src/a.ts\n@@\n+y\n"
      )
    ).toEqual(["src/a.ts", "src/a.ts"]);
  });

  it("returns no paths for a patch with no recognized header", () => {
    expect(extractDiffFilePaths("@@\n+just a line\n")).toEqual([]);
  });
});

describe("mergeDiffDelta", () => {
  it("dedups filesChanged by path across patches while lines sum", () => {
    const acc: CodexDiffAccumulator = {
      diffStats: null,
      diffFiles: new Set<string>(),
    };
    mergeDiffDelta(acc, patch("src/a.ts", ["one", "two"], ["gone"])); // +2 -1
    mergeDiffDelta(acc, patch("src/a.ts", ["three"], [])); // +1 -0, SAME file
    mergeDiffDelta(acc, patch("src/b.ts", ["four"], ["bye"])); // +1 -1, distinct

    // Two distinct files — NOT three patch headers.
    expect(acc.diffStats).toEqual({
      filesChanged: 2,
      linesAdded: 4,
      linesRemoved: 2,
    });
  });

  it("returns the per-patch delta for tu.diffDelta stamping", () => {
    const acc: CodexDiffAccumulator = {
      diffStats: null,
      diffFiles: new Set<string>(),
    };
    expect(mergeDiffDelta(acc, patch("src/a.ts", ["x", "y"], ["z"]))).toEqual({
      add: 2,
      del: 1,
    });
  });
});

describe("normalizeUnifiedHeaderPath — edge cases", () => {
  it("strips a trailing tab-timestamp from a unified diff header", () => {
    // `diff -u` appends `\t<timestamp>` after the path; the tab branch is uncovered
    // because standard git headers use `a/`/`b/` prefixes without trailing tabs.
    expect(
      extractDiffFilePaths(
        "--- a/src/a.ts\t2026-08-01 10:00:00\n+++ b/src/a.ts\t2026-08-01 10:00:01\n"
      )
    ).toEqual(["src/a.ts"]);
  });

  it("skips a Codex header whose path is blank after trimming (pure whitespace)", () => {
    // The regex captures `(.+)` which matches spaces; trimming collapses to "".
    // `if (path)` is FALSE → not pushed.
    const onlyWhitespace = "*** Update File:    \n@@\n+x\n";
    expect(extractDiffFilePaths(onlyWhitespace)).toEqual([]);
  });

  it("produces no paths when both old and new unified headers normalize to null (/dev/null pair)", () => {
    // `--- /dev/null` and `+++ /dev/null` both normalize to null.
    // chosen = null ?? null ?? null = null → not pushed.
    expect(extractDiffFilePaths("--- /dev/null\n+++ /dev/null\n+x\n")).toEqual(
      []
    );
  });
});

describe("parseCodexRollout diffStats (FEA-3943 regression)", () => {
  it("counts a file edited across multiple apply_patch events once", async () => {
    const lines = [
      ...META_LINES,
      applyPatchLine(
        "call_1",
        "2026-07-29T12:00:01.000Z",
        patch("src/same.ts", ["a", "b"], ["x"]) // +2 -1
      ),
      applyPatchLine(
        "call_2",
        "2026-07-29T12:00:02.000Z",
        patch("src/same.ts", ["c"], []) // +1 -0, SAME file
      ),
      applyPatchLine(
        "call_3",
        "2026-07-29T12:00:03.000Z",
        patch("src/other.ts", ["d"], ["y"]) // +1 -1, distinct file
      ),
    ];

    const session = await parseCodexRollout(lines, { sessionId: "codex-df" });

    // Distinct files = 2 (same.ts, other.ts), NOT the 3-patch header sum the
    // pre-FEA-3943 parser reported. Lines still sum across every patch.
    expect(session?.diffStats).toEqual({
      filesChanged: 2,
      linesAdded: 4,
      linesRemoved: 2,
    });
  });
});
