import { getSchema } from "@tiptap/core";
// biome-ignore lint/performance/noNamespaceImport: lib0 modules are designed for namespace import
import * as buf from "lib0/buffer";
// biome-ignore lint/performance/noNamespaceImport: lib0 modules are designed for namespace import
import * as sha256 from "lib0/hash/sha256";
import { XmlElement, type XmlFragment, type XmlHook, XmlText } from "yjs";
import { z } from "zod";
import { type FlatText, flattenTextBlocks } from "./comment-anchor-flatten";
import { createDocumentExtensions } from "./extensions";
import { LiveblocksSchemaName } from "./liveblocks";

/**
 * Comment anchoring on a document's Yjs fragment, with no Liveblocks client:
 * the Liveblocks path (`@repo/collaboration/server/yjs-anchor`) and the
 * doc-sync service both call it. The comment-mark attribute key
 * (`liveblocksCommentMark--<hashOfJSON>`) is permanent (PLN-2099 E6) and is
 * computed only here.
 */

/** The first occurrence of an anchor: the leaf block, its text nodes, and the offset in their joined text. */
export type AnchorMatch = {
  block: XmlElement;
  textNodes: XmlText[];
  offset: number;
};

export type AnchorLocation =
  | { kind: typeof AnchorKind.Unique; match: AnchorMatch }
  | { kind: typeof AnchorKind.NotFound }
  | { kind: typeof AnchorKind.Ambiguous; matchCount: number };

/**
 * A short hash of a JSON value, y-prosemirror's algorithm.
 * CRITICAL: lib0.encodeAny is order-sensitive -- object key order must match exactly.
 */
export const hashOfJSON = (json: unknown): string => {
  const digest = sha256.digest(buf.encodeAny(json));
  return buf.toBase64(convolute(digest));
};

/** Counts the non-overlapping occurrences of `anchorText` across every leaf block. */
export function locateAnchor(
  fragment: XmlFragment,
  anchorText: string
): AnchorLocation {
  const { matchCount, match } = searchFragment(fragment, anchorText);
  if (matchCount === 0 || match === null) {
    return { kind: AnchorKind.NotFound };
  }
  if (matchCount > 1) {
    return { kind: AnchorKind.Ambiguous, matchCount };
  }
  return { kind: AnchorKind.Unique, match };
}

/** Marks the matched range with a Liveblocks comment mark for `threadId`. Run it inside a transaction. */
export function applyCommentMark(
  match: AnchorMatch,
  anchorText: string,
  threadId: string
): void {
  const { key: attrKey, value: markValue } = commentMarkAttribute(threadId);
  const { textNodes, offset: matchStart } = match;
  const matchEnd = matchStart + anchorText.length;
  let cumulativeOffset = 0;

  for (const node of textNodes) {
    const nodeLen = node.length;
    const nodeStart = cumulativeOffset;
    const nodeEnd = cumulativeOffset + nodeLen;

    if (nodeEnd > matchStart && nodeStart < matchEnd) {
      const localStart = Math.max(0, matchStart - cumulativeOffset);
      const localLen =
        Math.min(nodeLen, matchEnd - cumulativeOffset) - localStart;
      node.format(localStart, localLen, { [attrKey]: markValue });
    }

    cumulativeOffset += nodeLen;
  }
}

/** Each leaf block's text, in document order, joined by `\n`: the text an anchor is matched against. */
export function fragmentPlainText(fragment: XmlFragment): string {
  return collectTextRuns(fragment).text;
}

/** A comment mark's attributes; `orphan` precedes `threadId` because the key hashes them in order. */
export type CommentMarkAttrs = { orphan: boolean; threadId: string };

/** The Yjs text attribute that carries a comment mark for `threadId`: its permanent key and its value. */
export function commentMarkAttribute(
  threadId: string,
  orphan = false
): { key: string; value: CommentMarkAttrs } {
  // CRITICAL: orphan must come before threadId -- lib0.encodeAny is order-sensitive
  const value = { orphan, threadId };
  const markJson = { type: LiveblocksSchemaName.CommentMark, attrs: value };
  return {
    key: `${LiveblocksSchemaName.CommentMark}--${hashOfJSON(markJson)}`,
    value,
  };
}

/**
 * The comment mark a Yjs text attribute carries, or `null` when it carries
 * none. Like y-prosemirror, the hash suffix is not checked: the attribute
 * name says which mark it is and the value holds its attrs.
 */
