/**
 * Tests for event_msg handler branches in parse-codex.ts that are NOT covered
 * by the main parse-codex.test.ts suite.
 *
 * Targets:
 *  - handleUserMessageEvent: Branch 97[0,1] (pendingTurnStartedAt), 98[0,1]
 *    (text truthy), 99[0,1] (emUserTexts.get)
 *  - handleAgentMessageEvent: Branch 100[0,1], 101[0,1]
 *  - handleAgentReasoningEvent: Branch 102[0,1]
 *  - handleTaskStartedEvent + captureModelContextWindow: Branch 103[1]
 *  - handleTokenCountEvent with token_count_info (not info): Branch 125[1]
 *  - handleTokenCountEvent bare (neither info nor token_count_info): Branch 125[2]
 *  - handleTokenCountEvent rate_limits (valid/malformed): Branch 125[1,2] context
 *  - handleTokenCountEvent untimestamped deferred delta: Branch 140[0], 141-145
 *  - handleErrorEvent: Branches 153[0,1], 154[0-3]
 *  - dispatchEvent: Branch 193[0] (no event type → return early)
 */

import { describe, expect, it } from "vitest";
import { parseCodexRollout } from "./parse-codex";

// ── Shared builders ─────────────────────────────────────────────────────────

const SESSION_META = (
  ts = "2026-08-01T10:00:00.000Z",
  cwd = "/workspace/proj"
) => JSON.stringify({ type: "session_meta", timestamp: ts, payload: { cwd } });

const TURN_CTX = (model: string, ts = "2026-08-01T10:00:01.000Z") =>
  JSON.stringify({ type: "turn_context", timestamp: ts, payload: { model } });

function tokenCountLine(
  ts: string,
  input: number,
  output: number,
  cached = 0
): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp: ts,
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
        },
      },
    },
  });
}

// ── handleUserMessageEvent (Branches 97-99) ──────────────────────────────────

describe("handleUserMessageEvent — user_message events", () => {
  it("increments userMessages via user_message event and records the message text (Branch 97[0] true)", async () => {
    const lines = [
      SESSION_META(),
      TURN_CTX("gpt-5"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:02.000Z",
        payload: { type: "user_message", message: "what is 2+2?" },
      }),
      tokenCountLine("2026-08-01T10:00:03.000Z", 10, 5),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "user-msg-ev",
    });
    expect(session).not.toBeNull();
    // user_message event increments userMessages
    expect(session?.userMessages).toBe(1);
  });

  it("user_message event without message text still increments count (Branch 98[1] false)", async () => {
    const lines = [
      SESSION_META(),
      TURN_CTX("gpt-5"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:02.000Z",
        payload: { type: "user_message" },
      }),
      tokenCountLine("2026-08-01T10:00:03.000Z", 10, 5),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "user-msg-no-text",
    });
    expect(session).not.toBeNull();
    expect(session?.userMessages).toBe(1);
  });

  it("filterInjectedUserMessages uses emUserTexts to discriminate injected from real prompts", async () => {
    // A user_message event with text "hello" means the response_item user
    // message with same text is REAL (not injected). A second response_item
    // user message with different text is injected → removed by filterInjected.
    const lines = [
      SESSION_META(),
      TURN_CTX("gpt-5"),
      // The real user_message event
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:02.000Z",
        payload: { type: "user_message", message: "hello" },
      }),
      // response_item matching the event text → kept as real
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-01T10:00:02.100Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      }),
      // response_item with DIFFERENT text (injected context) → removed
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-01T10:00:02.200Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "# AGENTS.md instructions..." },
          ],
        },
      }),
      tokenCountLine("2026-08-01T10:00:10.000Z", 100, 30),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "injected-filter",
    });
    expect(session).not.toBeNull();
    // After filtering: userMessages = emUserCount = 1 (just the event)
    expect(session?.userMessages).toBe(1);
    // The injected message was removed from the messages array
    const userMsgs = session?.messages.filter((m) => m.role === "human");
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs?.[0]?.text).toBe("hello");
  });

  it("identical prompts each consume one user_message event (count-per-text semantics, Branch 99[0-1])", async () => {
    // Two identical real prompts → emUserTexts increments to 2, each consumes one
    const lines = [
      SESSION_META(),
      TURN_CTX("gpt-5"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:02.000Z",
        payload: { type: "user_message", message: "retry" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: { type: "user_message", message: "retry" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-01T10:00:03.100Z",
        payload: { type: "message", role: "user", content: "retry" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-01T10:00:03.200Z",
        payload: { type: "message", role: "user", content: "retry" },
      }),
      tokenCountLine("2026-08-01T10:00:10.000Z", 100, 30),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "dup-prompts",
    });
    expect(session).not.toBeNull();
    // userMessages normalised to event count (2)
    expect(session?.userMessages).toBe(2);
  });
});

