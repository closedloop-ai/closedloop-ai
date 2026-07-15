/**
 * @file parser-utils.test.ts
 * @description Unit tests for the FEA-1554 helpers added to
 * src/main/collectors/parser-utils.ts: truncateText, computeLineDelta,
 * computeUnifiedDiffDelta, countDiffFiles, extractRepoFromCwd,
 * extractPrReferences, extractIssueReferences, isSyntheticModelKey,
 * and collectArtifacts.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  collectArtifacts,
  collectJsonlFiles,
  computeLineDelta,
  computeUnifiedDiffDelta,
  countDiffFiles,
  extractIssueReferences,
  extractPrReferences,
  extractRepoFromCwd,
  isSyntheticModelKey,
  shellCommandArgv,
  truncateText,
} from "../src/main/collectors/parsing/parser-utils.js";
import type { NormalizedToolUse } from "../src/main/collectors/types.js";

// ---------------------------------------------------------------------------
// truncateText
// ---------------------------------------------------------------------------

test("truncateText returns null for null", () => {
  assert.equal(truncateText(null), null);
});

test("truncateText returns null for undefined", () => {
  assert.equal(truncateText(undefined), null);
});

test("truncateText returns null for empty string", () => {
  assert.equal(truncateText(""), null);
});

test("truncateText passes through short strings unchanged", () => {
  assert.equal(truncateText("hello world"), "hello world");
});

test("truncateText truncates strings exceeding 4096 bytes", () => {
  const long = "x".repeat(5000);
  const result = truncateText(long);
  assert.ok(result !== null);
  assert.equal(Buffer.byteLength(result, "utf8"), 4096);
});

test("truncateText handles multi-byte UTF-8 correctly", () => {
  // Each emoji is 4 bytes in UTF-8
  const emoji = "\u{1F600}"; // 😀
  assert.equal(Buffer.byteLength(emoji, "utf8"), 4);
  // Build a string of emojis that exceeds a small byte limit
  const text = emoji.repeat(10); // 40 bytes
  const result = truncateText(text, 16);
  assert.ok(result !== null);
  assert.ok(Buffer.byteLength(result, "utf8") <= 16);
});

test("truncateText respects custom maxBytes", () => {
  const text = "abcdefghij"; // 10 bytes ASCII
  const result = truncateText(text, 5);
  assert.ok(result !== null);
  assert.equal(Buffer.byteLength(result, "utf8"), 5);
  assert.equal(result, "abcde");
});

// ---------------------------------------------------------------------------
// computeLineDelta
// ---------------------------------------------------------------------------

test("computeLineDelta returns {add:0, del:0} for null inputs", () => {
  assert.deepEqual(computeLineDelta(null, null), { add: 0, del: 0 });
});

test("computeLineDelta returns {add:0, del:0} for undefined inputs", () => {
  assert.deepEqual(computeLineDelta(undefined, undefined), { add: 0, del: 0 });
});

test("computeLineDelta computes add when new has more lines", () => {
  const result = computeLineDelta("line1", "line1\nline2\nline3");
  assert.deepEqual(result, { add: 2, del: 0 });
});

test("computeLineDelta computes del when old has more lines", () => {
  const result = computeLineDelta("a\nb\nc\nd", "a");
  assert.deepEqual(result, { add: 0, del: 3 });
});

test("computeLineDelta handles mixed add/del via set-based comparison", () => {
  // old {a,b,c} -> new {x,y,z,w,v}: all 3 old lines removed, all 5 new lines added
  const result = computeLineDelta("a\nb\nc", "x\ny\nz\nw\nv");
  assert.deepEqual(result, { add: 5, del: 3 });

  // old {a,b,c,d,e} -> new {x,y}: all 5 old removed, 2 new added
  const result2 = computeLineDelta("a\nb\nc\nd\ne", "x\ny");
  assert.deepEqual(result2, { add: 2, del: 5 });
});

test("computeLineDelta with one null side", () => {
  assert.deepEqual(computeLineDelta(null, "a\nb"), { add: 2, del: 0 });
  assert.deepEqual(computeLineDelta("a\nb\nc", null), { add: 0, del: 3 });
});

// ---------------------------------------------------------------------------
// computeUnifiedDiffDelta
// ---------------------------------------------------------------------------

test("computeUnifiedDiffDelta counts + lines excluding +++ header", () => {
  const patch = [
    "--- a/file.ts",
    "+++ b/file.ts",
    "@@ -1,3 +1,4 @@",
    " unchanged",
    "+added line 1",
    "+added line 2",
    " unchanged",
  ].join("\n");
  const result = computeUnifiedDiffDelta(patch);
  assert.equal(result.add, 2);
  assert.equal(result.del, 0);
});

test("computeUnifiedDiffDelta counts - lines excluding --- header", () => {
  const patch = [
    "--- a/file.ts",
    "+++ b/file.ts",
    "@@ -1,4 +1,2 @@",
    " unchanged",
    "-removed line 1",
    "-removed line 2",
    " unchanged",
  ].join("\n");
  const result = computeUnifiedDiffDelta(patch);
  assert.equal(result.add, 0);
  assert.equal(result.del, 2);
});

test("computeUnifiedDiffDelta returns zero for empty string", () => {
  assert.deepEqual(computeUnifiedDiffDelta(""), { add: 0, del: 0 });
});

test("computeUnifiedDiffDelta handles mixed adds and deletes", () => {
  const patch = [
    "--- a/file.ts",
    "+++ b/file.ts",
    "@@ -1,3 +1,3 @@",
    "-old line",
    "+new line",
    " context",
    "-another old",
    "+another new",
  ].join("\n");
  const result = computeUnifiedDiffDelta(patch);
  assert.equal(result.add, 2);
  assert.equal(result.del, 2);
});

// ---------------------------------------------------------------------------
// countDiffFiles
// ---------------------------------------------------------------------------

test("countDiffFiles counts --- headers in unified diff", () => {
  const patch = [
    "--- a/file1.ts",
    "+++ b/file1.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "--- a/file2.ts",
    "+++ b/file2.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  assert.equal(countDiffFiles(patch), 2);
});

test("countDiffFiles returns 0 for empty string", () => {
  assert.equal(countDiffFiles(""), 0);
});

test("countDiffFiles returns 0 for patch with no --- headers", () => {
  assert.equal(countDiffFiles("+added\n context"), 0);
});

// ---------------------------------------------------------------------------
// extractRepoFromCwd
// ---------------------------------------------------------------------------

test("extractRepoFromCwd returns last path component", () => {
  assert.equal(
    extractRepoFromCwd("/home/user/Workspace/symphony-alpha"),
    "symphony-alpha"
  );
});

test("extractRepoFromCwd returns null for null", () => {
  assert.equal(extractRepoFromCwd(null), null);
});

test("extractRepoFromCwd returns null for undefined", () => {
  assert.equal(extractRepoFromCwd(undefined), null);
});

test("extractRepoFromCwd returns null for empty string", () => {
  assert.equal(extractRepoFromCwd(""), null);
});

test("extractRepoFromCwd strips trailing slashes", () => {
  assert.equal(extractRepoFromCwd("/home/user/project/"), "project");
  assert.equal(extractRepoFromCwd("/home/user/project///"), "project");
});

// ---------------------------------------------------------------------------
// extractPrReferences
// ---------------------------------------------------------------------------

test("extractPrReferences finds PR from create_pull_request tool", () => {
  const refs = extractPrReferences("create_pull_request", {
    head: "feat/my-branch",
    repo: "closedloop-ai/symphony",
  });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].number, "pending");
  assert.equal(refs[0].repo, "closedloop-ai/symphony");
});

test("extractPrReferences finds PR from mcp__github__create_pull_request", () => {
  const refs = extractPrReferences("mcp__github__create_pull_request", {
    head: "fix/bug-123",
    repo: "org/repo",
  });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].number, "pending");
});

test("extractPrReferences finds PR from Bash tool gh pr create command", () => {
  const refs = extractPrReferences("Bash", {
    command: "gh pr create --title 'My PR' --body 'desc'",
  });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].number, "pending");
});

test("extractPrReferences returns empty for Bash without gh pr create", () => {
  const refs = extractPrReferences("Bash", {
    command: "git push origin main",
  });
  assert.equal(refs.length, 0);
});

test("extractPrReferences returns empty for unrelated tools", () => {
  assert.deepEqual(extractPrReferences("Read", { file: "foo.ts" }), []);
  assert.deepEqual(extractPrReferences("Edit", { file: "bar.ts" }), []);
});

test("extractPrReferences returns empty for null input", () => {
  assert.deepEqual(extractPrReferences("create_pull_request", null), []);
});

test("extractPrReferences records pending when head is missing", () => {
  const refs = extractPrReferences("create_pull_request", { repo: "org/repo" });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].number, "pending");
});

// ---------------------------------------------------------------------------
// extractIssueReferences
// ---------------------------------------------------------------------------

test("extractIssueReferences finds ENG-NNN pattern in text fields", () => {
  const refs = extractIssueReferences("Bash", {
    command: "git commit -m 'ENG-123: fix bug'",
  });
  assert.ok(refs.some((r) => r.key === "ENG-123"));
});

test("extractIssueReferences finds #NNN pattern", () => {
  const refs = extractIssueReferences("Bash", {
    command: "fixes #456",
  });
  assert.ok(refs.some((r) => r.key === "#456"));
});

test("extractIssueReferences finds issue from linear tool calls", () => {
  const refs = extractIssueReferences("mcp__linear-server__get_issue", {
    issue_id: "ENG-789",
  });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].key, "ENG-789");
});

test("extractIssueReferences finds issue from issueId field", () => {
  const refs = extractIssueReferences("linear.get_issue", {
    issueId: "PROJ-42",
  });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].key, "PROJ-42");
});

test("extractIssueReferences deduplicates", () => {
  const refs = extractIssueReferences("Bash", {
    command: "ENG-100 ENG-100 ENG-100",
  });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].key, "ENG-100");
});

test("extractIssueReferences scans multiple text fields", () => {
  const refs = extractIssueReferences("SomeTool", {
    command: "ENG-1",
    body: "ENG-2",
    description: "#99",
  });
  assert.ok(refs.some((r) => r.key === "ENG-1"));
  assert.ok(refs.some((r) => r.key === "ENG-2"));
  assert.ok(refs.some((r) => r.key === "#99"));
  assert.equal(refs.length, 3);
});

test("extractIssueReferences returns empty for null input", () => {
  assert.deepEqual(extractIssueReferences("Bash", null), []);
});

test("extractIssueReferences returns empty for unrelated input", () => {
  assert.deepEqual(extractIssueReferences("Read", { file: "foo.ts" }), []);
});

// ---------------------------------------------------------------------------
// isSyntheticModelKey
// ---------------------------------------------------------------------------

test("isSyntheticModelKey returns true for *-default patterns", () => {
  assert.equal(isSyntheticModelKey("claude-default"), true);
  assert.equal(isSyntheticModelKey("o3-default"), true);
  assert.equal(isSyntheticModelKey("anything-default"), true);
});

test("isSyntheticModelKey returns false for real model IDs", () => {
  assert.equal(isSyntheticModelKey("claude-opus-4"), false);
  assert.equal(isSyntheticModelKey("claude-sonnet-4-20250514"), false);
  assert.equal(isSyntheticModelKey("gpt-4o"), false);
  assert.equal(isSyntheticModelKey("o3-mini"), false);
  // FEA-2085: the Codex fallback is now the real, priceable gpt-5-codex, and the
  // old unpriceable "gpt-codex" placeholder is no longer emitted — neither is a
  // synthetic *key* anymore. The "guessed attribution" signal moved to the
  // token-row `inferred` flag.
  assert.equal(isSyntheticModelKey("gpt-5-codex"), false);
  assert.equal(isSyntheticModelKey("gpt-codex"), false);
});

// ---------------------------------------------------------------------------
// collectArtifacts
// ---------------------------------------------------------------------------

test("collectArtifacts combines PR and issue refs from multiple tool uses", () => {
  const toolUses = [
    {
      name: "create_pull_request",
      input: { head: "feat/x", repo: "org/repo" },
    },
    { name: "Bash", input: { command: "fixes ENG-42" } },
    { name: "mcp__linear-server__get_issue", input: { issue_id: "ENG-99" } },
  ];
  const result = collectArtifacts(toolUses, "/home/user/my-project");
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].number, "pending");
  assert.equal(result.prs[0].repo, "org/repo");
  assert.ok(result.issues.some((i) => i.key === "ENG-42"));
  assert.ok(result.issues.some((i) => i.key === "ENG-99"));
  assert.equal(result.repo, "my-project");
});

test("collectArtifacts extracts concrete PR URLs from tool output", () => {
  const toolUses = [
    {
      name: "exec_command",
      input: { cmd: "gh pr create --fill" },
      output:
        "Created https://github.com/closedloop-ai/symphony-alpha/pull/1453",
    },
  ];

  const result = collectArtifacts(toolUses, "/home/user/symphony-alpha");

  assert.deepEqual(result.prs, [
    {
      number: "1453",
      repo: "closedloop-ai/symphony-alpha",
      url: "https://github.com/closedloop-ai/symphony-alpha/pull/1453",
    },
  ]);
});

test("extractPrReferences does not add pending when output has a PR URL", () => {
  const refs = extractPrReferences(
    "Bash",
    { command: "gh pr create --fill" },
    "https://github.com/closedloop-ai/symphony-alpha/pull/1453"
  );

  assert.deepEqual(refs, [
    {
      number: "1453",
      repo: "closedloop-ai/symphony-alpha",
      url: "https://github.com/closedloop-ai/symphony-alpha/pull/1453",
    },
  ]);
});

test("collectArtifacts extracts repo from cwd", () => {
  const result = collectArtifacts([], "/home/user/Workspace/symphony-alpha");
  assert.equal(result.repo, "symphony-alpha");
  assert.deepEqual(result.prs, []);
  assert.deepEqual(result.issues, []);
});

test("collectArtifacts deduplicates PRs", () => {
  const toolUses = [
    {
      name: "create_pull_request",
      input: { head: "feat/x", repo: "org/repo" },
    },
    {
      name: "create_pull_request",
      input: { head: "feat/x", repo: "org/repo" },
    },
  ];
  const result = collectArtifacts(toolUses, null);
  assert.equal(result.prs.length, 1);
});

test("collectArtifacts deduplicates issues", () => {
  const toolUses = [
    { name: "Bash", input: { command: "ENG-42 and ENG-42" } },
    { name: "Bash", input: { command: "ENG-42 again" } },
  ];
  const result = collectArtifacts(toolUses, null);
  assert.equal(result.issues.filter((i) => i.key === "ENG-42").length, 1);
});

test("collectArtifacts returns null repo for null cwd", () => {
  const result = collectArtifacts([], null);
  assert.equal(result.repo, null);
});

test("collectArtifacts handles empty tool uses", () => {
  const result = collectArtifacts([], null);
  assert.deepEqual(result.prs, []);
  assert.deepEqual(result.issues, []);
  assert.equal(result.repo, null);
});

// ---------------------------------------------------------------------------
// shellCommandArgv (FEA-2791): exposes the argv array shellCommand would join,
// or null for non-argv shapes, so callers can respect argument boundaries.
// ---------------------------------------------------------------------------

const toolWith = (input: unknown): NormalizedToolUse =>
  ({ name: "Bash", input }) as unknown as NormalizedToolUse;

test("shellCommandArgv returns null for a bare string command", () => {
  assert.equal(shellCommandArgv(toolWith("git push origin feat/x")), null);
  assert.equal(
    shellCommandArgv(toolWith({ command: "git push origin feat/x" })),
    null
  );
});

test("shellCommandArgv returns the array for a bare-array input", () => {
  assert.deepEqual(
    shellCommandArgv(toolWith(["rg", "git push origin feat/x"])),
    ["rg", "git push origin feat/x"]
  );
});

test("shellCommandArgv unwraps command/cmd argv arrays and coerces elements", () => {
  assert.deepEqual(
    shellCommandArgv(toolWith({ command: ["git", "push", "-u", "origin"] })),
    ["git", "push", "-u", "origin"]
  );
  assert.deepEqual(shellCommandArgv(toolWith({ cmd: ["git", 42] })), [
    "git",
    "42",
  ]);
});

test("shellCommandArgv returns null for missing/empty input", () => {
  assert.equal(shellCommandArgv(toolWith(undefined)), null);
  assert.equal(shellCommandArgv(toolWith({})), null);
});

test("shellCommandArgv coerces null/undefined elements to '' like Array.join", () => {
  // shellCommand flattens via `argv.join(" ")`, which renders null/undefined as
  // "". shellCommandArgv must match so callers' offset math stays aligned.
  assert.deepEqual(
    shellCommandArgv(toolWith({ command: ["git", null, undefined, "push"] })),
    ["git", "", "", "push"]
  );
});

// ---------------------------------------------------------------------------
// collectJsonlFiles (shared walker behind collectRolloutFiles/collectTranscriptFiles)
// ---------------------------------------------------------------------------

function touchFile(p: string): string {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, "");
  return p;
}

test("collectJsonlFiles returns [] for a missing root", () => {
  assert.deepEqual(collectJsonlFiles("/no/such/root"), []);
});

test("collectJsonlFiles returns [] for empty/falsy root", () => {
  assert.deepEqual(collectJsonlFiles(""), []);
});

test("collectJsonlFiles collects only nested .jsonl files, is depth-bounded", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "collect-jsonl-"));
  const nested = touchFile(path.join(root, "2026", "06", "24", "a.jsonl"));
  touchFile(path.join(root, "b", "notes.txt")); // non-jsonl is ignored
  const tooDeep = touchFile(path.join(root, "a", "b", "c", "d", "deep.jsonl"));

  const found = collectJsonlFiles(root, { maxDepth: 3 });
  assert.ok(found.includes(nested), "nested .jsonl within depth is collected");
  assert.ok(!found.includes(tooDeep), "file beyond maxDepth is excluded");
  assert.ok(
    found.every((f) => f.endsWith(".jsonl")),
    "only .jsonl files are returned"
  );
});
