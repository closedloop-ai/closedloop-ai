import { GitHubDiffSide } from "@repo/api/src/types/branch-view";

/** Build the right-side line identifier expected by react-diff-viewer. */
export function getRightLineHighlightId(line: number): string {
  return `R-${line}`;
}

const LINE_NUMBER_PATTERN = /^\d+$/;
const RENDERED_LINE_ID_PATTERN = /^([LR])-(\d+)$/;

export type RenderedDiffLineAnchor = {
  line: number;
  side: GitHubDiffSide;
};

/** Build the left-side line identifier expected by react-diff-viewer. */
export function getLeftLineHighlightId(line: number): string {
  return `L-${line}`;
}

/** Parse a react-diff-viewer split-view line id into a GitHub review anchor. */
export function parseRenderedDiffLineAnchor(
  lineId: string
): RenderedDiffLineAnchor | null {
  const match = RENDERED_LINE_ID_PATTERN.exec(lineId.trim());
  if (!match) {
    return null;
  }
  return {
    line: Number(match[2]),
    side: match[1] === "L" ? GitHubDiffSide.Left : GitHubDiffSide.Right,
  };
}

/** Detect whether react-diff-viewer has finished inserting any table rows. */
export function hasRenderedDiffRows(root: HTMLElement): boolean {
  return root.querySelector("tr") !== null;
}

function parseLineNumber(text: string | null | undefined): number | null {
  const trimmed = text?.trim();
  if (!(trimmed && LINE_NUMBER_PATTERN.test(trimmed))) {
    return null;
  }
  return Number(trimmed);
}

function findLineNumberBeforeContentCell(
  contentCell: HTMLTableCellElement,
  stopAtContentClass?: "left" | "right"
): number | null {
  let sibling = contentCell.previousElementSibling;
  while (sibling instanceof HTMLTableCellElement) {
    if (stopAtContentClass && sibling.classList.contains(stopAtContentClass)) {
      break;
    }
    const lineNumber = parseLineNumber(
      sibling.querySelector("pre")?.textContent
    );
    if (lineNumber !== null) {
      return lineNumber;
    }
    sibling = sibling.previousElementSibling;
  }
  return null;
}

/**
 * Find the rendered split-view table row for a right-side diff line.
 *
 * react-diff-viewer renders each split-view side as gutter, optional custom
 * gutter, marker, and content cells. Anchor on the right content cell and scan
 * backward for the nearest matching gutter so left-side gutters and code cells
 * with duplicate text cannot be mistaken for the target line.
 */
export function findRenderedRightLineRow(
  root: HTMLElement,
  line: number
): HTMLTableRowElement | null {
  const rows = root.querySelectorAll("tr");

  for (const row of rows) {
    if (!(row instanceof HTMLTableRowElement) || row.cells.length < 2) {
      continue;
    }

    const rightContentCells = Array.from(row.cells).filter((cell) =>
      cell.classList.contains("right")
    );
    for (const rightContentCell of rightContentCells) {
      if (findLineNumberBeforeContentCell(rightContentCell, "left") === line) {
        return row;
      }
    }
  }

  return null;
}

/**
 * Build all highlight IDs for a rendered split-view row.
 *
 * react-diff-viewer highlights each side independently (`L-*` and `R-*`).
 * Supplying both IDs gives the branch target a GitHub-like row-wide highlight
 * while still handling added-only or empty-side rows by returning only the
 * side(s) that have a rendered line number.
 */
export function getRenderedSplitRowHighlightIds(
  row: HTMLTableRowElement
): string[] {
  const ids: string[] = [];
  const leftContentCell = Array.from(row.cells).find((cell) =>
    cell.classList.contains("left")
  );
  if (leftContentCell instanceof HTMLTableCellElement) {
    const leftLine = findLineNumberBeforeContentCell(leftContentCell);
    if (leftLine !== null) {
      ids.push(getLeftLineHighlightId(leftLine));
    }
  }

  const rightContentCell = Array.from(row.cells).find((cell) =>
    cell.classList.contains("right")
  );
  if (rightContentCell instanceof HTMLTableCellElement) {
    const rightLine = findLineNumberBeforeContentCell(rightContentCell, "left");
    if (rightLine !== null) {
      ids.push(getRightLineHighlightId(rightLine));
    }
  }

  return ids;
}

