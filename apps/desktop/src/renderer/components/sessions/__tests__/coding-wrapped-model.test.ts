import { describe, expect, it } from "vitest";
import { buildWrappedCards } from "../coding-wrapped-model";
import { makeGroundedMetrics } from "./grounded-metrics-factory";

describe("buildWrappedCards", () => {
  it("returns an empty deck for null metrics", () => {
    expect(buildWrappedCards(null)).toEqual([]);
  });

  it("returns an empty deck when every fun-fact signal is absent", () => {
    expect(buildWrappedCards(makeGroundedMetrics())).toEqual([]);
  });

  it("renders the top-model card from the highest-share model", () => {
    const cards = buildWrappedCards({
      ...makeGroundedMetrics(),
      modelMix: [
        { model: "claude-opus-4", sessions: 12, share: 0.7, tokens: 700 },
        { model: "claude-sonnet-4", sessions: 3, share: 0.3, tokens: 300 },
      ],
    });
    const model = cards.find((card) => card.id === "wrapped-top-model");
    expect(model).toBeDefined();
    expect(model?.value).toBe("claude-opus-4");
    expect(model?.caption).toContain("70%");
    expect(model?.caption).toContain("12 sessions");
  });

  it("hides the top-model card when the top model's share is negligible", () => {
    const cards = buildWrappedCards({
      ...makeGroundedMetrics(),
      modelMix: [{ model: "trace", sessions: 1, share: 0.005, tokens: 5 }],
    });
    expect(cards.some((card) => card.id === "wrapped-top-model")).toBe(false);
  });

  it("singularizes the session caption for a single session", () => {
    const cards = buildWrappedCards({
      ...makeGroundedMetrics(),
      modelMix: [
        { model: "claude-opus-4", sessions: 1, share: 0.9, tokens: 9 },
      ],
    });
    const model = cards.find((card) => card.id === "wrapped-top-model");
    expect(model?.caption).toContain("1 session");
    expect(model?.caption).not.toContain("1 sessions");
  });

  it("renders the cadence card with the night-owl percentage and label", () => {
    const cards = buildWrappedCards({
      ...makeGroundedMetrics(),
      sessionCadence: {
        byHour: new Array(24).fill(0),
        byWeekday: new Array(7).fill(0),
        label: "night owl: 42% after midnight",
        nightOwlRatio: 0.42,
      },
    });
    const cadence = cards.find((card) => card.id === "wrapped-cadence");
    expect(cadence?.value).toBe("42%");
    expect(cadence?.label).toBe("After midnight");
    expect(cadence?.caption).toBe("night owl: 42% after midnight");
  });

  it("surfaces the peak-activity label (not an after-midnight %) for a daytime coder", () => {
    const cards = buildWrappedCards({
      ...makeGroundedMetrics(),
      sessionCadence: {
        byHour: new Array(24).fill(0),
        byWeekday: new Array(7).fill(0),
        label: "most active around 3pm on Tuesday",
        nightOwlRatio: 0.05,
      },
    });
    const cadence = cards.find((card) => card.id === "wrapped-cadence");
    expect(cadence?.label).toBe("When you code");
    expect(cadence?.value).toBe("most active around 3pm on Tuesday");
    // No "5%" after-midnight headline that would contradict the daytime label.
    expect(cadence?.value).not.toContain("%");
  });

  it("renders the plan-mode card when the ratio is present (including zero)", () => {
    const cards = buildWrappedCards({
      ...makeGroundedMetrics(),
      planModeRatio: 0,
    });
    const plan = cards.find((card) => card.id === "wrapped-plan-mode");
    expect(plan).toBeDefined();
    expect(plan?.value).toBe("0%");
  });

  it("hides the plan-mode card when the ratio is undetectable (null)", () => {
    const cards = buildWrappedCards({
      ...makeGroundedMetrics(),
      planModeRatio: null,
    });
    expect(cards.some((card) => card.id === "wrapped-plan-mode")).toBe(false);
  });

  it("renders and truncates the most-reached-for prompt", () => {
    const long =
      "refactor the entire authentication subsystem end to end, then write comprehensive tests";
    const cards = buildWrappedCards({
      ...makeGroundedMetrics(),
      topPrompts: {
        avgPromptChars: 40,
        prompts: [{ count: 9, text: long }],
      },
    });
    const prompt = cards.find((card) => card.id === "wrapped-top-prompt");
    expect(prompt).toBeDefined();
    expect(prompt?.value.endsWith("…")).toBe(true);
    expect(prompt?.value.length).toBeLessThan(long.length);
    expect(prompt?.caption).toContain("9 times");
  });

  it("orders the deck model → cadence → plan → prompt and skips gaps", () => {
    const cards = buildWrappedCards({
      ...makeGroundedMetrics(),
      modelMix: [
        { model: "claude-opus-4", sessions: 2, share: 0.8, tokens: 8 },
      ],
      planModeRatio: 0.5,
      // cadence absent — the gap is skipped, not rendered blank.
      topPrompts: { avgPromptChars: 10, prompts: [{ count: 4, text: "go" }] },
    });
    expect(cards.map((card) => card.id)).toEqual([
      "wrapped-top-model",
      "wrapped-plan-mode",
      "wrapped-top-prompt",
    ]);
  });
});