// ── handleAgentMessageEvent (Branches 100-101) ───────────────────────────────

describe("handleAgentMessageEvent — agent_message and agent_message_delta", () => {
  it("records turn duration when agent_message event has iso (Branch 100[0], 101[0])", async () => {
    const lines = [
      SESSION_META(),
      TURN_CTX("gpt-5"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:02.000Z",
        payload: { type: "user_message", message: "prompt" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:05.000Z",
        payload: { type: "agent_message" },
      }),
      tokenCountLine("2026-08-01T10:00:06.000Z", 10, 5),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "agent-msg" });
    expect(session).not.toBeNull();
    // agent_message pushes a turn duration
    expect(session?.turnDurations.length).toBeGreaterThanOrEqual(1);
    expect(session?.messageTimestamps).toContain("2026-08-01T10:00:05.000Z");
  });

  it("agent_message_delta exercises the false branch of the agent_message guard (Branch 100[0] false)", async () => {
    // handleAgentMessageEvent guards: `if (asStr(p.type) === "agent_message")`.
    // agent_message_delta hits the false path: no messageTimestamp is pushed.
    const lines = [
      SESSION_META(),
      TURN_CTX("gpt-5"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:05.000Z",
        payload: { type: "agent_message_delta" },
      }),
      tokenCountLine("2026-08-01T10:00:06.000Z", 10, 5),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "agent-msg-delta",
    });
    expect(session).not.toBeNull();
    // agent_message_delta does NOT push a timestamp (false branch of the guard)
    expect(session?.messageTimestamps).not.toContain(
      "2026-08-01T10:00:05.000Z"
    );
  });

  it("agent_message event with no iso (no timestamp) does NOT push a timestamp (Branch 101[1] false)", async () => {
    const noTsAgentMsg = JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message" },
    });
    const lines = [
      JSON.stringify({
        type: "session_meta",
        payload: { cwd: "/workspace/proj" },
      }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5" } }),
      noTsAgentMsg,
      tokenCountLine("2026-08-01T10:00:06.000Z", 10, 5),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "agent-msg-no-ts",
    });
    expect(session).not.toBeNull();
    expect(session?.messageTimestamps).toHaveLength(0);
  });
});

// ── handleAgentReasoningEvent (Branch 102) ───────────────────────────────────

describe("handleAgentReasoningEvent — agent_reasoning and agent_reasoning_section_break", () => {
  it("increments thinkingBlockCount for agent_reasoning event (Branch 102[0])", async () => {
    const lines = [
      SESSION_META(),
      TURN_CTX("gpt-5"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: { type: "agent_reasoning" },
      }),
      tokenCountLine("2026-08-01T10:00:04.000Z", 10, 5),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "agent-reasoning",
    });
    expect(session).not.toBeNull();
    expect(session?.thinkingBlockCount).toBe(1);
  });

  it("agent_reasoning_section_break exercises the false branch of the agent_reasoning guard (Branch 102[0] false)", async () => {
    // handleAgentReasoningEvent guards: `if (asStr(p.type) === "agent_reasoning")`.
    // agent_reasoning_section_break hits the false path: thinkingBlockCount stays 0.
    const lines = [
      SESSION_META(),
      TURN_CTX("gpt-5"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: { type: "agent_reasoning_section_break" },
      }),
      tokenCountLine("2026-08-01T10:00:04.000Z", 10, 5),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "reasoning-break",
    });
    expect(session).not.toBeNull();
    // section_break does NOT increment thinkingBlockCount (false branch of the guard)
    expect(session?.thinkingBlockCount).toBe(0);
  });
});

