import { describe, expect, it } from "vitest";
import { CODEX_PROTOCOL_SUPPORT } from "./codex-protocol-inventory";
import { collectCodexUsageIdentities, parseCodexRollout } from "./parse-codex";

// The desktop suite exercises the Codex parser exhaustively through file I/O.
// These tests pin the browser entry point: it parses an in-memory line iterable
// (no fs, no env), derives the fresh-shape token totals (nonCached input, output
// + reasoning), and honors the no-timestamp null contract.

const LINES = [
  JSON.stringify({
    type: "session_meta",
    timestamp: "2026-07-09T12:00:00.000Z",
    payload: { cwd: "/workspace/proj", cli_version: "1.2.3" },
  }),
  JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-09T12:00:00.500Z",
    payload: { model: "gpt-5-codex" },
  }),
  JSON.stringify({
    type: "response_item",
    timestamp: "2026-07-09T12:00:01.000Z",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    },
  }),
  JSON.stringify({
    type: "response_item",
    timestamp: "2026-07-09T12:00:02.000Z",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "hi" }],
    },
  }),
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-09T12:00:03.000Z",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 30,
          reasoning_output_tokens: 5,
        },
      },
    },
  }),
];

describe("parseCodexRollout", () => {
  it("parses a minimal rollout and derives fresh-shape token totals", async () => {
    const session = await parseCodexRollout(LINES, { sessionId: "codex-sess" });

    expect(session).not.toBeNull();
    expect(session?.sessionId).toBe("codex-sess");
    expect(session?.entrypoint).toBe("codex");
    expect(session?.model).toBe("gpt-5-codex");
    expect(session?.userMessages).toBe(1);
    expect(session?.assistantMessages).toBe(1);
    // input = 100 total − 20 cached; output = 30 (reasoning 5 is a subset);
    // cacheRead = 20.
    expect(session?.tokensByModel["gpt-5-codex"]).toMatchObject({
      input: 80,
      output: 30,
      cacheRead: 20,
      cacheWrite: 0,
    });
    expect(session?.fileModifiedAt).toBeNull();
  });

  it("records the supported Codex protocol pin in parser output (FEA-3715)", async () => {
    const session = await parseCodexRollout(LINES, { sessionId: "codex-sess" });
    // AC3: every parsed Codex session self-documents the reviewed protocol pin
    // it was decoded under (supported version/commit range anchor).
    expect(session?.codexProtocolSupport).toEqual(CODEX_PROTOCOL_SUPPORT);
    expect(session?.codexProtocolSupport?.pinnedCommit).toBe(
      "963cda85aa2a4cfb85e52d771d22d9f3069951fa"
    );
  });

  it("tolerates a token_count event with an invalid counter without aborting the parse", async () => {
    // FEA cloud-render robustness: a non-Claude harness rollout (e.g. gpt-5.5)
    // can carry a fractional / JS-unsafe token counter. That used to throw
    // `InvalidTokenCountError` and blank the WHOLE transcript. The parser must
    // instead drop that one snapshot's usage and still render the conversation.
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-07-09T12:00:00.000Z",
        payload: { cwd: "/workspace/proj", cli_version: "1.2.3" },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-07-09T12:00:00.500Z",
        payload: { model: "gpt-5.5" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-09T12:00:01.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      }),
      // Bad snapshot: a fractional input counter trips the safe-integer guard.
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-07-09T12:00:02.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 100.5,
              cached_input_tokens: 20,
              output_tokens: 30,
              reasoning_output_tokens: 5,
            },
          },
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-09T12:00:03.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hi" }],
        },
      }),
      // A subsequent GOOD snapshot must still be counted (baseline is the last
      // good totals — none here — so its full cumulative value is the delta).
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-07-09T12:00:04.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 200,
              cached_input_tokens: 40,
              output_tokens: 60,
              reasoning_output_tokens: 10,
            },
          },
        },
      }),
    ];

    const session = await parseCodexRollout(lines, { sessionId: "codex-bad" });

    expect(session).not.toBeNull();
    // The conversation still rendered despite the bad token snapshot.
    expect(session?.userMessages).toBe(1);
    expect(session?.assistantMessages).toBe(1);
    expect(session?.model).toBe("gpt-5.5");
    // The bad snapshot was dropped; the good one counted (input = 200 − 40,
    // output = 60 with reasoning 10 as a subset, cacheRead = 40).
    expect(session?.tokensByModel["gpt-5.5"]).toMatchObject({
      input: 160,
      output: 60,
      cacheRead: 40,
    });
  });

  it("collects identities past an invalid-counter snapshot so a forked child still folds", async () => {
    // A resumed Codex rollout replays the parent's leading token_count
    // snapshots. The desktop collector first calls `collectCodexUsageIdentities`
    // over the PARENT to learn which snapshots the child will re-import. If the
    // parent carries a fractional / JS-unsafe counter, the unguarded
    // `readCodexTokenTotals` used to throw here and abort the whole fork/replay
    // fold — blanking the forked descendant's import — even though the main
    // parse path already tolerates that same bad shape. Identity collection must
    // mirror that tolerance: drop the bad snapshot's identity and keep going.
    const parentLines = [
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-07-09T12:00:00.000Z",
        payload: { model: "gpt-5.5" },
      }),
      // Bad snapshot: fractional input counter trips the safe-integer guard.
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-07-09T12:00:01.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 100.5,
              cached_input_tokens: 20,
              output_tokens: 30,
              reasoning_output_tokens: 5,
            },
          },
        },
      }),
      // Good snapshot the child WILL replay — its identity must be collected.
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-07-09T12:00:02.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 200,
              cached_input_tokens: 40,
              output_tokens: 60,
              reasoning_output_tokens: 10,
            },
          },
        },
      }),
    ];

    // Does not throw despite the parent's bad counter; the good snapshot is kept.
    const identities = await collectCodexUsageIdentities(parentLines);
    expect(identities.size).toBe(1);

    // The forked child replays the parent's good snapshot then adds its own
    // turn. With replay-matching on, the leading duplicate must be skipped and
    // only the child's own delta counted.
    const childLines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-07-09T12:05:00.000Z",
        payload: { cwd: "/workspace/proj", cli_version: "1.2.3" },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-07-09T12:05:00.500Z",
        payload: { model: "gpt-5.5" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-09T12:05:01.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "resumed" }],
        },
      }),
      // Replayed parent snapshot (same identity) — must be skipped, not counted.
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-07-09T12:05:02.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 200,
              cached_input_tokens: 40,
              output_tokens: 60,
              reasoning_output_tokens: 10,
            },
          },
        },
      }),
      // Child's own new snapshot — its delta over the replayed baseline counts.
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-07-09T12:05:03.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 300,
              cached_input_tokens: 60,
              output_tokens: 90,
              reasoning_output_tokens: 15,
            },
          },
        },
      }),
    ];

    const child = await parseCodexRollout(childLines, {
      sessionId: "codex-child",
      replayedUsageIdentities: identities,
    });

    expect(child).not.toBeNull();
    // Only the child's own delta (300−200 total, 60−40 cached, 90−60 out;
    // reasoning 15−10 is a subset of output) is counted; the replayed leading
    // snapshot was skipped.
    expect(child?.tokensByModel["gpt-5.5"]).toMatchObject({
      input: 80,
      output: 30,
      cacheRead: 20,
    });
    // FEA-3527: the replayed parent snapshot (reasoning 10) must NOT feed the
    // child's reasoning max — only the child's own snapshot (reasoning 15) does.
    // Here 15 > 10 so the value coincides, but the max is now sourced from the
    // non-replayed snapshot; see the dedicated no-double-count test below where
    // the replayed parent reasoning is the larger value and the distinction bites.
    expect(child?.usageExtras.reasoning_output_tokens).toBe(15);
  });

  it("counts assistantMessages from token_count events, not response_item messages (FEA-3125)", async () => {
    const phantomLines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-07-09T12:00:00.000Z",
        payload: { cwd: "/workspace/proj" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-09T12:00:01.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hi" }],
        },
      }),
    ];
    const session = await parseCodexRollout(phantomLines, {
      sessionId: "phantom",
    });
    expect(session).not.toBeNull();
    expect(session?.assistantMessages).toBe(0);
    expect(session?.messages).toHaveLength(1);
  });

  it("does not count null-info token_count as a billable round-trip (FEA-3125)", async () => {
    const nullInfoLines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-07-09T12:00:00.000Z",
        payload: { cwd: "/workspace/proj" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-07-09T12:00:01.000Z",
        payload: { type: "token_count", info: null },
      }),
    ];
    const session = await parseCodexRollout(nullInfoLines, {
      sessionId: "null-info",
    });
    expect(session).not.toBeNull();
    expect(session?.assistantMessages).toBe(0);
  });

  it("decrements assistantMessages for burst round-trips dropped by rebaseReplayedBurst (FEA-3439)", async () => {
    // A resumed/forked Codex rollout replays the parent's token_count events in
    // a tight leading burst, then appends real work. rebaseReplayedBurst drops
    // the replayed token entries from tokenSeries so the token totals are
    // rebased; assistantMessages (billable round-trips, FEA-3125) must be
    // decremented by the same count so session-trace `turns` doesn't keep
    // counting the parent's replayed round-trips.
    const burstEvent = (ts: string, input: number, output: number) =>
      JSON.stringify({
        type: "event_msg",
        timestamp: ts,
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: input,
              cached_input_tokens: 0,
              output_tokens: output,
              reasoning_output_tokens: 0,
            },
          },
        },
      });
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-07-09T12:00:00.000Z",
        payload: { cwd: "/workspace/proj" },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-07-09T12:00:00.050Z",
        payload: { model: "gpt-5.5" },
      }),
      // Replayed leading burst (3 round-trips within the 1s window).
      burstEvent("2026-07-09T12:00:00.100Z", 100, 10),
      burstEvent("2026-07-09T12:00:00.200Z", 200, 20),
      burstEvent("2026-07-09T12:00:00.300Z", 300, 30),
      // Real post-burst round-trip (outside the window; keeps the whole-file
      // span > 1s so isBurstSession does not blank the session).
      burstEvent("2026-07-09T12:00:05.000Z", 400, 40),
    ];

    const session = await parseCodexRollout(lines, {
      sessionId: "codex-resumed-burst",
      burstRecordMin: 3,
      burstWindowMs: 1000,
    });

    expect(session).not.toBeNull();
    // The 3 replayed burst round-trips are dropped; only the real one remains.
    expect(session?.assistantMessages).toBe(1);
    // Token totals are rebased to the single real turn (delta 400−300, 40−30).
    expect(session?.tokensByModel["gpt-5.5"]).toMatchObject({
      input: 100,
      output: 10,
    });
  });

  it("rebases reasoning_output_tokens to the burst-relative delta so it never exceeds the rebased output (FEA-3682)", async () => {
    // A resumed session replays the parent's leading token_count burst, whose
    // cumulative reasoning climbs 50→60→70 while output climbs 100→200→300. One
    // real post-burst turn brings output to 310 (delta 10) and reasoning to 72.
    // `reasoningOutputTokens` alone is a whole-file cumulative MAX, so without
    // rebasing it would surface 72 against a rebased output of 10 — breaking the
    // FEA-3527 subset-of-output invariant and double-counting the parent's
    // reasoning. It must rebase to 72−70 = 2, mirroring the output delta rebase.
    const burstEvent = (
      ts: string,
      input: number,
      output: number,
      reasoning: number
    ) =>
      JSON.stringify({
        type: "event_msg",
        timestamp: ts,
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: input,
              cached_input_tokens: 0,
              output_tokens: output,
              reasoning_output_tokens: reasoning,
            },
          },
        },
      });
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-07-09T12:00:00.000Z",
        payload: { cwd: "/home/me/proj" },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-07-09T12:00:00.050Z",
        payload: { model: "gpt-5.5" },
      }),
      // Replayed leading burst (3 round-trips within the 1s window).
      burstEvent("2026-07-09T12:00:00.100Z", 100, 100, 50),
      burstEvent("2026-07-09T12:00:00.200Z", 200, 200, 60),
      burstEvent("2026-07-09T12:00:00.300Z", 300, 300, 70),
      // Real post-burst round-trip (outside the window).
      burstEvent("2026-07-09T12:00:05.000Z", 310, 310, 72),
    ];

    const session = await parseCodexRollout(lines, {
      sessionId: "codex-resumed-reasoning",
      burstRecordMin: 3,
      burstWindowMs: 1000,
    });

    expect(session).not.toBeNull();
    // Output is rebased to the single real turn's delta (310−300).
    const rebasedOutput = session?.tokensByModel["gpt-5.5"]?.output ?? 0;
    expect(rebasedOutput).toBe(10);
    // Reasoning is rebased to the burst-relative delta (72−70), NOT the raw max.
    expect(session?.usageExtras.reasoning_output_tokens).toBe(2);
    // FEA-3527 invariant: reasoning stays a subset of the (rebased) output.
    expect(session?.usageExtras.reasoning_output_tokens).toBeLessThanOrEqual(
      rebasedOutput
    );
  });

  it("decrements assistantMessages by burst EVENTS when a replayed burst has a zero-delta round-trip (FEA-3608)", async () => {
    // Empirical repro: the replayed leading burst's MIDDLE event repeats the
    // previous cumulative total (zero delta). `assistantMessageCount++` runs for
    // that event (it is an extractable token_count), but `tokenSeries.push` does
    // NOT (delta is zero → hasTokens false). FEA-3439 decremented by the number
    // of removed tokenSeries entries (2), leaving assistantMessages = 2; the
    // burst carries 3 EVENTS, so counting events decrements by 3 → 1.
    const burstEvent = (ts: string, input: number, output: number) =>
      JSON.stringify({
        type: "event_msg",
        timestamp: ts,
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: input,
              cached_input_tokens: 0,
              output_tokens: output,
              reasoning_output_tokens: 0,
            },
          },
        },
      });
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-07-09T12:00:00.000Z",
        payload: { cwd: "/workspace/proj" },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-07-09T12:00:00.050Z",
        payload: { model: "gpt-5.5" },
      }),
      // Replayed leading burst (3 round-trips within the 1s window).
      burstEvent("2026-07-09T12:00:00.100Z", 100, 10),
      // MIDDLE event repeats the previous cumulative total → zero delta → bumps
      // assistantMessageCount but pushes no tokenSeries entry.
      burstEvent("2026-07-09T12:00:00.200Z", 100, 10),
      burstEvent("2026-07-09T12:00:00.300Z", 300, 30),
      // Real post-burst round-trip (outside the window).
      burstEvent("2026-07-09T12:00:05.000Z", 400, 40),
    ];

    const session = await parseCodexRollout(lines, {
      sessionId: "codex-resumed-burst-zero-delta",
      // The burst has 3 replayed round-trips, but the zero-delta middle event
      // pushes no tokenSeries entry, so only 2 series records land in the
      // window. Set the detection floor to 2 so the burst is still detected
      // (production uses 20 with many records); the point under test is the
      // decrement, not the detection threshold.
      burstRecordMin: 2,
      burstWindowMs: 1000,
    });

    expect(session).not.toBeNull();
    // 3 burst EVENTS dropped (incl. the zero-delta middle); only the real one
    // remains — NOT 2 (the number of removed tokenSeries entries).
    expect(session?.assistantMessages).toBe(1);
    // Token totals rebase to the single real turn (delta 400−300, 40−30).
    expect(session?.tokensByModel["gpt-5.5"]).toMatchObject({
      input: 100,
      output: 10,
    });
  });

  it("decrements assistantMessages for a FULLY zero-delta replayed burst that pushes no surviving tokenSeries entry (FEA-3681)", async () => {
    // Fully-degenerate case of FEA-3608: EVERY in-window token_count event of the
    // replayed leading burst reports the same (zero) cumulative total, so each
    // one bumps `assistantMessageCount` and records a `tokenEventTimestamps`
    // entry but pushes NO `tokenSeries` entry (delta is zero → hasTokens false).
    // The burst is still detected (its replayed assistant messages carry the
    // window records), but `rebaseReplayedBurst` used to early-return on
    // `!tokenSeries.some(inLeadingBurst)` BEFORE the tokenEventTimestamps-based
    // decrement — leaving `assistantMessages` inflated by the replayed
    // round-trips even though the token totals rebased to the single real turn.
    const tokenEvent = (ts: string, input: number, output: number) =>
      JSON.stringify({
        type: "event_msg",
        timestamp: ts,
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: input,
              cached_input_tokens: 0,
              output_tokens: output,
              reasoning_output_tokens: 0,
            },
          },
        },
      });
    const assistantMessage = (ts: string, text: string) =>
      JSON.stringify({
        type: "response_item",
        timestamp: ts,
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        },
      });
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-07-09T12:00:00.000Z",
        payload: { cwd: "/workspace/proj" },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-07-09T12:00:00.050Z",
        payload: { model: "gpt-5.5" },
      }),
      // Replayed leading burst: 3 round-trips within the 1s window, EVERY one at
      // the same zero cumulative total (event #1 has previousTotals=null, so its
      // own zero total is a zero delta too). Each bumps assistantMessageCount but
      // pushes no tokenSeries entry. Interleaved replayed assistant messages give
      // the burst its window records so it is still detected.
      tokenEvent("2026-07-09T12:00:00.100Z", 0, 0),
      assistantMessage("2026-07-09T12:00:00.120Z", "replayed a"),
      tokenEvent("2026-07-09T12:00:00.200Z", 0, 0),
      assistantMessage("2026-07-09T12:00:00.220Z", "replayed b"),
      tokenEvent("2026-07-09T12:00:00.300Z", 0, 0),
      assistantMessage("2026-07-09T12:00:00.320Z", "replayed c"),
      // Real post-burst round-trip (outside the window). Its delta against the
      // zero baseline is its full total → the single surviving tokenSeries entry.
      tokenEvent("2026-07-09T12:00:05.000Z", 100, 10),
    ];

    const session = await parseCodexRollout(lines, {
      sessionId: "codex-resumed-burst-all-zero-delta",
      // Detected via the 3 replayed burst-window records; the point under test is
      // the decrement path when ZERO burst tokenSeries entries survive.
      burstRecordMin: 3,
      burstWindowMs: 1000,
    });

    expect(session).not.toBeNull();
    // All 3 replayed burst EVENTS are decremented even though none left a
    // tokenSeries entry to remove; only the real post-burst round-trip remains.
    expect(session?.assistantMessages).toBe(1);
    // Token totals rebase to the single real turn (delta 100−0, 10−0).
    expect(session?.tokensByModel["gpt-5.5"]).toMatchObject({
      input: 100,
      output: 10,
    });
  });

  it("returns null when the rollout has no usable timestamp", async () => {
    const line = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "no ts" }],
      },
    });
    expect(await parseCodexRollout([line], { sessionId: "s" })).toBeNull();
  });

  it("counts a paired compacted record + context_compacted echo once (FEA-3127)", async () => {
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-06-26T14:00:00.000Z"),
        compactedLine("2026-06-26T14:39:15.273Z"),
        contextCompactedLine("2026-06-26T14:39:15.280Z"),
      ],
      { sessionId: "compacted-pair" }
    );
    expect(session?.compactions).toEqual([
      { uuid: null, timestamp: "2026-06-26T14:39:15.273Z" },
    ]);
  });

  it("counts two compaction pairs as two compactions (FEA-3127)", async () => {
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-05-21T19:00:00.000Z"),
        compactedLine("2026-05-21T19:47:05.907Z"),
        contextCompactedLine("2026-05-21T19:47:05.909Z"),
        compactedLine("2026-05-21T20:03:54.460Z"),
        contextCompactedLine("2026-05-21T20:03:54.464Z"),
      ],
      { sessionId: "compacted-two-pairs" }
    );
    expect(session?.compactions).toEqual([
      { uuid: null, timestamp: "2026-05-21T19:47:05.907Z" },
      { uuid: null, timestamp: "2026-05-21T20:03:54.460Z" },
    ]);
  });

  it("counts an unpaired compacted record without its echo (FEA-3127)", async () => {
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-06-26T14:00:00.000Z"),
        compactedLine("2026-06-26T14:39:15.273Z"),
      ],
      { sessionId: "compacted-only" }
    );
    expect(session?.compactions).toEqual([
      { uuid: null, timestamp: "2026-06-26T14:39:15.273Z" },
    ]);
  });

  it("counts an unpaired context_compacted event without a compacted record (FEA-3127)", async () => {
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-06-26T14:00:00.000Z"),
        contextCompactedLine("2026-06-26T14:39:15.280Z"),
      ],
      { sessionId: "context-compacted-only" }
    );
    expect(session?.compactions).toEqual([
      { uuid: null, timestamp: "2026-06-26T14:39:15.280Z" },
    ]);
  });

  it("reports no compactions for an uncompacted rollout (FEA-3127)", async () => {
    const session = await parseCodexRollout(LINES, {
      sessionId: "uncompacted",
    });
    expect(session?.compactions).toEqual([]);
  });

  // FEA-3526: capture the authoritative per-turn `last_token_usage` snapshot.
  describe("codexLastTokenUsage (FEA-3526)", () => {
    const preludeLines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-07-09T12:00:00.000Z",
        payload: { cwd: "/workspace/proj", cli_version: "1.2.3" },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-07-09T12:00:00.500Z",
        payload: { model: "gpt-5-codex" },
      }),
    ];

    function tokenCountLine(
      timestamp: string,
      totals: Record<string, number>,
      last: Record<string, number>
    ): string {
      return JSON.stringify({
        type: "event_msg",
        timestamp,
        payload: {
          type: "token_count",
          info: {
            total_token_usage: totals,
            last_token_usage: last,
          },
        },
      });
    }

    it("captures last_token_usage in fresh shape and agrees with the derived delta on the first turn", async () => {
      // First turn: cumulative == last, so the derived delta equals the
      // authoritative snapshot exactly (no drift).
      const lines = [
        ...preludeLines,
        tokenCountLine(
          "2026-07-09T12:00:03.000Z",
          {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 30,
            reasoning_output_tokens: 5,
          },
          {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 30,
            reasoning_output_tokens: 5,
          }
        ),
      ];

      const session = await parseCodexRollout(lines, { sessionId: "ltu-1" });
      expect(session?.codexLastTokenUsage).toHaveLength(1);
      const snap = session?.codexLastTokenUsage?.[0];
      // Fresh shape: input = 100 − 20 cached; cacheRead = 20; output = 30.
      expect(snap?.lastTokenUsage).toEqual({
        input: 80,
        output: 30,
        cacheRead: 20,
        cacheWrite: 0,
      });
      // Derived delta equals the snapshot on the first turn → no drift.
      expect(snap?.derivedDelta).toEqual(snap?.lastTokenUsage);
      expect(snap?.drifted).toBe(false);
      expect(snap?.model).toBe("gpt-5-codex");
      expect(snap?.timestamp).toBe("2026-07-09T12:00:03.000Z");
    });

    it("agrees across two turns where last_token_usage matches the cumulative delta", async () => {
      const lines = [
        ...preludeLines,
        tokenCountLine(
          "2026-07-09T12:00:03.000Z",
          {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 30,
            reasoning_output_tokens: 5,
          },
          {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 30,
            reasoning_output_tokens: 5,
          }
        ),
        // Second turn: cumulative grows by (+100 input, +20 cached, +30 output);
        // the per-turn last_token_usage reports exactly that delta.
        tokenCountLine(
          "2026-07-09T12:00:05.000Z",
          {
            input_tokens: 200,
            cached_input_tokens: 40,
            output_tokens: 60,
            reasoning_output_tokens: 10,
          },
          {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 30,
            reasoning_output_tokens: 5,
          }
        ),
      ];

      const session = await parseCodexRollout(lines, { sessionId: "ltu-2" });
      expect(session?.codexLastTokenUsage).toHaveLength(2);
      const second = session?.codexLastTokenUsage?.[1];
      expect(second?.lastTokenUsage).toEqual({
        input: 80,
        output: 30,
        cacheRead: 20,
        cacheWrite: 0,
      });
      expect(second?.derivedDelta).toEqual(second?.lastTokenUsage);
      expect(second?.drifted).toBe(false);
    });

    it("flags drift when last_token_usage disagrees with the derived cumulative delta", async () => {
      const lines = [
        ...preludeLines,
        tokenCountLine(
          "2026-07-09T12:00:03.000Z",
          {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 30,
            reasoning_output_tokens: 5,
          },
          {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 30,
            reasoning_output_tokens: 5,
          }
        ),
        // Second turn: cumulative delta is (+100 input, +20 cached, +30 output),
        // but last_token_usage claims a much larger per-turn spend → drift.
        tokenCountLine(
          "2026-07-09T12:00:05.000Z",
          {
            input_tokens: 200,
            cached_input_tokens: 40,
            output_tokens: 60,
            reasoning_output_tokens: 10,
          },
          {
            input_tokens: 900,
            cached_input_tokens: 100,
            output_tokens: 300,
            reasoning_output_tokens: 50,
          }
        ),
      ];

      const session = await parseCodexRollout(lines, {
        sessionId: "ltu-drift",
      });
      const second = session?.codexLastTokenUsage?.[1];
      // Snapshot is captured verbatim (input = 900 − 100, output = 300).
      expect(second?.lastTokenUsage).toEqual({
        input: 800,
        output: 300,
        cacheRead: 100,
        cacheWrite: 0,
      });
      // Derived cumulative delta is the small step, not the snapshot.
      expect(second?.derivedDelta).toEqual({
        input: 80,
        output: 30,
        cacheRead: 20,
        cacheWrite: 0,
      });
      expect(second?.drifted).toBe(true);
    });

    it("drops a malformed last_token_usage snapshot but keeps cumulative token math", async () => {
      const lines = [
        ...preludeLines,
        // Cumulative totals are valid; last_token_usage has a fractional counter
        // that trips the safe-integer guard → the snapshot is dropped, parse
        // continues, and the cumulative-derived totals are unaffected.
        tokenCountLine(
          "2026-07-09T12:00:03.000Z",
          {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 30,
            reasoning_output_tokens: 5,
          },
          {
            input_tokens: 100.5,
            cached_input_tokens: 20,
            output_tokens: 30,
            reasoning_output_tokens: 5,
          }
        ),
      ];

      const session = await parseCodexRollout(lines, { sessionId: "ltu-bad" });
      // No snapshot recorded; the array is omitted entirely (empty).
      expect(session?.codexLastTokenUsage).toBeUndefined();
      // Cumulative token math is untouched by the malformed snapshot.
      expect(session?.tokensByModel["gpt-5-codex"]).toMatchObject({
        input: 80,
        output: 30,
        cacheRead: 20,
      });
    });

    it("omits codexLastTokenUsage when token_count events carry no last_token_usage", async () => {
      // LINES has a token_count event with total_token_usage but no
      // last_token_usage — the additive field must stay absent (oracle-safe).
      const session = await parseCodexRollout(LINES, {
        sessionId: "ltu-absent",
      });
      expect(session?.codexLastTokenUsage).toBeUndefined();
      // Cumulative token totals are still derived as before.
      expect(session?.tokensByModel["gpt-5-codex"]).toMatchObject({
        input: 80,
        output: 30,
        cacheRead: 20,
      });
    });

    it("does not let last_token_usage alter the canonical cumulative token totals (conservation)", async () => {
      // Same two cumulative snapshots, run once WITHOUT and once WITH wildly
      // different last_token_usage values. The derived tokensByModel and
      // tokenSeries must be byte-identical: last_token_usage is metadata only.
      const cumulative: [string, Record<string, number>][] = [
        [
          "2026-07-09T12:00:03.000Z",
          {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 30,
            reasoning_output_tokens: 5,
          },
        ],
        [
          "2026-07-09T12:00:05.000Z",
          {
            input_tokens: 260,
            cached_input_tokens: 44,
            output_tokens: 90,
            reasoning_output_tokens: 12,
          },
        ],
      ];
      const withoutLast = [
        ...preludeLines,
        ...cumulative.map(([ts, totals]) =>
          JSON.stringify({
            type: "event_msg",
            timestamp: ts,
            payload: {
              type: "token_count",
              info: { total_token_usage: totals },
            },
          })
        ),
      ];
      const withLast = [
        ...preludeLines,
        ...cumulative.map(([ts, totals]) =>
          tokenCountLine(ts, totals, {
            // Deliberately inconsistent per-turn values.
            input_tokens: 9999,
            cached_input_tokens: 1,
            output_tokens: 8888,
            reasoning_output_tokens: 7,
          })
        ),
      ];

      const a = await parseCodexRollout(withoutLast, { sessionId: "cons-a" });
      const b = await parseCodexRollout(withLast, { sessionId: "cons-b" });
      expect(b?.tokensByModel).toEqual(a?.tokensByModel);
      expect(b?.tokenSeries).toEqual(a?.tokenSeries);
      // The metadata is captured only in the WITH-last run.
      expect(a?.codexLastTokenUsage).toBeUndefined();
      expect(b?.codexLastTokenUsage).toHaveLength(2);
    });
  });

  // FEA-3527: reasoning_output_tokens is a SUBDIVISION of output_tokens. It is
  // surfaced as non-additive metadata on usageExtras and must NEVER be folded
  // into the output total or any grand total.
  describe("FEA-3527 reasoning_output_tokens metadata", () => {
    // Build a token_count line whose reasoning_output_tokens is overridable.
    const tokenCountLine = (
      reasoning: unknown,
      timestamp = "2026-07-09T12:00:03.000Z"
    ): string =>
      JSON.stringify({
        type: "event_msg",
        timestamp,
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 20,
              output_tokens: 30,
              ...(reasoning === undefined
                ? {}
                : { reasoning_output_tokens: reasoning }),
            },
          },
        },
      });

    const baseLines = (tokenLine: string): string[] => [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-07-09T12:00:00.000Z",
        payload: { cwd: "/workspace/proj", cli_version: "1.2.3" },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-07-09T12:00:00.500Z",
        payload: { model: "gpt-5-codex" },
      }),
      tokenLine,
    ];

    it("surfaces a present reasoning_output_tokens as metadata", async () => {
      const session = await parseCodexRollout(baseLines(tokenCountLine(5)), {
        sessionId: "reasoning-present",
      });
      expect(session?.usageExtras.reasoning_output_tokens).toBe(5);
    });

    it("defaults reasoning_output_tokens to 0 when absent", async () => {
      const session = await parseCodexRollout(
        baseLines(tokenCountLine(undefined)),
        { sessionId: "reasoning-absent" }
      );
      expect(session?.usageExtras.reasoning_output_tokens).toBe(0);
    });

    it("drops the whole snapshot on a malformed reasoning_output_tokens without corrupting totals", async () => {
      // A fractional / JS-unsafe reasoning counter trips the same safe-integer
      // guard the parser already tolerates: the bad snapshot's usage is dropped
      // (metadata stays 0) but the conversation still parses.
      const session = await parseCodexRollout(baseLines(tokenCountLine(5.5)), {
        sessionId: "reasoning-malformed",
      });
      expect(session).not.toBeNull();
      // Bad snapshot dropped → no token rows, reasoning metadata stays at its 0
      // default. Crucially it is NOT silently added anywhere.
      expect(session?.usageExtras.reasoning_output_tokens).toBe(0);
      expect(session?.tokensByModel).toEqual({});
    });

    it("tracks the max cumulative reasoning across successive snapshots", async () => {
      const session = await parseCodexRollout(
        [
          ...baseLines(tokenCountLine(5, "2026-07-09T12:00:03.000Z")),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-07-09T12:00:04.000Z",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: {
                  input_tokens: 200,
                  cached_input_tokens: 40,
                  output_tokens: 60,
                  reasoning_output_tokens: 12,
                },
              },
            },
          }),
        ],
        { sessionId: "reasoning-cumulative" }
      );
      // Cumulative last-wins/max: the later 12 supersedes the earlier 5.
      expect(session?.usageExtras.reasoning_output_tokens).toBe(12);
    });

    it("conserves output and grand totals — reasoning is never additive", async () => {
      // Two otherwise-identical rollouts differing ONLY in reasoning_output_tokens
      // (0 vs 5, both a valid subset of output 30) MUST produce identical output
      // and grand totals. This is the token-conservation proof: surfacing the
      // subdivision changes metadata only, never the canonical token math.
      const withReasoning = await parseCodexRollout(
        baseLines(tokenCountLine(5)),
        { sessionId: "conservation-with" }
      );
      const withoutReasoning = await parseCodexRollout(
        baseLines(tokenCountLine(0)),
        { sessionId: "conservation-without" }
      );

      const tokensWith = withReasoning?.tokensByModel["gpt-5-codex"];
      const tokensWithout = withoutReasoning?.tokensByModel["gpt-5-codex"];

      // Output total is identical (reasoning 5 is NOT added to output 30).
      expect(tokensWith?.output).toBe(30);
      expect(tokensWithout?.output).toBe(30);
      // Every canonical counter is byte-identical between the two runs.
      expect(tokensWith).toEqual(tokensWithout);

      // Grand total (input + output + cacheRead + cacheWrite) is unchanged too.
      const grand = (t?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
      }) => (t ? t.input + t.output + t.cacheRead + t.cacheWrite : Number.NaN);
      expect(grand(tokensWith)).toBe(grand(tokensWithout));

      // Only the metadata subdivision differs.
      expect(withReasoning?.usageExtras.reasoning_output_tokens).toBe(5);
      expect(withoutReasoning?.usageExtras.reasoning_output_tokens).toBe(0);
    });

    it("does not fold replayed-parent reasoning into a forked child's max (no double-count)", async () => {
      // Regression: the reasoning max must be tracked AFTER the fork-replay skip,
      // mirroring the token-total delta dedup. A forked child replays the parent
      // prefix; those replayed snapshots are excluded from the child's token
      // totals and must likewise be excluded from its reasoning max — otherwise
      // `root.reasoning + child.reasoning` double-counts the parent's portion.
      //
      // Here the replayed parent snapshot carries the LARGER reasoning (20) and
      // the child's OWN snapshot the smaller (8). With the bug, the child's max
      // absorbs the replayed 20; correctly, it reflects only its own 8.
      const parentLines = [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-07-09T12:00:00.000Z",
          payload: { cwd: "/workspace/proj", cli_version: "1.2.3" },
        }),
        JSON.stringify({
          type: "turn_context",
          timestamp: "2026-07-09T12:00:00.500Z",
          payload: { model: "gpt-5-codex" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-07-09T12:00:02.000Z",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 200,
                cached_input_tokens: 40,
                output_tokens: 60,
                reasoning_output_tokens: 20,
              },
            },
          },
        }),
      ];
      const identities = await collectCodexUsageIdentities(parentLines);

      const childLines = [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-07-09T12:05:00.000Z",
          payload: { cwd: "/workspace/proj", cli_version: "1.2.3" },
        }),
        JSON.stringify({
          type: "turn_context",
          timestamp: "2026-07-09T12:05:00.500Z",
          payload: { model: "gpt-5-codex" },
        }),
        // Replayed parent snapshot (identity matches) — skipped for totals AND
        // for the reasoning max.
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-07-09T12:05:02.000Z",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 200,
                cached_input_tokens: 40,
                output_tokens: 60,
                reasoning_output_tokens: 20,
              },
            },
          },
        }),
        // Child's own new snapshot — smaller reasoning subdivision (8 of out 66).
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-07-09T12:05:03.000Z",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 210,
                cached_input_tokens: 40,
                output_tokens: 66,
                reasoning_output_tokens: 8,
              },
            },
          },
        }),
      ];

      const child = await parseCodexRollout(childLines, {
        sessionId: "codex-child-reasoning",
        replayedUsageIdentities: identities,
      });

      expect(child).not.toBeNull();
      // The replayed parent's reasoning (20) is excluded; only the child's own
      // snapshot (8) sets the max. Pre-fix this asserted 20 (double-count).
      expect(child?.usageExtras.reasoning_output_tokens).toBe(8);
    });
  });

  it("normalizes tool_search_call shapes without associating catalog output (FEA-3153)", async () => {
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-06-08T18:50:00.000Z"),
        JSON.stringify({
          timestamp: "2026-06-08T18:50:58.839Z",
          type: "response_item",
          payload: {
            type: "tool_search_call",
            call_id: "wrapped-call",
            arguments: {
              query: "spawn subagent worker task parallel review",
              limit: 8,
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-06-08T18:50:58.889Z",
          type: "response_item",
          payload: {
            type: "tool_search_output",
            call_id: "wrapped-call",
            tools: [{ type: "namespace", name: "multi_agent_v1" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-06-08T18:51:00.000Z",
          type: "tool_search_call",
          call_id: "bare-call",
          arguments: JSON.stringify({ query: "bare record", limit: 4 }),
        }),
        JSON.stringify({
          timestamp: "2026-06-08T18:51:01.000Z",
          type: "future_response_item",
          payload: {
            type: "tool_search_call",
            call_id: "unknown-wrapper-call",
            arguments: { query: "unknown wrapper", limit: 2 },
          },
        }),
      ],
      { sessionId: "tool-search-shapes" }
    );

    expect(session?.toolUses).toEqual([
      {
        name: "tool_search",
        timestamp: "2026-06-08T18:50:58.839Z",
        input: {
          query: "spawn subagent worker task parallel review",
          limit: 8,
        },
      },
      {
        name: "tool_search",
        timestamp: "2026-06-08T18:51:00.000Z",
        input: { query: "bare record", limit: 4 },
      },
      {
        name: "tool_search",
        timestamp: "2026-06-08T18:51:01.000Z",
        input: { query: "unknown wrapper", limit: 2 },
      },
    ]);
  });
});

// FEA-3524: capture the in-band `rate_limits` block Codex stamps on
// `token_count` events. Real golden shape (session 019ea892 line 20):
//   "rate_limits":{"limit_id":"codex","limit_name":null,
//     "primary":{"used_percent":3.0,"window_minutes":300,"resets_at":1780960632},
//     "secondary":{"used_percent":0.0,"window_minutes":10080,"resets_at":1781547432}}
// Most events instead carry "rate_limits":null. Capture must be permissive:
// last well-formed snapshot wins; null/absent/malformed never throws and never
// clobbers the last good snapshot; a session that never sees a well-formed block
// omits the field entirely so pre-existing normalized payloads round-trip.

/**
 * Sentinel meaning "emit no `rate_limits` key at all" (distinct from an explicit
 * `null`, which the parser must also handle).
 */
const NO_RATE_LIMITS = Symbol("no-rate-limits");

/** A `token_count` event line with an optional in-band `rate_limits` block. */
function tokenCountLine(
  timestamp: string,
  rateLimits: unknown = NO_RATE_LIMITS
): string {
  const info: Record<string, unknown> = {
    total_token_usage: {
      input_tokens: 100,
      cached_input_tokens: 20,
      output_tokens: 30,
      reasoning_output_tokens: 5,
    },
  };
  if (rateLimits !== NO_RATE_LIMITS) {
    info.rate_limits = rateLimits;
  }
  return JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: { type: "token_count", model: "gpt-5-codex", info },
  });
}

