import type { SessionTraceItem } from "../session-trace";

/**
 * Shared fixtures/DOM helpers for the SessionTrace test suite. Extracted so the
 * trace-composer tests (@-mention, parsing-bug flag) can live in sibling test
 * files without re-deriving the trace-item builders or the text-selection
 * plumbing, and to keep any single test file under the line ceiling.
 */

/** Regex matching the inline "Comment" affordance button by accessible name. */
export const COMMENT_BUTTON_NAME_RE = /comment/i;

const agentActor = {
  name: "claude-opus-4-8",
  sessionId: "s1",
  human: null,
  color: "var(--primary)",
};

/** Build a `say` trace item at a given row with optional overrides. */
export function sayItem(
  row: number,
  text: string,
  extra: Partial<Extract<SessionTraceItem, { type: "say" }>> = {}
): SessionTraceItem {
  return {
    type: "say",
    _row: row,
    t: "00:00",
    tMs: row,
    cum: 0,
    actor: agentActor,
    text,
    ...extra,
  };
}

/** Select `text` inside the rendered trace, mirroring a real user drag. */
export function selectRenderedText(
  container: HTMLElement,
  text: string,
  occurrence = 0
): Range {
  const node = findTextNode(container, text, occurrence);
  if (!node) {
    throw new Error(`Unable to find text node: ${text}`);
  }
  const value = node.textContent ?? "";
  const start = findOccurrenceIndex(value, text, occurrence);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + text.length);
  const selection = globalThis.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return range;
}

function findTextNode(node: Node, text: string, occurrence = 0): Text | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const value = node.textContent ?? "";
    if (findOccurrenceIndex(value, text, occurrence) >= 0) {
      return node as Text;
    }
  }
  for (const child of Array.from(node.childNodes)) {
    const found = findTextNode(child, text, occurrence);
    if (found) {
      return found;
    }
  }
  return null;
}

function findOccurrenceIndex(value: string, text: string, occurrence: number) {
  let cursor = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    cursor = value.indexOf(text, cursor + 1);
    if (cursor < 0) {
      return -1;
    }
  }
  return cursor;
}
