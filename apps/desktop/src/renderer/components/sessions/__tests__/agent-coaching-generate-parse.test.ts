import { describe, expect, it } from "vitest";
import { parseGeneratedTips } from "../agent-coaching-generate-parse";
import type { AgentCoachingTipCategory } from "../agent-coaching-types";

function tipJson(id: string, category: AgentCoachingTipCategory) {
  return {
    id,
    title: `${id} title`,
    category,
    body: "A concrete, quantified body.",
    whyItMatters: "It matters.",
    evidence: ["one fact"],
    experiment: "Try it.",
    detail: {
      whatThisMeans: "means",
      howToAct: ["act"],
      whyThisRecommendation: "because",
      autoApply: "auto",
    },
    actions: [],
  };
}

describe("parseGeneratedTips (FEA-3265 categories)", () => {
  it("accepts wall_time and cost tips advertised as focus areas (codex P1)", () => {
    // The prompt lists wall_time and cost as focus areas, so a compliant harness
    // can return them. The parser must not silently drop those valid tips.
    const raw = JSON.stringify([
      tipJson("compress-session-wall-time", "wall_time"),
      tipJson("rebalance-model-spend", "cost"),
    ]);

    const tips = parseGeneratedTips(raw);

    expect(tips.map((tip) => tip.id)).toEqual([
      "compress-session-wall-time",
      "rebalance-model-spend",
    ]);
    expect(tips.map((tip) => tip.category)).toEqual(["wall_time", "cost"]);
  });

  it("keeps valid tips from a mixed old/new-category batch", () => {
    const raw = JSON.stringify([
      tipJson("a", "token_efficiency"),
      tipJson("b", "cost"),
      // An unknown category is still dropped.
      { ...tipJson("c", "token_efficiency"), category: "not_a_category" },
    ]);

    const tips = parseGeneratedTips(raw);

    expect(tips.map((tip) => tip.id)).toEqual(["a", "b"]);
  });
});
