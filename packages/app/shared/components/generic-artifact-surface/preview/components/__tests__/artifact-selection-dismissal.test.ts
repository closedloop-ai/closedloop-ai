// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { shouldClearArtifactSelectionFromPointerTarget } from "../artifact-selection-dismissal";

function scroller(
  box: Readonly<{
    clientHeight: number;
    clientWidth: number;
    scrollHeight: number;
    scrollWidth: number;
  }>
): HTMLElement {
  const element = document.createElement("div");
  for (const [key, value] of Object.entries(box)) {
    Object.defineProperty(element, key, { configurable: true, value });
  }
  return element;
}

describe("shouldClearArtifactSelectionFromPointerTarget", () => {
  const vertical = scroller({
    clientHeight: 400,
    clientWidth: 585,
    scrollHeight: 2000,
    scrollWidth: 585,
  });
  const horizontal = scroller({
    clientHeight: 385,
    clientWidth: 600,
    scrollHeight: 385,
    scrollWidth: 1800,
  });

  it("keeps the set when the press lands on a scrollbar", () => {
    expect(
      shouldClearArtifactSelectionFromPointerTarget(vertical, {
        offsetX: 592,
        offsetY: 120,
      })
    ).toBe(false);
    expect(
      shouldClearArtifactSelectionFromPointerTarget(horizontal, {
        offsetX: 300,
        offsetY: 392,
      })
    ).toBe(false);
  });

  it("clears on a press inside the scrolling element's client box", () => {
    expect(
      shouldClearArtifactSelectionFromPointerTarget(vertical, {
        offsetX: 300,
        offsetY: 120,
      })
    ).toBe(true);
    expect(
      shouldClearArtifactSelectionFromPointerTarget(horizontal, {
        offsetX: 300,
        offsetY: 120,
      })
    ).toBe(true);
  });

  it("does not treat a press past a non-scrolling element's box as a scrollbar", () => {
    const flat = scroller({
      clientHeight: 400,
      clientWidth: 585,
      scrollHeight: 400,
      scrollWidth: 585,
    });
    expect(
      shouldClearArtifactSelectionFromPointerTarget(flat, {
        offsetX: 592,
        offsetY: 405,
      })
    ).toBe(true);
  });

  it("keeps selection while a group disclosure changes rendered rows", () => {
    const toggle = document.createElement("button");
    toggle.dataset.gridGroupToggle = "";
    const icon = document.createElement("span");
    toggle.append(icon);

    expect(shouldClearArtifactSelectionFromPointerTarget(icon)).toBe(false);
  });
});
