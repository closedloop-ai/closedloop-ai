/**
 * Tests for finalize-phase and collectCodexUsageIdentities branches in
 * parse-codex.ts that are NOT covered by the main test suite.
 *
 * Key insight: the deferred token flush path (`!iso && hasTokens` at line 1302)
 * requires acc.lastTs === null at the time the untimestamped token_count fires.
 * Since `iso = explicitIso || acc.lastTs`, any prior timestamped record sets
 * acc.lastTs and makes iso truthy — bypassing the deferred path. Therefore the
 * untimestamped token_count MUST come BEFORE any timestamped record.
 *
 * Targets:
 *  - parseCodexRollout Branch 256[0]: classify returns null (non-object JSON)
 *  - Branches 142-145: second untimestamped token accumulates into d (non-null)
 *  - Branches 261[0], 263[0], 264[0/1], 265[0/1]: deferred flush at finalize
 *  - Branch 260[0]: burst session → parseCodexRollout returns null
 *  - buildTokensByModel: codex-auto-review model remapping (Branches 240-243)
 *  - projectName fallback when cwd is absent (Branch 266[1])
 *  - collectCodexUsageIdentities:
 *    Branch 276[0] (skip blank lines), Branch 277[0] (JSON.parse error → continue),
 *    Branch 279[1] (turn_context model = codex-auto-review → not captured as model),
 *    Branch 283[0] (totals absent → skip), Branch 284-285 (token_count_info fallback),
 *    Branch 286[0] (InvalidTokenCountError → skip)
 */

import { describe, expect, it } from "vitest";
import { collectCodexUsageIdentities, parseCodexRollout } from "./parse-codex";

// Module-level regex constants (required by useTopLevelRegex lint rule)
const CODEX_SESSION_NAME_RE = /^Codex Session /;
const GPT4O_IDENTITY_RE = /^gpt-4o:/;

// ── Builder helpers ──────────────────────────────────────────────────────────

/** session_meta WITH a timestamp. */
function sessionMetaTs(
  fields: Record<string, unknown> = {},
  ts = "2026-08-01T10:00:00.000Z"
): string {
  return JSON.stringify({
    type: "session_meta",
    timestamp: ts,
    payload: fields,
  });
}

/** turn_context record with a timestamp. */
function turnCtx(model: string, ts = "2026-08-01T10:00:01.000Z"): string {
  return JSON.stringify({
    type: "turn_context",
    timestamp: ts,
    payload: { model },
  });
}

/** event_msg token_count WITH a timestamp (standard). */
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

/** event_msg token_count WITHOUT an outer timestamp.
 *  Triggers the deferred path when acc.lastTs is also null. */
function tokenCountNoTs(input: number, output: number, cached = 0): string {
  return JSON.stringify({
    type: "event_msg",
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

// ── Branch 256[0]: classify returns null in parseCodexRollout ──────────────────

describe("parseCodexRollout — classify returns null (Branch 256[0])", () => {
  it("skips a JSON null line (classify returns null for non-object)", async () => {
    // JSON.parse("null") → JS null → classify(null) → null → skip (Branch 256[0])
    const lines = [
      "null",
      sessionMetaTs({ cwd: "/work" }),
      turnCtx("gpt-5"),
      tokenCountLine("2026-08-01T10:00:05.000Z", 30, 10),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "null-line" });
    expect(session).not.toBeNull();
    // The null line is silently skipped; the rest of the session parses normally
    expect(session?.assistantMessages).toBe(1);
  });

  it("skips a JSON number line (classify returns null for non-object)", async () => {
    const lines = [
      "42",
      sessionMetaTs({ cwd: "/work" }),
      tokenCountLine("2026-08-01T10:00:05.000Z", 15, 5),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "num-line" });
    expect(session).not.toBeNull();
    expect(session?.assistantMessages).toBe(1);
  });
});

// ── Branches 142-145: second untimestamped token merges into d ────────────────

describe("handleTokenCountEvent — second untimestamped token merges into d (Branches 142-145)", () => {
  it("accumulates two consecutive untimestamped deltas: second fires d-non-null branches", async () => {
    // ORDERING: both untimestamped tokens come BEFORE any timestamped record.
    // acc.lastTs starts null and stays null for both.
    // First token: d = null → acc.deferredTokenDelta = {input:10, output:5}
    //   Branches 142[1], 143[1], 144[1], 145[1] (the `delta.X` arms)
    // Second token (cumulative={input:20, output:8}): delta = {input:10, output:3}
    //   d is non-null → Branches 142[0], 143[0], 144[0], 145[0] (the `d.X + delta.X` arms)
    const lines = [
      tokenCountNoTs(10, 5),
      tokenCountNoTs(20, 8),
      // Timestamped session_meta to set firstTimestamp (required for non-null return)
      sessionMetaTs({ cwd: "/work" }),
      turnCtx("gpt-5"),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "double-deferred",
    });
    expect(session).not.toBeNull();
    // Both deltas accumulated then flushed at finalize
    expect(session?.assistantMessages).toBe(2);
    expect(session?.tokenSeries).toHaveLength(1);
    // Total delta: second cumulative - start = {20-0=20, 8-0=8}
    const entry = session?.tokenSeries[0];
    expect(entry?.input).toBe(20);
    expect(entry?.output).toBe(8);
  });
});

