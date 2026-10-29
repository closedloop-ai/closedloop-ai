import {
  RadioGroup,
  RadioGroupItem,
} from "@closedloop-ai/design-system/components/ui/radio-group";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

const MODES = ["Auto", "Manual", "Off"];

function SegmentedModes() {
  const [value, setValue] = useState(MODES[0]);
  return (
    <RadioGroup
      aria-label="Mode"
      onValueChange={setValue}
      value={value}
      variant="segmented"
    >
      {MODES.map((mode) => (
        <RadioGroupItem key={mode} value={mode}>
          {mode}
        </RadioGroupItem>
      ))}
    </RadioGroup>
  );
}

function DefaultModes() {
  return (
    <RadioGroup aria-label="Default mode" defaultValue={MODES[0]}>
      {MODES.map((mode) => (
        <RadioGroupItem aria-label={mode} key={mode} value={mode}>
          {mode}
        </RadioGroupItem>
      ))}
    </RadioGroup>
  );
}

describe("RadioGroup segmented variant", () => {
  it("names each segment by its visible label and draws no radio indicator", () => {
    render(<SegmentedModes />);
    const group = screen.getByRole("radiogroup", { name: "Mode" });

    expect(group).toHaveAttribute("data-variant", "segmented");
    for (const mode of MODES) {
      expect(screen.getByRole("radio", { name: mode })).toHaveTextContent(mode);
    }
    expect(screen.getByRole("radio", { name: MODES[0] })).toBeChecked();
    expect(
      group.querySelector('[data-slot="radio-group-indicator"]')
    ).toBeNull();
  });

  it("keeps the default variant's indicator and drops its children", () => {
    render(<DefaultModes />);
    const checked = screen.getByRole("radio", { name: MODES[0] });

    expect(
      checked.querySelector('[data-slot="radio-group-indicator"]')
    ).not.toBeNull();
    expect(checked).not.toHaveTextContent(MODES[0]);
  });

  // Radio semantics, not toggle-group semantics: an arrow key moves the
  // selection along with focus.
  it("moves the selection with arrow keys", async () => {
    render(<SegmentedModes />);
    const radios = screen.getAllByRole("radio");

    act(() => radios[0].focus());
    act(() => {
      fireEvent.keyDown(radios[0], { key: "ArrowRight" });
    });

    await waitFor(() => expect(radios[1]).toHaveFocus());
    expect(radios[1]).toBeChecked();
    expect(radios[0]).not.toBeChecked();
  });
});
