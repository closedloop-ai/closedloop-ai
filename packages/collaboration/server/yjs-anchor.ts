import type { Liveblocks } from "@liveblocks/node";
import { DOCUMENT_FRAGMENT_FIELD } from "@repo/document-schema/collaboration-field";
import {
  AnchorKind,
  type AnchorLocation,
  type AnchorMatch,
  applyCommentMark,
  locateAnchor,
} from "@repo/document-schema/comment-anchor";
import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector } from "yjs";

type AnchorError = {
  message: string;
  status: 400;
};

export const ANCHOR_TEXT_NOT_FOUND_ERROR = "Anchor text not found in document";

const DUPLICATE_ANCHOR_TEXT_ERROR =
  /^Anchor text ".+" appears \d+ times in the document; use more specific text$/;

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
  const frag = ydoc.getXmlFragment(DOCUMENT_FRAGMENT_FIELD);
  validateMatchCount(locateAnchor(frag, anchorText), anchorText);
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
  const frag = ydoc.getXmlFragment(DOCUMENT_FRAGMENT_FIELD);
  const match = validateMatchCount(locateAnchor(frag, anchorText), anchorText);

  const sv = encodeStateVector(ydoc);

  ydoc.transact(() => {
    applyCommentMark(match, anchorText, threadId);
  });

  const diff = encodeStateAsUpdate(ydoc, sv);
  await liveblocks.sendYjsBinaryUpdate(roomId, diff);
}

/**
 * Identifies structured Yjs anchor validation failures that are safe to expose
 * to document-thread callers. Provider/auth failures should keep the generic
 * API error contract.
 */
export function isAnchorValidationError(error: unknown): boolean {
  if (!(error != null && typeof error === "object" && "status" in error)) {
    return false;
  }
  if (error.status !== 400 || !("message" in error)) {
    return false;
  }
  if (error.message === ANCHOR_TEXT_NOT_FOUND_ERROR) {
    return true;
  }
  return (
    typeof error.message === "string" &&
    DUPLICATE_ANCHOR_TEXT_ERROR.test(error.message)
  );
}

/** Fetch a Yjs document from Liveblocks and reconstruct it in memory. */
async function fetchYDoc(liveblocks: Liveblocks, roomId: string): Promise<Doc> {
  const binary = await liveblocks.getYjsDocumentAsBinaryUpdate(roomId);
  const ydoc = new Doc();
  applyUpdate(ydoc, new Uint8Array(binary));
  return ydoc;
}

/** The unique match, or a thrown structured 400 for a missing or repeated anchor. */
function validateMatchCount(
  location: AnchorLocation,
  anchorText: string
): AnchorMatch {
  if (location.kind === AnchorKind.NotFound) {
    throw {
      message: ANCHOR_TEXT_NOT_FOUND_ERROR,
      status: 400,
    } satisfies AnchorError;
  }
  if (location.kind === AnchorKind.Ambiguous) {
    throw {
      message: `Anchor text "${anchorText}" appears ${location.matchCount} times in the document; use more specific text`,
      status: 400,
    } satisfies AnchorError;
  }
  return location.match;
}