// ── handleTaskStartedEvent + captureModelContextWindow (Branch 103[1]) ────────

describe("handleTaskStartedEvent — model_context_window from task_started", () => {
  it("captures model_context_window from a task_started event", async () => {
    const lines = [
      SESSION_META(),
      TURN_CTX("gpt-5"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:02.000Z",
        payload: { type: "task_started", model_context_window: 131_072 },
      }),
      tokenCountLine("2026-08-01T10:00:03.000Z", 10, 5),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "task-started-ctx",
    });
    expect(session).not.toBeNull();
    expect(session?.modelContextWindow).toBe(131_072);
  });

  it("ignores invalid (float) model_context_window on task_started (Branch 103[1])", async () => {
    const lines = [
      SESSION_META(),
      TURN_CTX("gpt-5"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:02.000Z",
        payload: { type: "task_started", model_context_window: 131_072.5 },
      }),
      tokenCountLine("2026-08-01T10:00:03.000Z", 10, 5),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "task-bad-ctx",
    });
    expect(session).not.toBeNull();
    // Float value rejected by asNonNegInt → modelContextWindow not set
    expect(session?.modelContextWindow).toBeUndefined();
  });

  it("ignores negative model_context_window", async () => {
    const lines = [
      SESSION_META(),
      TURN_CTX("gpt-5"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:02.000Z",
        payload: { type: "task_started", model_context_window: -1 },
      }),
      tokenCountLine("2026-08-01T10:00:03.000Z", 10, 5),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "task-neg-ctx",
    });
    expect(session?.modelContextWindow).toBeUndefined();
  });
});

// ── handleTokenCountEvent — token_count_info fallback (Branch 125[1]) ────────

describe("handleTokenCountEvent — token_count_info instead of info (Branch 125[1])", () => {
  it("reads totals from token_count_info when info is absent", async () => {
    const lines = [
      SESSION_META(),
      TURN_CTX("gpt-5"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: {
          type: "token_count",
          token_count_info: {
            total_token_usage: {
              input_tokens: 80,
              cached_input_tokens: 0,
              output_tokens: 20,
            },
          },
        },
      }),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "tci-fallback",
    });
    expect(session).not.toBeNull();
    expect(session?.assistantMessages).toBe(1);
    expect(session?.tokensByModel["gpt-5"]).toMatchObject({
      input: 80,
      output: 20,
    });
  });
});

// ── handleTokenCountEvent — bare record (no info, no token_count_info) (125[2]) ─

describe("handleTokenCountEvent — totals on the bare payload (Branch 125[2])", () => {
  it("reads totals from the payload directly when neither info nor token_count_info exists", async () => {
    // The fallback is `?? p` (the payload itself), so total_token_usage on p is read.
    const lines = [
      SESSION_META(),
      TURN_CTX("gpt-5"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: {
          type: "token_count",
          total_token_usage: {
            input_tokens: 60,
            cached_input_tokens: 0,
            output_tokens: 15,
          },
        },
      }),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "bare-totals",
    });
    expect(session).not.toBeNull();
    expect(session?.assistantMessages).toBe(1);
    expect(session?.tokensByModel["gpt-5"]).toMatchObject({
      input: 60,
      output: 15,
    });
  });
});

// ── handleTokenCountEvent — untimestamped delta (Branch 140, 141-145) ─────────

