/**
 * Edge cases for buildMergedTrace's collectSessionTraceItems inner function:
 * 1. !mapped is true (line 138 arm=0): a turn item whose type is not handled
 *    by mapTurnItemToTrace (e.g., "sessionstart") → continue, no stamped entry
 * 2. Number.isNaN(ms) is true (line 146 arm=0): a mapped (non-null, non-end)
 *    turn item whose `t` field is an invalid timestamp → skip that item
 */
import type { TurnActor, TurnItem } from "@repo/api/src/types/agent-session";
import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import { describe, expect, it } from "vitest";
import { buildMergedTrace, type MergedTraceSessionInput } from "./merged-trace";

/**
 * `MergedTraceItem`'s prompt arm is discriminated as `"prompt" | "say"`, so a
 * plain `Extract<…, { type: "prompt" }>` resolves to `never`. Narrow on the arm
 * as declared instead, via a predicate so `.text` reads without a cast.
 */
function isPromptItem(
  item: MergedTraceItem
): item is Extract<MergedTraceItem, { type: "prompt" | "say" }> {
  return item.type === "prompt";
}

const ISO_START = "2026-08-01T00:00:00.000Z";

function actor(): TurnActor {
  return { name: "Agent", sessionId: "s1", human: "Agent", color: "#000000" };
}

function session(turnItems: readonly TurnItem[]): MergedTraceSessionInput {
  return {
    sessionId: "s1",
    startedAt: ISO_START,
    actorName: "Agent",
    harness: "claude",
    turnItems,
  };
}

describe("buildMergedTrace — collectSessionTraceItems edge cases", () => {
  it("ignores a sessionstart turn item (!mapped is true → continue, no double-count)", () => {
    // A sessionstart TurnItem falls through mapTurnItemToTrace's switch default → null.
    // The collectSessionTraceItems `if (!mapped) continue` arm (arm=0) is exercised.
    const result = buildMergedTrace([
      session([
        {
          type: "sessionstart",
          t: ISO_START,
          actor: actor(),
        },
      ]),
    ]);
    // Only the synthesized sessionstart marker is present (no turn-item copy).
    const sessionStarts = result.filter((item) => item.type === "sessionstart");
    expect(sessionStarts).toHaveLength(1);
  });

  it("ignores a mapped turn item with an invalid timestamp (NaN ms → continue)", () => {
    // A prompt with `t: "not-a-date"` maps to a non-null MergedTraceItem, but
    // Date.parse("not-a-date") is NaN → the `if (Number.isNaN(ms)) continue` path.
    const promptWithBadTimestamp: TurnItem = {
      type: "prompt",
      _row: 1,
      t: "not-a-date", // ← invalid → NaN → skip
      tMs: 0,
      cum: 0,
      actor: actor(),
      text: "hello",
    };
    const validPrompt: TurnItem = {
      type: "prompt",
      _row: 2,
      t: "2026-08-01T00:01:00.000Z",
      tMs: 60_000,
      cum: 0,
      actor: actor(),
      text: "world",
    };
    const result = buildMergedTrace([
      session([promptWithBadTimestamp, validPrompt]),
    ]);
    // The invalid prompt is silently dropped; only the valid prompt is stamped.
    const prompts = result.filter(isPromptItem);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.text).toBe("world");
  });
});
