import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommentsPaneLayout } from "../comments-pane-model";
import { CommentsRailShell } from "../comments-rail-shell";

function renderNarrowShell(keepOpenOnFieldEscape: boolean) {
  const onClose = vi.fn();
  render(
    <CommentsRailShell
      description="Comments for this view."
      keepOpenOnFieldEscape={keepOpenOnFieldEscape}
      layout={CommentsPaneLayout.Narrow}
      onClose={onClose}
      onWidthChange={() => undefined}
      open
      width={340}
    >
      <textarea aria-label="Draft" />
    </CommentsRailShell>
  );
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Draft" }), {
    key: "Escape",
  });
  return onClose;
}

describe("CommentsRailShell width commit", () => {
  function renderWideShell() {
    const onWidthChange = vi.fn();
    const onWidthCommit = vi.fn();
    render(
      <CommentsRailShell
        description="Comments for this view."
        layout={CommentsPaneLayout.Wide}
        onClose={() => undefined}
        onWidthChange={onWidthChange}
        onWidthCommit={onWidthCommit}
        open
        width={340}
      >
        <p>Body</p>
      </CommentsRailShell>
    );
    const separator = screen.getByRole("separator", {
      name: "Resize comments rail",
    });
    return { onWidthChange, onWidthCommit, separator };
  }

  it("commits once per drag, at pointer-up, never per move", () => {
    const { onWidthChange, onWidthCommit, separator } = renderWideShell();
    fireEvent.pointerDown(separator, { clientX: 500 });
    fireEvent.pointerMove(globalThis.window, { clientX: 480 });
    fireEvent.pointerMove(globalThis.window, { clientX: 460 });

    expect(onWidthChange).toHaveBeenCalledTimes(2);
    expect(onWidthCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(globalThis.window);
    expect(onWidthCommit).toHaveBeenCalledExactlyOnceWith(380);
  });

  it("commits nothing for a click on the handle without a drag", () => {
    const { onWidthCommit, separator } = renderWideShell();
    fireEvent.pointerDown(separator, { clientX: 500 });
    fireEvent.pointerUp(globalThis.window);
    expect(onWidthCommit).not.toHaveBeenCalled();
  });

  it("commits once per keyboard step", () => {
    const { onWidthCommit, separator } = renderWideShell();
    fireEvent.keyDown(separator, { key: "End" });
    expect(onWidthCommit).toHaveBeenCalledExactlyOnceWith(560);
  });
});

describe("CommentsRailShell narrow Sheet", () => {
  // ISS-11209 review: the field-Escape guard is the canonical pane's opt-in.
  // Branch's shipped Sheet keeps plain Radix behavior until Wiring moves it.
  it("closes on Escape typed into a field by default, as Branch's Sheet always has", () => {
    expect(renderNarrowShell(false)).toHaveBeenCalledTimes(1);
  });

  it("keeps the Sheet open on Escape typed into a field when the host opts in", () => {
    expect(renderNarrowShell(true)).not.toHaveBeenCalled();
  });
});
