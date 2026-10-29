import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import {
  formatRangeValue as formatRangeValueV1,
  isFilterMenuGroupActive as isFilterMenuGroupActiveV1,
  parseRangeInput as parseRangeInputV1,
  RangeSubmenu as RangeSubmenuV1,
} from "@closedloop-ai/design-system/components/ui/filter-range-submenu";
import {
  formatRangeValue,
  isFilterMenuGroupActive,
  parseRangeInput,
  RangeFilterContent,
  RangeSubmenu,
} from "@closedloop-ai/design-system/components/ui/filter-range-submenu-v2";
import type { FilterRangeGroup } from "@closedloop-ai/design-system/components/ui/table-filters-v2";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { leadingIcon } from "./fixtures/filter-popover-fixtures";

/**
 * ISS-7349. The range facet is the one filter control that takes FREE TEXT, so
 * it is the one that has to decide what a non-numeric entry means. Its contract
 * is spelled out in the module: drafts are held locally and committed only on
 * blur/Enter (so an in-progress entry cannot clobber the sibling bound), an
 * unparseable entry becomes an unset bound rather than NaN, and the collapsed
 * trigger shows the applied range rather than a bare count.
 *
 * `filter-range-submenu.tsx` is the champion and `filter-range-submenu-v2.tsx`
 * the fork kept as the flag-off rollback (ISS-12641). Both now carry ISS-8068's
 * scoped Escape, asserted for each in `grid-table-v2-escape-dismissal.test.tsx`;
 * what this file covers is the range CONTRACT above, which both variants share.
 * Both are shipped and reachable, so both are asserted here rather than testing
 * one and assuming the other, which is exactly how the two would drift.
 */

function rangeGroup(
  overrides: Partial<FilterRangeGroup> = {}
): FilterRangeGroup {
  return {
    id: "cost",
    kind: "range",
    label: "Cost",
    onChange: vi.fn(),
    ...overrides,
  };
}

/** A submenu trigger is only legal inside an open menu's content. */
function renderInOpenMenu(ui: React.ReactNode) {
  return render(
    <DropdownMenu open>
      <DropdownMenuTrigger>Filter</DropdownMenuTrigger>
      <DropdownMenuContent>{ui}</DropdownMenuContent>
    </DropdownMenu>
  );
}

describe.each([
  ["v2", parseRangeInput],
  ["v1", parseRangeInputV1],
])("parseRangeInput (%s)", (_variant, parse) => {
  it.each([
    ["an empty string", ""],
    ["whitespace only", "   "],
  ])("returns undefined for %s", (_label, raw) => {
    expect(parse(raw)).toBeUndefined();
  });

  it.each([
    ["non-numeric text", "abc"],
    ["a partial number", "1.2.3"],
    ["Infinity", "Infinity"],
  ])("returns undefined rather than a bad number for %s", (_label, raw) => {
    // An unparseable bound is an UNSET bound. Returning NaN here would put NaN
    // into the host's filter state and silently drop every row.
    expect(parse(raw)).toBeUndefined();
  });

  it("parses a surrounded-by-whitespace integer", () => {
    expect(parse("  42  ")).toBe(42);
  });

  it("parses a decimal and a negative", () => {
    expect(parse("3.5")).toBe(3.5);
    expect(parse("-7")).toBe(-7);
  });

  it("parses an explicit zero rather than treating it as empty", () => {
    // `0` is falsy, so an implementation that guarded on truthiness would lose
    // a legitimate lower bound of zero.
    expect(parse("0")).toBe(0);
  });
});

describe.each([
  ["v2", formatRangeValue],
  ["v1", formatRangeValueV1],
])("formatRangeValue (%s)", (_variant, format) => {
  it("renders both bounds as a range", () => {
    expect(format(0, 50)).toBe("0 – 50");
  });

  it("renders a min-only bound with a trailing plus", () => {
    expect(format(500, undefined)).toBe("500+");
  });

  it("renders a max-only bound with a leading at-most sign", () => {
    expect(format(undefined, 50)).toBe("≤ 50");
  });

  it("returns null when neither bound is set", () => {
    expect(format(undefined, undefined)).toBeNull();
  });

  it("renders a zero min as a bound rather than dropping it", () => {
    expect(format(0, undefined)).toBe("0+");
  });

  it("treats a non-finite bound as no bound", () => {
    // A `number` parameter does not stop `NaN`/`±Infinity` at runtime, and
    // `Cost: NaN+` states a filter the user never set.
    expect(format(Number.NaN, undefined)).toBeNull();
    expect(format(undefined, Number.POSITIVE_INFINITY)).toBeNull();
    expect(format(Number.NEGATIVE_INFINITY, Number.NaN)).toBeNull();
  });

  it("keeps the finite half of a partly non-finite range", () => {
    expect(format(0, Number.NaN)).toBe("0+");
    expect(format(Number.POSITIVE_INFINITY, 50)).toBe("≤ 50");
  });
});

describe.each([
  ["v2", isFilterMenuGroupActive],
  ["v1", isFilterMenuGroupActiveV1],
])("isFilterMenuGroupActive (%s)", (_variant, isActive) => {
  it("counts a range group with only a min as active", () => {
    expect(isActive(rangeGroup({ min: 5 }))).toBe(true);
  });

  it("counts a range group with only a max as active", () => {
    expect(isActive(rangeGroup({ max: 5 }))).toBe(true);
  });

  it("counts a range group with a zero bound as active", () => {
    expect(isActive(rangeGroup({ min: 0 }))).toBe(true);
  });

  it("does not count an unbounded range group", () => {
    expect(isActive(rangeGroup())).toBe(false);
  });

  it("counts an options group with a selection as active", () => {
    expect(
      isActive({
        id: "status",
        label: "Status",
        onToggle: vi.fn(),
        options: [],
        selectedValues: ["open"],
      })
    ).toBe(true);
  });

  it("does not count an options group with no selection", () => {
    expect(
      isActive({
        id: "status",
        label: "Status",
        onToggle: vi.fn(),
        options: [],
        selectedValues: [],
      })
    ).toBe(false);
  });
});

