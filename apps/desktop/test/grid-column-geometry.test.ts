import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { Locator } from "@playwright/test";
import ts from "typescript6";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const geometrySchema = z.object({
  measurePinnedCellSample: z.custom<
    (
      element: Element,
      args: { coveredElement: Element; sample: "center" | "covered-right-edge" }
    ) => boolean
  >((value) => typeof value === "function"),
  pinnedCellIsTopmost: z.custom<
    (
      pinned: Locator,
      covered: Locator,
      sample?: "center" | "covered-right-edge"
    ) => Promise<boolean>
  >((value) => typeof value === "function"),
});
const { measurePinnedCellSample, pinnedCellIsTopmost } = loadGeometry();

describe("atomic grid overlap sample", () => {
  it.each([
    ["center", 35],
    ["covered-right-edge", 48],
  ] as const)("samples %s with both current rectangles", (sample, x) => {
    const { pinned, covered, hitTest, reads } = makeCells();
    expect(
      measurePinnedCellSample(pinned, { coveredElement: covered, sample })
    ).toBe(true);
    expect(hitTest).toHaveBeenCalledWith(x, 30);
    expect(reads).toEqual(["pinned", "covered", "hit"]);
  });

  it("keeps the half-pixel inset for a narrow overlap", () => {
    const { pinned, covered, hitTest } = makeCells({
      x: 49,
      y: 20,
      width: 10,
      height: 20,
    });
    expect(
      measurePinnedCellSample(pinned, {
        coveredElement: covered,
        sample: "covered-right-edge",
      })
    ).toBe(true);
    expect(hitTest).toHaveBeenCalledWith(49.5, 30);
  });

  it("accepts a pinned descendant but rejects a foreign occluder and no hit", () => {
    const cells = makeCells();
    const child = {} as Element;
    cells.contains.mockReturnValue(true);
    cells.hitTest.mockReturnValue(child);
    expect(
      measurePinnedCellSample(cells.pinned, {
        coveredElement: cells.covered,
        sample: "center",
      })
    ).toBe(true);
    cells.contains.mockReturnValue(false);
    expect(
      measurePinnedCellSample(cells.pinned, {
        coveredElement: cells.covered,
        sample: "center",
      })
    ).toBe(false);
    cells.hitTest.mockReturnValue(null);
    expect(
      measurePinnedCellSample(cells.pinned, {
        coveredElement: cells.covered,
        sample: "center",
      })
    ).toBe(false);
  });

  it.each([
    { x: 50, y: 20, width: 10, height: 20 },
    { x: 20, y: 40, width: 10, height: 20 },
  ])("rejects a missing overlap without hit testing", (rect) => {
    const cells = makeCells(rect);
    expect(() =>
      measurePinnedCellSample(cells.pinned, {
        coveredElement: cells.covered,
        sample: "center",
      })
    ).toThrow("Grid cells do not overlap");
    expect(cells.hitTest).not.toHaveBeenCalled();
  });

  it("rejects an element with no rendered box", () => {
    const cells = makeCells();
    cells.covered.getClientRects = () => ({ length: 0 }) as DOMRectList;
    expect(() =>
      measurePinnedCellSample(cells.pinned, {
        coveredElement: cells.covered,
        sample: "center",
      })
    ).toThrow("no measurable bounds");
  });

  it("rejects incompatible document coordinate systems", () => {
    const cells = makeCells();
    const other = makeCells();
    expect(() =>
      measurePinnedCellSample(cells.pinned, {
        coveredElement: other.covered,
        sample: "center",
      })
    ).toThrow("one document");
  });

  it("invokes the atomic browser callback through the shipped locator wrapper", async () => {
    const cells = makeCells();
    const handle = { dispose: vi.fn().mockResolvedValue(undefined) };
    const evaluate = vi
      .fn()
      .mockImplementation(
        async (
          callback: typeof measurePinnedCellSample,
          args: { sample: "center" | "covered-right-edge" }
        ) =>
          callback(cells.pinned, {
            coveredElement: cells.covered,
            sample: args.sample,
          })
      );
    const pinned: Partial<Locator> = {
      evaluate,
      boundingBox: vi.fn(),
    };
    const elementHandle = vi.fn().mockResolvedValue(handle);
    const covered: Partial<Locator> = {
      elementHandle,
      boundingBox: vi.fn(),
    };
    expect(
      await pinnedCellIsTopmost(
        pinned as Locator,
        covered as Locator,
        "covered-right-edge"
      )
    ).toBe(true);
    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate).toHaveBeenCalledWith(measurePinnedCellSample, {
      coveredElement: handle,
      sample: "covered-right-edge",
    });
    expect(pinned.boundingBox).not.toHaveBeenCalled();
    expect(covered.boundingBox).not.toHaveBeenCalled();
    expect(handle.dispose).toHaveBeenCalledOnce();
  });

  it("retains the sample error before an independent release error", async () => {
    const primary = new Error("hit test failed");
    const cleanup = new Error("handle release failed");
    const dispose = vi.fn().mockRejectedValue(cleanup);
    const pinned = {
      evaluate: vi.fn().mockRejectedValue(primary),
    } as Partial<Locator>;
    const covered = {
      elementHandle: vi.fn().mockResolvedValue({ dispose }),
    } as Partial<Locator>;
    const result = await pinnedCellIsTopmost(
      pinned as Locator,
      covered as Locator
    ).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    if (!(result instanceof AggregateError)) {
      throw new Error("Missing sample and cleanup errors");
    }
    expect(result.errors).toEqual([primary, cleanup]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("propagates the original sample failure after releasing its handle", async () => {
    const primary = new Error("hit test failed");
    const dispose = vi.fn().mockResolvedValue(undefined);
    const pinned = {
      evaluate: vi.fn().mockRejectedValue(primary),
    } as Partial<Locator>;
    const covered = {
      elementHandle: vi.fn().mockResolvedValue({ dispose }),
    } as Partial<Locator>;
    await expect(
      pinnedCellIsTopmost(pinned as Locator, covered as Locator)
    ).rejects.toBe(primary);
    expect(dispose).toHaveBeenCalledOnce();
  });
});

function makeCells(coveredRect = { x: 20, y: 20, width: 60, height: 20 }) {
  const reads: string[] = [];
  const hitTest = vi.fn<(x: number, y: number) => Element | null>();
  const ownerDocument: Partial<Document> = { elementFromPoint: hitTest };
  const contains = vi
    .fn<(node: Node | null) => boolean>()
    .mockReturnValue(false);
  const pinned = {
    ownerDocument: ownerDocument as Document,
    contains,
    getClientRects: () => ({ length: 1 }) as DOMRectList,
    getBoundingClientRect: () => {
      reads.push("pinned");
      return { x: 0, y: 10, width: 50, height: 30 } as DOMRect;
    },
  } as Partial<Element>;
  const covered = {
    ownerDocument: ownerDocument as Document,
    getClientRects: () => ({ length: 1 }) as DOMRectList,
    getBoundingClientRect: () => {
      reads.push("covered");
      return coveredRect as DOMRect;
    },
  } as Partial<Element>;
  hitTest.mockImplementation(() => {
    reads.push("hit");
    return pinned as Element;
  });
  return {
    pinned: pinned as Element,
    covered: covered as Element,
    hitTest,
    reads,
    contains,
  };
}

/** Execute the shipped module without widening Desktop's Node-test source root. */
function loadGeometry() {
  const source = ts.createSourceFile(
    "e2e/helpers/grid-column-geometry.ts",
    readFileSync(
      new URL("../../../e2e/helpers/grid-column-geometry.ts", import.meta.url),
      "utf8"
    ),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const program = ts.transpileModule(ts.createPrinter().printFile(source), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const exports = {};
  runInNewContext(program, { exports, AggregateError, Error });
  return geometrySchema.parse(exports);
}