/**
 * Collect the line numbers currently rendered for one split-view side.
 *
 * react-diff-viewer renders only hunk + context rows, so folds between hunks
 * leave gaps in the returned set. Range selection uses this to keep a multi-line
 * comment within a single contiguous hunk.
 */
export function collectRenderedLineNumbers(
  root: HTMLElement,
  side: GitHubDiffSide
): Set<number> {
  const lineNumbers = new Set<number>();
  const contentClass = side === GitHubDiffSide.Right ? "right" : "left";
  const stopAtClass = side === GitHubDiffSide.Right ? "left" : undefined;
  for (const row of root.querySelectorAll("tr")) {
    if (!(row instanceof HTMLTableRowElement)) {
      continue;
    }
    const contentCell = Array.from(row.cells).find((cell) =>
      cell.classList.contains(contentClass)
    );
    if (contentCell instanceof HTMLTableCellElement) {
      const line = findLineNumberBeforeContentCell(contentCell, stopAtClass);
      if (line !== null) {
        lineNumbers.add(line);
      }
    }
  }
  return lineNumbers;
}

/**
 * Clamp a pivot-to-target selection to the contiguous block of rendered lines
 * that contains the pivot. A fold/gap between the pivot and the target caps the
 * range at the last consecutive line, so the selection can never cross a hunk
 * boundary (which GitHub rejects for multi-line comments).
 */
export function clampRangeToContiguous(
  rendered: Set<number>,
  pivot: number,
  target: number
): { startLine: number; endLine: number } {
  const low = Math.min(pivot, target);
  const high = Math.max(pivot, target);
  if (!rendered.has(pivot)) {
    return { endLine: high, startLine: low };
  }
  let blockMin = pivot;
  while (rendered.has(blockMin - 1)) {
    blockMin -= 1;
  }
  let blockMax = pivot;
  while (rendered.has(blockMax + 1)) {
    blockMax += 1;
  }
  return {
    endLine: Math.min(high, blockMax),
    startLine: Math.max(low, blockMin),
  };
}

/** Locate the design-system ScrollArea viewport that owns the diff scroll. */
export function findScrollAreaViewport(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
}

function isScrollableElement(element: HTMLElement): boolean {
  return element.scrollHeight - element.clientHeight > 1;
}

function uniqueElements(elements: Array<HTMLElement | null>): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  const unique: HTMLElement[] = [];
  for (const element of elements) {
    if (!element || seen.has(element)) {
      continue;
    }
    seen.add(element);
    unique.push(element);
  }
  return unique;
}

function getScrollableAncestors(
  root: HTMLElement,
  row: HTMLElement
): HTMLElement[] {
  const ancestors: Array<HTMLElement | null> = [findScrollAreaViewport(root)];
  let current = row.parentElement;
  while (current) {
    ancestors.push(current);
    current = current.parentElement;
  }
  const documentScroller = root.ownerDocument.scrollingElement;
  if (documentScroller instanceof HTMLElement) {
    ancestors.push(documentScroller);
  }
  return uniqueElements(ancestors).filter(isScrollableElement);
}

/**
 * Compute the scrollTop that centers a rendered diff row inside a scroll
 * container. This uses geometry relative to the container instead of relying on
 * Element.scrollIntoView choosing the correct scroll ancestor.
 */
export function getCenteredRowScrollTop(
  viewport: HTMLElement,
  row: HTMLElement
): number {
  const viewportRect = viewport.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const rowTopInViewport = rowRect.top - viewportRect.top;
  return Math.max(
    0,
    viewport.scrollTop +
      rowTopInViewport -
      (viewport.clientHeight - rowRect.height) / 2
  );
}

function scrollElementTo(element: HTMLElement, top: number): void {
  if (typeof element.scrollTo === "function") {
    element.scrollTo({ top });
  } else {
    element.scrollTop = top;
  }
}

/** Scroll the effective diff viewport until the target row is centered. */
export function scrollRowIntoDiffViewport(
  root: HTMLElement,
  row: HTMLElement
): boolean {
  for (const scrollContainer of getScrollableAncestors(root, row)) {
    const previousScrollTop = scrollContainer.scrollTop;
    const top = getCenteredRowScrollTop(scrollContainer, row);
    scrollElementTo(scrollContainer, top);
    if (
      Math.abs(scrollContainer.scrollTop - previousScrollTop) > 0.5 ||
      Math.abs(top - previousScrollTop) <= 0.5
    ) {
      return true;
    }
  }
  return false;
}
