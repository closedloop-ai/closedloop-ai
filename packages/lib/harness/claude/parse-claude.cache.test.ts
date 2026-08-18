import { describe, expect, it } from "vitest";
import { ASSISTANT_LINE, USER_LINE } from "./parse-claude.test-fixtures";
import { parseClaudeTranscript } from "./parse-claude-core";

// FEA-3496: the detailed `cache_creation` breakdown (ephemeral 5m vs 1h TTL) is
// captured into `usageExtras`, aggregated over the SAME deduped per-turn usage
// as the canonical token totals so duplicate content-block lines never inflate
// it — and it is a subdivision of `cache_creation_input_tokens`, not additive.
describe("parseClaudeTranscript cache_creation breakdown (FEA-3496)", () => {
  /** One assistant usage line for a turn keyed by (messageId, requestId). */
  function assistantLine(opts: {
    messageId: string;
    requestId: string;
    timestamp: string;
    text: string;
    cacheCreationTotal: number;
    ephemeral5m: number;
    ephemeral1h: number;
  }): string {
    return JSON.stringify({
      type: "assistant",
      timestamp: opts.timestamp,
      requestId: opts.requestId,
      message: {
        id: opts.messageId,
        role: "assistant",
        model: "claude-opus-4",
        content: [{ type: "text", text: opts.text }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: opts.cacheCreationTotal,
          cache_creation: {
            ephemeral_5m_input_tokens: opts.ephemeral5m,
            ephemeral_1h_input_tokens: opts.ephemeral1h,
          },
        },
      },
    });
  }

  it("sums the ephemeral 5m/1h breakdown across turns without per-line inflation", async () => {
    // Turn 1 emits TWO lines sharing (m1, req1) — the same content-block
    // duplication that inflated naive token sums 2.8-68x (FEA-1459). The
    // breakdown must be counted once for the turn (last-occurrence-wins).
    const turn1a = assistantLine({
      messageId: "m1",
      requestId: "req1",
      timestamp: "2026-07-09T12:00:01.000Z",
      text: "first block",
      cacheCreationTotal: 300,
      ephemeral5m: 100,
      ephemeral1h: 200,
    });
    const turn1b = assistantLine({
      messageId: "m1",
      requestId: "req1",
      timestamp: "2026-07-09T12:00:01.500Z",
      text: "second block, same turn",
      cacheCreationTotal: 300,
      ephemeral5m: 100,
      ephemeral1h: 200,
    });
    const turn2 = assistantLine({
      messageId: "m2",
      requestId: "req2",
      timestamp: "2026-07-09T12:00:02.000Z",
      text: "next turn",
      cacheCreationTotal: 30,
      ephemeral5m: 10,
      ephemeral1h: 20,
    });

    const session = await parseClaudeTranscript(
      [USER_LINE, turn1a, turn1b, turn2],
      { sessionId: "s" }
    );

    // Two deduped API turns despite three usage lines.
    expect(session?.assistantMessages).toBe(2);
    // FEA-3419: the split is a TYPED per-model field summed once per deduped
    // turn: 100+10 and 200+20 — no session-level blob exists anymore.
    expect(session?.tokensByModel["claude-opus-4"]?.cacheWriteTtl).toEqual({
      fiveM: 110,
      oneH: 220,
    });
    // Subdivision, not additive: the 5m+1h split equals the canonical deduped
    // `cache_creation_input_tokens` total (300 counted once + 30 = 330).
    expect(session?.tokensByModel["claude-opus-4"]?.cacheWrite).toBe(330);
    // Per-event records carry each deduped turn's own split.
    expect(session?.tokenSeries).toEqual([
      expect.objectContaining({ cacheWriteTtl: { fiveM: 100, oneH: 200 } }),
      expect.objectContaining({ cacheWriteTtl: { fiveM: 10, oneH: 20 } }),
    ]);
    // The blob is gone: exactly one source of truth for the split.
    expect(
      (session?.usageExtras as Record<string, unknown>).cache_creation
    ).toBeUndefined();
  });

  it("rejects the ENTIRE split when any member is malformed (all-or-absent)", async () => {
    // FEA-3419 one-rule hardening: a negative or fractional member rejects the
    // whole breakdown to absent — never a member-wise coercion to 0, which
    // would fabricate a `{0, oneH}` split the provider never reported.
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:01.000Z",
      requestId: "req-bad",
      message: {
        id: "m-bad",
        role: "assistant",
        model: "claude-opus-4",
        content: [{ type: "text", text: "hi" }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 300,
          cache_creation: {
            ephemeral_5m_input_tokens: -1000,
            ephemeral_1h_input_tokens: 12.5,
          },
        },
      },
    });
    const session = await parseClaudeTranscript([USER_LINE, line], {
      sessionId: "s",
    });
    expect(
      session?.tokensByModel["claude-opus-4"]?.cacheWriteTtl
    ).toBeUndefined();
    expect(session?.tokenSeries[0]?.cacheWriteTtl).toBeUndefined();
    // The canonical total is untouched by the bad breakdown.
    expect(session?.tokensByModel["claude-opus-4"]?.cacheWrite).toBe(300);
  });

  it("rejects a non-numeric TTL member without coercing the remaining member", async () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:01.000Z",
      requestId: "req-string-ttl",
      message: {
        id: "m-string-ttl",
        role: "assistant",
        model: "claude-opus-4",
        content: [{ type: "text", text: "hi" }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 300,
          cache_creation: {
            ephemeral_5m_input_tokens: "100",
            ephemeral_1h_input_tokens: 200,
          },
        },
      },
    });
    const session = await parseClaudeTranscript([USER_LINE, line], {
      sessionId: "s",
    });

    expect(
      session?.tokensByModel["claude-opus-4"]?.cacheWriteTtl
    ).toBeUndefined();
    expect(session?.tokenSeries[0]?.cacheWriteTtl).toBeUndefined();
    expect(session?.tokensByModel["claude-opus-4"]?.cacheWrite).toBe(300);
  });

  it("rejects a split whose sum exceeds the canonical cacheWrite total", async () => {
    // A breakdown inconsistent with its own aggregate is untrustworthy in
    // whole: conservation (fiveM + oneH ≤ cacheWrite) must never be violated.
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:01.000Z",
      requestId: "req-over",
      message: {
        id: "m-over",
        role: "assistant",
        model: "claude-opus-4",
        content: [{ type: "text", text: "hi" }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 100,
          cache_creation: {
            ephemeral_5m_input_tokens: 80,
            ephemeral_1h_input_tokens: 30,
          },
        },
      },
    });
    const session = await parseClaudeTranscript([USER_LINE, line], {
      sessionId: "s",
    });
    expect(
      session?.tokensByModel["claude-opus-4"]?.cacheWriteTtl
    ).toBeUndefined();
    expect(session?.tokensByModel["claude-opus-4"]?.cacheWrite).toBe(100);
  });

  it("keeps a partial split (sum < cacheWrite) with the residual unclassified", async () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:01.000Z",
      requestId: "req-partial",
      message: {
        id: "m-partial",
        role: "assistant",
        model: "claude-opus-4",
        content: [{ type: "text", text: "hi" }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 300,
          cache_creation: {
            ephemeral_5m_input_tokens: 100,
            ephemeral_1h_input_tokens: 150,
          },
        },
      },
    });
    const session = await parseClaudeTranscript([USER_LINE, line], {
      sessionId: "s",
    });
    // 50 tokens stay unclassified (cacheWrite − fiveM − oneH), priced at the
    // default rate downstream; the reported members are preserved exactly.
    expect(session?.tokensByModel["claude-opus-4"]?.cacheWriteTtl).toEqual({
      fiveM: 100,
      oneH: 150,
    });
    expect(session?.tokensByModel["claude-opus-4"]?.cacheWrite).toBe(300);
  });

  it("distinguishes a reported-zero split from an absent breakdown", async () => {
    const zeroLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:01.000Z",
      requestId: "req-zero",
      message: {
        id: "m-zero",
        role: "assistant",
        model: "claude-opus-4",
        content: [{ type: "text", text: "hi" }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 0,
          },
        },
      },
    });
    const session = await parseClaudeTranscript([USER_LINE, zeroLine], {
      sessionId: "s",
    });
    // Reported zero → explicit {0,0}, NOT absent.
    expect(session?.tokensByModel["claude-opus-4"]?.cacheWriteTtl).toEqual({
      fiveM: 0,
      oneH: 0,
    });
  });

  it("leaves the split absent when transcripts omit cache_creation", async () => {
    // ASSISTANT_LINE carries no nested `cache_creation` object → absent
    // provenance (undefined), distinguishable from a reported zero.
    const session = await parseClaudeTranscript([USER_LINE, ASSISTANT_LINE], {
      sessionId: "s",
    });
    expect(
      session?.tokensByModel["claude-opus-4"]?.cacheWriteTtl
    ).toBeUndefined();
    expect(session?.tokenSeries[0]?.cacheWriteTtl).toBeUndefined();
  });

  it("attributes the split per model in a mixed-model session", async () => {
    // The session-level blob could never express this: each model's rows carry
    // that model's own TTL split, and a model with no breakdown stays absent.
    function modelLine(opts: {
      messageId: string;
      model: string;
      total: number;
      breakdown?: { fiveM: number; oneH: number };
    }): string {
      return JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-09T12:00:01.000Z",
        requestId: `req-${opts.messageId}`,
        message: {
          id: opts.messageId,
          role: "assistant",
          model: opts.model,
          content: [{ type: "text", text: "hi" }],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: opts.total,
            ...(opts.breakdown
              ? {
                  cache_creation: {
                    ephemeral_5m_input_tokens: opts.breakdown.fiveM,
                    ephemeral_1h_input_tokens: opts.breakdown.oneH,
                  },
                }
              : {}),
          },
        },
      });
    }
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        modelLine({
          messageId: "m-opus",
          model: "claude-opus-4",
          total: 200,
          breakdown: { fiveM: 50, oneH: 150 },
        }),
        modelLine({
          messageId: "m-haiku",
          model: "claude-haiku-4",
          total: 400,
          breakdown: { fiveM: 400, oneH: 0 },
        }),
        modelLine({
          messageId: "m-legacy",
          model: "claude-sonnet-4",
          total: 90,
        }),
      ],
      { sessionId: "s" }
    );
    expect(session?.tokensByModel["claude-opus-4"]?.cacheWriteTtl).toEqual({
      fiveM: 50,
      oneH: 150,
    });
    expect(session?.tokensByModel["claude-haiku-4"]?.cacheWriteTtl).toEqual({
      fiveM: 400,
      oneH: 0,
    });
    expect(
      session?.tokensByModel["claude-sonnet-4"]?.cacheWriteTtl
    ).toBeUndefined();
  });
});

