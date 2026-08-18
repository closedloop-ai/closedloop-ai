/**
 * @file session-analytics-chunking.ts
 * @description Pure chunk packing for the session-analytics rollup.
 *
 * Extracted from `write-core.ts` (ISS-4592), which is on the `biome.jsonc`
 * shrink-only grandfather list. This is pure, exhaustively unit-tested logic
 * with no DB dependency, so it does not belong in the importer.
 */

/**
 * FEA-3132 (D6): pure greedy packer — group `idBytes` (order-preserving) into
 * chunks whose summed `bytes` ≤ `maxBytes` AND length ≤ `maxCount`. A single id
 * whose `bytes` already exceeds `maxBytes` forms its own chunk. Every id appears
 * in exactly one chunk (no drop, no duplication) — the invariant the rollup
 * depends on. Separated from the DB lookup so it is exhaustively unit-testable.
 */
export function packIdsByMetadataBudget(
  idBytes: readonly { id: string; bytes: number }[],
  maxBytes: number,
  maxCount: number
): string[][] {
  const byteCap = Math.max(1, maxBytes);
  const countCap = Math.max(1, maxCount);
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const { id, bytes } of idBytes) {
    const wouldExceedBytes =
      current.length > 0 && currentBytes + bytes > byteCap;
    const wouldExceedCount = current.length >= countCap;
    if (wouldExceedBytes || wouldExceedCount) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(id);
    currentBytes += bytes;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}
