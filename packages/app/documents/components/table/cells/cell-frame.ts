"use client";

import {
  CELL_CLASSES,
  CELL_LINK_CLASSES,
} from "@repo/app/documents/components/table/cells/shared-cell-styles";
import { createContext, useContext } from "react";

/**
 * Who draws a column cell's frame: its column divider, its fixed track width
 * and its padding.
 *
 * The ungrouped document row lays its cells out itself, so each cell draws
 * its own box (`Own`). Inside `GridTableV2` the grid's cell IS that box: it
 * draws the divider and the padding over the track the header measured. A cell
 * that drew its own box there painted a second divider and pushed its value a
 * padding's width right of its header (manual QA, PR #8885), so a grid host
 * provides `Host` and the cell fills the grid's box instead.
 */
export const DocumentCellFrame = {
  Own: "own",
  Host: "host",
} as const;
export type DocumentCellFrame =
  (typeof DocumentCellFrame)[keyof typeof DocumentCellFrame];

export const DocumentCellFrameContext = createContext<DocumentCellFrame>(
  DocumentCellFrame.Own
);

/** The class strings a cell composes, for the frame its host provides. */
export type DocumentCellClasses = {
  /** A centred, padded value box. */
  box: string;
  /** A box whose inner control brings its own padding (links, pickers). */
  bareBox: string;
  /** A padded box that sizes to its content rather than the column track. */
  contentBox: string;
  /** An undrawn wrapper holding the track for a control drawn inside it. */
  trackBox: string;
  /** The drawn control inside a `trackBox`. */
  trackControl: string;
};

export function useDocumentCellClasses(): DocumentCellClasses {
  return useContext(DocumentCellFrameContext) === DocumentCellFrame.Host
    ? HOSTED_CELL_CLASSES
    : OWN_CELL_CLASSES;
}

const OWN_CELL_CLASSES: DocumentCellClasses = {
  box: CELL_CLASSES,
  bareBox: CELL_LINK_CLASSES,
  contentBox: "flex h-full min-h-11 shrink-0 items-center border-l px-3",
  trackBox: "h-full min-h-11 w-[124px] shrink-0",
  trackControl: CELL_CLASSES,
};

/**
 * Inside a grid cell: no divider and no fixed width, and the box spans the
 * grid cell's padding (`-mx-3`) so a hover fill still reaches the divider and
 * the value keeps the same inset the header label has.
 */
const HOSTED_FILL = "-mx-3 h-full min-h-11 min-w-0 flex-1 self-stretch";

const HOSTED_CELL_CLASSES: DocumentCellClasses = {
  box: `${HOSTED_FILL} flex items-center px-3 py-2`,
  bareBox: HOSTED_FILL,
  contentBox: `${HOSTED_FILL} flex items-center px-3`,
  trackBox: HOSTED_FILL,
  trackControl: "flex h-full min-h-11 w-full items-center px-3 py-2",
};