const GOLDEN_RATE_LIMITS = {
  limit_id: "codex",
  limit_name: null,
  primary: { used_percent: 3.0, window_minutes: 300, resets_at: 1_780_960_632 },
  secondary: {
    used_percent: 0.0,
    window_minutes: 10_080,
    resets_at: 1_781_547_432,
  },
  credits: null,
  plan_type: "prolite",
  rate_limit_reached_type: null,
};

describe("parseCodexRollout rate_limits capture (FEA-3524)", () => {
  it("captures a populated rate_limits block, dropping un-modeled extras", async () => {
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-06-08T13:50:00.000Z"),
        tokenCountLine("2026-06-08T13:50:03.000Z", GOLDEN_RATE_LIMITS),
      ],
      { sessionId: "codex-rl" }
    );
    // limit_id/plan_type/credits/… are NOT retained — only the window telemetry.
    expect(session?.codexRateLimits).toEqual({
      primary: {
        used_percent: 3.0,
        window_minutes: 300,
        resets_at: 1_780_960_632,
      },
      secondary: {
        used_percent: 0.0,
        window_minutes: 10_080,
        resets_at: 1_781_547_432,
      },
    });
  });

  it("omits the field when rate_limits is null on every event", async () => {
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-06-08T13:50:00.000Z"),
        tokenCountLine("2026-06-08T13:50:03.000Z", null),
      ],
      { sessionId: "codex-rl-null" }
    );
    expect(session).not.toBeNull();
    expect(session?.codexRateLimits).toBeUndefined();
    expect("codexRateLimits" in (session ?? {})).toBe(false);
  });

  it("omits the field when rate_limits is absent from the event", async () => {
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-06-08T13:50:00.000Z"),
        tokenCountLine("2026-06-08T13:50:03.000Z"),
      ],
      { sessionId: "codex-rl-absent" }
    );
    expect(session).not.toBeNull();
    expect(session?.codexRateLimits).toBeUndefined();
  });

  it("keeps the LATEST well-formed snapshot across events", async () => {
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-06-08T13:50:00.000Z"),
        tokenCountLine("2026-06-08T13:50:03.000Z", {
          primary: {
            used_percent: 3.0,
            window_minutes: 300,
            resets_at: 1_780_960_632,
          },
          secondary: null,
        }),
        tokenCountLine("2026-06-08T13:51:03.000Z", {
          primary: {
            used_percent: 42.5,
            window_minutes: 300,
            resets_at: 1_780_960_999,
          },
          secondary: {
            used_percent: 7.0,
            window_minutes: 10_080,
            resets_at: 1_781_547_999,
          },
        }),
      ],
      { sessionId: "codex-rl-latest" }
    );
    expect(session?.codexRateLimits?.primary?.used_percent).toBe(42.5);
    expect(session?.codexRateLimits?.secondary?.used_percent).toBe(7.0);
  });

  it("keeps the last good snapshot when a later event is null/malformed", async () => {
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-06-08T13:50:00.000Z"),
        tokenCountLine("2026-06-08T13:50:03.000Z", GOLDEN_RATE_LIMITS),
        // Later null block must NOT clobber the captured snapshot.
        tokenCountLine("2026-06-08T13:51:03.000Z", null),
        // Neither may a block with no primary/secondary windows.
        tokenCountLine("2026-06-08T13:52:03.000Z", { limit_id: "codex" }),
      ],
      { sessionId: "codex-rl-lastgood" }
    );
    expect(session?.codexRateLimits?.primary?.used_percent).toBe(3.0);
    expect(session?.codexRateLimits?.secondary?.used_percent).toBe(0.0);
  });

  it("degrades malformed window fields to null without throwing", async () => {
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-06-08T13:50:00.000Z"),
        tokenCountLine("2026-06-08T13:50:03.000Z", {
          primary: {
            used_percent: "lots", // wrong type → null
            window_minutes: 300,
            resets_at: Number.NaN, // non-finite → null
          },
          secondary: "nope", // non-object window → null
        }),
      ],
      { sessionId: "codex-rl-malformed" }
    );
    // The block had a (degraded) primary window, so it is still captured.
    expect(session?.codexRateLimits).toEqual({
      primary: {
        used_percent: null,
        window_minutes: 300,
        resets_at: null,
      },
      secondary: null,
    });
  });

  it("omits the field when the block has neither primary nor secondary", async () => {
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-06-08T13:50:00.000Z"),
        tokenCountLine("2026-06-08T13:50:03.000Z", {
          limit_id: "codex",
          plan_type: "prolite",
        }),
      ],
      { sessionId: "codex-rl-empty-block" }
    );
    expect(session?.codexRateLimits).toBeUndefined();
  });
});