// ── Deferred token delta flushed at finalize (Branches 261[0], 263[0], 264[0/1], 265[0/1]) ──

describe("parseCodexRollout — deferred token delta flushed at finalize", () => {
  it("flushes an untimestamped token delta with session model (Branches 261[0], 263[0], 264[0], 265[1])", async () => {
    // CRITICAL ordering: untimestamped token FIRST so iso=null (deferred path!),
    // then timestamped records set firstTimestamp+lastTs for the finalize flush.
    // Branch 264[0]: acc.model is set → eventModel = acc.model (not FALLBACK).
    // Branch 265[1]: !acc.model is false → eventInferred=false → no {inferred:true}.
    const lines = [
      // Untimestamped token first: iso = null || null = null → deferred
      tokenCountNoTs(40, 15),
      // Timestamped records set firstTimestamp + lastTs
      sessionMetaTs({ cwd: "/work" }),
      turnCtx("gpt-5"),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "deferred-with-model",
    });
    expect(session).not.toBeNull();
    // Deferred delta flushed at finalize
    expect(session?.tokenSeries).toHaveLength(1);
    const entry = session?.tokenSeries[0];
    expect(entry?.model).toBe("gpt-5");
    expect((entry as Record<string, unknown>)?.inferred).toBeUndefined();
    expect(session?.tokensByModel["gpt-5"]?.input).toBe(40);
    expect(session?.tokensByModel["gpt-5"]?.output).toBe(15);
  });

  it("flushes deferred token delta with FALLBACK model (Branches 261[0], 263[0], 264[1], 265[0])", async () => {
    // No model ever set → acc.model = null.
    // Branch 264[1]: acc.model is null → eventModel = CODEX_FALLBACK_MODEL.
    // Branch 265[0]: eventInferred = !acc.model = true → { inferred: true }.
    const lines = [tokenCountNoTs(25, 8), sessionMetaTs({ cwd: "/work" })];
    const session = await parseCodexRollout(lines, {
      sessionId: "deferred-no-model",
    });
    expect(session).not.toBeNull();
    expect(session?.tokenSeries).toHaveLength(1);
    const entry = session?.tokenSeries[0];
    expect(entry?.model).toBe("gpt-5-codex");
    expect((entry as Record<string, unknown>)?.inferred).toBe(true);
  });

  it("does NOT flush deferred delta when all tokens have timestamps (Branch 261[1] false path)", async () => {
    // All tokens have timestamps → deferred path never taken → no finalize flush
    const lines = [
      sessionMetaTs({ cwd: "/work" }),
      turnCtx("gpt-5"),
      tokenCountLine("2026-08-01T10:00:05.000Z", 30, 10),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "no-deferred",
    });
    expect(session?.tokenSeries).toHaveLength(1);
    expect(session?.tokensByModel["gpt-5"]?.input).toBe(30);
  });
});

// ── Branch 260[0]: burst session → returns null ───────────────────────────────