// PRD-538: web-search request count is captured into `usageExtras` from
// `usage.server_tool_use.web_search_requests`. The counter is CUMULATIVE across a
// session's assistant turns, so the parser takes the MAX (the session total) —
// summing per-turn snapshots would double-count. The persisted count is what the
// cost rollup prices exactly once at the session level.
describe("parseClaudeTranscript web_search_requests (PRD-538)", () => {
  function assistantLineWithWebSearch(opts: {
    messageId: string;
    requestId: string;
    timestamp: string;
    text: string;
    webSearchRequests: number;
  }): string {
    return JSON.stringify({
      type: "assistant",
      timestamp: opts.timestamp,
      requestId: opts.requestId,
      message: {
        id: opts.messageId,
        role: "assistant",
        model: "claude-opus-4",
        content: [{ type: "text", text: opts.text }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          server_tool_use: {
            web_search_requests: opts.webSearchRequests,
          },
        },
      },
    });
  }

  it("refuses a non-finite count instead of storing Infinity as the session total", async () => {
    // ISS-6735. Built as RAW text, not via JSON.stringify, because stringify
    // turns Infinity into null — the value can only arrive the way it really
    // does: `JSON.parse('{"x":1e999}')` yields Infinity for an overflowing
    // literal. `typeof Infinity === "number"` is TRUE, so the typeof half of the
    // guard lets it through and `Math.trunc(Infinity)` would store Infinity as
    // the count a cost rollup then prices. `Number.isFinite` is the half that
    // actually rejects it, and this is the only input that tells the two apart.
    const overflowing = `{"type":"assistant","timestamp":"2026-07-09T12:00:01.000Z","requestId":"req1","message":{"id":"m1","role":"assistant","model":"claude-opus-4","content":[{"type":"text","text":"turn 1"}],"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"server_tool_use":{"web_search_requests":1e999}}}}`;
    const finite = assistantLineWithWebSearch({
      messageId: "m2",
      requestId: "req2",
      timestamp: "2026-07-09T12:00:02.000Z",
      text: "turn 2",
      webSearchRequests: 3,
    });

    const session = await parseClaudeTranscript(
      [USER_LINE, overflowing, finite],
      { sessionId: "s" }
    );

    // The finite turn still counts; the non-finite one contributes nothing to
    // the total. This pins the REJECTION, not the silence around it: dropping
    // the value without a trace is a gap against the root AGENTS.md bad-data
    // rule ("never silently coerce a bad value away" — route it to an existing
    // monitor). The drift module today reports unknown record TYPES and
    // ATTRIBUTES, not malformed values, so there is no path to route this to
    // yet; ISS-6779 covers adding one. Until then this asserts that a
    // fabricated count cannot reach the cost rollup, which is the half that
    // matters most.
    expect(session?.usageExtras.web_search_requests).toBe(3);
  });

  it("captures the MAX cumulative web-search count across turns (no double-count)", async () => {
    // The counter is cumulative: turn 1 reports 2, turn 2 reports 5. The session
    // total is 5 (the max), NOT 7 (a naive sum would double-count the first two).
    const turn1 = assistantLineWithWebSearch({
      messageId: "m1",
      requestId: "req1",
      timestamp: "2026-07-09T12:00:01.000Z",
      text: "turn 1",
      webSearchRequests: 2,
    });
    const turn2 = assistantLineWithWebSearch({
      messageId: "m2",
      requestId: "req2",
      timestamp: "2026-07-09T12:00:02.000Z",
      text: "turn 2",
      webSearchRequests: 5,
    });

    const session = await parseClaudeTranscript([USER_LINE, turn1, turn2], {
      sessionId: "s",
    });

    expect(session?.usageExtras.web_search_requests).toBe(5);
  });

  it("defaults to zero when transcripts report no server_tool_use", async () => {
    const session = await parseClaudeTranscript([USER_LINE, ASSISTANT_LINE], {
      sessionId: "s",
    });
    expect(session?.usageExtras.web_search_requests).toBe(0);
  });

  it("ignores negative/non-finite web-search counts (keeps the count sane)", async () => {
    const bad = assistantLineWithWebSearch({
      messageId: "m-bad",
      requestId: "req-bad",
      timestamp: "2026-07-09T12:00:01.000Z",
      text: "bad",
      webSearchRequests: -3,
    });
    const session = await parseClaudeTranscript([USER_LINE, bad], {
      sessionId: "s",
    });
    expect(session?.usageExtras.web_search_requests).toBe(0);
  });
});

