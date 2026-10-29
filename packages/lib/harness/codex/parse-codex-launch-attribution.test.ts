/**
 * ISS-7259: Codex launch-attribution capture from `session_meta`, asserted
 * through the production parser entry point.
 *
 * Codex states the spawn block twice — top level and nested under
 * `source.subagent.thread_spawn` — and `source` itself is polymorphic (a bare
 * string for a user thread, an object for a spawned one). Both spellings and the
 * polymorphism are exercised here because all three arrive as transcript JSON,
 * which the type system does not constrain.
 */
import { describe, expect, it } from "vitest";
import {
  LaunchThreadSource,
  MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS,
} from "../launch-attribution";
import { parseCodexRollout } from "./parse-codex";

const TS = "2026-08-13T00:01:59.007Z";

function sessionMeta(fields: Record<string, unknown>): string {
  return JSON.stringify({
    type: "session_meta",
    timestamp: TS,
    payload: { id: "019ff86c-f8b9-7300-a499-8e62d000b034", ...fields },
  });
}

function userTurn(): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp: TS,
    payload: { type: "user_message", message: "go" },
  });
}

describe("parseCodexRollout — harnessLaunchAttribution", () => {
  it("captures a spawned subagent's role, nickname, parent and depth", async () => {
    const session = await parseCodexRollout(
      [
        sessionMeta({
          originator: "codex-tui",
          thread_source: "subagent",
          agent_role: "logical-lead-investigator",
          agent_nickname: "Leibniz",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "019ff86a-38b0-7cf3-8b8f-30db8edc9bc6",
                depth: 1,
                agent_path: "/root/multiplayer_sync_triage",
                agent_nickname: "Leibniz",
                agent_role: "logical-lead-investigator",
              },
            },
          },
        }),
        userTurn(),
      ],
      { sessionId: "codex-subagent" }
    );

    // Whole-object equality also pins the DELIBERATE omission of `agent_path`:
    // it is the one member carrying task-derived free text, and a key-by-key
    // check would stay green if it started leaking into cloud metadata.
    expect(session?.harnessLaunchAttribution).toEqual({
      threadSource: LaunchThreadSource.Subagent,
      agentRole: "logical-lead-investigator",
      agentNickname: "Leibniz",
      parentThreadId: "019ff86a-38b0-7cf3-8b8f-30db8edc9bc6",
      depth: 1,
    });
  });

  // Scoped to the spawn DETAILS on purpose: `thread_source` is read only from
  // the top level (it is never nested in real rollouts), so this case states
  // nothing about it and the name must not imply otherwise.
  it("reads the spawn details from nested thread_spawn when the top-level copies are absent", async () => {
    const session = await parseCodexRollout(
      [
        sessionMeta({
          thread_source: "subagent",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "parent-abc",
                depth: 2,
                agent_role: "design-engineer",
                agent_nickname: "Mencius",
              },
            },
          },
        }),
        userTurn(),
      ],
      { sessionId: "codex-nested-only" }
    );

    expect(session?.harnessLaunchAttribution).toEqual({
      threadSource: LaunchThreadSource.Subagent,
      agentRole: "design-engineer",
      agentNickname: "Mencius",
      parentThreadId: "parent-abc",
      depth: 2,
    });
  });

  it("omits the facet for a user-started rollout whose source is a bare string", async () => {
    // The real shape for a terminal launch: `source: "cli"`, no spawn block. The
    // polymorphism must not throw, and an unspawned thread must not gain a facet.
    const session = await parseCodexRollout(
      [sessionMeta({ originator: "codex-tui", source: "cli" }), userTurn()],
      { sessionId: "codex-root" }
    );

    expect(session?.harnessLaunchAttribution).toBeUndefined();
  });

  it("records a stated user spawn even though nothing else was captured", async () => {
    const session = await parseCodexRollout(
      [sessionMeta({ thread_source: "user", source: "exec" }), userTurn()],
      { sessionId: "codex-user-thread" }
    );

    expect(session?.harnessLaunchAttribution).toEqual({
      threadSource: LaunchThreadSource.User,
    });
  });

  it("degrades an unrecognised thread_source to Unknown without dropping the rest", async () => {
    const session = await parseCodexRollout(
      [
        sessionMeta({
          thread_source: "orchestrator",
          agent_role: "review-soul",
        }),
        userTurn(),
      ],
      { sessionId: "codex-unknown-source" }
    );

    expect(session?.harnessLaunchAttribution).toEqual({
      threadSource: LaunchThreadSource.Unknown,
      agentRole: "review-soul",
    });
  });

  it("keeps the FIRST stated value when a later session_meta contradicts it", async () => {
    // A rollout can carry several session_meta records. Every member here is
    // first-wins, and each assertion ends on a DIFFERENT value than it starts
    // on, so an unconditional last-wins overwrite of any one of them fails.
    const session = await parseCodexRollout(
      [
        sessionMeta({
          thread_source: "subagent",
          agent_role: "design-engineer",
          agent_nickname: "Mencius",
          source: {
            subagent: {
              thread_spawn: { parent_thread_id: "parent-first", depth: 1 },
            },
          },
        }),
        sessionMeta({
          thread_source: "user",
          agent_role: "review-soul",
          agent_nickname: "Leibniz",
          source: {
            subagent: {
              thread_spawn: { parent_thread_id: "parent-second", depth: 9 },
            },
          },
        }),
        userTurn(),
      ],
      { sessionId: "codex-multi-meta" }
    );

    expect(session?.harnessLaunchAttribution).toEqual({
      threadSource: LaunchThreadSource.Subagent,
      agentRole: "design-engineer",
      agentNickname: "Mencius",
      parentThreadId: "parent-first",
      depth: 1,
    });
  });

  it("takes the first STATED spawn word, not the first record", async () => {
    // The distinction matters: an earlier record that says nothing must not
    // block a later one that does, or a rollout whose first session_meta omits
    // `thread_source` would be permanently recorded as unattributed.
    const session = await parseCodexRollout(
      [
        sessionMeta({ originator: "codex-tui" }),
        sessionMeta({ thread_source: "subagent", agent_role: "explorer" }),
        userTurn(),
      ],
      { sessionId: "codex-late-spawn-word" }
    );

    expect(session?.harnessLaunchAttribution).toEqual({
      threadSource: LaunchThreadSource.Subagent,
      agentRole: "explorer",
    });
  });

  it("keeps a depth of 0, which is a real depth and not an absence", async () => {
    const session = await parseCodexRollout(
      [
        sessionMeta({
          thread_source: "subagent",
          source: { subagent: { thread_spawn: { depth: 0 } } },
        }),
        userTurn(),
      ],
      { sessionId: "codex-zero-depth" }
    );

    expect(session?.harnessLaunchAttribution).toEqual({
      threadSource: LaunchThreadSource.Subagent,
      depth: 0,
    });
  });

  it("falls back to a top-level parent_thread_id when no thread_spawn block exists", async () => {
    const session = await parseCodexRollout(
      [
        sessionMeta({
          thread_source: "subagent",
          parent_thread_id: "top-level-parent",
        }),
        userTurn(),
      ],
      { sessionId: "codex-top-level-parent" }
    );

    expect(session?.harnessLaunchAttribution).toEqual({
      threadSource: LaunchThreadSource.Subagent,
      parentThreadId: "top-level-parent",
    });
  });

  it("drops an over-long agent_role instead of carrying free text to the cloud", async () => {
    // A value this long is not a role name; capturing it would let a malformed
    // or hostile rollout smuggle task content through an identifier field.
    const session = await parseCodexRollout(
      [
        sessionMeta({
          thread_source: "subagent",
          agent_role: "x".repeat(MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS + 1),
          agent_nickname: "Leibniz",
        }),
        userTurn(),
      ],
      { sessionId: "codex-overlong-role" }
    );

    // The over-long member is dropped; the rest of the facet still lands.
    expect(session?.harnessLaunchAttribution).toEqual({
      threadSource: LaunchThreadSource.Subagent,
      agentNickname: "Leibniz",
    });
  });

  it("drops a non-finite depth rather than persisting NaN through the wire", async () => {
    const session = await parseCodexRollout(
      [
        sessionMeta({
          thread_source: "subagent",
          source: { subagent: { thread_spawn: { depth: "deep" } } },
        }),
        userTurn(),
      ],
      { sessionId: "codex-bad-depth" }
    );

    expect(session?.harnessLaunchAttribution).toEqual({
      threadSource: LaunchThreadSource.Subagent,
    });
  });

  it("reads role and nickname from source.subagent, the location the collector and fixtures use", async () => {
    // The canonical desktop fixture (`codexSubagentMeta` in
    // test/codex-rollout-fixture.ts) and the collector's
    // `readCodexRolloutLinkage` both put these on `source.subagent` directly —
    // NOT at the payload top level and NOT inside `thread_spawn`. Reading only
    // the other two spellings drops role and nickname while parent and depth
    // still land, so the facet looks populated and is quietly incomplete.
    const session = await parseCodexRollout(
      [
        sessionMeta({
          thread_source: "subagent",
          source: {
            subagent: {
              agent_nickname: "child-019f",
              agent_role: "worker",
              thread_spawn: {
                parent_thread_id: "019ff86a-38b0-7cf3-8b8f-30db8edc9bc6",
                depth: 1,
              },
            },
          },
        }),
        userTurn(),
      ],
      { sessionId: "codex-subagent-scoped-role" }
    );

    expect(session?.harnessLaunchAttribution).toEqual({
      threadSource: LaunchThreadSource.Subagent,
      agentRole: "worker",
      agentNickname: "child-019f",
      parentThreadId: "019ff86a-38b0-7cf3-8b8f-30db8edc9bc6",
      depth: 1,
    });
  });

  it("drops a negative depth, which would otherwise sync as a real hierarchy level", async () => {
    // `depth` is JSON-controlled. A non-integer like 1.5 is rejected loudly by
    // the worker's `z.number().int()` boundary, but a negative integer passes
    // that schema and reaches the cloud as a genuine hierarchy level — a
    // plausible-but-wrong value, which is worse than a rejection.
    const session = await parseCodexRollout(
      [
        sessionMeta({
          thread_source: "subagent",
          source: { subagent: { thread_spawn: { depth: -1 } } },
        }),
        userTurn(),
      ],
      { sessionId: "codex-negative-depth" }
    );

    expect(session?.harnessLaunchAttribution).toEqual({
      threadSource: LaunchThreadSource.Subagent,
    });
  });

  it("drops a fractional depth at the parser instead of deferring to the worker schema", async () => {
    const session = await parseCodexRollout(
      [
        sessionMeta({
          thread_source: "subagent",
          source: { subagent: { thread_spawn: { depth: 1.5 } } },
        }),
        userTurn(),
      ],
      { sessionId: "codex-fractional-depth" }
    );

    expect(session?.harnessLaunchAttribution).toEqual({
      threadSource: LaunchThreadSource.Subagent,
    });
  });
});
