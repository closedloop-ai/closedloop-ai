import { InfoHint } from "@repo/design-system/components/ui/primitives/info-hint";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const LABEL = "About Active sessions";
const BODY = "Agent sessions matching the current filters and time range.";

function renderInfoHint() {
  return render(
    <InfoHint contentClassName="w-60" label={LABEL}>
      <p>{BODY}</p>
    </InfoHint>
  );
}

describe("InfoHint (FEA-3819)", () => {
  it("opens on hover and dismisses on pointer-out, with no click", async () => {
    renderInfoHint();
    const trigger = screen.getByRole("button", { name: LABEL });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });

    const dialog = await screen.findByRole("dialog", { name: LABEL });
    expect(dialog.textContent).toContain(BODY);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens on keyboard focus and closes on blur", async () => {
    renderInfoHint();
    const trigger = screen.getByRole("button", { name: LABEL });

    // A key press marks the modality as keyboard, so the focus that follows is a
    // genuine keyboard focus that reveals the hint.
    fireEvent.keyDown(trigger, { key: "Tab" });
    fireEvent.focus(trigger);
    const dialog = await screen.findByRole("dialog", { name: LABEL });
    expect(dialog.textContent).toContain(BODY);

    fireEvent.blur(trigger);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("does not reveal on a programmatic (non-keyboard) focus", () => {
    renderInfoHint();
    const trigger = screen.getByRole("button", { name: LABEL });

    // A pointer interaction sets the modality to pointer; a focus that then lands
    // on the trigger programmatically — as a modal's focus-trap does — must NOT
    // open the hint, or its Radix layer would swallow the modal's Escape (the
    // insights expand-modal regression).
    fireEvent.pointerDown(document.body, { pointerType: "mouse" });
    trigger.focus();
    fireEvent.focus(trigger);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on a touch tap and closes on the next tap", async () => {
    renderInfoHint();
    const trigger = screen.getByRole("button", { name: LABEL });

    // A real tap fires pointerdown then a click; the click owns activation, so
    // the two together must open exactly once (never pin-then-unpin).
    fireEvent.pointerDown(trigger, { pointerType: "touch" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: LABEL });
    expect(dialog.textContent).toContain(BODY);

    // Tapping again closes it.
    fireEvent.pointerDown(trigger, { pointerType: "touch" });
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("widens the trigger hit area past the glyph strokes", () => {
    renderInfoHint();
    // Horizontal padding on the trigger is what lets a hover land on the
    // whitespace around the "i", not only its strokes (the reported friction).
    expect(screen.getByRole("button", { name: LABEL }).className).toContain(
      "px-1.5"
    );
  });
});
