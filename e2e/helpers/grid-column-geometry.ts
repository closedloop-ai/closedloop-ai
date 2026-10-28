import type { Locator } from "@playwright/test";

/** Read the rendered track, which a resize changes even when its label does not. */
export async function headerWidth(header: Locator): Promise<number> {
  const box = await header.boundingBox();
  if (!box) {
    throw new Error("The column header has no measurable bounds");
  }
  return box.width;
}

/** Compare a pinned cell with a neighboring track through a real scroll. */
export async function leftEdge(locator: Locator): Promise<number> {
  const box = await locator.first().boundingBox();
  if (!box) {
    throw new Error("The grid cell has no measurable bounds");
  }
  return box.x;
}

/** Read the painted background alpha so an opaque pin cannot become translucent on hover. */
export function backgroundAlpha(
  cell: Locator,
  pseudoElement?: "::before"
): Promise<number> {
  return cell.evaluate((element, pseudo) => {
    const canvas = element.ownerDocument.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d");
    const view = element.ownerDocument.defaultView;
    if (!(context && view)) {
      throw new Error("Grid pin surface cannot be measured");
    }
    context.fillStyle = "rgba(0, 0, 0, 0)";
    context.fillStyle = view.getComputedStyle(element, pseudo).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[3];
  }, pseudoElement);
}

/** Test whether the pin owns a point where another grid cell lies beneath it. */
export async function pinnedCellIsTopmost(
  pinned: Locator,
  covered: Locator,
  sample: "center" | "covered-right-edge" = "center"
): Promise<boolean> {
  const coveredElement = await covered.elementHandle();
  if (!coveredElement) {
    throw new Error("Overlapping grid cells have no measurable bounds");
  }
  const outcome = await pinned
    .evaluate(measurePinnedCellSample, { coveredElement, sample })
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
  try {
    await coveredElement.dispose();
  } catch (cleanupError) {
    if (!outcome.ok) {
      throw new AggregateError(
        [outcome.error, cleanupError],
        "Grid sample failed and its element handle could not be released"
      );
    }
    throw cleanupError;
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

/**
 * Sample both grid cells and their hit target in one browser task. Rectangles
 * and elementFromPoint use the same document viewport;
 * no main-frame boundingBox coordinates cross the evaluation boundary.
 */
export function measurePinnedCellSample(
  element: Element,
  {
    coveredElement,
    sample,
  }: {
    coveredElement: Element;
    sample: "center" | "covered-right-edge";
  }
): boolean {
  if (element.ownerDocument !== coveredElement.ownerDocument) {
    throw new Error("Grid overlap must be sampled in one document");
  }
  if (
    element.getClientRects().length === 0 ||
    coveredElement.getClientRects().length === 0
  ) {
    throw new Error("Overlapping grid cells have no measurable bounds");
  }
  const pinnedBox = element.getBoundingClientRect();
  const coveredBox = coveredElement.getBoundingClientRect();
  const left = Math.max(pinnedBox.x, coveredBox.x);
  const right = Math.min(
    pinnedBox.x + pinnedBox.width,
    coveredBox.x + coveredBox.width
  );
  const top = Math.max(pinnedBox.y, coveredBox.y);
  const bottom = Math.min(
    pinnedBox.y + pinnedBox.height,
    coveredBox.y + coveredBox.height
  );
  if (left >= right || top >= bottom) {
    throw new Error("Grid cells do not overlap at the tested scroll position");
  }
  const x =
    sample === "covered-right-edge"
      ? Math.max(left + 0.5, right - 2)
      : (left + right) / 2;
  const topmost = element.ownerDocument.elementFromPoint(x, (top + bottom) / 2);
  return topmost === element || element.contains(topmost);
}

/** Hover the painted cell without locator hover scrolling away its overlap. */
export async function hoverCellInPlace(cell: Locator): Promise<void> {
  const box = await cell.boundingBox();
  if (!box) {
    throw new Error("The grid cell has no measurable bounds");
  }
  await cell.page().mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}
