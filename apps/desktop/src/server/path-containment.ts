import path from "node:path";

/**
 * Lexical containment only: both arguments must already be absolute and
 * normalized (`path.resolve`d). Symlinks are not followed here on purpose —
 * callers that need realpath semantics use `security.ts`.
 *
 * The comparison is case-SENSITIVE, so a caller matching case-insensitively
 * must fold both arguments itself (`isSensitiveDeniedPath` in `security.ts`
 * lower-cases each side before calling).
 */
export function isUnderDir(file: string, dir: string): boolean {
  const prefix = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
  return file === dir || file.startsWith(prefix);
}
