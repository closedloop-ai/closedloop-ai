import { InlineScalarCell } from "@closedloop-ai/design-system/components/ui/inline-scalar-cell";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * PRD-722: a host that parses its value out of plain text (a custom-field
 * duration or date) refuses a draft before it is sent, in its own words.
 *
 * The refusal must keep the typing, say why, and never call `onCommit`; and a
 * draft that still equals the confirmed value is not a commit at all, so it is
 * never refused. Two fixtures with different words pin that the cell renders
 * the host's sentence and not one of its own.
 */

const DIGITS_ONLY = /^\d*$/;

function refuseLetters(draft: string) {
  return DIGITS_ONLY.test(draft.trim()) ? null : `Not a span: ${draft}`;
}

describe("InlineScalarCell draftRejection", () => {
  it("keeps a refused draft, says why, and sends nothing", () => {
    const onCommit = vi.fn();
    render(
      <InlineScalarCell
        draftRejection={refuseLetters}
        label="Estimate"
        onCommit={onCommit}
        value="90"
      />
    );
    const input = screen.getByRole("textbox", { name: "Estimate" });

    fireEvent.change(input, { target: { value: "soon" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCommit).not.toHaveBeenCalled();
    expect(input).toHaveValue("soon");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const message = screen.getByText("Not a span: soon");
    expect(input.getAttribute("aria-describedby")).toContain(
      message.closest("[id]")?.id
    );

    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input).toHaveValue("soon");
  });

  it("drops the refusal when the user edits, and commits a draft it accepts", () => {
    const onCommit = vi.fn();
    render(
      <InlineScalarCell
        draftRejection={refuseLetters}
        label="Estimate"
        onCommit={onCommit}
        value="90"
      />
    );
    const input = screen.getByRole("textbox", { name: "Estimate" });

    fireEvent.change(input, { target: { value: "soon" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "120" } });
    expect(screen.queryByText("Not a span: soon")).toBeNull();
    expect(input).not.toHaveAttribute("aria-invalid");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("120");
  });

  it("restores the confirmed value on Escape and clears the refusal", () => {
    render(
      <InlineScalarCell
        draftRejection={refuseLetters}
        label="Estimate"
        onCommit={vi.fn()}
        value="90"
      />
    );
    const input = screen.getByRole("textbox", { name: "Estimate" });

    fireEvent.change(input, { target: { value: "soon" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(input).toHaveValue("90");
    expect(screen.queryByText("Not a span: soon")).toBeNull();
  });

  it("never asks about a draft that still equals the confirmed value", () => {
    const draftRejection = vi.fn(() => "never shown");
    const onCommit = vi.fn();
    render(
      <InlineScalarCell
        draftRejection={draftRejection}
        label="Estimate"
        onCommit={onCommit}
        value="raw text"
      />
    );
    const input = screen.getByRole("textbox", { name: "Estimate" });

    fireEvent.blur(input);

    expect(draftRejection).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByText("never shown")).toBeNull();
  });

  it("does not send a refused draft when the host tears the cell down", () => {
    const onCommit = vi.fn();
    const { unmount } = render(
      <InlineScalarCell
        draftRejection={refuseLetters}
        label="Estimate"
        onCommit={onCommit}
        value="90"
      />
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Estimate" }), {
      target: { value: "soon" },
    });

    act(() => unmount());

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("restores the confirmed value when the host refuses an accepted draft", async () => {
    render(
      <InlineScalarCell
        draftRejection={refuseLetters}
        label="Estimate"
        onCommit={() => Promise.reject(new Error("refused"))}
        value="90"
      />
    );
    const input = screen.getByRole("textbox", { name: "Estimate" });

    fireEvent.change(input, { target: { value: "120" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });

    expect(input).toHaveValue("90");
  });
});
