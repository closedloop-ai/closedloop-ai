/**
 * Tests for session_meta, turn_context, and session-level metadata branches
 * in parse-codex.ts that are NOT covered by the main test suite.
 *
 * Targets:
 *  - applySessionMeta:
 *    Branch 196[1] (forked_from_id present but p has parent_thread_id → skip),
 *    Branch 197[1] (forked_from_id absent/empty → skip), Branch 198[0] (workdir
 *    fallback for cwd), Branch 205[1] (originator), Branch 206[1] (asStr null),
 *    Branch 207[0] (git object branch/ref), Branch 208-210 (git.ref fallback,
 *    git_branch string), Branch 209[0] (git.branch), Branch 212[0-1] (model
 *    exclusion for codex-auto-review), Branch 213[0-1] (asStr null model)
 *  - applyTurnContext:
 *    Branch 214[1] (model is codex-auto-review → skipped from acc.model but
 *    currentTurnModel still set), Branch 216[1] (no model at all), Branch 217[0]
 *    (cwd from turn_context), Branch 218[0-1] (isMeaningfulCwd)
 *  - filterInjectedUserMessages:
 *    Branch 219[1] (emUserCount=0 → early return), Branch 220[0-1]/221[0-1]
 *    (pending count decrement), Branch 222[0-1] (injected.size > 0)
 *  - parseCodexRollout: Branch 260[0] (null when no firstTimestamp → null return)
 *  - codexForkedFromId surface on the parsed session (FEA-3708)
 *  - originator surfaced on the parsed session (FEA-2641)
 */

import { describe, expect, it } from "vitest";
import { parseCodexRollout } from "./parse-codex";

// ── Shared builders ─────────────────────────────────────────────────────────

function sessionMeta(
  fields: Record<string, unknown>,
  ts = "2026-08-01T10:00:00.000Z"
): string {
  return JSON.stringify({
    type: "session_meta",
    timestamp: ts,
    payload: fields,
  });
}

function turnCtx(model: string, ts = "2026-08-01T10:00:01.000Z"): string {
  return JSON.stringify({
    type: "turn_context",
    timestamp: ts,
    payload: { model },
  });
}

function tokenCount(ts = "2026-08-01T10:00:10.000Z"): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp: ts,
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 5,
        },
      },
    },
  });
}

// ── parseCodexRollout — returns null when no timestamp (Branch 260[0]) ────────

describe("parseCodexRollout — returns null when no timestamp anywhere (Branch 260[0])", () => {
  it("returns null when all records lack timestamps", async () => {
    const lines = [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/work" } }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5" } }),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "no-ts" });
    expect(session).toBeNull();
  });
});

// ── applySessionMeta — workdir fallback for cwd (Branch 198[0]) ──────────────

describe("applySessionMeta — workdir field as cwd fallback (Branch 198[0])", () => {
  it("uses workdir as cwd when cwd is absent", async () => {
    const lines = [
      sessionMeta({ workdir: "/home/me/project" }),
      turnCtx("gpt-5"),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "workdir" });
    expect(session).not.toBeNull();
    expect(session?.cwd).toBe("/home/me/project");
  });

  it("prefers cwd over workdir when both are present", async () => {
    const lines = [
      sessionMeta({ cwd: "/preferred", workdir: "/fallback" }),
      turnCtx("gpt-5"),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "cwd-over-workdir",
    });
    expect(session?.cwd).toBe("/preferred");
  });
});

// ── applySessionMeta — originator field (Branch 205[1], 206[1]) ───────────────

describe("applySessionMeta — originator as session entrypoint (Branch 205[1])", () => {
  it("uses originator as the session entrypoint", async () => {
    const lines = [
      sessionMeta({ cwd: "/work", originator: "codex-tui" }),
      turnCtx("gpt-5"),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "originator" });
    expect(session).not.toBeNull();
    expect(session?.entrypoint).toBe("codex-tui");
  });

  it("defaults entrypoint to 'codex' when originator is absent", async () => {
    const lines = [
      sessionMeta({ cwd: "/work" }),
      turnCtx("gpt-5"),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "no-originator",
    });
    expect(session?.entrypoint).toBe("codex");
  });

  it("originator is only captured once (first non-null wins)", async () => {
    const lines = [
      sessionMeta({ cwd: "/work", originator: "codex-tui" }),
      sessionMeta(
        { cwd: "/work2", originator: "codex_exec" },
        "2026-08-01T10:00:01.000Z"
      ),
      turnCtx("gpt-5"),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "originator-first-wins",
    });
    expect(session?.entrypoint).toBe("codex-tui");
  });
});

// ── applySessionMeta — git branch extraction (Branches 207-210) ──────────────

