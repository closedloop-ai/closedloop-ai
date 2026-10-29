import {
  InlineScalarCell,
  type InlineScalarCellProps,
} from "@closedloop-ai/design-system/components/ui/inline-scalar-cell";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-9589. A committed value handed down while the user is typing — another
 * user's edit, a refetch — used to replace the draft mid-edit. Each case here
 * lands that value BETWEEN the typing and the commit or cancel, which is the
 * only window the defect lived in, and renders two cells so a rule that holds
 * every cell, or none, cannot pass for one that holds only the dirty one.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("InlineScalarCell under a live update", () => {
  it("keeps the typing in the dirty cell and applies the update to the clean one", () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <TwoCells estimate="7" onCommit={onCommit} points="3" />
    );

    const estimate = screen.getByRole("textbox", { name: "Estimate" });
    estimate.focus();
    fireEvent.change(estimate, { target: { value: "9" } });

    rerender(<TwoCells estimate="12" onCommit={onCommit} points="5" />);

    expect(estimate).toHaveValue("9");
    expect(screen.getByRole("textbox", { name: "Points" })).toHaveValue("5");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("shows the held update after Escape, not the value the edit began from", () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <TwoCells estimate="7" onCommit={onCommit} points="3" />
    );

    const estimate = screen.getByRole("textbox", { name: "Estimate" });
    estimate.focus();
    fireEvent.change(estimate, { target: { value: "9" } });
    rerender(<TwoCells estimate="12" onCommit={onCommit} points="3" />);
    fireEvent.keyDown(estimate, { key: "Escape" });

    expect(estimate).toHaveValue("12");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits the typing over a held update", () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <TwoCells estimate="7" onCommit={onCommit} points="3" />
    );

    const estimate = screen.getByRole("textbox", { name: "Estimate" });
    estimate.focus();
    fireEvent.change(estimate, { target: { value: "9" } });
    rerender(<TwoCells estimate="12" onCommit={onCommit} points="3" />);
    fireEvent.blur(estimate);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Estimate", "9");
  });

  it("PRD-722 DT-034 keeps the rejected draft over the held confirmation", async () => {
    const refused = Promise.reject(new Error("the server refused it"));
    refused.catch(() => undefined);
    const onCommit = vi.fn(() => refused);
    const { rerender } = render(
      <TwoCells
        estimate="7"
        onCommit={onCommit}
        points="3"
        retainRejectedDraft
      />
    );

    const estimate = screen.getByRole("textbox", { name: "Estimate" });
    estimate.focus();
    fireEvent.change(estimate, { target: { value: "9" } });
    rerender(
      <TwoCells
        estimate="12"
        onCommit={onCommit}
        points="3"
        retainRejectedDraft
      />
    );
    fireEvent.blur(estimate);
    await act(async () => {
      await refused.catch(() => undefined);
    });

    expect(onCommit).toHaveBeenCalledWith("Estimate", "9");
    expect(estimate).toHaveValue("9");
    fireEvent.keyDown(estimate, { key: "Escape" });
    expect(estimate).toHaveValue("12");
  });

  it("keeps a commit the user made before the update's effects flushed", () => {
    // whitlockk review, PR #7836: React commits the new value, then the next Enter
    // lands before the cell's effects run. The commit resolves without an echo,
    // so only the cell's own decision can put the typing back on screen.
    const onCommit = vi.fn();
    const { rerender } = render(
      <>
        <PressEnter press={false} />
        <TwoCells estimate="7" onCommit={onCommit} points="3" />
      </>
    );

    const estimate = screen.getByRole("textbox", { name: "Estimate" });
    estimate.focus();
    fireEvent.change(estimate, { target: { value: "9" } });
    rerender(
      <>
        <PressEnter press />
        <TwoCells estimate="12" onCommit={onCommit} points="3" />
      </>
    );

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Estimate", "9");
    expect(estimate).toHaveValue("9");
  });

  it("sends nothing once the update matches what was typed", () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <TwoCells estimate="7" onCommit={onCommit} points="3" />
    );

    const estimate = screen.getByRole("textbox", { name: "Estimate" });
    estimate.focus();
    fireEvent.change(estimate, { target: { value: "12" } });
    rerender(<TwoCells estimate="12" onCommit={onCommit} points="3" />);
    fireEvent.blur(estimate);

    expect(estimate).toHaveValue("12");
    expect(onCommit).not.toHaveBeenCalled();
  });
});

/** Two cells in one row, so a per-cell rule is observable as one. */
function TwoCells({
  estimate,
  onCommit,
  points,
  retainRejectedDraft = false,
}: Readonly<{
  estimate: string;
  onCommit: (
    label: string,
    next: string
  ) => ReturnType<InlineScalarCellProps["onCommit"]>;
  points: string;
  retainRejectedDraft?: boolean;
}>) {
  const estimateCell = retainRejectedDraft ? (
    <InlineScalarCell
      label="Estimate"
      onCommit={(next) => onCommit("Estimate", next)}
      retainRejectedDraft
      saveErrorMessage="Save failed"
      value={estimate}
    />
  ) : (
    <InlineScalarCell
      label="Estimate"
      onCommit={(next) => onCommit("Estimate", next)}
      value={estimate}
    />
  );
  return (
    <>
      {estimateCell}
      <InlineScalarCell
        label="Points"
        onCommit={(next) => onCommit("Points", next)}
        value={points}
      />
    </>
  );
}

/**
 * Presses Enter in the Estimate cell from a passive effect that runs BEFORE the
 * cells' own, because it is an earlier sibling: the window in which a real
 * keystroke can land between React committing a value and flushing effects.
 */
function PressEnter({ press }: Readonly<{ press: boolean }>) {
  useEffect(() => {
    if (press) {
      screen
        .getByRole("textbox", { name: "Estimate" })
        .dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
        );
    }
  }, [press]);
  return null;
}