// FEA-3702: a malformed rate-limit WINDOW must preserve the last-good snapshot
// (never zero/blank it) and only skip the bad window, and each malformed
// rate_limits record must be counted in parse quality without failing the
// session. These regressions pin the AC's specific data-loss scenario
// ({primary:{garbage:true}} over a valid snapshot) plus partial-update,
// reset-boundary, reordering, unknown-field, and version-skew semantics.
describe("parseCodexRollout rate_limits last-good preservation (FEA-3702)", () => {
  it("preserves last-good when a later window is an all-null (garbage) object", async () => {
    // The AC's exact evidence: a valid snapshot followed by {primary:{garbage:true}}
    // must NOT produce an all-null primary window — last-good is retained.
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-06-08T13:50:00.000Z"),
        tokenCountLine("2026-06-08T13:50:03.000Z", GOLDEN_RATE_LIMITS),
        // A window object carrying no usable telemetry fields at all.
        tokenCountLine("2026-06-08T13:51:03.000Z", {
          primary: { garbage: true },
        }),
      ],
      { sessionId: "codex-rl-garbage-window" }
    );
    // Last-good is intact — NOT zeroed/nulled by the malformed window.
    expect(session?.codexRateLimits).toEqual({
      primary: {
        used_percent: 3.0,
        window_minutes: 300,
        resets_at: 1_780_960_632,
      },
      secondary: {
        used_percent: 0.0,
        window_minutes: 10_080,
        resets_at: 1_781_547_432,
      },
    });
    // The malformed record is surfaced in parse quality (not silently dropped).
    expect(session?.parseQuality?.malformedRateLimits).toBe(1);
  });

  it("resumes on the next good window after a malformed one", async () => {
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-06-08T13:50:00.000Z"),
        tokenCountLine("2026-06-08T13:50:03.000Z", GOLDEN_RATE_LIMITS),
        // Malformed window in the middle — preserve last-good, skip it.
        tokenCountLine("2026-06-08T13:51:03.000Z", {
          primary: { garbage: true },
          secondary: 12_345, // non-object → also invalid
        }),
        // A subsequent good window resumes the series.
        tokenCountLine("2026-06-08T13:52:03.000Z", {
          primary: {
            used_percent: 55.5,
            window_minutes: 300,
            resets_at: 1_780_999_999,
          },
          secondary: {
            used_percent: 9.0,
            window_minutes: 10_080,
            resets_at: 1_781_599_999,
          },
        }),
      ],
      { sessionId: "codex-rl-resume" }
    );
    expect(session?.codexRateLimits?.primary?.used_percent).toBe(55.5);
    expect(session?.codexRateLimits?.secondary?.used_percent).toBe(9.0);
    expect(session?.parseQuality?.malformedRateLimits).toBe(1);
  });

  it("applies a partial update atomically, preserving the untouched sibling", async () => {
    // A later event updates only `primary`; `secondary` is absent this event.
    // The prior valid `secondary` must survive rather than be blanked.
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-06-08T13:50:00.000Z"),
        tokenCountLine("2026-06-08T13:50:03.000Z", GOLDEN_RATE_LIMITS),
        tokenCountLine("2026-06-08T13:51:03.000Z", {
          primary: {
            used_percent: 80.0,
            window_minutes: 300,
            resets_at: 1_780_970_000,
          },
          // secondary omitted from this partial event.
        }),
      ],
      { sessionId: "codex-rl-partial" }
    );
    expect(session?.codexRateLimits?.primary?.used_percent).toBe(80.0);
    // Prior secondary is preserved (the sibling was NOT zeroed).
    expect(session?.codexRateLimits?.secondary?.used_percent).toBe(0.0);
    expect(session?.codexRateLimits?.secondary?.window_minutes).toBe(10_080);
    // No malformed record: an absent sibling within a block that has a valid
    // window is a legitimate partial update.
    expect(session?.parseQuality?.malformedRateLimits).toBeUndefined();
  });

  it("preserves last-good across a reset-boundary window with only resets_at", async () => {
    // At a reset boundary Codex may report the new resets_at before usage
    // repopulates. A window with just a valid resets_at is a legitimate partial
    // update — kept — merged over the prior sibling.
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-06-08T13:50:00.000Z"),
        tokenCountLine("2026-06-08T13:50:03.000Z", GOLDEN_RATE_LIMITS),
        tokenCountLine("2026-06-08T13:51:03.000Z", {
          primary: { resets_at: 1_780_990_000 },
        }),
      ],
      { sessionId: "codex-rl-reset" }
    );
    expect(session?.codexRateLimits?.primary?.resets_at).toBe(1_780_990_000);
    // used_percent absent this event → null for that field; sibling untouched.
    expect(session?.codexRateLimits?.secondary?.used_percent).toBe(0.0);
    expect(session?.parseQuality?.malformedRateLimits).toBeUndefined();
  });

  it("keeps last-good across a reordered/interleaved malformed record", async () => {
    // good → malformed → good(same) → malformed: last-good never regresses.
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-06-08T13:50:00.000Z"),
        tokenCountLine("2026-06-08T13:50:03.000Z", GOLDEN_RATE_LIMITS),
        tokenCountLine("2026-06-08T13:51:03.000Z", { primary: {} }), // all-null
        tokenCountLine("2026-06-08T13:52:03.000Z", GOLDEN_RATE_LIMITS),
        tokenCountLine("2026-06-08T13:53:03.000Z", "not-an-object"), // malformed block
      ],
      { sessionId: "codex-rl-reordered" }
    );
    expect(session?.codexRateLimits?.primary?.used_percent).toBe(3.0);
    expect(session?.codexRateLimits?.secondary?.used_percent).toBe(0.0);
    // Two present-but-malformed records counted; the good ones are not.
    expect(session?.parseQuality?.malformedRateLimits).toBe(2);
  });

  it("tolerates unknown/version-skewed extra fields on a valid window", async () => {
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-06-08T13:50:00.000Z"),
        tokenCountLine("2026-06-08T13:50:03.000Z", {
          limit_id: "codex",
          some_future_field: { nested: true }, // unknown block-level extra
          primary: {
            used_percent: 12.0,
            window_minutes: 300,
            resets_at: 1_780_960_632,
            future_slot: "ignored", // unknown window-level extra
          },
        }),
      ],
      { sessionId: "codex-rl-version-skew" }
    );
    expect(session?.codexRateLimits?.primary?.used_percent).toBe(12.0);
    // Un-modeled extras are dropped; the window is still valid.
    expect(session?.codexRateLimits?.primary).toEqual({
      used_percent: 12.0,
      window_minutes: 300,
      resets_at: 1_780_960_632,
    });
    expect(session?.parseQuality?.malformedRateLimits).toBeUndefined();
  });

  it("counts a non-object rate_limits block as one malformed record", async () => {
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-06-08T13:50:00.000Z"),
        tokenCountLine("2026-06-08T13:50:03.000Z", GOLDEN_RATE_LIMITS),
        tokenCountLine("2026-06-08T13:51:03.000Z", "garbage"),
      ],
      { sessionId: "codex-rl-nonobject-block" }
    );
    expect(session?.codexRateLimits?.primary?.used_percent).toBe(3.0);
    expect(session?.parseQuality?.malformedRateLimits).toBe(1);
  });

  it("does not count absent/null blocks as malformed", async () => {
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-06-08T13:50:00.000Z"),
        tokenCountLine("2026-06-08T13:50:03.000Z", GOLDEN_RATE_LIMITS),
        tokenCountLine("2026-06-08T13:51:03.000Z", null),
        tokenCountLine("2026-06-08T13:52:03.000Z"), // absent
      ],
      { sessionId: "codex-rl-absent-not-malformed" }
    );
    expect(session?.codexRateLimits?.primary?.used_percent).toBe(3.0);
    expect(session?.parseQuality?.malformedRateLimits).toBeUndefined();
  });

  it("does not count a present block with explicitly-null windows as malformed", async () => {
    // The real Codex "no active window" shape (limit_id `premium`, both windows
    // explicitly null) is a legitimate no-op, NOT corruption. It must keep
    // last-good silently and emit no parse-quality signal — matching the frozen
    // golden oracle for session 019e8ee8 (codexRateLimits:null, no
    // malformedRateLimits). Only a slot present with a non-null-but-invalid
    // value (e.g. `{primary:{}}`) is malformed.
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-06-08T13:50:00.000Z"),
        tokenCountLine("2026-06-08T13:50:03.000Z", {
          limit_id: "premium",
          limit_name: null,
          primary: null,
          secondary: null,
          credits: { has_credits: false, unlimited: false, balance: null },
          plan_type: null,
          rate_limit_reached_type: null,
        }),
      ],
      { sessionId: "codex-rl-null-windows-not-malformed" }
    );
    // No valid window was ever seen → the field is omitted entirely.
    expect(session?.codexRateLimits).toBeUndefined();
    expect(session?.parseQuality?.malformedRateLimits).toBeUndefined();
  });

  it("still counts a block whose only present window slot is invalid", async () => {
    // Guards the boundary of the fix above: an explicitly-null `secondary`
    // alongside a PRESENT-but-invalid `primary` object is still one malformed
    // record (the present slot failed validation).
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-06-08T13:50:00.000Z"),
        tokenCountLine("2026-06-08T13:50:03.000Z", GOLDEN_RATE_LIMITS),
        tokenCountLine("2026-06-08T13:51:03.000Z", {
          primary: {}, // present, non-null, no usable telemetry → invalid
          secondary: null, // legitimately absent this event
        }),
      ],
      { sessionId: "codex-rl-mixed-null-and-invalid" }
    );
    expect(session?.codexRateLimits?.primary?.used_percent).toBe(3.0);
    expect(session?.parseQuality?.malformedRateLimits).toBe(1);
  });
});

