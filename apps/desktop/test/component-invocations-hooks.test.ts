import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { deriveAgentComponentInvocationCandidates } from "../src/main/database/component-invocations.js";
import { makeSession } from "./normalized-session-test-utils.js";

// FEA-4093: a hook firing captured by the parser (`session.hooks`) must
// materialize into a Hook invocation candidate so the usage rollup attributes
// non-zero usage to the Hook inventory row. Before this, hooks produced no
// candidates and Hook rows always aggregated to zero.

const NOW = "2026-07-24T17:00:00.000Z";
const MAIN_AGENT = "main-agent";
// The literal `${CLAUDE_PLUGIN_ROOT}` placeholder, assembled from parts so the
// source has no `${…}` sequence Biome flags as a mistaken template string.
const PLUGIN_ROOT = `$${"{CLAUDE_PLUGIN_ROOT}"}`;

describe("deriveAgentComponentInvocationCandidates hook firings (FEA-4093)", () => {
  test("derives one Hook candidate per captured hook firing", () => {
    const timestamp = "2026-07-24T16:59:00.000Z";
    const candidates = deriveAgentComponentInvocationCandidates(
      makeSession({
        sessionId: "hooks-session",
        messages: [{ role: "human", timestamp, text: "hello" }],
        hooks: [
          {
            name: "PreToolUse:Bash",
            event: "PreToolUse",
            command: 'node "hook-handler.js"',
            succeeded: true,
            timestamp,
          },
        ],
      }),
      MAIN_AGENT,
      NOW
    );
    const hookCandidates = candidates.filter(
      (candidate) =>
        candidate.componentKind === AgentComponentInvocationKind.Hook
    );
    assert.equal(hookCandidates.length, 1);
    const hook = hookCandidates[0];
    // componentKey is the normalized per-handler identity (hookName + the
    // machine-independent normalized command), not hookName alone.
    assert.equal(hook?.componentKey, 'PreToolUse:Bash node "hook-handler.js"');
    assert.equal(hook?.rawName, "PreToolUse:Bash");
    assert.equal(hook?.agentId, MAIN_AGENT);
    assert.equal(hook?.invokedAt, timestamp);
    assert.equal(
      hook?.externalInvocationId,
      `hook:0:${timestamp}:PreToolUse:Bash node "hook-handler.js"`
    );
    // A hook attachment has no transcript turn, so it anchors to the Session
    // rather than a Timestamp ordinal that could collide onto an unrelated row.
    assert.equal(hook?.anchorKind, "session");
    assert.equal(hook?.anchorValue, "hooks-session");
  });

  test("keeps distinct handlers on the same matcher as separate Hook components", () => {
    const timestamp = "2026-07-24T16:59:00.000Z";
    const candidates = deriveAgentComponentInvocationCandidates(
      makeSession({
        sessionId: "hooks-multi-handler",
        hooks: [
          {
            name: "PreToolUse:Bash",
            event: "PreToolUse",
            command: "rtk hook claude",
            succeeded: true,
            timestamp,
          },
          {
            name: "PreToolUse:Bash",
            event: "PreToolUse",
            command: `${PLUGIN_ROOT}/hooks/pre-tool-use-hook.sh`,
            succeeded: true,
            timestamp: "2026-07-24T16:59:01.000Z",
          },
        ],
      }),
      MAIN_AGENT,
      NOW
    );
    const keys = candidates
      .filter(
        (candidate) =>
          candidate.componentKind === AgentComponentInvocationKind.Hook
      )
      .map((candidate) => candidate.componentKey)
      .sort();
    assert.deepEqual(keys, [
      `PreToolUse:Bash ${PLUGIN_ROOT}/hooks/pre-tool-use-hook.sh`,
      "PreToolUse:Bash rtk hook claude",
    ]);
  });

  test("masks machine-specific home paths out of the Hook component key", () => {
    const timestamp = "2026-07-24T16:59:00.000Z";
    const linux = deriveAgentComponentInvocationCandidates(
      makeSession({
        sessionId: "hooks-linux",
        hooks: [
          {
            name: "PostToolUse:Bash",
            event: "PostToolUse",
            command: "python3 /home/testuser6/.claude/scripts/track-tokens.py",
            succeeded: true,
            timestamp,
          },
        ],
      }),
      MAIN_AGENT,
      NOW
    );
    const mac = deriveAgentComponentInvocationCandidates(
      makeSession({
        sessionId: "hooks-mac",
        hooks: [
          {
            name: "PostToolUse:Bash",
            event: "PostToolUse",
            command: "python3 /Users/someone/.claude/scripts/track-tokens.py",
            succeeded: true,
            timestamp,
          },
        ],
      }),
      MAIN_AGENT,
      NOW
    );
    const linuxKey = linux.find(
      (candidate) =>
        candidate.componentKind === AgentComponentInvocationKind.Hook
    )?.componentKey;
    const macKey = mac.find(
      (candidate) =>
        candidate.componentKind === AgentComponentInvocationKind.Hook
    )?.componentKey;
    // The same logical hook on two machines resolves to one host-independent
    // identity; no absolute home path leaks into the key.
    assert.equal(
      linuxKey,
      "PostToolUse:Bash python3 ~/.claude/scripts/track-tokens.py"
    );
    assert.equal(macKey, linuxKey);
  });

  test("derives a distinct candidate per firing of the same hook", () => {
    const first = "2026-07-24T16:59:00.000Z";
    const second = "2026-07-24T16:59:05.000Z";
    const candidates = deriveAgentComponentInvocationCandidates(
      makeSession({
        sessionId: "hooks-repeat-session",
        hooks: [
          {
            name: "PostToolUse:Edit",
            event: "PostToolUse",
            command: null,
            succeeded: true,
            timestamp: first,
          },
          {
            name: "PostToolUse:Edit",
            event: "PostToolUse",
            command: null,
            succeeded: true,
            timestamp: second,
          },
        ],
      }),
      MAIN_AGENT,
      NOW
    );
    const hookCandidates = candidates.filter(
      (candidate) =>
        candidate.componentKind === AgentComponentInvocationKind.Hook
    );
    assert.equal(hookCandidates.length, 2);
    // command is null here, so the identity is hookName alone.
    assert.deepEqual(
      hookCandidates.map((candidate) => candidate.externalInvocationId),
      [`hook:0:${first}:PostToolUse:Edit`, `hook:1:${second}:PostToolUse:Edit`]
    );
  });

  test("threads hook succeeded onto the candidate so a failed firing rolls up as an error", () => {
    const timestamp = "2026-07-24T16:59:00.000Z";
    const candidates = deriveAgentComponentInvocationCandidates(
      makeSession({
        sessionId: "hooks-failed-session",
        hooks: [
          {
            name: "SessionStart:startup",
            event: "SessionStart",
            command: "hook.sh",
            succeeded: false,
            timestamp,
          },
          {
            name: "PreToolUse:Bash",
            event: "PreToolUse",
            command: "hook.sh",
            succeeded: true,
            timestamp: "2026-07-24T16:59:05.000Z",
          },
        ],
      }),
      MAIN_AGENT,
      NOW
    );
    const hookCandidates = candidates.filter(
      (candidate) =>
        candidate.componentKind === AgentComponentInvocationKind.Hook
    );
    assert.equal(hookCandidates.length, 2);
    const failed = hookCandidates.find(
      (candidate) => candidate.componentKey === "SessionStart:startup hook.sh"
    );
    const succeeded = hookCandidates.find(
      (candidate) => candidate.componentKey === "PreToolUse:Bash hook.sh"
    );
    assert.equal(failed?.succeeded, false);
    assert.equal(succeeded?.succeeded, true);
  });

  test("leaves succeeded null for a non-hook candidate", () => {
    const candidates = deriveAgentComponentInvocationCandidates(
      makeSession({
        sessionId: "tool-session",
        toolUses: [{ id: "toolu_1", name: "Read", timestamp: NOW }],
      }),
      MAIN_AGENT,
      NOW
    );
    const toolCandidate = candidates.find(
      (candidate) =>
        candidate.componentKind === AgentComponentInvocationKind.Tool
    );
    assert.equal(toolCandidate?.succeeded, null);
  });

  test("produces no Hook candidate for a session with no hook firings", () => {
    const candidates = deriveAgentComponentInvocationCandidates(
      makeSession({
        sessionId: "no-hooks-session",
        messages: [{ role: "human", timestamp: NOW, text: "hi" }],
      }),
      MAIN_AGENT,
      NOW
    );
    const hookCandidates = candidates.filter(
      (candidate) =>
        candidate.componentKind === AgentComponentInvocationKind.Hook
    );
    assert.equal(hookCandidates.length, 0);
  });
});
