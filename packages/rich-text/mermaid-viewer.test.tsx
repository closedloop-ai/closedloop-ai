// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreOwnProperty } from "./__tests__/dom-property";
import { MermaidViewer } from "./mermaid-viewer";

const mocks = vi.hoisted(() => ({
  centerOnSvgPoint: vi.fn(),
  computeFitTransform: vi.fn(),
  containerSize: { height: 240, width: 320 },
  contentBBox: { height: 50, width: 100, x: 10, y: 20 } as Box | null,
  exportPng: vi.fn(),
  exportSvg: vi.fn(),
  fullscreen: false,
  layoutHeight: 240,
  layoutWidth: 320,
  naturalSize: { height: 60, width: 120 } as Size | null,
  prepared: {
    dims: { height: 50, width: 100 } as Size | null,
    html: '<svg viewBox="0 0 100 50"><rect /></svg>',
  },
  requestFullscreen: vi.fn(),
  toastError: vi.fn(),
  visibleRegion: { height: 25, width: 50, x: 15, y: 25 } as Box | null,
  zoomAtPoint: vi.fn(),
}));

vi.mock("./mermaid-viewer-hooks", () => ({
  useContainerSize: () => mocks.containerSize,
  useFullscreen: () => ({
    isFullscreen: mocks.fullscreen,
    toggle: mocks.requestFullscreen,
  }),
  useLatestRef: <T,>(value: T) => ({ current: value }),
  useSvgMeasurements: () => ({
    contentBBox: mocks.contentBBox,
    naturalSize: mocks.naturalSize,
  }),
  useVisibleRegion: () => mocks.visibleRegion,
}));

vi.mock("./mermaid-viewer-utils", () => ({
  centerOnSvgPoint: mocks.centerOnSvgPoint,
  computeFitTransform: mocks.computeFitTransform,
  cropSvgToBBox: vi.fn((svg: string) => `cropped:${svg}`),
  exportPng: mocks.exportPng,
  exportSvg: mocks.exportSvg,
  INLINE_HEIGHT: 360,
  MAX_SCALE: 4,
  MIN_SCALE: 0.25,
  prepareSvg: vi.fn(() => mocks.prepared),
  ZOOM_FACTOR: 0.1,
  zoomAtPoint: mocks.zoomAtPoint,
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: mocks.toastError },
}));

vi.mock("@repo/design-system/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: Readonly<{ children: ReactNode }>) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: Readonly<{ children: ReactNode }>) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
  }: Readonly<{ children: ReactNode; onClick?: () => void }>) => (
    <button onClick={onClick} type="button">
      {children}
    </button>
  ),
  DropdownMenuTrigger: ({ children }: Readonly<{ children: ReactNode }>) => (
    <div>{children}</div>
  ),
}));

vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  Tooltip: ({ children }: Readonly<{ children: ReactNode }>) => (
    <div>{children}</div>
  ),
  TooltipContent: ({ children }: Readonly<{ children: ReactNode }>) => (
    <div>{children}</div>
  ),
  TooltipTrigger: ({ children }: Readonly<{ children: ReactNode }>) => (
    <div>{children}</div>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.centerOnSvgPoint.mockImplementation(
    (_transform, x: number, y: number) => ({ scale: 2, x: -x, y: -y })
  );
  mocks.computeFitTransform.mockReturnValue({ scale: 1, x: 8, y: 12 });
  mocks.containerSize = { height: 240, width: 320 };
  mocks.contentBBox = { height: 50, width: 100, x: 10, y: 20 };
  mocks.exportPng.mockResolvedValue(undefined);
  mocks.fullscreen = false;
  mocks.layoutHeight = 240;
  mocks.layoutWidth = 320;
  mocks.naturalSize = { height: 60, width: 120 };
  mocks.prepared = {
    dims: { height: 50, width: 100 },
    html: '<svg viewBox="0 0 100 50"><rect /></svg>',
  };
  mocks.visibleRegion = { height: 25, width: 50, x: 15, y: 25 };
  mocks.zoomAtPoint.mockImplementation(
    (transform: Transform, scale: number, cx: number, cy: number) => ({
      scale,
      x: transform.x + cx,
      y: transform.y + cy,
    })
  );

  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    () => mocks.layoutWidth
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    () => mocks.layoutHeight
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    bottom: 240,
    height: 240,
    left: 10,
    right: 330,
    toJSON: () => ({}),
    top: 20,
    width: 320,
    x: 10,
    y: 20,
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn(),
    writable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreOwnProperty(
    HTMLElement.prototype,
    "setPointerCapture",
    originalSetPointerCaptureDescriptor
  );
});