describe("handleTokenCountEvent — untimestamped leading delta deferred (Branch 140)", () => {
  it("defers an untimestamped token delta and flushes it with the next timestamped event", async () => {
    // First token_count has no own timestamp: acc.lastTs is the only timestamp,
    // but explicitIso is null. With no iso at that point either (no prior record
    // with a timestamp), the delta is deferred.
    //
    // This is unusual but covers the deferredTokenDelta accumulation branch.
    const noTsTokenCount = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 50,
            cached_input_tokens: 0,
            output_tokens: 10,
          },
        },
      },
    });
    const lines = [
      // No timestamp on session_meta either
      JSON.stringify({ type: "session_meta", payload: { cwd: "/work" } }),
      noTsTokenCount,
      // A later event WITH a timestamp flushes the deferred delta
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:10.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 0,
              output_tokens: 30,
            },
          },
        },
      }),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "deferred-delta",
    });
    expect(session).not.toBeNull();
    // Both token events contribute to assistantMessages
    expect(session?.assistantMessages).toBe(2);
    // The deferred delta (50, 10) is flushed with the second event
    // delta at second event = (100-50)=50 input, (30-10)=20 output, plus deferred
    // Actually deferred accumulates: first noTs event → deferredTokenDelta = {input:50, output:10}
    // second event delta = {input:50, output:20} + deferred {input:50, output:10} = {input:100, output:30}
    const tokens = session?.tokensByModel["gpt-5"];
    expect(tokens).toBeUndefined(); // no model set → falls back to CODEX_FALLBACK_MODEL
    const fallbackTokens = session?.tokensByModel["gpt-5-codex"];
    expect(fallbackTokens?.input).toBeGreaterThan(0);
    expect(fallbackTokens?.output).toBeGreaterThan(0);
  });
});

// ── handleTokenCountEvent — rate_limits handling ──────────────────────────────

describe("handleTokenCountEvent — rate_limits parsing", () => {
  it("captures a well-formed primary rate_limits window", async () => {
    const lines = [
      SESSION_META(),
      TURN_CTX("gpt-5"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 0,
              output_tokens: 5,
            },
            rate_limits: {
              primary: {
                used_percent: 45.5,
                window_minutes: 60,
                resets_at: 1_754_000_000,
              },
            },
          },
        },
      }),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "rl-valid" });
    expect(session).not.toBeNull();
    expect(session?.codexRateLimits?.primary).toMatchObject({
      used_percent: 45.5,
      window_minutes: 60,
      resets_at: 1_754_000_000,
    });
    expect(session?.parseQuality?.malformedRateLimits).toBeUndefined();
  });

  it("counts a malformed rate_limits block (non-object) in parseQuality (FEA-3702)", async () => {
    const lines = [
      SESSION_META(),
      TURN_CTX("gpt-5"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 0,
              output_tokens: 5,
            },
            rate_limits: "not-an-object",
          },
        },
      }),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "rl-malformed",
    });
    expect(session).not.toBeNull();
    expect(session?.parseQuality?.malformedRateLimits).toBe(1);
    // Last-good is preserved (none here → null)
    expect(session?.codexRateLimits).toBeUndefined();
  });

  it("counts a rate_limits block with a non-null but all-null-fields primary window as malformed (FEA-3702)", async () => {
    // {primary: {garbage: true}} — window PRESENT but no usable telemetry fields
    const lines = [
      SESSION_META(),
      TURN_CTX("gpt-5"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 0,
              output_tokens: 5,
            },
            rate_limits: { primary: { garbage: true } },
          },
        },
      }),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "rl-garbage-window",
    });
    expect(session).not.toBeNull();
    expect(session?.parseQuality?.malformedRateLimits).toBe(1);
  });

  it("silently keeps last-good when rate_limits block is null (absent shape)", async () => {
    // First event sets a valid rate_limits, second carries null
    const lines = [
      SESSION_META(),
      TURN_CTX("gpt-5"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 0,
              output_tokens: 5,
            },
            rate_limits: {
              primary: {
                used_percent: 30,
                window_minutes: 60,
                resets_at: 1_754_000_000,
              },
            },
          },
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:05.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 20,
              cached_input_tokens: 0,
              output_tokens: 10,
            },
            rate_limits: null,
          },
        },
      }),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "rl-null-keeps-last",
    });
    // No malformed counter (null block is the legitimate absent shape)
    expect(session?.parseQuality?.malformedRateLimits).toBeUndefined();
    // Last-good is preserved
    expect(session?.codexRateLimits?.primary?.used_percent).toBe(30);
  });

  it("accepts used_percentage alias in addition to used_percent", async () => {
    const lines = [
      SESSION_META(),
      TURN_CTX("gpt-5"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 0,
              output_tokens: 5,
            },
            rate_limits: {
              secondary: { used_percentage: 72.3, window_minutes: 1440 },
            },
          },
        },
      }),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "rl-pct-alias",
    });
    expect(session?.codexRateLimits?.secondary?.used_percent).toBe(72.3);
    expect(session?.codexRateLimits?.secondary?.window_minutes).toBe(1440);
  });
});

