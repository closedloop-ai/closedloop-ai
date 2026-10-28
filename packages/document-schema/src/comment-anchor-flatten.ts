/**
 * A document's textblocks as one string: each block's text in document
 * order, joined by {@link FLAT_TEXT_BLOCK_SEPARATOR}. Comment anchors
 * (`quote`, `position`) and comment-mark ranges are offsets into `text`.
 */
export type FlatText = {
  text: string;
  blockStarts: number[];
};

export const FLAT_TEXT_BLOCK_SEPARATOR = "\n";

export function flattenTextBlocks(blocks: readonly string[]): FlatText {
  const blockStarts: number[] = [];
  let offset = 0;
  for (const block of blocks) {
    blockStarts.push(offset);
    offset += block.length + FLAT_TEXT_BLOCK_SEPARATOR.length;
  }
  return { text: blocks.join(FLAT_TEXT_BLOCK_SEPARATOR), blockStarts };
}