// FEA-3525: `info.model_context_window` capture. The value rides the same
// `info` object the parser already reads for token totals; capture is
// permissive (non-negative integers only, never throws) and additive (omitted
// when unreported so pre-FEA-3525 payloads round-trip unchanged).
describe("parseCodexRollout model_context_window (FEA-3525)", () => {
  function tokenCountLine(
    timestamp: string,
    info: Record<string, unknown>
  ): string {
    return JSON.stringify({
      type: "event_msg",
      timestamp,
      payload: { type: "token_count", info },
    });
  }

  const baseTotals = {
    total_token_usage: {
      input_tokens: 100,
      cached_input_tokens: 20,
      output_tokens: 30,
      reasoning_output_tokens: 5,
    },
  };

  it("captures model_context_window when present", async () => {
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-07-09T12:00:00.000Z"),
        tokenCountLine("2026-07-09T12:00:03.000Z", {
          ...baseTotals,
          model_context_window: 258_400,
        }),
      ],
      { sessionId: "ctx-window-present" }
    );
    expect(session?.modelContextWindow).toBe(258_400);
  });

  it("omits the field entirely when model_context_window is absent", async () => {
    const session = await parseCodexRollout(LINES, {
      sessionId: "ctx-window-absent",
    });
    expect(session?.modelContextWindow).toBeUndefined();
    expect("modelContextWindow" in (session ?? {})).toBe(false);
  });

  it("ignores malformed model_context_window values without throwing", async () => {
    // Negative, fractional, string, and non-finite are all rejected; the rest
    // of the rollout still parses (token totals intact).
    for (const bad of [-1, 12.5, "258400", Number.NaN, null] as const) {
      const session = await parseCodexRollout(
        [
          sessionMetaLine("2026-07-09T12:00:00.000Z"),
          tokenCountLine("2026-07-09T12:00:03.000Z", {
            ...baseTotals,
            model_context_window: bad,
          }),
        ],
        { sessionId: `ctx-window-bad-${String(bad)}` }
      );
      expect(session?.modelContextWindow).toBeUndefined();
      // Token math is unaffected by the bad enrichment value.
      expect(session?.tokensByModel["gpt-5-codex"]).toMatchObject({
        input: 80,
      });
    }
  });

  it("keeps the latest valid model_context_window across events", async () => {
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-07-09T12:00:00.000Z"),
        tokenCountLine("2026-07-09T12:00:03.000Z", {
          ...baseTotals,
          model_context_window: 200_000,
        }),
        // A later event with a malformed window must NOT clobber the last good
        // value; a later valid one wins.
        tokenCountLine("2026-07-09T12:00:04.000Z", {
          ...baseTotals,
          model_context_window: -5,
        }),
        tokenCountLine("2026-07-09T12:00:05.000Z", {
          ...baseTotals,
          model_context_window: 258_400,
        }),
      ],
      { sessionId: "ctx-window-latest" }
    );
    expect(session?.modelContextWindow).toBe(258_400);
  });

  it("captures the window even when the event carries no usable totals", async () => {
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-07-09T12:00:00.000Z"),
        tokenCountLine("2026-07-09T12:00:03.000Z", {
          model_context_window: 258_400,
        }),
      ],
      { sessionId: "ctx-window-no-totals" }
    );
    expect(session?.modelContextWindow).toBe(258_400);
  });

  function taskStartedLine(
    timestamp: string,
    payload: Record<string, unknown>
  ): string {
    return JSON.stringify({
      type: "event_msg",
      timestamp,
      payload: { type: "task_started", ...payload },
    });
  }

  // SDK rollouts (codex_sdk_ts) can report the window on `event_msg`/
  // `task_started` and emit ZERO `token_count` records (zero-usage / aborted
  // runs). The window rides the payload directly, not under `info`.
  it("captures model_context_window from task_started with no token_count events", async () => {
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-07-09T12:00:00.000Z"),
        taskStartedLine("2026-07-09T12:00:01.000Z", {
          model_context_window: 258_400,
        }),
      ],
      { sessionId: "ctx-window-task-started" }
    );
    expect(session?.modelContextWindow).toBe(258_400);
  });

  it("ignores malformed task_started model_context_window without throwing", async () => {
    const session = await parseCodexRollout(
      [
        sessionMetaLine("2026-07-09T12:00:00.000Z"),
        taskStartedLine("2026-07-09T12:00:01.000Z", {
          model_context_window: -5,
        }),
      ],
      { sessionId: "ctx-window-task-started-bad" }
    );
    expect(session?.modelContextWindow).toBeUndefined();
    expect("modelContextWindow" in (session ?? {})).toBe(false);
  });
});

