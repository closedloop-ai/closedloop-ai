import type { Liveblocks } from "@liveblocks/node";
// biome-ignore lint/performance/noNamespaceImport: lib0 modules are designed for namespace import
import * as buf from "lib0/buffer";
// biome-ignore lint/performance/noNamespaceImport: lib0 modules are designed for namespace import
import * as sha256 from "lib0/hash/sha256";
import {
  applyUpdate,
  Doc,
  encodeStateAsUpdate,
  encodeStateVector,
  XmlElement,
  type XmlFragment,
  type XmlHook,
  XmlText,
} from "yjs";

type MatchRecord = {
  block: XmlElement;
  textNodes: XmlText[];
  offset: number;
};

type AnchorError = {
  message: string;
  status: 400;
};

/**
 * Compute a short hash of a JSON value using the same algorithm as y-prosemirror.
 * CRITICAL: lib0.encodeAny is order-sensitive -- object key order must match exactly.
 * Exported for testing.
 */
export const hashOfJSON = (json: unknown): string => {
  const digest = sha256.digest(buf.encodeAny(json));
  return buf.toBase64(convolute(digest));
};

/**
 * Validate that `anchorText` exists exactly once in the Yjs document for the given room.
 * Throws `{ message, status: 400 }` if not found or found more than once.
 * Returns void on success.
 */
export async function findAnchorText(
  liveblocks: Liveblocks,
  roomId: string,
  anchorText: string
): Promise<void> {
  const ydoc = await fetchYDoc(liveblocks, roomId);
  const frag = ydoc.getXmlFragment("default");
  const { matchCount } = searchFragment(frag, anchorText);
  validateMatchCount(matchCount, anchorText);
}

/**
 * Fetch the Yjs document for `roomId`, find `anchorText`, apply a Liveblocks
 * comment mark to it, and send the diff back to Liveblocks.
 * Throws `{ message, status: 400 }` if text is not found or is ambiguous.
 */
export async function anchorThreadToText(
  liveblocks: Liveblocks,
  roomId: string,
  threadId: string,
  anchorText: string
): Promise<void> {
  const ydoc = await fetchYDoc(liveblocks, roomId);
  const frag = ydoc.getXmlFragment("default");
  const { matchCount, matchRecord } = searchFragment(frag, anchorText);

  validateMatchCount(matchCount, anchorText);

  // matchRecord is always set when matchCount === 1 after validation
  const record = matchRecord as MatchRecord;

  const markJson = {
    type: "liveblocksCommentMark",
    // CRITICAL: orphan must come before threadId -- lib0.encodeAny is order-sensitive
    attrs: { orphan: false, threadId },
  };
  const attrKey = `liveblocksCommentMark--${hashOfJSON(markJson)}`;
  const markValue = { orphan: false, threadId };

  const sv = encodeStateVector(ydoc);

  ydoc.transact(() => {
    applyMarkToTextNodes(record, anchorText, attrKey, markValue);
  });

  const diff = encodeStateAsUpdate(ydoc, sv);
  await liveblocks.sendYjsBinaryUpdate(roomId, diff);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Reduce a SHA-256 digest to 6 bytes via XOR folding (matches y-prosemirror). */
function convolute(digest: Uint8Array): Uint8Array {
  const N = 6;
  for (let i = N; i < digest.length; i++) {
    // biome-ignore lint/suspicious/noBitwiseOperators: Required to match y-prosemirror hash algorithm exactly
    digest[i % N] = (digest[i % N] as number) ^ (digest[i] as number);
  }
  return digest.slice(0, N);
}

/** Fetch a Yjs document from Liveblocks and reconstruct it in memory. */
async function fetchYDoc(liveblocks: Liveblocks, roomId: string): Promise<Doc> {
  const binary = await liveblocks.getYjsDocumentAsBinaryUpdate(roomId);
  const ydoc = new Doc();
  applyUpdate(ydoc, new Uint8Array(binary));
  return ydoc;
}

/** Throw a structured 400 error based on match count. */
function validateMatchCount(matchCount: number, anchorText: string): void {
  if (matchCount === 0) {
    throw {
      message: "Anchor text not found in document",
      status: 400,
    } satisfies AnchorError;
  }
  if (matchCount > 1) {
    throw {
      message: `Anchor text "${anchorText}" appears ${matchCount} times in the document; use more specific text`,
      status: 400,
    } satisfies AnchorError;
  }
}

type SearchResult = {
  matchCount: number;
  matchRecord: MatchRecord | null;
};

/**
 * Walk the entire XmlFragment depth-first and count all non-overlapping
 * occurrences of `anchorText`. Records the first occurrence for use by
 * `anchorThreadToText`.
 */
function searchFragment(frag: XmlFragment, anchorText: string): SearchResult {
  let matchCount = 0;
  let matchRecord: MatchRecord | null = null;

  const blocks = collectLeafBlocks(frag);

  for (const { block, textNodes } of blocks) {
    const result = countOccurrencesInBlock(textNodes, anchorText);
    matchCount += result.count;
    if (result.count >= 1 && matchRecord === null) {
      matchRecord = { block, textNodes, offset: result.firstOffset };
    }
  }

  return { matchCount, matchRecord };
}

type BlockEntry = {
  block: XmlElement;
  textNodes: XmlText[];
};

/**
 * Collect all leaf-level XmlElements (those whose direct children include at
 * least one XmlText node) via a depth-first walk of the fragment.
 */
function collectLeafBlocks(frag: XmlFragment): BlockEntry[] {
  const blocks: BlockEntry[] = [];
  collectLeafBlocksFromChildren(frag.toArray(), blocks);
  return blocks;
}

function collectLeafBlocksFromChildren(
  children: (XmlElement | XmlText | XmlHook)[],
  blocks: BlockEntry[]
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

    if (textNodes.length > 0) {
      // This is a leaf block containing text nodes
      blocks.push({ block: child, textNodes });
    } else {
      // Recurse into nested elements
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
 * Apply a format mark to all XmlText nodes that overlap the anchor range.
 * Called inside a Yjs transaction.
 */
function applyMarkToTextNodes(
  record: MatchRecord,
  anchorText: string,
  attrKey: string,
  markValue: { orphan: boolean; threadId: string }
): void {
  const { textNodes, offset: matchStart } = record;
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
