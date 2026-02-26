import type { JSONContent } from "@tiptap/react";

const COMMENT_MARK_TYPE = "liveblocksCommentMark";

/**
 * Extracts plain text from a TipTap JSON node by recursively joining text nodes.
 */
function nodeToPlainText(node: JSONContent): string {
  if (node.type === "text") {
    return node.text ?? "";
  }
  if (!node.content) {
    return "";
  }
  return node.content.map(nodeToPlainText).join("");
}

/**
 * Checks whether a node (or any descendant) has a liveblocksCommentMark.
 */
function hasCommentMark(node: JSONContent): boolean {
  if (node.marks?.some((m) => m.type === COMMENT_MARK_TYPE)) {
    return true;
  }
  if (!node.content) {
    return false;
  }
  return node.content.some(hasCommentMark);
}

/**
 * Merges Liveblocks comment marks from the current editor state into a snapshot.
 *
 * For each top-level block whose plain text is unchanged between the snapshot
 * and the current document, the current block's content (including thread marks)
 * replaces the snapshot's. This preserves comment anchoring on unchanged text
 * while still reverting content edits.
 *
 * Thread marks on text that was modified or added during editing cannot be
 * reliably re-anchored and will be lost.
 */
export function mergeCommentMarks(
  snapshot: JSONContent,
  current: JSONContent
): JSONContent {
  if (!(snapshot.content && current.content)) {
    return snapshot;
  }

  // Quick check: if no comment marks in current doc, snapshot is fine as-is
  if (!hasCommentMark(current)) {
    return snapshot;
  }

  const merged = structuredClone(snapshot);

  // Build a map: plain text → content arrays, for current blocks with comment marks.
  // Uses an array per key to handle duplicate text across blocks (FIFO matching).
  const currentBlocksByText = new Map<string, JSONContent[][]>();
  for (const block of current.content) {
    if (!hasCommentMark(block)) {
      continue;
    }
    const text = nodeToPlainText(block);
    if (!text) {
      continue;
    }
    const entries = currentBlocksByText.get(text) ?? [];
    entries.push(block.content ?? []);
    currentBlocksByText.set(text, entries);
  }

  // Walk merged content and swap in current content arrays where text matches
  for (const block of merged.content!) {
    const text = nodeToPlainText(block);
    if (!text) {
      continue;
    }
    const entries = currentBlocksByText.get(text);
    if (entries && entries.length > 0) {
      block.content = structuredClone(entries.shift()!);
      if (entries.length === 0) {
        currentBlocksByText.delete(text);
      }
    }
  }

  return merged;
}