describe("RangeFilterContent", () => {
  it("seeds the inputs from the committed bounds", () => {
    render(
      <RangeFilterContent
        clearLabel="Clear"
        group={rangeGroup({ max: 50, min: 5 })}
      />
    );

    expect(screen.getByLabelText("Min")).toHaveValue("5");
    expect(screen.getByLabelText("Max")).toHaveValue("50");
  });

  it("renders empty inputs when neither bound is set", () => {
    render(<RangeFilterContent clearLabel="Clear" group={rangeGroup()} />);

    expect(screen.getByLabelText("Min")).toHaveValue("");
    expect(screen.getByLabelText("Max")).toHaveValue("");
  });

  it("does not commit while the user is still typing", () => {
    // The whole reason drafts are local: per-keystroke commit would clamp mid
    // entry and fight the user.
    const onChange = vi.fn();
    render(
      <RangeFilterContent clearLabel="Clear" group={rangeGroup({ onChange })} />
    );

    fireEvent.change(screen.getByLabelText("Min"), { target: { value: "5" } });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("commits both bounds on blur", () => {
    const onChange = vi.fn();
    render(
      <RangeFilterContent clearLabel="Clear" group={rangeGroup({ onChange })} />
    );

    fireEvent.change(screen.getByLabelText("Min"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Max"), { target: { value: "50" } });
    fireEvent.blur(screen.getByLabelText("Max"));

    expect(onChange).toHaveBeenCalledWith({ max: 50, min: 5 });
  });

  it("commits on Enter", () => {
    const onChange = vi.fn();
    render(
      <RangeFilterContent clearLabel="Clear" group={rangeGroup({ onChange })} />
    );

    fireEvent.change(screen.getByLabelText("Min"), { target: { value: "12" } });
    fireEvent.keyDown(screen.getByLabelText("Min"), { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith({ max: undefined, min: 12 });
  });

  it("does not commit on a key that is not Enter", () => {
    const onChange = vi.fn();
    render(
      <RangeFilterContent clearLabel="Clear" group={rangeGroup({ onChange })} />
    );

    fireEvent.change(screen.getByLabelText("Min"), { target: { value: "12" } });
    fireEvent.keyDown(screen.getByLabelText("Min"), { key: "a" });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("commits an unparseable entry as an unset bound", () => {
    const onChange = vi.fn();
    render(
      <RangeFilterContent
        clearLabel="Clear"
        group={rangeGroup({ min: 5, onChange })}
      />
    );

    fireEvent.change(screen.getByLabelText("Min"), {
      target: { value: "abc" },
    });
    fireEvent.blur(screen.getByLabelText("Min"));

    expect(onChange).toHaveBeenCalledWith({ max: undefined, min: undefined });
  });

  it("hides the clear action when no bound is applied", () => {
    render(<RangeFilterContent clearLabel="Clear" group={rangeGroup()} />);

    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("clears both bounds through the clear action", () => {
    const onChange = vi.fn();
    render(
      <RangeFilterContent
        clearLabel="Clear"
        group={rangeGroup({ max: 50, min: 5, onChange })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(onChange).toHaveBeenCalledWith({ max: undefined, min: undefined });
  });

  it("re-syncs the drafts when the host rewrites a committed bound", () => {
    // The host owns normalization, so a bound can change from outside (clear
    // all, a deep link, a clamp). The draft must follow it.
    const { rerender } = render(
      <RangeFilterContent clearLabel="Clear" group={rangeGroup({ min: 5 })} />
    );

    rerender(
      <RangeFilterContent clearLabel="Clear" group={rangeGroup({ min: 99 })} />
    );

    expect(screen.getByLabelText("Min")).toHaveValue("99");
  });

  it("uses the supplied placeholders and defaults the max placeholder", () => {
    render(
      <RangeFilterContent
        clearLabel="Clear"
        group={rangeGroup({ minPlaceholder: "0" })}
      />
    );

    expect(screen.getByLabelText("Min")).toHaveAttribute("placeholder", "0");
    expect(screen.getByLabelText("Max")).toHaveAttribute("placeholder", "Any");
  });
});

describe.each([
  ["v2", RangeSubmenu],
  ["v1", RangeSubmenuV1],
])("RangeSubmenu (%s)", (_variant, Submenu) => {
  it("shows the applied range on the collapsed trigger", () => {
    // A bare "1" would not say whether the filter is `0 – 50` or `500+`.
    renderInOpenMenu(
      <Submenu clearLabel="Clear" group={rangeGroup({ max: 50, min: 0 })} />
    );

    expect(screen.getByText("0 – 50")).toBeInTheDocument();
  });

  it("shows the label with no range text when nothing is applied", () => {
    renderInOpenMenu(<Submenu clearLabel="Clear" group={rangeGroup()} />);

    expect(screen.getByText("Cost")).toBeInTheDocument();
    expect(screen.queryByText("≤ 50")).toBeNull();
  });

  it("draws no leading icon on the trigger", () => {
    renderInOpenMenu(<Submenu clearLabel="Clear" group={rangeGroup()} />);

    expect(
      leadingIcon(screen.getByRole("menuitem", { name: "Cost" }))
    ).toBeNull();
  });
});
