// @vitest-environment jsdom

/**
 * Pins the ONLY user-visible signal a failed PNG export produces.
 *
 * FEA-4111 removed the `console.error` that used to sit in this catch, so the
 * toast is now the entire feedback path. Without this test the handler could
 * quietly drift back to swallowing the rejection and the export would look like
 * it simply did nothing.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MermaidViewer } from "./mermaid-viewer";

const mocks = vi.hoisted(() => ({
  exportPng: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("./mermaid-viewer-utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./mermaid-viewer-utils")>();
  return { ...actual, exportPng: mocks.exportPng };
});

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: mocks.toastError },
}));

const SVG = '<svg viewBox="0 0 120 80" width="120" height="80"><rect /></svg>';
const DOWNLOAD_BUTTON = /download/i;

// Radix menus need these two; jsdom ships neither. Same shim as
// packages/app/projects/components/__tests__/project-select-popover.test.tsx.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.scrollIntoView ??= () => undefined;

class StubResizeObserver {
  observe() {
    return undefined;
  }
  unobserve() {
    return undefined;
  }
  disconnect() {
    return undefined;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom implements neither ResizeObserver nor layout, both of which the
  // viewer's measurement hooks reach for on mount.
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  // jsdom implements no SVG geometry API at all, so these are absent rather
  // than stubbed — the hooks bail out cleanly on a null CTM.
  Object.defineProperty(SVGElement.prototype, "getScreenCTM", {
    configurable: true,
    value: () => null,
  });
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ height: 80, width: 120, x: 0, y: 0 }),
  });
  vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockReturnValue({
    bottom: 80,
    height: 80,
    left: 0,
    right: 120,
    toJSON: () => ({}),
    top: 0,
    width: 120,
    x: 0,
    y: 0,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openExportMenu() {
  render(<MermaidViewer onEdit={() => undefined} svg={SVG} />);
  const trigger = await screen.findByRole("button", { name: DOWNLOAD_BUTTON });
  // Radix opens a dropdown on pointerdown, not click.
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  return await screen.findByText("Download as PNG");
}

test("surfaces a toast when the PNG export rejects", async () => {
  mocks.exportPng.mockRejectedValueOnce(new Error("canvas tainted"));

  fireEvent.click(await openExportMenu());

  await waitFor(() => expect(mocks.exportPng).toHaveBeenCalled());
  await waitFor(() =>
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't export the diagram as a PNG."
    )
  );
});

test("stays silent when the PNG export succeeds", async () => {
  mocks.exportPng.mockResolvedValueOnce(undefined);

  fireEvent.click(await openExportMenu());

  await waitFor(() => expect(mocks.exportPng).toHaveBeenCalled());
  expect(mocks.toastError).not.toHaveBeenCalled();
});
