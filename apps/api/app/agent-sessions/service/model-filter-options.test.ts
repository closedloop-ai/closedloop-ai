import { describe, expect, it } from "vitest";
import { buildModelFilterOptions } from "./model-filter-options";

describe("buildModelFilterOptions (FEA-4303)", () => {
  it("maps primary-model groups to facet options and sorts by session count desc", () => {
    const options = buildModelFilterOptions([
      { model: "claude-opus-4", _count: { _all: 4 } },
      { model: "gpt-5.5", _count: { _all: 9 } },
    ]);

    expect(options).toEqual([
      { model: "gpt-5.5", sessionCount: 9 },
      { model: "claude-opus-4", sessionCount: 4 },
    ]);
  });

  it("drops the null-primary-model group — there is no Model value to filter to", () => {
    // A session with no captured primary model (`SessionDetail.model` is
    // nullable) groups under a null key; it must never surface as a selectable
    // option the table's Model column could not display.
    const options = buildModelFilterOptions([
      { model: "claude-opus-4", _count: { _all: 4 } },
      { model: null, _count: { _all: 3 } },
    ]);

    expect(options).toEqual([{ model: "claude-opus-4", sessionCount: 4 }]);
    expect(options.map((option) => option.model)).not.toContain(null);
  });

  it("returns an empty list for no groups", () => {
    expect(buildModelFilterOptions([])).toEqual([]);
  });
});
