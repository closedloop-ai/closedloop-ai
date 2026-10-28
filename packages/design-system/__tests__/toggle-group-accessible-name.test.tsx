import { AnalyticsRangeToggle } from "@closedloop-ai/design-system/components/ui/analytics-range-toggle";
import { TableViewMenu } from "@closedloop-ai/design-system/components/ui/table-view-menu";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * ISS-5540 follow-up. Making every single-select `ToggleGroup` a `radiogroup`
 * raised the bar on its callers: ARIA REQUIRES an accessible name on
 * `radiogroup`, where the `group` it replaced merely recommended one. The
 * shipped segmented controls all rendered their label as an unlinked `<span>`
 * or `<p>` beside the control, which names nothing — so the role change alone
 * would have left a screen-reader user hearing an unnamed set of radios and
 * still unable to tell what the choice controls. WCAG 2.2 SC 1.3.1 Info and
 * Relationships (Level A).
 *
 * Every expected name below is a WIRE LITERAL — the words a user reads on
 * screen — rather than a value read back out of the component's own props or
 * constants, so a component that renamed its label could not also move the
 * assertion.
 */

const GROUP_BY_LABEL = "Group by";
const VIEW_LABEL = "View";
const RANGE_OPTIONS = [
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
];

describe("AnalyticsRangeToggle accessible name", () => {
  it("names its radiogroup with the label it renders on screen", () => {
    render(
      <AnalyticsRangeToggle
        onValueChange={vi.fn()}
        options={RANGE_OPTIONS}
        value="7d"
      />
    );

    // "Range" is this component's documented default label, and it is visible
    // text — so the accessible name and the on-screen name are the same words
    // (WCAG 2.2 SC 2.5.3 Label in Name).
    const group = screen.getByRole("radiogroup", { name: "Range" });
    expect(group).toBeInTheDocument();
    expect(screen.getByText("Range")).toBeInTheDocument();
  });

  it("follows a caller-supplied label rather than a hardcoded name", () => {
    render(
      <AnalyticsRangeToggle
        label="Window"
        onValueChange={vi.fn()}
        options={RANGE_OPTIONS}
        value="7d"
      />
    );

    // The pair that stops the name being a constant: the custom label must be
    // the name, and the default must no longer be.
    expect(screen.getByRole("radiogroup", { name: "Window" })).toBeVisible();
    expect(screen.queryByRole("radiogroup", { name: "Range" })).toBeNull();
  });
});

describe("TableViewMenu accessible names", () => {
  it("names both segmented controls with their visible section labels", () => {
    render(
      <TableViewMenu
        groupByOptions={[
          { label: "None", value: "none" },
          { label: "Status", value: "status" },
        ]}
        groupByValue="none"
        onChangeGroupBy={vi.fn()}
        onChangeView={vi.fn()}
        view="list"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: VIEW_LABEL }));

    // Both groups live behind the popover, which is why no story covers them.
    expect(
      screen.getByRole("radiogroup", { name: GROUP_BY_LABEL })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radiogroup", { name: VIEW_LABEL })
    ).toBeInTheDocument();
  });

  it("leaves no unnamed radiogroup behind the popover", () => {
    render(
      <TableViewMenu
        groupByOptions={[
          { label: "None", value: "none" },
          { label: "Status", value: "status" },
        ]}
        groupByValue="none"
        onChangeGroupBy={vi.fn()}
        onChangeView={vi.fn()}
        view="list"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: VIEW_LABEL }));

    // The invariant, stated over the whole subtree rather than per control: a
    // third segmented control added here without a label would fail this even
    // though the two named assertions above kept passing.
    const named = screen
      .getAllByRole("radiogroup")
      .map((group) => group.getAttribute("aria-labelledby"))
      .map((id) => (id ? document.getElementById(id)?.textContent : null));
    expect(named).toEqual([VIEW_LABEL, GROUP_BY_LABEL]);
  });
});
