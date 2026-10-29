// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreOwnProperty } from "./__tests__/dom-property";
import { exportPng, exportSvg, fitNodeLabels } from "./mermaid-viewer-utils";

const SVG_NS = "http://www.w3.org/2000/svg";
const OBJECT_URL = "blob:mermaid-export";
const RE_SVG_DATA_URL_PREFIX = /^data:image\/svg\+xml;base64,/;

function svgWithLabels(...foreignObjects: string[]): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = `<svg xmlns="${SVG_NS}">${foreignObjects.join("")}</svg>`;
  return root;
}

function labelDiv(root: HTMLElement, index = 0): HTMLDivElement {
  // jsdom's selector engine does not match `foreignObject div` as one
  // descendant selector, so look up in two steps like the source does.
  const div = root
    .querySelectorAll("foreignObject")
    [index]?.querySelector("div");
  if (!(div instanceof HTMLDivElement)) {
    throw new Error(`no label div at index ${index}`);
  }
  return div;
}

function setScrollHeight(element: Element, value: number): void {
  Object.defineProperty(element, "scrollHeight", {
    value,
    configurable: true,
  });
}

describe("fitNodeLabels", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shrinks an overflowing label proportionally with a 10% margin", () => {
    const root = svgWithLabels(
      '<foreignObject height="20"><div>wrapped label</div></foreignObject>'
    );
    const div = labelDiv(root);
    setScrollHeight(div, 40);

    fitNodeLabels(root);

    // ratio 0.5 × base 16 (jsdom's computed "16px", not the fallback) × 0.9 = 7.2
    expect(div.style.fontSize).toBe("7.2px");
  });

  it("uses the computed font size as the base when the browser reports one", () => {
    const root = svgWithLabels(
      '<foreignObject height="20"><div>wrapped label</div></foreignObject>'
    );
    const div = labelDiv(root);
    setScrollHeight(div, 40);
    const computed = document.createElement("span").style;
    computed.fontSize = "20px";
    vi.spyOn(window, "getComputedStyle").mockReturnValue(computed);

    fitNodeLabels(root);

    expect(div.style.fontSize).toBe("9px");
  });

  it("falls back to a 16px base when the computed font size is empty", () => {
    const root = svgWithLabels(
      '<foreignObject height="20"><div>wrapped label</div></foreignObject>'
    );
    const div = labelDiv(root);
    setScrollHeight(div, 40);
    const computed = document.createElement("span").style;
    vi.spyOn(window, "getComputedStyle").mockReturnValue(computed);

    fitNodeLabels(root);

    expect(computed.fontSize).toBe("");
    expect(div.style.fontSize).toBe("7.2px");
  });

  it("never shrinks below the 6px floor", () => {
    const root = svgWithLabels(
      '<foreignObject height="10"><div>x</div></foreignObject>'
    );
    const div = labelDiv(root);
    setScrollHeight(div, 1000);

    fitNodeLabels(root);

    expect(div.style.fontSize).toBe("6px");
  });

  it("leaves a label alone when its content fits the declared height", () => {
    const root = svgWithLabels(
      '<foreignObject height="20"><div>fits</div></foreignObject>'
    );
    const div = labelDiv(root);
    setScrollHeight(div, 20);

    fitNodeLabels(root);

    expect(div.style.fontSize).toBe("");
  });

  it("skips a foreignObject with no div and still fits the next one", () => {
    const root = svgWithLabels(
      '<foreignObject height="20"><span>no div</span></foreignObject>',
      '<foreignObject height="20"><div>wrapped label</div></foreignObject>'
    );
    const div = labelDiv(root, 1);
    setScrollHeight(div, 40);

    fitNodeLabels(root);

    expect(div.style.fontSize).toBe("7.2px");
  });

  it.each([
    ["missing", "<foreignObject><div>x</div></foreignObject>"],
    ["zero", '<foreignObject height="0"><div>x</div></foreignObject>'],
    ["negative", '<foreignObject height="-5"><div>x</div></foreignObject>'],
  ])("skips a foreignObject whose height is %s", (_label, markup) => {
    const root = svgWithLabels(markup);
    const div = labelDiv(root);
    setScrollHeight(div, 1000);

    fitNodeLabels(root);

    expect(div.style.fontSize).toBe("");
  });

  it("is idempotent: an already-adjusted label is not re-measured", () => {
    const root = svgWithLabels(
      '<foreignObject height="20"><div>done</div></foreignObject>'
    );
    const div = labelDiv(root);
    div.style.fontSize = "12px";
    setScrollHeight(div, 1000);

    fitNodeLabels(root);

    expect(div.style.fontSize).toBe("12px");
  });
});

