import { screen } from "@testing-library/react";
import { vi } from "vitest";

const BUCKET_NAME = /^Jump to timeline bucket/;

export function elementAt(elements: readonly HTMLElement[], index: number) {
  const element = elements[index];
  if (!element) {
    throw new Error(`element ${index} missing`);
  }
  return element;
}

export function bucketButtons(): HTMLElement[] {
  return screen.getAllByRole("button", { name: BUCKET_NAME });
}

export function bucketAt(index: number): HTMLElement {
  return elementAt(bucketButtons(), index);
}

export function barGrid(): HTMLElement {
  const grid = bucketAt(0).parentElement;
  if (!grid) {
    throw new Error("bar grid missing");
  }
  return grid;
}

export function plotElement(): HTMLElement {
  const plot = barGrid().parentElement?.parentElement;
  if (!plot) {
    throw new Error("plot missing");
  }
  return plot;
}

export function markerGrid(): HTMLElement {
  const grid = plotElement().children[1]?.firstElementChild;
  if (!(grid instanceof HTMLElement)) {
    throw new Error("marker grid missing");
  }
  return grid;
}

export function cursorLeft(): string | null {
  const first = barGrid().parentElement?.firstElementChild;
  return first instanceof HTMLElement && first !== barGrid()
    ? first.style.left
    : null;
}

export function axisLabels(): string[] {
  return [...(plotElement().lastElementChild?.children ?? [])].map(
    (label) => label.textContent ?? ""
  );
}

export function measurePlot(widthPx: number): HTMLElement {
  const plot = plotElement();
  Object.defineProperty(plot, "clientWidth", {
    configurable: true,
    value: widthPx,
  });
  return plot;
}

export function stubLayoutRect(width: number, left = 0) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ height: 10, width, x: left, y: 0 })
  );
}
