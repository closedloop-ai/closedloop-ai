import type { FilterFacetGroup } from "@repo/design-system/components/ui/table-filters";
import { describe, expect, it, vi } from "vitest";
import { deriveSessionFilterChips } from "../session-active-filter-chips";

function group(overrides: Partial<FilterFacetGroup>): FilterFacetGroup {
  return {
    id: "status",
    label: "Status",
    options: [],
    selectedValues: [],
    onToggle: vi.fn(),
    ...overrides,
  };
}

describe("deriveSessionFilterChips", () => {
  it("emits one chip per selected value, in facet then selection order", () => {
    const chips = deriveSessionFilterChips([
      group({
        id: "status",
        label: "Status",
        options: [
          { id: "completed", label: "Completed" },
          { id: "error", label: "Failed" },
        ],
        selectedValues: ["error", "completed"],
      }),
      group({
        id: "owner",
        label: "Owner",
        options: [{ id: "user-ada", label: "Ada Lovelace" }],
        selectedValues: ["user-ada"],
      }),
    ]);

    expect(
      chips.map((chip) => `${chip.facetLabel}:${chip.valueLabel}`)
    ).toEqual(["Status:Failed", "Status:Completed", "Owner:Ada Lovelace"]);
    expect(chips.map((chip) => chip.key)).toEqual([
      "status:error",
      "status:completed",
      "owner:user-ada",
    ]);
  });

  it("emits no chips when nothing is selected", () => {
    expect(
      deriveSessionFilterChips([
        group({
          options: [{ id: "completed", label: "Completed" }],
          selectedValues: [],
        }),
      ])
    ).toEqual([]);
  });

  it("falls back to the raw value when no option label exists so a selection stays removable", () => {
    const chips = deriveSessionFilterChips([
      group({
        id: "owner",
        label: "Owner",
        options: [],
        selectedValues: ["user-out-of-range"],
      }),
    ]);

    expect(chips).toHaveLength(1);
    expect(chips[0]?.valueLabel).toBe("user-out-of-range");
  });

  it("remove() toggles that one value back off its own facet", () => {
    const onToggle = vi.fn();
    const chips = deriveSessionFilterChips([
      group({
        id: "cost",
        label: "Cost",
        options: [{ id: "unknown", label: "Unknown" }],
        selectedValues: ["unknown"],
        onToggle,
      }),
    ]);

    chips[0]?.remove();
    expect(onToggle).toHaveBeenCalledWith("unknown");
  });
});