// FEA-3553: Claude implementation plans were silently dropped — the Claude
// parser never populated `NormalizedSession.plans[]` (Codex-only until now), so
// a plan passed to ExitPlanMode (or presented inline as prose when the harness
// wasn't in a plan-mode session, so no plan file was written) never surfaced in
// the dashboard Plans table. These pin both extraction sources plus the negative
// case (ordinary prose must NOT be mislabelled as a plan).
describe("parseClaudeTranscript plan extraction (FEA-3553)", () => {
  function exitPlanModeLine(plan: string, timestamp: string): string {
    return JSON.stringify({
      type: "assistant",
      timestamp,
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [
          {
            type: "tool_use",
            id: "toolu_plan1",
            name: "ExitPlanMode",
            input: { plan },
          },
        ],
      },
    });
  }

  function assistantTextLine(text: string, timestamp: string): string {
    return JSON.stringify({
      type: "assistant",
      timestamp,
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [{ type: "text", text }],
      },
    });
  }

  it("captures a plan from ExitPlanMode tool input", async () => {
    const plan =
      "# Implementation Plan\n\nPhase 1 — scaffold\nPhase 2 — wire it up\nPhase 3 — test";
    const session = await parseClaudeTranscript(
      [USER_LINE, exitPlanModeLine(plan, "2026-07-09T12:00:05.000Z")],
      { sessionId: "s" }
    );

    expect(session?.plans).toHaveLength(1);
    expect(session?.plans?.[0]).toEqual({
      source: "claude-exit-plan-mode",
      content: plan,
      timestamp: "2026-07-09T12:00:05.000Z",
    });
  });

  it("captures a plan the model presented inline as assistant prose", async () => {
    // The exact ticket case: model loaded ExitPlanMode outside a plan-mode
    // session, so no plan file was written and it presented the plan inline.
    const prose = [
      "I loaded ExitPlanMode but I'm not actually in a plan-mode session, so",
      "I'll present the plan inline.",
      "",
      "## Implementation Plan",
      "",
      "Phase 1 — audit the parser",
      "Phase 2 — add the extraction path",
      "Phase 3 — cover it with tests",
    ].join("\n");
    const session = await parseClaudeTranscript(
      [USER_LINE, assistantTextLine(prose, "2026-07-09T12:00:06.000Z")],
      { sessionId: "s" }
    );

    expect(session?.plans).toHaveLength(1);
    expect(session?.plans?.[0].source).toBe("claude-inline-plan");
    expect(session?.plans?.[0].content).toContain("Phase 1 — audit the parser");
    expect(session?.plans?.[0].timestamp).toBe("2026-07-09T12:00:06.000Z");
  });

  it("does NOT mislabel ordinary prose as a plan (negative case)", async () => {
    // Ordinary assistant chatter that mentions "the plan" and a single phase,
    // but has neither a plan-title header nor multiple enumerated phases.
    const prose = [
      "Sure — that plan sounds reasonable to me. In Phase 1 of the rollout the",
      "team already shipped the login flow, so we can build on it. Let me know",
      "if you want me to start.",
    ].join("\n");
    const session = await parseClaudeTranscript(
      [USER_LINE, assistantTextLine(prose, "2026-07-09T12:00:07.000Z")],
      { sessionId: "s" }
    );

    expect(session?.plans ?? []).toEqual([]);
  });

  it("dedups a plan captured from both ExitPlanMode and an inline echo", async () => {
    // Same plan text in both surfaces (structured input + prose) is recorded
    // once, not twice.
    const plan =
      "## Implementation Plan\n\nPhase 1 — do the thing\nPhase 2 — verify the thing";
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        exitPlanModeLine(plan, "2026-07-09T12:00:08.000Z"),
        assistantTextLine(plan, "2026-07-09T12:00:09.000Z"),
      ],
      { sessionId: "s" }
    );

    expect(session?.plans).toHaveLength(1);
    // The structured ExitPlanMode capture wins (seen first).
    expect(session?.plans?.[0].source).toBe("claude-exit-plan-mode");
  });

  it("defaults plans to empty when the session has none", async () => {
    const session = await parseClaudeTranscript([USER_LINE, ASSISTANT_LINE], {
      sessionId: "s",
    });
    expect(session?.plans ?? []).toEqual([]);
  });
});