function sessionMetaLine(timestamp: string): string {
  return JSON.stringify({
    type: "session_meta",
    timestamp,
    payload: { cwd: "/workspace/proj" },
  });
}

/** The top-level `compacted` record shape observed in real rollouts. */
function compactedLine(timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: "compacted",
    payload: {
      message: "",
      replacement_history: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "summarized history" }],
        },
      ],
    },
  });
}

/** The `event_msg`/`context_compacted` echo emitted alongside `compacted`. */
function contextCompactedLine(timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: { type: "context_compacted" },
  });
}

describe("FEA-3708 codexForkedFromId lineage", () => {
  // A minimal but valid rollout (session_meta + one user message → non-null
  // session), with an overridable session_meta payload so each case controls
  // only the lineage field.
  const rolloutLines = (
    sessionMetaPayload: Record<string, unknown>
  ): string[] => [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-07-09T12:00:00.000Z",
      payload: {
        cwd: "/home/me/proj",
        cli_version: "1.2.3",
        ...sessionMetaPayload,
      },
    }),
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-09T12:00:00.500Z",
      payload: { model: "gpt-5-codex" },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-07-09T12:00:01.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    }),
  ];

  it("omits codexForkedFromId for a root rollout (no fork lineage)", async () => {
    const session = await parseCodexRollout(rolloutLines({}), {
      sessionId: "fork-root",
    });
    expect(session).not.toBeNull();
    expect(session?.codexForkedFromId).toBeUndefined();
    expect(session).not.toHaveProperty("codexForkedFromId");
  });

  it("captures session_meta.forked_from_id as the parent-rollout lineage pointer", async () => {
    const parentRolloutId = "019ea892-0957-71e2-8052-1f4e717dd2cc";
    const session = await parseCodexRollout(
      rolloutLines({ forked_from_id: parentRolloutId }),
      { sessionId: "fork-child" }
    );
    expect(session?.codexForkedFromId).toBe(parentRolloutId);
  });

  it("keeps the first forked_from_id when several session_meta records appear", async () => {
    // First-non-null-wins, mirroring the other session_meta fields (originator,
    // cwd, version). A later session_meta must not overwrite the lineage.
    const lines = [
      ...rolloutLines({ forked_from_id: "parent-a" }),
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-07-09T12:00:02.000Z",
        payload: { forked_from_id: "parent-b" },
      }),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "fork-first" });
    expect(session?.codexForkedFromId).toBe("parent-a");
  });

  it("does not treat a subagent-spawn link as a fork (forked_from_id == parent_thread_id)", async () => {
    // A spawned Codex subagent's session_meta carries forked_from_id equal to its
    // parent_thread_id — the spawn link, not a fork. Mirror the collector's rule
    // (buildCodexChildMeta records codexForkedFromId only when there is no parent
    // thread) so a subagent's parsed session does not mislabel its parent as a fork.
    const parentThread = "019ea892-0957-71e2-8052-1f4e717dd2cc";
    const session = await parseCodexRollout(
      rolloutLines({
        forked_from_id: parentThread,
        source: {
          subagent: { thread_spawn: { parent_thread_id: parentThread } },
        },
      }),
      { sessionId: "fork-subagent" }
    );
    expect(session?.codexForkedFromId).toBeUndefined();
  });

  it("treats an empty forked_from_id as absent", async () => {
    const session = await parseCodexRollout(
      rolloutLines({ forked_from_id: "" }),
      { sessionId: "fork-empty" }
    );
    expect(session?.codexForkedFromId).toBeUndefined();
  });

  it("preserves a stable codexForkedFromId across a deterministic reparse", async () => {
    // Stable identity across reparse: parsing the same bytes twice yields the
    // same lineage pointer (no ordering / accumulator-state leakage).
    const lines = rolloutLines({ forked_from_id: "parent-stable" });
    const first = await parseCodexRollout(lines, { sessionId: "fork-reparse" });
    const second = await parseCodexRollout(lines, {
      sessionId: "fork-reparse",
    });
    expect(first?.codexForkedFromId).toBe("parent-stable");
    expect(second?.codexForkedFromId).toBe(first?.codexForkedFromId);
  });
});

