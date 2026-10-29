/**
 * `values` in slices of `size`, in order. Empty input yields no chunks.
 *
 * A leaf on purpose — no imports — so a read that only needs to cut an id list
 * for the bind budget does not drag the importer's dependency graph along with
 * it. It had grown two copies (an export inside the artifact-links authority
 * queries and a private twin in the plugin child-usage read); ISS-9853 folded
 * both onto this one.
 */
export function chunksOf<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
