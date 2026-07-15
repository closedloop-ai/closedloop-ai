/**
 * @file transcript-discovery.test.ts
 * @description FEA-2715 discovery ref-mapping (pure). Verifies Claude main +
 * subagent files and Codex root + descendant rollouts all map to
 * `(externalSessionId, fileKey)` with subagents grouped under their owning
 * session.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodexRolloutLinkage } from "../src/main/collectors/codex/codex-subagent-rollouts.js";
import {
  claudeRefsFromListings,
  codexRefsFromRollouts,
} from "../src/main/transcript-sync/transcript-discovery.js";
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