describe("parseQuality.unknownRecords (FEA-3713)", () => {
  // A syntactically valid JSON record with no recognizable envelope type and no
  // session-ish fields — the classifier routes it to `kind:"other"`, which
  // `dispatchLine` previously dropped silently.
  const unknownLine = (timestamp: string): string =>
    JSON.stringify({ timestamp, heartbeat: true });

  const baseLines = [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-07-09T12:00:00.000Z",
      payload: { cwd: "/home/me/proj", cli_version: "1.2.3" },
    }),
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-09T12:00:00.500Z",
      payload: { model: "gpt-5-codex" },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-07-09T12:00:01.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hi" }],
      },
    }),
  ];

  it("omits unknownRecords for a rollout the parser fully recognizes", async () => {
    const session = await parseCodexRollout(baseLines, {
      sessionId: "uk-clean",
    });
    // Clean rollouts must round-trip byte-identically — the field is absent, not
    // a literal 0, so existing metadata blobs and golden snapshots do not churn.
    expect(session?.parseQuality?.unknownRecords).toBeUndefined();
    expect(session?.parseQuality).not.toHaveProperty("unknownRecords");
  });

  it("counts a valid-but-unroutable record instead of dropping it silently", async () => {
    const session = await parseCodexRollout(
      [...baseLines, unknownLine("2026-07-09T12:00:02.000Z")],
      { sessionId: "uk-one" }
    );
    // The record parsed cleanly (not malformed) but has no known envelope type.
    expect(session?.parseQuality?.malformedLines).toBe(0);
    expect(session?.parseQuality?.unknownRecords).toBe(1);
  });

  it("cannot report a cleaner session as more unknown evidence is appended", async () => {
    // AC: quality cannot improve when additional unknown/unresolved evidence is
    // appended. Each appended unknown record only ever raises the count.
    const counts: number[] = [];
    for (let extra = 0; extra <= 3; extra++) {
      const lines = [...baseLines];
      for (let i = 0; i < extra; i++) {
        lines.push(unknownLine(`2026-07-09T12:00:1${i}.000Z`));
      }
      const session = await parseCodexRollout(lines, {
        sessionId: `uk-mono-${extra}`,
      });
      counts.push(session?.parseQuality?.unknownRecords ?? 0);
    }
    expect(counts).toEqual([0, 1, 2, 3]);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    }
  });
});

