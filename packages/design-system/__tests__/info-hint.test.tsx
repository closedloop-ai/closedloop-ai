import { InfoHint } from "@closedloop-ai/design-system/components/ui/primitives/info-hint";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * ISS-7349. `InfoHint` folds three independent open reasons — hover, focus, and
 * a pinned click — into one popover, and the interesting behavior is entirely
 * in how they interact. Two rules the component's own docs call out:
 *
 *  - focus opens it ONLY on a genuine keyboard focus. A modal's focus trap
 *    moving focus onto the trigger would otherwise pop the hint open unbidden
 *    and, being a dismissable layer, swallow the enclosing modal's Escape.
 *  - a touch pointer never opens on hover, because a tap has no hover — the
 *    click it produces owns activation, so a tap opens and closes in one
 *    gesture instead of pinning then immediately unpinning.
 *
 * Neither is reachable from a story, and both fail silently (a hint that pops
 * open on its own; a tap that appears to do nothing).
 */

function renderHint() {
  render(
    <InfoHint label="About sessions">
      <p>Sessions counted in the selected window.</p>
    </InfoHint>
  );
  return screen.getByRole("button", { name: "About sessions" });
}

const body = () =>
  screen.queryByText("Sessions counted in the selected window.");

describe("InfoHint resting state", () => {
  it("renders a labelled trigger with the popover closed", () => {
    const trigger = renderHint();

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(body()).toBeNull();
  });

  it("advertises that it opens a dialog", () => {
    expect(renderHint()).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("carries no aria-controls while closed", () => {
    // Pointing at content that is not in the tree is a broken reference.
    expect(renderHint()).not.toHaveAttribute("aria-controls");
  });
});

describe("InfoHint hover", () => {
  it("opens on a mouse pointer entering the trigger", () => {
    const trigger = renderHint();

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });

    expect(body()).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("closes when the pointer leaves", () => {
    const trigger = renderHint();
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });

    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });

    expect(body()).toBeNull();
  });

  it("does not open on a touch pointer", () => {
    // A tap has no hover; the click it produces owns activation.
    const trigger = renderHint();

    fireEvent.pointerEnter(trigger, { pointerType: "touch" });

    expect(body()).toBeNull();
  });

  it("ignores a touch pointer leaving without opening", () => {
    const trigger = renderHint();
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });

    fireEvent.pointerLeave(trigger, { pointerType: "touch" });

    expect(body()).toBeInTheDocument();
  });

  it("points aria-controls at the open content", () => {
    const trigger = renderHint();

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });

    expect(trigger).toHaveAttribute("aria-controls");
  });
});

describe("InfoHint focus modality", () => {
  it("opens on focus after a keyboard interaction", () => {
    const trigger = renderHint();

    fireEvent.keyDown(globalThis.document, { key: "Tab" });
    fireEvent.focus(trigger);

    expect(body()).toBeInTheDocument();
  });

  it("stays closed on a focus that follows a pointer interaction", () => {
    // Stands in for a modal's focus trap moving focus onto the trigger.
    const trigger = renderHint();

    fireEvent.keyDown(globalThis.document, { key: "Tab" });
    fireEvent.pointerDown(globalThis.document);
    fireEvent.focus(trigger);

    expect(body()).toBeNull();
  });

  it("closes when focus moves outside the trigger", () => {
    const trigger = renderHint();
    fireEvent.keyDown(globalThis.document, { key: "Tab" });
    fireEvent.focus(trigger);

    fireEvent.blur(trigger, { relatedTarget: globalThis.document.body });

    expect(body()).toBeNull();
  });

  it("stays open when focus moves to a descendant of the trigger", () => {
    const trigger = renderHint();
    fireEvent.keyDown(globalThis.document, { key: "Tab" });
    fireEvent.focus(trigger);

    fireEvent.blur(trigger, { relatedTarget: trigger.firstChild });

    expect(body()).toBeInTheDocument();
  });
});

describe("InfoHint pinning", () => {
  it("pins open on a click", () => {
    const trigger = renderHint();

    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);

    expect(body()).toBeInTheDocument();
  });

  it("stays open after the pointer leaves once pinned", () => {
    const trigger = renderHint();
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);

    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });

    expect(body()).toBeInTheDocument();
  });

  it("unpins on a second click", () => {
    // The pointerdown captures the already-pinned state so the click that
    // follows toggles correctly even after Radix dismisses the layer.
    const trigger = renderHint();
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);

    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);

    expect(body()).toBeNull();
  });

  it("opens and closes across one tap gesture", () => {
    const trigger = renderHint();

    fireEvent.pointerEnter(trigger, { pointerType: "touch" });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    expect(body()).toBeInTheDocument();

    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    expect(body()).toBeNull();
  });
});