describe("parseClaudeTranscript system-reminder exclusion (FEA-2927)", () => {
  it("excludes a pure system-reminder entry from human messages", async () => {
    const sysReminderLine = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:00.000Z",
      cwd: "/home/me/myproject",
      message: {
        role: "user",
        content:
          "<system-reminder>\nThe task tools haven't been used recently.\n</system-reminder>",
      },
    });
    const session = await parseClaudeTranscript(
      [sysReminderLine, ASSISTANT_LINE],
      { sessionId: "s" }
    );
    expect(session).not.toBeNull();
    expect(session?.userMessages).toBe(0);
    expect(session?.messages.filter((m) => m.role === "human")).toHaveLength(0);
  });

  it("keeps a mixed entry (human text + system-reminder) as human", async () => {
    const mixedLine = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:00.000Z",
      cwd: "/home/me/myproject",
      message: {
        role: "user",
        content:
          "please fix the bug\n<system-reminder>\nSome injected context.\n</system-reminder>",
      },
    });
    const session = await parseClaudeTranscript([mixedLine, ASSISTANT_LINE], {
      sessionId: "s",
    });
    expect(session).not.toBeNull();
    expect(session?.userMessages).toBe(1);
    expect(session?.messages.filter((m) => m.role === "human")).toHaveLength(1);
  });

  it("excludes multiple multiline system-reminder blocks", async () => {
    const multiBlockLine = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:00.000Z",
      cwd: "/home/me/myproject",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>\nMCP server instructions block 1.\nWith multiple lines.\n</system-reminder>\n\n<system-reminder>\nAnother block of injected context.\n</system-reminder>",
          },
        ],
      },
    });
    const session = await parseClaudeTranscript(
      [multiBlockLine, ASSISTANT_LINE],
      { sessionId: "s" }
    );
    expect(session).not.toBeNull();
    expect(session?.userMessages).toBe(0);
    expect(session?.messages.filter((m) => m.role === "human")).toHaveLength(0);
  });

  it("does NOT classify empty input as a system-reminder", async () => {
    const emptyLine = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:00.000Z",
      cwd: "/home/me/myproject",
      message: { role: "user", content: "   " },
    });
    const session = await parseClaudeTranscript([emptyLine, ASSISTANT_LINE], {
      sessionId: "s",
    });
    expect(session).not.toBeNull();
    expect(session?.userMessages).toBe(1);
  });
});
