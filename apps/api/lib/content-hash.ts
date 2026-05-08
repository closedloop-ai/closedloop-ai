import { createHash } from "node:crypto";

/** Returns a short stable SHA-256 digest for diagnostics without logging content. */
export function shortContentHash(
  value: string | undefined | null
): string | null {
  return value == null
    ? null
    : createHash("sha256").update(value).digest("hex").slice(0, 12);
}
