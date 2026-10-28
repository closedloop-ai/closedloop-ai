import { InlineScalarCell } from "@closedloop-ai/design-system/components/ui/inline-scalar-cell";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * ISS-12938 (PRD-722 E3): a formatted number rests on the host's display text
 * and edits from the bare value, and a refused write comes back to that text.
 */

const INVALID = "Enter a number";
const FORMATTED = "$1,234.50";

function Formatted({
  onCommit,
}: {
  onCommit: (next: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState("1234.5");
  return (
    <InlineScalarCell
      invalidMessage={INVALID}
      label="Budget"
      onCommit={(next) => onCommit(next).then(() => setValue(next))}
      restingValue={value === "1234.5" ? FORMATTED : undefined}
      type="number"
      value={value}
    />
  );
}

describe("InlineScalarCell restingValue", () => {
  it("shows the host's formatted text at rest and the bare value while editing", () => {
    render(<Formatted onCommit={() => Promise.resolve()} />);
    const field = screen.getByRole("spinbutton", { name: "Budget" });

    expect(screen.getByText(FORMATTED)).toBeVisible();
    expect(field).toHaveAttribute("aria-valuetext", FORMATTED);

    fireEvent.focus(field);

    expect(screen.queryByText(FORMATTED)).toBeNull();
    expect(field).toHaveValue(1234.5);
    expect(field).not.toHaveAttribute("aria-valuetext");
  });

  it("returns to the formatted text when the write is refused", async () => {
    const onCommit = vi.fn(() => Promise.reject(new Error("refused")));
    render(<Formatted onCommit={onCommit} />);
    const field = screen.getByRole("spinbutton", { name: "Budget" });

    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "99" } });
    fireEvent.blur(field);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onCommit).toHaveBeenCalledExactlyOnceWith("99");
    expect(field).toHaveValue(1234.5);
    expect(screen.getByText(FORMATTED)).toBeVisible();
  });

  it("rests again after an empty commit collapses the focused field and a value arrives", async () => {
    const onCommit = vi.fn(() => Promise.resolve());
    const { rerender } = render(
      <InlineScalarCell
        invalidMessage={INVALID}
        label="Budget"
        onCommit={onCommit}
        type="number"
        value="7"
      />
    );
    const field = screen.getByRole("spinbutton", { name: "Budget" });
    field.focus();
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await act(async () => {
      await Promise.resolve();
    });
    rerender(
      <InlineScalarCell
        invalidMessage={INVALID}
        label="Budget"
        onCommit={onCommit}
        type="number"
        value=""
      />
    );
    const setButton = screen.getByRole("button", { name: "Set Budget" });
    // The user moves on; nothing in the cell holds focus any more.
    act(() => setButton.blur());
    fireEvent.blur(setButton);

    rerender(
      <InlineScalarCell
        invalidMessage={INVALID}
        label="Budget"
        onCommit={onCommit}
        restingValue="$500.00"
        type="number"
        value="500"
      />
    );

    expect(
      screen.getByRole("spinbutton", { name: "Budget" })
    ).not.toHaveFocus();
    expect(screen.getByText("$500.00")).toBeVisible();
  });
});
