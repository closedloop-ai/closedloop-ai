import {
  ENTERABLE_CONTENT_SELECTOR,
  GRID_SUPPRESSED_TAB_STOP_ATTRIBUTE,
  suppressGridCellTabStops,
} from "@closedloop-ai/design-system/lib/grid-cell-tab-stops";
import { afterEach, describe, expect, it } from "vitest";

function buildGrid(): { gridBody: HTMLDivElement; cleanup: () => void } {
  const gridBody = document.createElement("div");
  gridBody.setAttribute("data-grid-body", "");

  const row = document.createElement("div");
  row.setAttribute("data-grid-row", "");
  row.setAttribute("data-grid-row-id", "r1");

  const cell1 = document.createElement("div");
  cell1.setAttribute("data-grid-cell", "");
  cell1.tabIndex = 0;

  const button = document.createElement("button");
  button.textContent = "Action";
  cell1.appendChild(button);

  const cell2 = document.createElement("div");
  cell2.setAttribute("data-grid-cell", "");
  cell2.tabIndex = -1;

  const link = document.createElement("a");
  link.href = "https://example.com";
  link.textContent = "Link";
  cell2.appendChild(link);

  row.appendChild(cell1);
  row.appendChild(cell2);
  gridBody.appendChild(row);
  document.body.appendChild(gridBody);

  return {
    gridBody,
    cleanup: () => {
      document.body.removeChild(gridBody);
    },
  };
}

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
});

describe("suppressGridCellTabStops", () => {
  it("suppresses focusable controls inside cells", () => {
    const { gridBody, cleanup } = buildGrid();
    cleanupFn = cleanup;

    const controller = suppressGridCellTabStops(gridBody);
    const button = gridBody.querySelector("button")!;
    expect(button.getAttribute("tabindex")).toBe("-1");
    expect(button.hasAttribute(GRID_SUPPRESSED_TAB_STOP_ATTRIBUTE)).toBe(true);

    controller.dispose();
  });

  it("suppresses links with href", () => {
    const { gridBody, cleanup } = buildGrid();
    cleanupFn = cleanup;

    const controller = suppressGridCellTabStops(gridBody);
    const link = gridBody.querySelector("a")!;
    expect(link.getAttribute("tabindex")).toBe("-1");
    expect(link.hasAttribute(GRID_SUPPRESSED_TAB_STOP_ATTRIBUTE)).toBe(true);

    controller.dispose();
  });

  it("does not suppress the cell element itself (it carries the roving tab stop)", () => {
    const { gridBody, cleanup } = buildGrid();
    cleanupFn = cleanup;

    const controller = suppressGridCellTabStops(gridBody);
    const cells = gridBody.querySelectorAll("[data-grid-cell]");
    // The first cell has tabIndex=0 — it should NOT be suppressed
    expect(cells[0].getAttribute("tabindex")).toBe("0");
    expect(cells[0].hasAttribute(GRID_SUPPRESSED_TAB_STOP_ATTRIBUTE)).toBe(
      false
    );

    controller.dispose();
  });

  it("restores original tabindex on dispose", () => {
    const { gridBody, cleanup } = buildGrid();
    cleanupFn = cleanup;

    const button = gridBody.querySelector("button")!;
    // Button has no explicit tabindex (native 0)
    const originalTabIndex = button.getAttribute("tabindex");

    const controller = suppressGridCellTabStops(gridBody);
    expect(button.getAttribute("tabindex")).toBe("-1");

    controller.dispose();
    // Button with no original tabindex attribute gets it removed
    expect(button.getAttribute("tabindex")).toBe(originalTabIndex);
  });

  it("restores an explicit original tabindex on dispose", () => {
    const { gridBody, cleanup } = buildGrid();
    cleanupFn = cleanup;

    const button = gridBody.querySelector("button")!;
    button.setAttribute("tabindex", "5");

    const controller = suppressGridCellTabStops(gridBody);
    expect(button.getAttribute("tabindex")).toBe("-1");

    controller.dispose();
    expect(button.getAttribute("tabindex")).toBe("5");
  });

  it("removes the marker attribute on dispose", () => {
    const { gridBody, cleanup } = buildGrid();
    cleanupFn = cleanup;

    const controller = suppressGridCellTabStops(gridBody);
    const button = gridBody.querySelector("button")!;
    expect(button.hasAttribute(GRID_SUPPRESSED_TAB_STOP_ATTRIBUTE)).toBe(true);

    controller.dispose();
    expect(button.hasAttribute(GRID_SUPPRESSED_TAB_STOP_ATTRIBUTE)).toBe(false);
  });

  it("does not suppress disabled buttons", () => {
    const { gridBody, cleanup } = buildGrid();
    cleanupFn = cleanup;

    const button = gridBody.querySelector("button")!;
    button.disabled = true;

    const controller = suppressGridCellTabStops(gridBody);
    // Disabled buttons don't match ENTERABLE_CONTENT_SELECTOR
    expect(button.hasAttribute(GRID_SUPPRESSED_TAB_STOP_ATTRIBUTE)).toBe(false);

    controller.dispose();
  });
});

