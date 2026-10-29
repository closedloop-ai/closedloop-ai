import {
  ToggleGroup,
  ToggleGroupItem,
} from "@closedloop-ai/design-system/components/ui/toggle-group";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

/**
 * ISS-5540. A single-select `ToggleGroup` renders its items as `role="radio"`
 * with `aria-checked` — Radix supplies both — but its root defaulted to
 * `role="group"`, and ARIA requires a `radiogroup` owner for `radio` children.
 * The consequence is not cosmetic: with a `group` owner the selection
 * relationship and the group's own accessible name never reach assistive tech,
 * so a screen-reader user hears three unrelated radios and no group name.
 * WCAG 2.2 SC 1.3.1 Info and Relationships (Level A).
 *
 * The role alone is not the contract, which is why this file drives the
 * keyboard rather than asserting an attribute: a `radiogroup` that is not one
 * tab stop, or whose arrow keys do nothing, is the same defect wearing the
 * right name.
 *
 * ACTIVATION is asserted a layer up, on the real Agents switchers
 * (`packages/app/agents/components/workspace/__tests__/token-trend-chart.test
 * .tsx`), because proving it needs a driver that translates Enter on a button
 * into a click the way a browser does, and `@testing-library/user-event` is a
 * `@repo/app` dependency this package does not carry.
 */

const METRICS = ["Cost", "Tokens", "Sessions"];

function MetricSwitcher() {
  const [value, setValue] = useState(METRICS[0]);
  return (
    <ToggleGroup
      aria-label="Metric"
      onValueChange={(next) => {
        if (next) {
          setValue(next);
        }
      }}
      type="single"
      value={value}
      variant="outline"
    >
      {METRICS.map((metric) => (
        <ToggleGroupItem key={metric} value={metric}>
          {metric}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

describe("ToggleGroup single-select semantics", () => {
  it("owns its radio children as a named radiogroup", () => {
    render(<MetricSwitcher />);

    expect(
      screen.getByRole("radiogroup", { name: "Metric" })
    ).toBeInTheDocument();
    // The positive that stops the role being a bare attribute swap: the radios
    // must be OWNED by it, not merely present somewhere in the document.
    expect(
      screen
        .getByRole("radiogroup", { name: "Metric" })
        .querySelectorAll('[role="radio"]')
    ).toHaveLength(METRICS.length);
  });

  it("does not present a single-select group as a plain group", () => {
    render(<MetricSwitcher />);

    // Paired with the positive above: a root carrying BOTH roles, or the old
    // `group`, would satisfy one assertion and fail this one.
    expect(screen.queryByRole("group", { name: "Metric" })).toBeNull();
  });

  it("exposes the selected item through aria-checked", () => {
    render(<MetricSwitcher />);

    expect(
      screen
        .getAllByRole("radio")
        .filter((radio) => radio.getAttribute("aria-checked") === "true")
        .map((radio) => radio.textContent)
    ).toEqual([METRICS[0]]);
  });

  it("moves focus across the group with arrow keys, and wraps", async () => {
    render(<MetricSwitcher />);
    const radios = screen.getAllByRole("radio");

    act(() => radios[0].focus());
    fireEvent.keyDown(radios[0], { key: "ArrowRight" });
    await waitFor(() => expect(radios[1]).toHaveFocus());

    fireEvent.keyDown(radios[1], { key: "ArrowRight" });
    await waitFor(() => expect(radios[2]).toHaveFocus());

    // Wrapping is what makes the group traversable without a dead end.
    fireEvent.keyDown(radios[2], { key: "ArrowRight" });
    await waitFor(() => expect(radios[0]).toHaveFocus());

    fireEvent.keyDown(radios[0], { key: "ArrowLeft" });
    await waitFor(() => expect(radios[2]).toHaveFocus());
  });

  it("is one tab stop, and tabbing in lands on the selected option", async () => {
    render(<MetricSwitcher />);
    const group = screen.getByRole("radiogroup", { name: "Metric" });
    const radios = screen.getAllByRole("radio");

    // A radiogroup owes the keyboard user ONE tab stop, not one per option, and
    // it owes them entry at the current selection rather than at the first
    // option. Both are asserted here because the role is a promise about
    // keyboard cost, and a role with neither is the defect wearing a new name.
    expect(group).toHaveAttribute("tabindex", "0");
    act(() => group.focus());

    await waitFor(() => expect(radios[0]).toHaveFocus());
    // Roving tabindex: while focus is inside, exactly one option is tabbable,
    // so Tab leaves the group instead of walking it.
    fireEvent.keyDown(radios[0], { key: "ArrowRight" });
    await waitFor(() =>
      expect(
        radios.filter((radio) => radio.getAttribute("tabindex") === "0")
      ).toEqual([radios[1]])
    );
  });
});

const FORMATS = ["Bold", "Italic"];

/**
 * The other half of the `type === "single"` conditional. Without this, a later
 * edit that drops the condition — applying `radiogroup` unconditionally — keeps
 * every assertion above green while silently telling assistive tech that a set
 * of independent `aria-pressed` toggles is a mutually-exclusive choice.
 *
 * Both cases render the single-select switcher ALONGSIDE the multi-select
 * group, so each "is not a radiogroup" / "owns no radio" assertion carries its
 * positive control on the same selector in the same document.
 */
function FormatToggles() {
  return (
    <>
      <MetricSwitcher />
      <ToggleGroup
        aria-label="Format"
        defaultValue={[FORMATS[0]]}
        type="multiple"
        variant="outline"
      >
        {FORMATS.map((format) => (
          <ToggleGroupItem key={format} value={format}>
            {format}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </>
  );
}

describe("ToggleGroup multi-select semantics", () => {
  it("stays a plain group while its single-select sibling is the radiogroup", () => {
    render(<FormatToggles />);

    expect(screen.getByRole("group", { name: "Format" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Format" })).toBeNull();
    // Positive control on the SAME selector: `radiogroup` is matchable in this
    // very render, so the null above is the conditional holding rather than the
    // query being unsatisfiable.
    expect(
      screen
        .getAllByRole("radiogroup")
        .map((group) => group.getAttribute("aria-label"))
    ).toEqual(["Metric"]);
  });

  it("presses its items instead of checking them", () => {
    render(<FormatToggles />);
    const group = screen.getByRole("group", { name: "Format" });

    expect(
      within(group)
        .getAllByRole("button")
        .map((item) => item.getAttribute("aria-pressed"))
    ).toEqual(["true", "false"]);
    expect(within(group).queryAllByRole("radio")).toHaveLength(0);
    // Positive control: the document DOES contain radios, so the zero above is
    // scoped to this group rather than `radio` being absent everywhere.
    expect(screen.getAllByRole("radio")).toHaveLength(METRICS.length);
  });
});
