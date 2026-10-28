import type {
  TraceSelectionDraft,
  TraceTextHighlight,
} from "./session-trace-contract";
import type { TraceTextAnchor } from "./trace-comments";

const MARKDOWN_IMAGE_PATTERN = /^!\[([^\]]*)\]\([^)]+\)/;
const MARKDOWN_LINK_PATTERN = /^\[([^\]]+)\]\([^)]+\)/;
const MARKDOWN_EMPHASIS_PATTERN = /^(\*\*|__|\*|_|~~|`)(.*?)\1/;

const TRACE_COMMENT_POPOVER_GUTTER = 8;
const TRACE_COMMENT_COMPOSER_MAX_WIDTH = 340;

export function resolveTraceSelection(
  selection: Selection | null | undefined,
  root: HTMLElement | null
): TraceSelectionDraft | null {
  if (
    !(selection && root && selection.rangeCount > 0 && !selection.isCollapsed)
  ) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) {
    return null;
  }
  const anchorElement = getSelectionElement(range.startContainer);
  const focusElement = getSelectionElement(range.endContainer);
  const startSource = anchorElement?.closest<HTMLElement>(
    "[data-trace-text-row][data-trace-text]"
  );
  const endSource = focusElement?.closest<HTMLElement>(
    "[data-trace-text-row][data-trace-text]"
  );
  if (!(startSource && endSource && startSource === endSource)) {
    return null;
  }
  const row = Number(startSource.dataset.traceTextRow);
  const sourceText =
    startSource.textContent ?? startSource.dataset.traceText ?? "";
  const traceId = startSource.dataset.traceId;
  const turnId = startSource.dataset.traceTurnId;
  const offsets = getRangeTextOffsets(startSource, range);
  const selectedText = selection.toString();
  const trimmedSelection = selectedText.trim();
  if (
    !(
      Number.isFinite(row) &&
      sourceText &&
      trimmedSelection &&
      offsets &&
      traceId &&
      turnId
    )
  ) {
    return null;
  }
  const leadingTrim = selectedText.length - selectedText.trimStart().length;
  const startOffset = offsets.startOffset + leadingTrim;
  const endOffset = startOffset + trimmedSelection.length;
  if (
    startOffset < 0 ||
    endOffset > sourceText.length ||
    sourceText.slice(startOffset, endOffset) !== trimmedSelection
  ) {
    return null;
  }
  const rect = getTraceRangeRect(range);
  const rootRect = root.getBoundingClientRect();
  return {
    anchor: {
      actor: {
        human: startSource.dataset.traceHuman || null,
        name: startSource.dataset.traceActor || "Agent",
      },
      endOffset,
      row,
      selectedText: trimmedSelection,
      sessionId: startSource.dataset.traceSessionId || null,
      sourceText,
      startOffset,
      traceId,
      turnId,
    },
    mode: "affordance",
    position: {
      x: getTraceCommentPopoverX(rect, rootRect),
      y: Math.max(
        TRACE_COMMENT_POPOVER_GUTTER,
        rect.bottom - rootRect.top + TRACE_COMMENT_POPOVER_GUTTER
      ),
    },
  };
}

function getTraceCommentPopoverX(rect: DOMRect, rootRect: DOMRect): number {
  const rootWidth = Math.max(0, rootRect.width);
  const composerWidth = Math.min(
    TRACE_COMMENT_COMPOSER_MAX_WIDTH,
    Math.max(0, rootWidth - TRACE_COMMENT_POPOVER_GUTTER * 2)
  );
  const maxX = rootWidth
    ? Math.max(
        TRACE_COMMENT_POPOVER_GUTTER,
        rootWidth - composerWidth - TRACE_COMMENT_POPOVER_GUTTER
      )
    : TRACE_COMMENT_POPOVER_GUTTER;
  const selectionX = rect.left - rootRect.left;

  if (!Number.isFinite(selectionX)) {
    return TRACE_COMMENT_POPOVER_GUTTER;
  }

  return Math.min(Math.max(TRACE_COMMENT_POPOVER_GUTTER, selectionX), maxX);
}

function getSelectionElement(node: Node): Element | null {
  if (node instanceof Element) {
    return node;
  }
  return node.parentNode instanceof Element ? node.parentNode : null;
}

function getRangeTextOffsets(
  source: HTMLElement,
  range: Range
): { startOffset: number; endOffset: number } | null {
  try {
    const beforeStart = source.ownerDocument.createRange();
    beforeStart.selectNodeContents(source);
    beforeStart.setEnd(range.startContainer, range.startOffset);
    const beforeEnd = source.ownerDocument.createRange();
    beforeEnd.selectNodeContents(source);
    beforeEnd.setEnd(range.endContainer, range.endOffset);
    return {
      startOffset: beforeStart.toString().length,
      endOffset: beforeEnd.toString().length,
    };
  } catch {
    return null;
  }
}

function getTraceRangeRect(range: Range): DOMRect {
  if ("getBoundingClientRect" in range) {
    return range.getBoundingClientRect();
  }
  return {
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    toJSON: () => ({}),
    top: 0,
    width: 0,
    x: 0,
    y: 0,
  };
}

export function getTraceTextHighlight(
  anchor: TraceTextAnchor | null | undefined,
  row: number,
  sourceText: string,
  traceId: string,
  turnId: string
): TraceTextHighlight | null {
  if (
    !anchor ||
    anchor.row !== row ||
    anchor.traceId !== traceId ||
    anchor.turnId !== turnId
  ) {
    return null;
  }
  if (
    anchor.sourceText === sourceText &&
    anchor.startOffset >= 0 &&
    anchor.endOffset > anchor.startOffset &&
    anchor.endOffset <= sourceText.length &&
    sourceText.slice(anchor.startOffset, anchor.endOffset) ===
      anchor.selectedText
  ) {
    return {
      kind: "exact",
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset,
    };
  }
  const renderedText = getMarkdownRenderedText(sourceText);
  if (
    anchor.sourceText === renderedText &&
    anchor.startOffset >= 0 &&
    anchor.endOffset > anchor.startOffset &&
    anchor.endOffset <= renderedText.length &&
    renderedText.slice(anchor.startOffset, anchor.endOffset) ===
      anchor.selectedText
  ) {
    return {
      kind: "exact",
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset,
    };
  }
  return { kind: "row" };
}

/**
 * Computes the same rendered-text coordinate space used by browser selections
 * for inline markdown constructs that hide delimiters while preserving visible
 * labels/content.
 */
function getMarkdownRenderedText(sourceText: string): string {
  let out = "";
  for (let index = 0; index < sourceText.length; index += 1) {
    const textFromIndex = sourceText.slice(index);
    const imageMatch = textFromIndex.match(MARKDOWN_IMAGE_PATTERN);
    const linkMatch = textFromIndex.match(MARKDOWN_LINK_PATTERN);
    const emphasisMatch = textFromIndex.match(MARKDOWN_EMPHASIS_PATTERN);
    const match = imageMatch ?? linkMatch ?? emphasisMatch;

    if (match) {
      const visibleText = match[2] ?? match[1] ?? "";
      out += visibleText;
      index += match[0].length - 1;
      continue;
    }

    out += sourceText[index];
  }
  return out;
}