class FakeImage {
  static fail = false;
  static last: FakeImage | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  #src = "";

  constructor() {
    FakeImage.last = this;
  }

  get src(): string {
    return this.#src;
  }

  set src(value: string) {
    this.#src = value;
    queueMicrotask(() => {
      if (FakeImage.fail) {
        this.onerror?.();
      } else {
        this.onload?.();
      }
    });
  }
}

type DownloadSpies = {
  createObjectURL: ReturnType<typeof vi.fn>;
  revokeObjectURL: ReturnType<typeof vi.fn>;
  click: ReturnType<typeof vi.spyOn>;
  appendChild: ReturnType<typeof vi.spyOn>;
  removeChild: ReturnType<typeof vi.spyOn>;
};

function appendedAnchor(spies: DownloadSpies): HTMLAnchorElement {
  const node = spies.appendChild.mock.calls[0]?.[0];
  if (!(node instanceof HTMLAnchorElement)) {
    throw new Error("downloadBlob did not append an anchor");
  }
  return node;
}

describe("downloads", () => {
  const originalCreate = Object.getOwnPropertyDescriptor(
    URL,
    "createObjectURL"
  );
  const originalRevoke = Object.getOwnPropertyDescriptor(
    URL,
    "revokeObjectURL"
  );
  let spies: DownloadSpies;

  beforeEach(() => {
    const createObjectURL = vi.fn(() => OBJECT_URL);
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectURL,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectURL,
      configurable: true,
      writable: true,
    });
    spies = {
      createObjectURL,
      revokeObjectURL,
      click: vi
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(() => undefined),
      appendChild: vi.spyOn(document.body, "appendChild"),
      removeChild: vi.spyOn(document.body, "removeChild"),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    restoreOwnProperty(URL, "createObjectURL", originalCreate);
    restoreOwnProperty(URL, "revokeObjectURL", originalRevoke);
    FakeImage.fail = false;
    FakeImage.last = null;
  });

  describe("exportSvg", () => {
    it("downloads the SVG text as an image/svg+xml blob and cleans up", () => {
      const svg = "<svg><text>ü</text></svg>";

      exportSvg(svg, "diagram.svg");

      const blob = spies.createObjectURL.mock.calls[0]?.[0];
      if (!(blob instanceof Blob)) {
        throw new Error("exportSvg did not create an object URL for a Blob");
      }
      expect(blob.type).toBe("image/svg+xml;charset=utf-8");
      expect(blob.size).toBe(new TextEncoder().encode(svg).byteLength);
      const anchor = appendedAnchor(spies);
      expect(anchor.download).toBe("diagram.svg");
      expect(anchor.href).toBe(OBJECT_URL);
      expect(spies.click).toHaveBeenCalledOnce();
      expect(spies.removeChild).toHaveBeenCalledWith(anchor);
      expect(spies.revokeObjectURL).toHaveBeenCalledWith(OBJECT_URL);
      expect(document.body.contains(anchor)).toBe(false);
    });
  });

  describe("exportPng", () => {
    type FakeContext = Pick<
      CanvasRenderingContext2D,
      "fillRect" | "scale" | "drawImage"
    > & { fillStyle: string };

    type StubbedCanvas = {
      ctx: FakeContext;
      getContext: ReturnType<typeof vi.spyOn>;
      toBlob: ReturnType<typeof vi.spyOn>;
    };

    function stubCanvas(pngBlob: Blob | null): StubbedCanvas {
      const ctx: FakeContext = {
        fillStyle: "",
        fillRect: vi.fn(),
        scale: vi.fn(),
        drawImage: vi.fn(),
      };
      const getContext = vi
        .spyOn(HTMLCanvasElement.prototype, "getContext")
        .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
      const toBlob = vi
        .spyOn(HTMLCanvasElement.prototype, "toBlob")
        .mockImplementation((callback) => callback(pngBlob));
      return { ctx, getContext, toBlob };
    }

    function rasterizedCanvas(stub: StubbedCanvas): HTMLCanvasElement {
      const canvas = stub.toBlob.mock.instances[0];
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error("exportPng did not call toBlob on a canvas");
      }
      return canvas;
    }

    beforeEach(() => {
      vi.stubGlobal("Image", FakeImage);
    });

    it("rejects when the SVG image fails to load", async () => {
      FakeImage.fail = true;

      await expect(exportPng("<svg/>", 10, 10, "d.png")).rejects.toThrow(
        "Failed to load SVG"
      );
      expect(spies.createObjectURL).not.toHaveBeenCalled();
    });

    it("loads the SVG from an inline base64 data URL, not a blob URL", async () => {
      stubCanvas(new Blob(["png"], { type: "image/png" }));
      const svg = '<svg viewBox="0 0 1 1"><text>ünïcode</text></svg>';

      await exportPng(svg, 10, 10, "d.png");

      const src = FakeImage.last?.src ?? "";
      expect(src).toMatch(RE_SVG_DATA_URL_PREFIX);
      const payload = src.replace(RE_SVG_DATA_URL_PREFIX, "");
      const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
      expect(new TextDecoder().decode(bytes)).toBe(svg);
    });

    it("rejects when the canvas yields no 2d context", async () => {
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

      await expect(exportPng("<svg/>", 10, 10, "d.png")).rejects.toThrow(
        "Failed to get canvas context"
      );
      expect(spies.createObjectURL).not.toHaveBeenCalled();
    });

    it("rasterizes at 2x on a white background and downloads the PNG", async () => {
      const png = new Blob(["png"], { type: "image/png" });
      const stub = stubCanvas(png);
      const { ctx } = stub;

      await exportPng("<svg/>", 120.4, 80.6, "diagram.png");

      const canvas = rasterizedCanvas(stub);
      expect(stub.getContext).toHaveBeenCalledWith("2d");
      expect(canvas.width).toBe(241);
      expect(canvas.height).toBe(161);
      expect(ctx.fillStyle).toBe("#ffffff");
      expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 241, 161);
      expect(ctx.scale).toHaveBeenCalledWith(2, 2);
      expect(ctx.drawImage).toHaveBeenCalledWith(
        FakeImage.last,
        0,
        0,
        120.4,
        80.6
      );
      expect(stub.toBlob).toHaveBeenCalledWith(
        expect.any(Function),
        "image/png"
      );
      expect(spies.createObjectURL).toHaveBeenCalledWith(png);
      expect(appendedAnchor(spies).download).toBe("diagram.png");
      expect(spies.click).toHaveBeenCalledOnce();
    });

    it("never creates a 0-pixel canvas for a degenerate size", async () => {
      const stub = stubCanvas(new Blob(["png"], { type: "image/png" }));

      await exportPng("<svg/>", 0, 0.2, "tiny.png");

      const canvas = rasterizedCanvas(stub);
      expect(canvas.width).toBe(1);
      expect(canvas.height).toBe(1);
    });

    it("resolves without downloading when toBlob yields null", async () => {
      stubCanvas(null);

      await expect(
        exportPng("<svg/>", 10, 10, "d.png")
      ).resolves.toBeUndefined();

      expect(spies.createObjectURL).not.toHaveBeenCalled();
      expect(spies.click).not.toHaveBeenCalled();
    });
  });
});