describe("parseCodexRollout — burst session is filtered (Branch 260[0])", () => {
  it("returns null for a session with many records within burst window", async () => {
    // DEFAULT_BURST_RECORD_MIN = 20, DEFAULT_BURST_WINDOW_MS = 5000
    // recordCount = messages.length + toolUses.length + tokenSeries.length + turnDurations.length
    // Need recordCount >= 20 with span < 5000ms.
    //
    // Strategy: 10 user+assistant pairs (20 messages, 10 turnDurations, 1 tokenSeries) = 31 records
    const ts1 = "2026-08-01T10:00:00.000Z";
    const ts2 = "2026-08-01T10:00:01.000Z"; // 1s from start
    const ts3 = "2026-08-01T10:00:02.000Z"; // 2s from start — within 5000ms
    const burstLines: string[] = [sessionMetaTs({ cwd: "/work" }, ts1)];
    // 10 user+assistant pairs:
    // - user message sets pendingTurnStartedAt
    // - assistant message pushes 1 message + 1 turnDuration
    for (let i = 0; i < 10; i++) {
      // user response_item/message
      burstLines.push(
        JSON.stringify({
          type: "response_item",
          timestamp: ts2,
          payload: { type: "message", role: "user", content: `prompt ${i}` },
        })
      );
      // assistant response_item/message
      burstLines.push(
        JSON.stringify({
          type: "response_item",
          timestamp: ts2,
          payload: { type: "message", role: "assistant", content: "reply" },
        })
      );
    }
    // Token count sets lastTimestamp (needed for span computation)
    burstLines.push(tokenCountLine(ts3, 100, 30));
    const session = await parseCodexRollout(burstLines, {
      sessionId: "burst-sess",
    });
    // messages=20, turnDurations=10, tokenSeries=1 → 31 >= 20, span=2000 < 5000 → null
    expect(session).toBeNull();
  });
});

// ── buildTokensByModel — codex-auto-review model remapping ───────────────────

describe("buildTokensByModel — codex-auto-review model remapping (Branches 240-243)", () => {
  it("remaps codex-auto-review tokens to session model when one exists (Branch 240[0])", async () => {
    // Turn context with gpt-5, token_count model is codex-auto-review.
    // buildTokensByModel remaps the auto-review entry to gpt-5.
    const lines = [
      sessionMetaTs({ cwd: "/work" }),
      turnCtx("gpt-5"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: {
          type: "token_count",
          model: "codex-auto-review",
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
      sessionId: "auto-review-remap",
    });
    expect(session).not.toBeNull();
    expect(session?.tokensByModel["codex-auto-review"]).toBeUndefined();
    expect(session?.tokensByModel["gpt-5"]).toBeDefined();
    expect(session?.tokensByModel["gpt-5"]?.input).toBe(100);
  });

  it("remaps codex-auto-review to CODEX_FALLBACK_MODEL when no session model (Branch 241[1])", async () => {
    // No real model anywhere → codex-auto-review remaps to CODEX_FALLBACK_MODEL.
    const lines = [
      sessionMetaTs({ cwd: "/work" }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: {
          type: "token_count",
          model: "codex-auto-review",
          info: {
            total_token_usage: {
              input_tokens: 50,
              cached_input_tokens: 0,
              output_tokens: 15,
            },
          },
        },
      }),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "auto-review-no-model",
    });
    expect(session?.tokensByModel["codex-auto-review"]).toBeUndefined();
    const fallback = session?.tokensByModel["gpt-5-codex"];
    expect(fallback).toBeDefined();
    expect(fallback?.inferred).toBe(true);
    expect(fallback?.input).toBe(50);
  });
});

// ── projectName fallback (Branch 266[1]) ─────────────────────────────────────

describe("parseCodexRollout — projectName fallback when cwd is absent (Branch 266[1])", () => {
  it("names the session 'Codex Session <prefix>' when cwd was never captured", async () => {
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-08-01T10:00:00.000Z",
        payload: {},
      }),
      turnCtx("gpt-5"),
      tokenCountLine("2026-08-01T10:00:03.000Z", 10, 5),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "no-cwd-sess",
    });
    expect(session).not.toBeNull();
    expect(session?.name).toMatch(CODEX_SESSION_NAME_RE);
    expect(session?.cwd).toBeNull();
  });
});

// ── collectCodexUsageIdentities — edge cases ──────────────────────────────────