describe("applySessionMeta — git branch extraction", () => {
  it("reads branch from git.branch object field (Branch 207[0], 209[0])", async () => {
    const lines = [
      sessionMeta({ cwd: "/work", git: { branch: "feat/my-branch" } }),
      turnCtx("gpt-5"),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "git-branch" });
    expect(session?.gitBranch).toBe("feat/my-branch");
  });

  it("falls back to git.ref when branch is absent from git object (Branch 208[0])", async () => {
    const lines = [
      sessionMeta({ cwd: "/work", git: { ref: "refs/heads/main" } }),
      turnCtx("gpt-5"),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "git-ref" });
    expect(session?.gitBranch).toBe("refs/heads/main");
  });

  it("reads git_branch as a top-level string field when git object is absent (Branch 210[0])", async () => {
    const lines = [
      sessionMeta({ cwd: "/work", git_branch: "release/1.0" }),
      turnCtx("gpt-5"),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "git-branch-str",
    });
    expect(session?.gitBranch).toBe("release/1.0");
  });

  it("gitBranch is null when neither git nor git_branch is present", async () => {
    const lines = [
      sessionMeta({ cwd: "/work" }),
      turnCtx("gpt-5"),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "no-git" });
    expect(session?.gitBranch).toBeNull();
  });

  it("gitBranch is captured only from the first session_meta that has it (first wins)", async () => {
    const lines = [
      sessionMeta({ cwd: "/work", git: { branch: "first-branch" } }),
      sessionMeta(
        { cwd: "/work2", git: { branch: "second-branch" } },
        "2026-08-01T10:00:01.000Z"
      ),
      turnCtx("gpt-5"),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "git-first-wins",
    });
    expect(session?.gitBranch).toBe("first-branch");
  });
});

// ── applySessionMeta — model exclusion (Branches 212-213) ────────────────────

describe("applySessionMeta — codex-auto-review model exclusion (Branches 212-213)", () => {
  it("does not set session model when session_meta.model is codex-auto-review (Branch 212[0])", async () => {
    // codex-auto-review in session_meta.model must be excluded
    const lines = [
      sessionMeta({ cwd: "/work", model: "codex-auto-review" }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "session-meta-auto-review",
    });
    expect(session).not.toBeNull();
    // model should be null (or fall back to CODEX_FALLBACK_MODEL via buildTokensByModel)
    expect(session?.model).not.toBe("codex-auto-review");
  });

  it("uses model from session_meta when it is a real model (control, Branch 212[1])", async () => {
    const lines = [
      sessionMeta({ cwd: "/work", model: "gpt-4o" }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "session-meta-model",
    });
    expect(session?.model).toBe("gpt-4o");
  });
});

// ── applySessionMeta — version field (Branch 205[0]) ────────────────────────

describe("applySessionMeta — version field extraction", () => {
  it("reads version from cli_version field", async () => {
    const lines = [
      sessionMeta({ cwd: "/work", cli_version: "2.1.0" }),
      turnCtx("gpt-5"),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "cli-version",
    });
    expect(session?.version).toBe("2.1.0");
  });

  it("falls back to version field when cli_version is absent", async () => {
    const lines = [
      sessionMeta({ cwd: "/work", version: "1.0.0" }),
      turnCtx("gpt-5"),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "version-field",
    });
    expect(session?.version).toBe("1.0.0");
  });
});

// ── applySessionMeta — forked_from_id (Branches 196-197) ─────────────────────

describe("applySessionMeta — forked_from_id lineage pointer (FEA-3708) (Branches 196-197)", () => {
  it("captures forked_from_id when no parent_thread_id is present (Branch 196[0])", async () => {
    const lines = [
      sessionMeta({ cwd: "/work", forked_from_id: "parent-rollout-uuid" }),
      turnCtx("gpt-5"),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "forked" });
    expect(session).not.toBeNull();
    expect(session?.codexForkedFromId).toBe("parent-rollout-uuid");
  });

  it("skips forked_from_id when parent_thread_id is present (subagent spawn, not fork) (Branch 196[1])", async () => {
    // A subagent-spawn rollout: forked_from_id == parent_thread_id (spawn link, not a fork).
    // codexParentThreadId sees the parent_thread_id → skip the forked_from_id capture.
    const lines = [
      sessionMeta({
        cwd: "/work",
        forked_from_id: "parent-thread-id",
        parent_thread_id: "parent-thread-id",
      }),
      turnCtx("gpt-5"),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "subagent-spawn",
    });
    // The spawn link is skipped; codexForkedFromId stays absent
    expect(session?.codexForkedFromId).toBeUndefined();
  });

  it("skips forked_from_id when source.subagent.thread_spawn.parent_thread_id is set", async () => {
    const lines = [
      sessionMeta({
        cwd: "/work",
        forked_from_id: "parent-thread-uuid",
        source: {
          subagent: {
            thread_spawn: { parent_thread_id: "parent-thread-uuid" },
          },
        },
      }),
      turnCtx("gpt-5"),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "subagent-spawn-nested",
    });
    expect(session?.codexForkedFromId).toBeUndefined();
  });

  it("does not overwrite forked_from_id once set (first wins) (Branch 197[1])", async () => {
    const lines = [
      sessionMeta({ cwd: "/work", forked_from_id: "first-parent" }),
      sessionMeta(
        { cwd: "/work2", forked_from_id: "second-parent" },
        "2026-08-01T10:00:01.000Z"
      ),
      turnCtx("gpt-5"),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "forked-first-wins",
    });
    expect(session?.codexForkedFromId).toBe("first-parent");
  });
});