describe("MermaidViewer", () => {
  it("renders the inline toolbar and forwards edit, fullscreen, and exports", async () => {
    const onEdit = vi.fn();
    render(<MermaidViewer onEdit={onEdit} svg="raw-svg" />);

    expect(screen.getByText("100%")).toBeTruthy();
    expect(getCanvas().style.height).toBe("360px");

    fireEvent.click(screen.getByRole("button", { name: "Edit source" }));
    fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }));
    fireEvent.click(screen.getByText("Download as SVG"));
    fireEvent.click(screen.getByText("Download as PNG"));

    expect(onEdit).toHaveBeenCalledOnce();
    expect(mocks.requestFullscreen).toHaveBeenCalledOnce();
    expect(mocks.exportSvg).toHaveBeenCalledWith(
      mocks.prepared.html,
      "mermaid-diagram.svg"
    );
    await waitFor(() =>
      expect(mocks.exportPng).toHaveBeenCalledWith(
        mocks.prepared.html,
        100,
        50,
        "mermaid-diagram.png"
      )
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("renders fullscreen state", () => {
    mocks.fullscreen = true;

    const { container } = render(
      <MermaidViewer onEdit={vi.fn()} svg="raw-svg" />
    );

    expect(container.firstElementChild?.className).toBe("bg-background");
    expect(getCanvas().style.height).toBe("100%");
    expect(
      screen.getByRole("button", { name: "Exit fullscreen" })
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit source" })).toBeTruthy();
  });

  it("zooms around the viewport center and resets on button or double-click", () => {
    render(<MermaidViewer onEdit={vi.fn()} svg="raw-svg" />);

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(mocks.zoomAtPoint).toHaveBeenLastCalledWith(
      expect.objectContaining({ scale: 1 }),
      1.1,
      160,
      120
    );

    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(mocks.zoomAtPoint).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.closeTo(0.99),
      160,
      120
    );

    fireEvent.click(screen.getByRole("button", { name: "Fit to view" }));
    fireEvent.doubleClick(getCanvas());
    expect(mocks.computeFitTransform).toHaveBeenCalledWith(
      { height: 50, width: 100 },
      320,
      240
    );
    expect(mocks.computeFitTransform).toHaveBeenCalledTimes(3);
  });

  it("pans with wheel events and zooms bounded ctrl-wheel gestures", () => {
    render(<MermaidViewer onEdit={vi.fn()} svg="raw-svg" />);
    const canvas = getCanvas();

    fireEvent.wheel(canvas, { deltaX: 4, deltaY: 6 });
    expect(getContent().style.transform).toContain("translate(4px, 6px)");

    fireEvent.wheel(canvas, {
      clientX: 42,
      clientY: 64,
      ctrlKey: true,
      deltaY: -1000,
    });
    expect(mocks.zoomAtPoint).toHaveBeenLastCalledWith(
      expect.anything(),
      4,
      32,
      44
    );

    fireEvent.wheel(canvas, {
      clientX: 42,
      clientY: 64,
      ctrlKey: true,
      deltaY: 1000,
    });
    expect(mocks.zoomAtPoint).toHaveBeenLastCalledWith(
      expect.anything(),
      0.25,
      32,
      44
    );
  });

  it("tracks left-button pointer panning and ignores right-button drags", () => {
    render(<MermaidViewer onEdit={vi.fn()} svg="raw-svg" />);
    const canvas = getCanvas();

    fireEvent.pointerDown(canvas, {
      button: 2,
      clientX: 30,
      clientY: 40,
      pointerId: 1,
    });
    fireEvent.pointerMove(canvas, { clientX: 80, clientY: 90 });
    expect(canvas.className).not.toContain("cursor-grabbing");

    fireEvent.pointerDown(canvas, {
      button: 0,
      clientX: 30,
      clientY: 40,
      pointerId: 2,
    });
    expect(canvas.className).toContain("cursor-grabbing");
    expect(canvas.setPointerCapture).toHaveBeenCalledWith(2);

    fireEvent.pointerMove(canvas, { clientX: 50, clientY: 70 });
    expect(getContent().style.transform).toContain("translate(28px, 42px)");

    fireEvent.pointerUp(canvas);
    expect(canvas.className).not.toContain("cursor-grabbing");
  });

  it("navigates from pointer minimap clicks but ignores keyboard clicks", () => {
    render(<MermaidViewer onEdit={vi.fn()} svg="raw-svg" />);
    const minimap = screen.getByRole("button", {
      name: "Navigate diagram via minimap",
    });

    fireEvent.click(minimap, { clientX: 110, clientY: 120, detail: 0 });
    expect(mocks.centerOnSvgPoint).not.toHaveBeenCalled();

    fireEvent.click(minimap, { clientX: 110, clientY: 120, detail: 1 });
    expect(mocks.centerOnSvgPoint).toHaveBeenCalledWith(
      expect.anything(),
      43.333_333_333_333_336,
      53.333_333_333_333_336,
      320,
      240
    );
  });

  it("uses natural-size and SVG-dimension fallbacks for the minimap", () => {
    mocks.contentBBox = null;
    const { rerender } = render(
      <MermaidViewer onEdit={vi.fn()} svg="natural" />
    );
    const minimap = screen.getByRole("button", {
      name: "Navigate diagram via minimap",
    });
    expect(minimap.style.width).toBe("300px");
    expect(minimap.style.height).toBe("150px");

    mocks.naturalSize = null;
    rerender(<MermaidViewer onEdit={vi.fn()} svg="dimensions" />);
    expect(minimap.style.width).toBe("300px");
    expect(minimap.style.height).toBe("150px");
  });

  it("does not render the minimap until all measurement boundaries exist", () => {
    mocks.containerSize = { height: 0, width: 0 };
    const { rerender } = render(
      <MermaidViewer onEdit={vi.fn()} svg="no-container" />
    );
    expect(
      screen.queryByRole("button", { name: "Navigate diagram via minimap" })
    ).toBeNull();

    mocks.containerSize = { height: 240, width: 320 };
    mocks.visibleRegion = null;
    rerender(<MermaidViewer onEdit={vi.fn()} svg="no-region" />);
    expect(
      screen.queryByRole("button", { name: "Navigate diagram via minimap" })
    ).toBeNull();
  });

  it("ignores fit and PNG export when SVG dimensions are unavailable", () => {
    mocks.prepared = { dims: null, html: "<svg />" };
    render(<MermaidViewer onEdit={vi.fn()} svg="dimensionless" />);

    fireEvent.click(screen.getByRole("button", { name: "Fit to view" }));
    fireEvent.doubleClick(getCanvas());
    fireEvent.click(screen.getByText("Download as PNG"));

    expect(mocks.computeFitTransform).not.toHaveBeenCalled();
    expect(mocks.exportPng).not.toHaveBeenCalled();
  });

  it("surfaces PNG export failures through the public toast boundary", async () => {
    mocks.exportPng.mockRejectedValueOnce(new Error("canvas failed"));
    render(<MermaidViewer onEdit={vi.fn()} svg="raw-svg" />);

    fireEvent.click(screen.getByText("Download as PNG"));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Couldn't export the diagram as a PNG."
      )
    );
  });

  it("does not fit when the measured container has no area", () => {
    mocks.layoutWidth = 0;
    mocks.layoutHeight = 0;

    render(<MermaidViewer onEdit={vi.fn()} svg="raw-svg" />);

    expect(mocks.computeFitTransform).not.toHaveBeenCalled();
  });
});

type Box = Size & { x: number; y: number };
type Size = { height: number; width: number };
type Transform = { scale: number; x: number; y: number };

function getCanvas(): HTMLElement {
  const canvas = screen.getByText("mermaid").parentElement;
  if (!canvas) {
    throw new Error("viewer canvas was not rendered");
  }
  return canvas;
}

function getContent(): HTMLElement {
  const content = getCanvas().querySelector<HTMLElement>(".origin-top-left");
  if (!content) {
    throw new Error("viewer content was not rendered");
  }
  return content;
}

const originalSetPointerCaptureDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "setPointerCapture"
);
