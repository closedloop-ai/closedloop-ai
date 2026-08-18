import type { FriendlyErrorInput } from "@repo/api/src/types/friendly-error";
import { resolveFriendlyError } from "@repo/api/src/types/friendly-error";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FriendlyErrorAlert } from "../friendly-error-alert";

const error: FriendlyErrorInput = {
  message: "Claude CLI exited before the loop completed.",
};

// The exact resolved copy this fixture produces — pinned so a regression in the
// resolver or the component's render of it fails here.
const resolved = resolveFriendlyError(error);

// The real inline caller (loop-progress-panel) strips the alert's box so the
// error reads as inline event copy, not a boxed alert.
const INLINE_CALLER_CLASSNAME = "border-none bg-transparent p-0 shadow-none";

const RAW_RED_UTILITY = /\bred-\d/;
const HEX_COLOR = /#[0-9a-fA-F]{3,8}/;

describe("FriendlyErrorAlert", () => {
  it("does not hand-roll its own destructive tint — the DS error variant owns it", () => {
    render(<FriendlyErrorAlert error={error} />);

    const alert = screen.getByRole("alert");
    const classAttr = alert.getAttribute("class") ?? "";

    // The component no longer sets its own tint. The old bolted-on hand-rolled
    // tint (`bg-destructive/10`) must be gone, and no raw red utility or hex may
    // creep in — the tokenized `variant="error"` is the only source of the tint.
    expect(alert).not.toHaveClass("bg-destructive/10");
    expect(classAttr).not.toMatch(RAW_RED_UTILITY);
    expect(classAttr).not.toMatch(HEX_COLOR);
  });

  it("preserves the alert role and renders the resolved friendly copy", () => {
    render(<FriendlyErrorAlert error={error} />);

    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    // Pin the resolved title and description so a copy regression is caught.
    expect(alert).toHaveTextContent(resolved.title);
    expect(alert).toHaveTextContent(resolved.description);
  });

  it("lets the inline caller strip the box without reintroducing a tint", () => {
    render(
      <FriendlyErrorAlert className={INLINE_CALLER_CLASSNAME} error={error} />
    );

    const alert = screen.getByRole("alert");
    // The caller's layout overrides win — a merge-order regression that
    // restored the boxed alert in the inline event layout fails here.
    expect(alert).toHaveClass("border-none");
    expect(alert).toHaveClass("bg-transparent");
    expect(alert).toHaveClass("p-0");
    expect(alert).toHaveClass("shadow-none");
    // And no hand-rolled tint sneaks back in alongside the overrides.
    expect(alert.getAttribute("class") ?? "").not.toMatch(RAW_RED_UTILITY);
  });
});