// ── FEA-3701: MCP call/output correlation by call_id ────────────────────────
// These fixtures model the EVENT-only (legacy) Codex shape where MCP tools are
// synthesized from `mcp_tool_call_begin` and completed by `mcp_tool_call_end`
// (no response_item items), which is exactly the path that used positional
// backward-scan matching. `sawResponseItems` must stay false, so the fixtures
// carry NO response_item lines and use `event_msg` for user/assistant turns.

/** A Codex `mcp_tool_call_begin` event carrying an explicit `call_id`. */
function mcpBeginLine(
  timestamp: string,
  callId: string,
  server: string,
  tool: string,
  args: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "mcp_tool_call_begin",
      call_id: callId,
      invocation: { server, tool, arguments: args },
    },
  });
}

/**
 * A Codex `mcp_tool_call_end` event carrying its originating `call_id`. Mirrors
 * the real golden shape: the payload's `result` object is the sole output source
 * (there is no top-level `output` string), so the correlated tool's `output`
 * captures the serialized result and `isError` reflects an error result.
 */
function mcpEndLine(
  timestamp: string,
  callId: string,
  outputText: string,
  isError = false
): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "mcp_tool_call_end",
      call_id: callId,
      result: isError
        ? { is_error: true, error: outputText }
        : { Ok: { content: [{ type: "text", text: outputText }] } },
    },
  });
}

/** An `mcp_tool_call_begin`/`_end` with NO identifier (legacy pre-call_id data). */
function mcpBeginLineNoId(
  timestamp: string,
  server: string,
  tool: string
): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "mcp_tool_call_begin",
      invocation: { server, tool, arguments: {} },
    },
  });
}

function mcpEndLineNoId(timestamp: string, outputText: string): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: { type: "mcp_tool_call_end", output: outputText },
  });
}

/** The tool use for an MCP call named `<server>__<tool>` (event-fallback path). */
function mcpTool(
  session: Awaited<ReturnType<typeof parseCodexRollout>>,
  name: string
) {
  return session?.toolUses.find((t) => t.name === name);
}

