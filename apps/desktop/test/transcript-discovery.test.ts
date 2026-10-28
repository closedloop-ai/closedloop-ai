/**
 * @file transcript-discovery.test.ts
 * @description FEA-2715 discovery ref-mapping (pure). Verifies Claude main +
 * subagent files and Codex root + descendant rollouts all map to
 * `(externalSessionId, fileKey)` with subagents grouped under their owning
 * session.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { CodexRolloutLinkage } from "../src/main/collectors/codex/codex-subagent-rollouts.js";
import {
  claudeRefsFromListings,
  codexRefsFromRollouts,
  codexRefsFromRolloutsAttributable,
  discoverTranscriptFiles,
  discoverTranscriptFilesWithEvidence,
  opencodeRefsFromSessions,
} from "../src/main/transcript-sync/transcript-discovery.js";
import {
  TRANSCRIPT_MAIN_FILE_KEY,
  TranscriptSourceHarness,
} from "../src/main/transcript-sync/transcript-sync-types.js";
import { codexLinkage as linkage } from "./normalized-session-test-utils.js";

test("claudeRefsFromListings maps main + subagent files to one session", () => {
  const refs = claudeRefsFromListings(
    ["/home/.claude/projects/proj/sess-1.jsonl"],
    [
      {
        parentSessionId: "sess-1",
        fileId: "agent-abc",
        filePath:
          "/home/.claude/projects/proj/sess-1/subagents/agent-abc.jsonl",
      },
    ]
  );
  assert.deepEqual(
    refs.map((r) => `${r.externalSessionId}:${r.fileKey}:${r.sourceHarness}`),
    ["sess-1:main:claude", "sess-1:subagent:agent-abc:claude"]
  );
});

test("codexRefsFromRollouts groups descendants under the root session", () => {
  const byId = new Map<string, CodexRolloutLinkage>([
    ["root", linkage("root", null, 0, "/codex/root.jsonl")],
    ["child", linkage("child", "root", 1, "/codex/child.jsonl")],
    [
      "grandchild",
      linkage("grandchild", "child", 1, "/codex/grandchild.jsonl"),
    ],
  ]);
  const refs = codexRefsFromRollouts(byId);
  const byRolloutPath = new Map(refs.map((r) => [r.sourcePath, r]));

  assert.equal(byRolloutPath.get("/codex/root.jsonl")?.fileKey, "main");
  assert.equal(
    byRolloutPath.get("/codex/root.jsonl")?.externalSessionId,
    "root"
  );
  // Both descendants archive under the root session with distinct subagent keys.
  assert.equal(
    byRolloutPath.get("/codex/child.jsonl")?.externalSessionId,
    "root"
  );
  assert.equal(
    byRolloutPath.get("/codex/child.jsonl")?.fileKey,
    "subagent:child"
  );
  assert.equal(
    byRolloutPath.get("/codex/grandchild.jsonl")?.externalSessionId,
    "root"
  );
  assert.equal(
    byRolloutPath.get("/codex/grandchild.jsonl")?.fileKey,
    "subagent:grandchild"
  );
});

test("codexRefsFromRollouts groups fork rollouts under the root session (FEA-2928)", () => {
  const byId = new Map<string, CodexRolloutLinkage>([
    ["root", linkage("root", null, 0, "/codex/root.jsonl")],
    ["fork", linkage("fork", null, null, "/codex/fork.jsonl", "root")],
  ]);
  const refs = codexRefsFromRollouts(byId);
  const byRolloutPath = new Map(refs.map((r) => [r.sourcePath, r]));

  assert.equal(byRolloutPath.get("/codex/root.jsonl")?.fileKey, "main");
  assert.equal(
    byRolloutPath.get("/codex/root.jsonl")?.externalSessionId,
    "root"
  );
  assert.equal(
    byRolloutPath.get("/codex/fork.jsonl")?.externalSessionId,
    "root"
  );
  assert.equal(
    byRolloutPath.get("/codex/fork.jsonl")?.fileKey,
    "subagent:fork"
  );
});

test("codexRefsFromRollouts classifies orphan fork as main (FEA-2928)", () => {
  const byId = new Map<string, CodexRolloutLinkage>([
    ["orphan", linkage("orphan", null, null, "/codex/orphan.jsonl", "ghost")],
  ]);
  const refs = codexRefsFromRollouts(byId);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.fileKey, "main");
  assert.equal(refs[0]?.externalSessionId, "orphan");
});

test("opencodeRefsFromSessions maps materialized files to opencode refs (FEA-3932)", () => {
  const refs = opencodeRefsFromSessions([
    {
      externalSessionId: "opencode-root",
      fileKey: "main",
      sourcePath:
        "/state/transcript-materialized/opencode/opencode-root/main.jsonl",
    },
    {
      externalSessionId: "opencode-root",
      fileKey: "subagent:child",
      sourcePath:
        "/state/transcript-materialized/opencode/opencode-root/subagent:child.jsonl",
    },
  ]);
  assert.deepEqual(
    refs.map((r) => `${r.externalSessionId}:${r.fileKey}:${r.sourceHarness}`),
    ["opencode-root:main:opencode", "opencode-root:subagent:child:opencode"]
  );
});

test("discoverTranscriptFiles appends opencode refs after claude + codex (FEA-3932)", () => {
  const refs = discoverTranscriptFiles({
    listClaudeMainFiles: () => ["/home/.claude/projects/p/sess-1.jsonl"],
    listClaudeSubagentFiles: () => [],
    listCodexRolloutFiles: () => [],
    mapCodexById: () => new Map(),
    listOpencodeMaterializedFiles: () => [
      {
        externalSessionId: "opencode-1",
        fileKey: TRANSCRIPT_MAIN_FILE_KEY,
        sourcePath:
          "/state/transcript-materialized/opencode/opencode-1/main.jsonl",
      },
    ],
  });
  const harnesses = refs.map((r) => r.sourceHarness);
  assert.ok(harnesses.includes(TranscriptSourceHarness.Claude));
  assert.ok(harnesses.includes(TranscriptSourceHarness.OpenCode));
  // OpenCode refs come last (appended after claude + codex).
  assert.equal(refs.at(-1)?.sourceHarness, TranscriptSourceHarness.OpenCode);
  assert.equal(refs.at(-1)?.externalSessionId, "opencode-1");
});

test("the import lane still re-roots an orphaned descendant onto itself", () => {
  // ISS-8506 pins the EXISTING behavior rather than changing it. For an
  // error-tolerant import, half a graph beats none: the session is real and its
  // transcript should still sync. The measurement lane needs the opposite
  // answer, which is why it is a separate function rather than an edit here.
  const byId = new Map<string, CodexRolloutLinkage>([
    ["child", linkage("child", "missing-parent", 1, "/codex/child.jsonl")],
  ]);

  const refs = codexRefsFromRollouts(byId);

  assert.deepEqual(
    refs.map((r) => `${r.externalSessionId}:${r.fileKey}`),
    ["child:main"]
  );
});

test("the measurement lane drops a rollout whose parent chain was cut", () => {
  // Re-rooting here would file real bytes under a session id that is not a
  // session — a fabricated measurement. Under-report with evidence instead.
  const byId = new Map<string, CodexRolloutLinkage>([
    ["child", linkage("child", "missing-parent", 1, "/codex/child.jsonl")],
  ]);

  const attributable = codexRefsFromRolloutsAttributable(byId);

  assert.deepEqual(attributable.refs, []);
  assert.equal(attributable.orphanCount, 1);
});

test("the measurement lane keeps a rollout whose chain resolves intact", () => {
  const byId = new Map<string, CodexRolloutLinkage>([
    ["root", linkage("root", null, 0, "/codex/root.jsonl")],
    ["child", linkage("child", "root", 1, "/codex/child.jsonl")],
  ]);

  const attributable = codexRefsFromRolloutsAttributable(byId);

  assert.equal(attributable.orphanCount, 0);
  assert.deepEqual(
    attributable.refs.map((r) => `${r.externalSessionId}:${r.fileKey}`).sort(),
    ["root:main", "root:subagent:child"]
  );
});

test("a fork-linked rollout with a missing target is dropped, not re-rooted", () => {
  // `effectiveParentId` prefers `parentThreadId` and falls back to
  // `forkedFromId`. Reusing it here is what keeps the orphan test from drifting
  // out of step with the walk's own notion of a parent.
  const byId = new Map<string, CodexRolloutLinkage>([
    ["forked", linkage("forked", null, 0, "/codex/forked.jsonl", "gone")],
  ]);

  assert.equal(codexRefsFromRolloutsAttributable(byId).orphanCount, 1);
});

test("discovery with evidence walks the same one enumeration and reports orphans", () => {
  const discovered = discoverTranscriptFilesWithEvidence({
    listClaudeMainFiles: () => ["/home/.claude/projects/p/sess-1.jsonl"],
    listClaudeSubagentFiles: () => [],
    listCodexRolloutFiles: () => [],
    mapCodexById: () =>
      new Map<string, CodexRolloutLinkage>([
        ["orphan", linkage("orphan", "gone", 1, "/codex/orphan.jsonl")],
        ["root", linkage("root", null, 0, "/codex/root.jsonl")],
      ]),
    listOpencodeMaterializedFiles: () => [
      {
        externalSessionId: "opencode-1",
        fileKey: TRANSCRIPT_MAIN_FILE_KEY,
        sourcePath:
          "/state/transcript-materialized/opencode/opencode-1/main.jsonl",
      },
    ],
  });

  // Same three harnesses, same order, one walk — the numerator and the
  // denominator cannot disagree about which files exist.
  assert.deepEqual(
    discovered.refs.map((r) => r.sourceHarness),
    [
      TranscriptSourceHarness.Claude,
      TranscriptSourceHarness.Codex,
      TranscriptSourceHarness.OpenCode,
    ]
  );
  assert.equal(discovered.orphanCount, 1);
});
