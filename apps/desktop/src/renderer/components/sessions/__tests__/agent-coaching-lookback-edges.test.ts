import { describe, expect, it } from "vitest";
import {
  computePeakFrustration,
  summarizeLookback,
} from "../agent-coaching-lookback";
import type { AgentCoachingInput } from "../agent-coaching-types";
import {
  commandlessShellEvent,
  FRUSTRATED_TURN,
  localIso,
  makeInput,
  makeInputWithTokens,
  promptEvent,
  shellEvent,
  timestampedEvent,
  userEvent,
} from "./fixtures/agent-coaching-input";

// ISS-10696: the lookback reducer's fallbacks and tie-breaks. The headline
// derivations live in `agent-coaching-generation.test.ts`; this file pins the
// arms a well-formed fixture never reaches — an absent field, a malformed
// timestamp, an equal score.

describe("lookback window label", () => {
  it("uses the caller's positive request when the payload reports no window", () => {
    const metrics = summarizeLookback(noWindowInput(), 7);

    expect(metrics.lookbackDays).toBe(7);
  });

  it("falls back to the 30-day default for a request that is not a positive day count", () => {
    expect(summarizeLookback(noWindowInput(), -3).lookbackDays).toBe(30);
    expect(summarizeLookback(noWindowInput(), Number.NaN).lookbackDays).toBe(
      30
    );
    expect(summarizeLookback(noWindowInput()).lookbackDays).toBe(30);
  });

  it("labels an all-time request as the unbounded window", () => {
    expect(
      summarizeLookback(makeInput({ analytics: null }), null).lookbackDays
    ).toBe(0);
  });
});

describe("skills and event fallbacks", () => {
  it("reports skill invocations as unavailable, never zero, when the read failed", () => {
    const metrics = summarizeLookback(
      makeInput({ skills: [], skillsUnavailable: true })
    );

    expect(metrics.totalSkillInvocations).toBeNull();
  });

  it("counts captured events as a sample when analytics is absent", () => {
    const metrics = summarizeLookback(
      makeInput({
        analytics: null,
        recentEvents: [shellEvent("git status")],
      })
    );

    expect(metrics.eventsAnalyzed).toBe(1);
    expect(metrics.eventsAnalyzedIsAllTime).toBe(false);
    expect(metrics.sessionsAnalyzed).toBe(2);
  });
});

describe("peak frustration edge cases", () => {
  it("skips a user turn with no text and reads one whose text is only in data", () => {
    const peak = computePeakFrustration([
      { ...userEvent(""), data: null },
      { ...userEvent(""), data: FRUSTRATED_TURN, summary: null },
    ]);

    expect(peak).not.toBeNull();
    expect(peak?.excerpt).toContain("STOP. this is WRONG again");
  });

  it("caps the surviving excerpt at 160 characters with an ellipsis", () => {
    const shout = `${FRUSTRATED_TURN} ${"x".repeat(200)}`;
    const peak = computePeakFrustration([userEvent(shout)]);

    expect(peak?.excerpt).toHaveLength(161);
    expect(peak?.excerpt.endsWith("…")).toBe(true);
    expect(peak?.excerpt.startsWith("STOP. this is WRONG again")).toBe(true);
  });

  it("carries a null session name through rather than redacting it", () => {
    const peak = computePeakFrustration([
      { ...userEvent(FRUSTRATED_TURN), sessionName: null },
    ]);

    expect(peak?.sessionName).toBeNull();
  });
});