describe("ENTERABLE_CONTENT_SELECTOR", () => {
  it("matches buttons, links, inputs, selects, textareas", () => {
    const button = document.createElement("button");
    expect(button.matches(ENTERABLE_CONTENT_SELECTOR)).toBe(true);

    const link = document.createElement("a");
    link.href = "https://example.com";
    expect(link.matches(ENTERABLE_CONTENT_SELECTOR)).toBe(true);

    const input = document.createElement("input");
    expect(input.matches(ENTERABLE_CONTENT_SELECTOR)).toBe(true);

    const select = document.createElement("select");
    expect(select.matches(ENTERABLE_CONTENT_SELECTOR)).toBe(true);

    const textarea = document.createElement("textarea");
    expect(textarea.matches(ENTERABLE_CONTENT_SELECTOR)).toBe(true);
  });

  it("matches role=button elements", () => {
    const div = document.createElement("div");
    div.setAttribute("role", "button");
    expect(div.matches(ENTERABLE_CONTENT_SELECTOR)).toBe(true);
  });

  it("matches elements with positive tabindex", () => {
    const div = document.createElement("div");
    div.setAttribute("tabindex", "0");
    expect(div.matches(ENTERABLE_CONTENT_SELECTOR)).toBe(true);
  });

  it("does not match elements with tabindex=-1 unless suppressed", () => {
    const div = document.createElement("div");
    div.setAttribute("tabindex", "-1");
    expect(div.matches(ENTERABLE_CONTENT_SELECTOR)).toBe(false);
  });

  it("matches suppressed elements (keeps the entry route)", () => {
    const div = document.createElement("div");
    div.setAttribute("tabindex", "-1");
    div.setAttribute(GRID_SUPPRESSED_TAB_STOP_ATTRIBUTE, "");
    expect(div.matches(ENTERABLE_CONTENT_SELECTOR)).toBe(true);
  });

  it("does not match suppressed disabled elements", () => {
    const button = document.createElement("button");
    button.disabled = true;
    button.setAttribute(GRID_SUPPRESSED_TAB_STOP_ATTRIBUTE, "");
    // Disabled button matches button:not([disabled]) = false, but the
    // suppressed selector has :not([disabled]) too
    expect(button.matches(ENTERABLE_CONTENT_SELECTOR)).toBe(false);
  });

  it("does not match disabled inputs", () => {
    const input = document.createElement("input");
    input.disabled = true;
    expect(input.matches(ENTERABLE_CONTENT_SELECTOR)).toBe(false);
  });

  it("does not match aria-disabled role=button", () => {
    const div = document.createElement("div");
    div.setAttribute("role", "button");
    div.setAttribute("aria-disabled", "true");
    expect(div.matches(ENTERABLE_CONTENT_SELECTOR)).toBe(false);
  });
});
