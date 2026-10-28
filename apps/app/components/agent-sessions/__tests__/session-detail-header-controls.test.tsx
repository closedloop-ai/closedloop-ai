import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installPointerCaptureShims } from "@/__tests__/helpers/pointer-capture-shims";
import { SessionDetailActions } from "../session-detail-header-controls";

installPointerCaptureShims();

/**
 * ISS-12269 removed the header's overflow kebab and its Refresh button on the
 * operator's instruction (2026-10-08), so the assertions that drove them are
 * deleted rather than repaired. The two absence cases below are counterfactuals
 * for that ruling and deliberately hold the removed control's own words: they
 * are the only thing that fails if either control is reintroduced here.
 */
describe("SessionDetailActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderActions(
    overrides: Partial<{
      commentsRailOpen: boolean;
      onToggleCommentsRail: () => void;
    }> = {}
  ) {
    const handlers = {
      commentsRailOpen: false,
      onToggleCommentsRail: vi.fn(),
      ...overrides,
    };
    render(<SessionDetailActions {...handlers} />);
    return handlers;
  }

  it("renders no Refresh button (ISS-12269)", () => {
    renderActions();

    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  });

  it("renders no overflow menu trigger (ISS-12269)", () => {
    renderActions();

    expect(
      screen.queryByRole("button", { name: "More session actions" })
    ).toBeNull();
  });

  it("labels the comments rail toggle to show it and marks aria-pressed false when closed", () => {
    renderActions({ commentsRailOpen: false });

    const toggle = screen.getByRole("button", { name: "Show comments rail" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("labels the comments rail toggle to hide it and marks aria-pressed true when open", () => {
    renderActions({ commentsRailOpen: true });

    const toggle = screen.getByRole("button", { name: "Hide comments rail" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("calls onToggleCommentsRail when the toggle is clicked", async () => {
    const user = userEvent.setup();
    const handlers = renderActions({ commentsRailOpen: false });

    await user.click(
      screen.getByRole("button", { name: "Show comments rail" })
    );

    expect(handlers.onToggleCommentsRail).toHaveBeenCalledTimes(1);
  });
});