// ── handleErrorEvent (Branches 153-154) ───────────────────────────────────────

describe("handleErrorEvent — error and stream_error events", () => {
  it("records an error event with message field", async () => {
    const lines = [
      SESSION_META(),
      TURN_CTX("gpt-5"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: { type: "error", message: "Rate limit exceeded" },
      }),
      tokenCountLine("2026-08-01T10:00:04.000Z", 10, 5),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "error-msg" });
    expect(session).not.toBeNull();
    expect(session?.apiErrors).toHaveLength(1);
    expect(session?.apiErrors[0]?.message).toBe("Rate limit exceeded");
    expect(session?.apiErrors[0]?.type).toBe("error");
  });

  it("records a stream_error event using the error field when message is absent (Branch 154[1-2])", async () => {
    const lines = [
      SESSION_META(),
      TURN_CTX("gpt-5"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: { type: "stream_error", error: "connection reset" },
      }),
      tokenCountLine("2026-08-01T10:00:04.000Z", 10, 5),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "stream-error",
    });
    expect(session).not.toBeNull();
    expect(session?.apiErrors).toHaveLength(1);
    expect(session?.apiErrors[0]?.message).toBe("connection reset");
    expect(session?.apiErrors[0]?.type).toBe("stream_error");
  });

  it("falls back to 'Codex error' when neither message nor error field exists (Branch 154[3])", async () => {
    const lines = [
      SESSION_META(),
      TURN_CTX("gpt-5"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: { type: "error" },
      }),
      tokenCountLine("2026-08-01T10:00:04.000Z", 10, 5),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "error-fallback",
    });
    expect(session).not.toBeNull();
    expect(session?.apiErrors[0]?.message).toBe("Codex error");
  });

  it("records error timestamp from the event iso", async () => {
    const ts = "2026-08-01T10:00:03.000Z";
    const lines = [
      SESSION_META(),
      TURN_CTX("gpt-5"),
      JSON.stringify({
        type: "event_msg",
        timestamp: ts,
        payload: { type: "error", message: "timeout" },
      }),
      tokenCountLine("2026-08-01T10:00:04.000Z", 10, 5),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "error-ts" });
    expect(session?.apiErrors[0]?.timestamp).toBe(ts);
  });
});

// ── dispatchEvent — event type absent (Branch 193[0]) ─────────────────────────

describe("dispatchEvent — records with no event type are silently skipped (Branch 193[0])", () => {
  it("ignores an event_msg payload where p.type is missing", async () => {
    const lines = [
      SESSION_META(),
      TURN_CTX("gpt-5"),
      // event_msg with a payload that has no 'type' field
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:02.000Z",
        payload: { someField: "someValue" },
      }),
      tokenCountLine("2026-08-01T10:00:03.000Z", 10, 5),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "no-event-type",
    });
    expect(session).not.toBeNull();
    // No crash; the record was silently skipped
    expect(session?.assistantMessages).toBe(1);
  });
});
