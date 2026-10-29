import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { BranchCommentsTab } from "../branch-comments-model";
import { BranchCommentsRail } from "../branch-comments-rail";

describe("BranchCommentsRail on the shared shell", () => {
  // ISS-11209 D1: Escape-to-close is the canonical pane's opt-in; the shipped
  // Branch rail keeps its behavior until Wiring moves it onto the pane.
  it("stays open on Escape in the wide layout", () => {
    const onClose = vi.fn();
    render(
      <BranchCommentsRail
        activeTab={BranchCommentsTab.Details}
        onClose={onClose}
        onWidthChange={() => undefined}
        open
        returnFocusRef={createRef()}
        width={340}
      >
        <button type="button">Inside</button>
      </BranchCommentsRail>
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Inside" }), {
      key: "Escape",
    });

    expect(onClose).not.toHaveBeenCalled();
    // A visible focus ring on the resize handle, not an outline swapped for a tint.
    expect(
      screen.getByRole("separator", { name: "Resize comments rail" })
    ).toHaveClass("focus-visible:ring-ring");
    expect(
      screen.getByRole("complementary", { name: "Comments" })
    ).toBeInTheDocument();
  });
});
