import { describe, expect, it } from "vitest";
import { buildModelFilterOptionsFromCounts } from "./agent-session-model-facet.ts";

describe("buildModelFilterOptionsFromCounts", () => {
  it("returns no options when counts are absent", () => {
    expect(buildModelFilterOptionsFromCounts(undefined)).toEqual([]);
  });

  it("drops null models and sorts by count then model", () => {
    expect(
      buildModelFilterOptionsFromCounts([
        { model: null, sessionCount: 100 },
        { model: "model-z", sessionCount: 5 },
        { model: "model-a", sessionCount: 5 },
        { model: "popular-model", sessionCount: 8 },
      ])
    ).toEqual([
      { model: "popular-model", sessionCount: 8 },
      { model: "model-a", sessionCount: 5 },
      { model: "model-z", sessionCount: 5 },
    ]);
  });
});