// ── applyTurnContext — codex-auto-review exclusion (Branches 214, 216) ────────

describe("applyTurnContext — codex-auto-review exclusion (Branch 214[1], 216[1])", () => {
  it("does not set acc.model but still sets currentTurnModel for codex-auto-review (Branch 214[1])", async () => {
    // If the only turn_context model is codex-auto-review, session.model stays null.
    // Token events under this label are remapped to the fallback in buildTokensByModel.
    const lines = [
      sessionMeta({ cwd: "/work" }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-08-01T10:00:01.000Z",
        payload: { model: "codex-auto-review" },
      }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "auto-review-tc",
    });
    expect(session).not.toBeNull();
    expect(session?.model).not.toBe("codex-auto-review");
    // Tokens recorded under the label are remapped to CODEX_FALLBACK_MODEL
    expect(session?.tokensByModel["codex-auto-review"]).toBeUndefined();
  });

  it("does not set acc.model when turn_context has no model field (Branch 216[1] false)", async () => {
    const lines = [
      sessionMeta({ cwd: "/work" }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-08-01T10:00:01.000Z",
        payload: {},
      }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "tc-no-model",
    });
    expect(session).not.toBeNull();
    // model comes from token event's fallback; null without a real model
    // The session.model may be null or from fallback
    expect(session?.model).toBeNull();
  });
});

// ── applyTurnContext — cwd from turn_context (Branches 217-218) ──────────────

describe("applyTurnContext — cwd from turn_context (Branches 217-218)", () => {
  it("sets cwd from turn_context when session_meta did not provide it (Branch 217[0])", async () => {
    const lines = [
      // session_meta with no cwd
      sessionMeta({ cli_version: "1.0" }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-08-01T10:00:01.000Z",
        payload: { model: "gpt-5", cwd: "/from-turn-context" },
      }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "tc-cwd" });
    expect(session).not.toBeNull();
    expect(session?.cwd).toBe("/from-turn-context");
  });

  it("does not overwrite cwd from session_meta (Branch 217[0] false — cwd already set)", async () => {
    const lines = [
      sessionMeta({ cwd: "/from-session-meta" }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-08-01T10:00:01.000Z",
        payload: { model: "gpt-5", cwd: "/from-turn-context" },
      }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "tc-cwd-no-overwrite",
    });
    expect(session?.cwd).toBe("/from-session-meta");
  });
});

// ── filterInjectedUserMessages — emUserCount=0 early return (Branch 219[1]) ───

describe("filterInjectedUserMessages — early return when no user_message events (Branch 219[1])", () => {
  it("keeps all response_item user messages when no user_message events were seen", async () => {
    // When emUserCount=0, filterInjectedUserMessages returns immediately — all
    // response_item user messages survive unchanged.
    const lines = [
      sessionMeta({ cwd: "/work" }),
      turnCtx("gpt-5"),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-01T10:00:02.000Z",
        payload: { type: "message", role: "user", content: "msg-1" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: { type: "message", role: "user", content: "msg-2" },
      }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "no-ev-user" });
    expect(session).not.toBeNull();
    const userMsgs = session?.messages.filter((m) => m.role === "human");
    expect(userMsgs).toHaveLength(2);
  });
});

// ── filterInjectedUserMessages — injected set removal (Branches 220-222) ─────

describe("filterInjectedUserMessages — injected context removal (Branches 220-222)", () => {
  it("removes injected context messages not matched by a user_message event (Branch 222[0])", async () => {
    const lines = [
      sessionMeta({ cwd: "/work" }),
      turnCtx("gpt-5"),
      // One real user_message event with text "hello"
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:02.000Z",
        payload: { type: "user_message", message: "hello" },
      }),
      // response_item matching event → real, kept
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-01T10:00:02.100Z",
        payload: { type: "message", role: "user", content: "hello" },
      }),
      // response_item NOT matching any event → injected, removed
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-01T10:00:02.200Z",
        payload: {
          type: "message",
          role: "user",
          content: "# AGENTS.md instructions for the session",
        },
      }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "injected-rm",
    });
    const userMsgs = session?.messages.filter((m) => m.role === "human");
    // Only the real "hello" survives
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs?.[0]?.text).toBe("hello");
  });

  it("userMessageCount is normalised to emUserCount after filtering (Branch 222[0])", async () => {
    const lines = [
      sessionMeta({ cwd: "/work" }),
      turnCtx("gpt-5"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:02.000Z",
        payload: { type: "user_message", message: "question" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-01T10:00:02.100Z",
        payload: { type: "message", role: "user", content: "question" },
      }),
      // Injected context adds an extra response_item user message
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-01T10:00:02.200Z",
        payload: {
          type: "message",
          role: "user",
          content: "<environment_context>...",
        },
      }),
      tokenCount(),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "user-count-norm",
    });
    // emUserCount = 1 (the event), userMessageCount normalised to 1
    expect(session?.userMessages).toBe(1);
  });
});