export function readCommentMarkAttribute(
  key: string,
  value: unknown
): CommentMarkAttrs | null {
  if (
    key !== LiveblocksSchemaName.CommentMark &&
    !key.startsWith(`${LiveblocksSchemaName.CommentMark}--`)
  ) {
    return null;
  }
  const parsed = commentMarkAttrsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Reduce a SHA-256 digest to 6 bytes via XOR folding (matches y-prosemirror). */
function convolute(digest: Uint8Array): Uint8Array {
  const N = 6;
  for (let i = N; i < digest.length; i++) {
    // biome-ignore lint/suspicious/noBitwiseOperators: Required to match y-prosemirror hash algorithm exactly
    digest[i % N] = (digest[i % N] as number) ^ (digest[i] as number);
  }
  return digest.slice(0, N);
}

type SearchResult = {
  matchCount: number;
  match: AnchorMatch | null;
};

function searchFragment(frag: XmlFragment, anchorText: string): SearchResult {
  let matchCount = 0;
  let match: AnchorMatch | null = null;

  for (const { block, textNodes } of collectLeafBlocks(frag)) {
    const result = countOccurrencesInBlock(textNodes, anchorText);
    matchCount += result.count;
    if (result.count >= 1 && match === null) {
      match = { block, textNodes, offset: result.firstOffset };
    }
  }

  return { matchCount, match };
}

type LeafBlock = {
  block: XmlElement;
  textNodes: XmlText[];
};

/**
 * Collect every textblock via a depth-first walk of the fragment: the blocks
 * every flattened-text coordinate counts, in document order. A textblock is
 * a schema textblock, or any element with a direct XmlText child. An empty
 * paragraph has an XmlText child only when y-prosemirror emptied an existing
 * one (y-prosemirror issue 108), so the schema decides, not the child.
 */
function collectLeafBlocks(frag: XmlFragment): LeafBlock[] {
  const blocks: LeafBlock[] = [];
  collectLeafBlocksFromChildren(frag.toArray(), blocks);
  return blocks;
}

function collectLeafBlocksFromChildren(
  children: (XmlElement | XmlText | XmlHook)[],
  blocks: LeafBlock[]
): void {
  for (const child of children) {
    if (!(child instanceof XmlElement)) {
      // XmlText and XmlHook nodes at this level are not block containers
      continue;
    }

    const grandChildren = child.toArray();
    const textNodes = grandChildren.filter(
      (n): n is XmlText => n instanceof XmlText
    );

    if (textNodes.length > 0 || documentTextblockNames().has(child.nodeName)) {
      blocks.push({ block: child, textNodes });
    } else {
      collectLeafBlocksFromChildren(grandChildren, blocks);
    }
  }
}

type BlockOccurrenceResult = {
  count: number;
  firstOffset: number;
};

/**
 * Count all non-overlapping occurrences of `anchorText` in the concatenated
 * plain text of a block's XmlText nodes. Also returns the char offset of the
 * first occurrence within the concatenated string.
 */
function countOccurrencesInBlock(
  textNodes: XmlText[],
  anchorText: string
): BlockOccurrenceResult {
  const plainText = textNodes.map(getNodePlainText).join("");
  let count = 0;
  let firstOffset = -1;
  let searchStart = 0;

  while (searchStart <= plainText.length - anchorText.length) {
    const idx = plainText.indexOf(anchorText, searchStart);
    if (idx === -1) {
      break;
    }
    count++;
    if (firstOffset === -1) {
      firstOffset = idx;
    }
    searchStart = idx + anchorText.length;
  }

  return { count, firstOffset };
}

/**
 * Extract plain text from an XmlText node using toDelta().
 * XmlText.toString() returns XML-encoded text with formatting tags
 * (e.g., `<code>text</code>`), which inflates offsets. toDelta()
 * returns the actual text content matching node.length.
 */
function getNodePlainText(node: XmlText): string {
  return node
    .toDelta()
    .map((op: { insert: string }) => op.insert)
    .join("");
}

/** The discriminant of an {@link AnchorLocation}. */
export const AnchorKind = {
  Unique: "unique",
  NotFound: "not_found",
  Ambiguous: "ambiguous",
} as const;
export type AnchorKind = (typeof AnchorKind)[keyof typeof AnchorKind];

/** An absent `orphan` reads as ProseMirror's default for the mark, `false`. */
const commentMarkAttrsSchema = z.object({
  orphan: z.boolean().default(false),
  threadId: z.string().min(1),
});

/** One formatted run of a textblock's text. */
export type TextRun = {
  node: XmlText;
  nodeOffset: number;
  /** Flattened offset of the run's first character. */
  start: number;
  text: string;
  attributes: Record<string, unknown>;
};

type DeltaOp = { insert: string; attributes?: Record<string, unknown> };

/**
 * Every formatted run of the fragment's text, with the flattened text they
 * add up to: the one walk every flattened coordinate (anchor matching and
 * comment marks alike) is derived from.
 */
export function collectTextRuns(
  fragment: XmlFragment
): FlatText & { runs: TextRun[] } {
  const blocks = collectLeafBlocks(fragment).map(({ textNodes }) => {
    const runs: TextRun[] = [];
    let text = "";
    for (const node of textNodes) {
      let nodeOffset = 0;
      for (const op of node.toDelta() as DeltaOp[]) {
        runs.push({
          node,
          nodeOffset,
          start: text.length,
          text: op.insert,
          attributes: op.attributes ?? {},
        });
        nodeOffset += op.insert.length;
        text += op.insert;
      }
    }
    return { runs, text };
  });
  const flat = flattenTextBlocks(blocks.map(({ text }) => text));
  const runs = blocks.flatMap((block, index) => {
    const blockStart = flat.blockStarts[index] ?? 0;
    return block.runs.map((run) => ({ ...run, start: blockStart + run.start }));
  });
  return { ...flat, runs };
}

let textblockNames: ReadonlySet<string> | undefined;

/** The document schema's textblock node names, built once. */
function documentTextblockNames(): ReadonlySet<string> {
  textblockNames ??= new Set(
    Object.values(
      getSchema(createDocumentExtensions({ undoRedo: false })).nodes
    )
      .filter((type) => type.isTextblock)
      .map((type) => type.name)
  );
  return textblockNames;
}
