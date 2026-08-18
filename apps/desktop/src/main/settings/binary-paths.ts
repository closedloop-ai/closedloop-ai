/**
 * The resolved-binary path map persisted under `binaryPaths`, plus the pure
 * merge helper over it. Split out of `settings-store.ts` (FEA-3907) so that file
 * stays comfortably under the 1,000-line ceiling; the merge needs no store
 * instance.
 */

export type BinaryPaths = {
  claude?: string;
  gh?: string;
  codex?: string;
  cursor?: string;
  opencode?: string;
  python3?: string;
  git?: string;
};

/**
 * Applies a `path | null` patch onto the current binary-path map, returning a new
 * map: a `null` value removes the key, any other value sets it. Pure — the caller
 * owns persistence.
 */
export function mergeBinaryPaths(
  current: BinaryPaths,
  patch: Record<string, string | null>
): BinaryPaths {
  const merged: BinaryPaths = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete (merged as Record<string, string | undefined>)[key];
    } else {
      (merged as Record<string, string>)[key] = value;
    }
  }
  return merged;
}