describe("collectCodexUsageIdentities — edge cases", () => {
  it("skips blank lines without crashing (Branch 276[0])", async () => {
    const lines = [
      "",
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-08-01T10:00:01.000Z",
        payload: { model: "gpt-5" },
      }),
      "   ",
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 30,
              cached_input_tokens: 0,
              output_tokens: 10,
            },
          },
        },
      }),
    ];
    const ids = await collectCodexUsageIdentities(lines);
    expect(ids.size).toBe(1);
  });

  it("skips malformed JSON lines gracefully (Branch 277[0])", async () => {
    const lines = [
      "NOT VALID JSON",
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-08-01T10:00:01.000Z",
        payload: { model: "gpt-5" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 30,
              cached_input_tokens: 0,
              output_tokens: 10,
            },
          },
        },
      }),
    ];
    const ids = await collectCodexUsageIdentities(lines);
    expect(ids.size).toBe(1);
  });

  it("does NOT include codex-auto-review in identity model (Branch 279[1])", async () => {
    // A turn_context with codex-auto-review should NOT update the model for identity
    const withAutoReview = [
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-08-01T10:00:01.000Z",
        payload: { model: "codex-auto-review" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 30,
              cached_input_tokens: 0,
              output_tokens: 10,
            },
          },
        },
      }),
    ];
    const withRealModel = [
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-08-01T10:00:01.000Z",
        payload: { model: "gpt-5" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 30,
              cached_input_tokens: 0,
              output_tokens: 10,
            },
          },
        },
      }),
    ];
    const autoIds = await collectCodexUsageIdentities(withAutoReview);
    const realIds = await collectCodexUsageIdentities(withRealModel);
    // Identities differ: auto-review uses null model, real uses gpt-5
    expect(autoIds.size).toBe(1);
    expect(realIds.size).toBe(1);
    const [autoId] = autoIds;
    const [realId] = realIds;
    expect(autoId).not.toBe(realId);
  });

  it("skips token_count events with no extractable totals (Branch 283[0])", async () => {
    const lines = [
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: { type: "token_count", info: { no_totals_here: true } },
      }),
    ];
    const ids = await collectCodexUsageIdentities(lines);
    expect(ids.size).toBe(0);
  });

  it("reads totals from token_count_info fallback (Branch 284[1,2])", async () => {
    const lines = [
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-08-01T10:00:01.000Z",
        payload: { model: "gpt-5" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: {
          type: "token_count",
          // No info field; token_count_info is the fallback
          token_count_info: {
            total_token_usage: {
              input_tokens: 40,
              cached_input_tokens: 0,
              output_tokens: 15,
            },
          },
        },
      }),
    ];
    const ids = await collectCodexUsageIdentities(lines);
    expect(ids.size).toBe(1);
  });

  it("reads model from payload.model when no turn_context set it", async () => {
    const lines = [
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: {
          type: "token_count",
          model: "gpt-4o",
          info: {
            total_token_usage: {
              input_tokens: 20,
              cached_input_tokens: 0,
              output_tokens: 8,
            },
          },
        },
      }),
    ];
    const ids = await collectCodexUsageIdentities(lines);
    expect(ids.size).toBe(1);
    const [id] = ids;
    expect(id).toMatch(GPT4O_IDENTITY_RE);
  });

  it("handles auto-classified (unknown-wrapper) token_count records", async () => {
    // Unknown envelope with a token_count payload → classified as 'auto'
    const lines = [
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-08-01T10:00:01.000Z",
        payload: { model: "gpt-5" },
      }),
      JSON.stringify({
        type: "future_envelope",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 50,
              cached_input_tokens: 0,
              output_tokens: 20,
            },
          },
        },
      }),
    ];
    const ids = await collectCodexUsageIdentities(lines);
    expect(ids.size).toBe(1);
  });

  it("skips a JSON null line (classify returns null for non-object)", async () => {
    const lines = [
      "null",
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
          },
        },
      }),
    ];
    const ids = await collectCodexUsageIdentities(lines);
    expect(ids.size).toBe(1);
  });

  it("handles an InvalidTokenCountError by skipping that identity (Branch 286[0])", async () => {
    // Fractional input_tokens → InvalidTokenCountError → identity skipped, not thrown
    const lines = [
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 100.5,
              cached_input_tokens: 0,
              output_tokens: 30,
            },
          },
        },
      }),
      // Good snapshot after the bad one — its identity IS collected
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:04.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 200,
              cached_input_tokens: 0,
              output_tokens: 60,
            },
          },
        },
      }),
    ];
    const ids = await collectCodexUsageIdentities(lines);
    expect(ids.size).toBe(1);
  });

  it("skips event records with no payload type (no token_count)", async () => {
    const lines = [
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:03.000Z",
        payload: { no_type: "here" },
      }),
    ];
    const ids = await collectCodexUsageIdentities(lines);
    expect(ids.size).toBe(0);
  });
});

// ── rebaseReplayedBurst / isBurstSession — no firstTimestamp (Branch 226[0]) ───

describe("isBurstSession — no firstTimestamp path", () => {
  it("returns null (early exit) when session has no timestamps at all", async () => {
    // No timestamps → acc.firstTimestamp = null → early return at line 1974.
    // This verifies the !acc.firstTimestamp guard (not isBurstSession itself,
    // since isBurstSession's Branch 226[0] guard is inside that function).
    const lines = [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/work" } }),
      JSON.stringify({
        type: "event_msg",
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
      }),
    ];
    const session = await parseCodexRollout(lines, {
      sessionId: "no-timestamps",
    });
    expect(session).toBeNull();
  });
});