describe("parseCodexRollout MCP call-id correlation (FEA-3701)", () => {
  it("correlates interleaved MCP outputs to the right call by id — A-begin, B-begin, A-end, B-end", async () => {
    // The reproduction from the FEAT: two MCP calls in flight; A completes
    // first. Positional backward-scan matching assigned A's output to B (the
    // last open MCP tool) and vice-versa. Call-id correlation must attach each
    // output to its ORIGINATING call.
    const lines = [
      sessionMetaLine("2026-07-09T12:00:00.000Z"),
      mcpBeginLine("2026-07-09T12:00:01.000Z", "call_A", "srv", "alpha"),
      mcpBeginLine("2026-07-09T12:00:02.000Z", "call_B", "srv", "beta"),
      mcpEndLine("2026-07-09T12:00:03.000Z", "call_A", "OUTPUT_A"),
      mcpEndLine("2026-07-09T12:00:04.000Z", "call_B", "OUTPUT_B"),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "s" });

    const toolA = mcpTool(session, "srv__alpha");
    const toolB = mcpTool(session, "srv__beta");
    // Output is the serialized `result` object; assert the correct text landed
    // on the correct call (the whole point — no A↔B cross-assignment).
    expect(toolA?.output).toContain("OUTPUT_A");
    expect(toolA?.output).not.toContain("OUTPUT_B");
    expect(toolB?.output).toContain("OUTPUT_B");
    expect(toolB?.output).not.toContain("OUTPUT_A");
    // No orphans / ambiguity: every output correlated by explicit call_id.
    expect(session?.parseQuality?.orphanedToolOutputs).toBeUndefined();
    expect(session?.parseQuality?.ambiguousToolOutputs).toBeUndefined();
  });

  it("correlates interleaved MCP outputs in the OTHER completion order — B-end, A-end", async () => {
    const lines = [
      sessionMetaLine("2026-07-09T12:00:00.000Z"),
      mcpBeginLine("2026-07-09T12:00:01.000Z", "call_A", "srv", "alpha"),
      mcpBeginLine("2026-07-09T12:00:02.000Z", "call_B", "srv", "beta"),
      mcpEndLine("2026-07-09T12:00:03.000Z", "call_B", "OUTPUT_B"),
      mcpEndLine("2026-07-09T12:00:04.000Z", "call_A", "OUTPUT_A"),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "s" });

    expect(mcpTool(session, "srv__alpha")?.output).toContain("OUTPUT_A");
    expect(mcpTool(session, "srv__beta")?.output).toContain("OUTPUT_B");
  });

  it("correlates three interleaved MCP calls, all completing out of call order", async () => {
    const lines = [
      sessionMetaLine("2026-07-09T12:00:00.000Z"),
      mcpBeginLine("2026-07-09T12:00:01.000Z", "call_1", "srv", "one"),
      mcpBeginLine("2026-07-09T12:00:02.000Z", "call_2", "srv", "two"),
      mcpBeginLine("2026-07-09T12:00:03.000Z", "call_3", "srv", "three"),
      mcpEndLine("2026-07-09T12:00:04.000Z", "call_2", "OUT_2"),
      mcpEndLine("2026-07-09T12:00:05.000Z", "call_3", "OUT_3"),
      mcpEndLine("2026-07-09T12:00:06.000Z", "call_1", "OUT_1"),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "s" });

    expect(mcpTool(session, "srv__one")?.output).toContain("OUT_1");
    expect(mcpTool(session, "srv__two")?.output).toContain("OUT_2");
    expect(mcpTool(session, "srv__three")?.output).toContain("OUT_3");
  });

  it("propagates the error flag to the correct interleaved call", async () => {
    const lines = [
      sessionMetaLine("2026-07-09T12:00:00.000Z"),
      mcpBeginLine("2026-07-09T12:00:01.000Z", "call_A", "srv", "alpha"),
      mcpBeginLine("2026-07-09T12:00:02.000Z", "call_B", "srv", "beta"),
      // A fails, B succeeds; the error must land on A, not the last-open B.
      mcpEndLine("2026-07-09T12:00:03.000Z", "call_A", "boom", true),
      mcpEndLine("2026-07-09T12:00:04.000Z", "call_B", "OK_B"),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "s" });

    expect(mcpTool(session, "srv__alpha")?.isError).toBe(true);
    expect(mcpTool(session, "srv__beta")?.isError).toBe(false);
  });

  it("drops an orphan MCP output (unknown call_id) instead of cross-assigning it", async () => {
    const lines = [
      sessionMetaLine("2026-07-09T12:00:00.000Z"),
      mcpBeginLine("2026-07-09T12:00:01.000Z", "call_A", "srv", "alpha"),
      // End for a call that never began — the old code slapped this on the last
      // open MCP tool (A); now it is an orphan and A keeps no output.
      mcpEndLine("2026-07-09T12:00:02.000Z", "call_GHOST", "STRAY"),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "s" });

    expect(mcpTool(session, "srv__alpha")?.output).toBeUndefined();
    expect(session?.parseQuality?.orphanedToolOutputs).toBe(1);
  });

  it("ignores a duplicate MCP end for an already-completed call id", async () => {
    const lines = [
      sessionMetaLine("2026-07-09T12:00:00.000Z"),
      mcpBeginLine("2026-07-09T12:00:01.000Z", "call_A", "srv", "alpha"),
      mcpEndLine("2026-07-09T12:00:02.000Z", "call_A", "FIRST"),
      // A replayed / duplicate completion must not overwrite or re-correlate.
      mcpEndLine("2026-07-09T12:00:03.000Z", "call_A", "SECOND"),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "s" });

    expect(mcpTool(session, "srv__alpha")?.output).toContain("FIRST");
    expect(mcpTool(session, "srv__alpha")?.output).not.toContain("SECOND");
    // A duplicate is neither an orphan nor an ambiguous positional match.
    expect(session?.parseQuality?.orphanedToolOutputs).toBeUndefined();
    expect(session?.parseQuality?.ambiguousToolOutputs).toBeUndefined();
  });

  it("falls back to positional matching for legacy identifier-free MCP data, flagging it ambiguous", async () => {
    const lines = [
      sessionMetaLine("2026-07-09T12:00:00.000Z"),
      mcpBeginLineNoId("2026-07-09T12:00:01.000Z", "srv", "alpha"),
      mcpEndLineNoId("2026-07-09T12:00:02.000Z", "LEGACY_OUT"),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "s" });

    // With no ids at all, the single open MCP call still gets its output via the
    // documented compatibility fallback — but the session flags the ambiguity.
    expect(mcpTool(session, "srv__alpha")?.output).toBe("LEGACY_OUT");
    expect(session?.parseQuality?.ambiguousToolOutputs).toBe(1);
  });

  it("does not cross-assign when only ONE of an interleaved pair carries an id", async () => {
    // A has an id, B does not. A's id-keyed output must reach A; B's id-less end
    // uses the positional fallback (last open MCP tool = B), flagged ambiguous.
    const lines = [
      sessionMetaLine("2026-07-09T12:00:00.000Z"),
      mcpBeginLine("2026-07-09T12:00:01.000Z", "call_A", "srv", "alpha"),
      mcpBeginLineNoId("2026-07-09T12:00:02.000Z", "srv", "beta"),
      mcpEndLine("2026-07-09T12:00:03.000Z", "call_A", "OUTPUT_A"),
      mcpEndLineNoId("2026-07-09T12:00:04.000Z", "OUTPUT_B"),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "s" });

    expect(mcpTool(session, "srv__alpha")?.output).toContain("OUTPUT_A");
    // The id-less end (top-level `output` string) uses the positional fallback.
    expect(mcpTool(session, "srv__beta")?.output).toBe("OUTPUT_B");
    expect(session?.parseQuality?.ambiguousToolOutputs).toBe(1);
  });

  it("leaves a missing-end MCP call with no output (partial session), no cross-assign", async () => {
    const lines = [
      sessionMetaLine("2026-07-09T12:00:00.000Z"),
      mcpBeginLine("2026-07-09T12:00:01.000Z", "call_A", "srv", "alpha"),
      mcpBeginLine("2026-07-09T12:00:02.000Z", "call_B", "srv", "beta"),
      // Only B completes — A is still in flight when the rollout is cut off.
      mcpEndLine("2026-07-09T12:00:03.000Z", "call_B", "OUTPUT_B"),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "s" });

    expect(mcpTool(session, "srv__alpha")?.output).toBeUndefined();
    expect(mcpTool(session, "srv__beta")?.output).toContain("OUTPUT_B");
  });

  it("correlates interleaved function_call/output response items by call_id (modern path)", async () => {
    // Modern Codex models MCP calls as function_call response items whose output
    // arrives as function_call_output — correlated by the SAME call_id. Interleave
    // them and confirm each output reaches its originating call.
    const fnCall = (ts: string, callId: string, name: string) =>
      JSON.stringify({
        timestamp: ts,
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: callId,
          name,
          arguments: "{}",
        },
      });
    const fnOutput = (ts: string, callId: string, output: string) =>
      JSON.stringify({
        timestamp: ts,
        type: "response_item",
        payload: { type: "function_call_output", call_id: callId, output },
      });
    const lines = [
      sessionMetaLine("2026-07-09T12:00:00.000Z"),
      fnCall("2026-07-09T12:00:01.000Z", "call_A", "alpha"),
      fnCall("2026-07-09T12:00:02.000Z", "call_B", "beta"),
      fnOutput("2026-07-09T12:00:03.000Z", "call_B", "OUTPUT_B"),
      fnOutput("2026-07-09T12:00:04.000Z", "call_A", "OUTPUT_A"),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "s" });

    const toolA = session?.toolUses.find((t) => t.name === "alpha");
    const toolB = session?.toolUses.find((t) => t.name === "beta");
    expect(toolA?.output).toBe("OUTPUT_A");
    expect(toolB?.output).toBe("OUTPUT_B");
    expect(session?.parseQuality?.orphanedToolOutputs).toBeUndefined();
  });

  it("drops an orphan function_call_output instead of last-wins cross-assign", async () => {
    const fnCall = (ts: string, callId: string, name: string) =>
      JSON.stringify({
        timestamp: ts,
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: callId,
          name,
          arguments: "{}",
        },
      });
    const fnOutput = (ts: string, callId: string, output: string) =>
      JSON.stringify({
        timestamp: ts,
        type: "response_item",
        payload: { type: "function_call_output", call_id: callId, output },
      });
    const lines = [
      sessionMetaLine("2026-07-09T12:00:00.000Z"),
      fnCall("2026-07-09T12:00:01.000Z", "call_A", "alpha"),
      // Output for a call that never happened — must NOT land on alpha.
      fnOutput("2026-07-09T12:00:02.000Z", "call_GHOST", "STRAY"),
    ];
    const session = await parseCodexRollout(lines, { sessionId: "s" });

    expect(
      session?.toolUses.find((t) => t.name === "alpha")?.output
    ).toBeUndefined();
    expect(session?.parseQuality?.orphanedToolOutputs).toBe(1);
  });
});