describe("model mix ordering", () => {
  it("breaks an equal token share by model name", () => {
    const metrics = summarizeLookback(
      makeInputWithTokens({
        byModel: [
          {
            estimatedCostUsd: 1,
            inputTokens: 100,
            model: "zeta",
            outputTokens: 0,
            sessions: 1,
          },
          {
            estimatedCostUsd: 1,
            inputTokens: 50,
            model: "alpha",
            outputTokens: 50,
            sessions: 1,
          },
        ],
      })
    );

    expect(metrics.modelMix?.map((row) => row.model)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(metrics.modelMix?.[0]?.share).toBeCloseTo(0.5);
  });
});

describe("top prompts", () => {
  it("reads a human turn's text from data when summary is absent and drops empty turns", () => {
    const metrics = summarizeLookback(
      makeInput({
        recentEvents: [
          {
            ...promptEvent("ignored"),
            data: "  fix the build\n",
            summary: null,
          },
          { ...promptEvent("ignored"), data: null, summary: null },
        ],
      })
    );

    expect(metrics.topPrompts).toEqual({
      avgPromptChars: 13,
      prompts: [{ count: 1, text: "fix the build" }],
    });
  });

  it("caps a prompt preview at 120 characters while averaging the full length", () => {
    const long = `refactor ${"the parser ".repeat(20)}`.trim();
    const metrics = summarizeLookback(
      makeInput({ recentEvents: [promptEvent(long)] })
    );

    expect(metrics.topPrompts?.prompts[0]?.text).toHaveLength(121);
    expect(metrics.topPrompts?.prompts[0]?.text.endsWith("…")).toBe(true);
    expect(metrics.topPrompts?.avgPromptChars).toBe(long.length);
  });

  it("orders equally frequent prompts by their text", () => {
    const metrics = summarizeLookback(
      makeInput({
        recentEvents: [promptEvent("write docs"), promptEvent("add tests")],
      })
    );

    expect(metrics.topPrompts?.prompts.map((prompt) => prompt.text)).toEqual([
      "add tests",
      "write docs",
    ]);
  });
});

describe("session cadence", () => {
  it("ignores an event whose timestamp does not parse", () => {
    const metrics = summarizeLookback(
      makeInput({ recentEvents: [timestampedEvent("not-a-date")] })
    );

    expect(metrics.sessionCadence).toBeNull();
  });

  it("names a morning peak with am, a noon peak as 12pm, and a midnight tie as 12am", () => {
    const midnightTie = summarizeLookback(
      makeInput({
        recentEvents: [0, 9, 10, 11, 12].map((hour) =>
          timestampedEvent(localIso(2026, 5, 17, hour))
        ),
      })
    );
    // One in five events after midnight sits under the night-owl threshold,
    // and the tie resolves to the earliest hour.
    expect(midnightTie.sessionCadence?.label).toBe(
      "most active around 12am on Wednesday"
    );

    const midnight = summarizeLookback(
      makeInput({
        recentEvents: [
          timestampedEvent(localIso(2026, 5, 17, 0)),
          timestampedEvent(localIso(2026, 5, 17, 9)),
          timestampedEvent(localIso(2026, 5, 17, 9)),
          timestampedEvent(localIso(2026, 5, 17, 9)),
          timestampedEvent(localIso(2026, 5, 17, 9)),
        ],
      })
    );
    expect(midnight.sessionCadence?.label).toBe(
      "most active around 9am on Wednesday"
    );

    const noon = summarizeLookback(
      makeInput({
        recentEvents: [
          timestampedEvent(localIso(2026, 5, 17, 12)),
          timestampedEvent(localIso(2026, 5, 17, 12)),
          timestampedEvent(localIso(2026, 5, 17, 13)),
          timestampedEvent(localIso(2026, 5, 17, 14)),
          timestampedEvent(localIso(2026, 5, 17, 15)),
        ],
      })
    );
    expect(noon.sessionCadence?.label).toBe(
      "most active around 12pm on Wednesday"
    );
  });
});

describe("shell command sampling", () => {
  it("drops a shell event whose data is a blob with no recoverable command", () => {
    const metrics = summarizeLookback(
      makeInput({
        recentEvents: [commandlessShellEvent(), shellEvent("git status")],
      })
    );

    expect(metrics.shellCommandsSampled).toBe(1);
    expect(metrics.unwrappedShellCommandRatio).toBe(1);
  });

  it("does not count a bare rtk wrapper as a command family", () => {
    const metrics = summarizeLookback(
      makeInput({
        recentEvents: [
          shellEvent("rtk", "s-1"),
          shellEvent("rtk", "s-2"),
          shellEvent("rtk", "s-3"),
        ],
      })
    );

    expect(metrics.shellCommandsSampled).toBe(3);
    expect(metrics.unwrappedShellCommandRatio).toBe(1);
    expect(metrics.repeatedCommandFamilies).toEqual([]);
  });
});

/** The default input with a payload that reports no window of its own. */
function noWindowInput(): AgentCoachingInput {
  return makeInputWithTokens({ windowDays: 0 });
}
