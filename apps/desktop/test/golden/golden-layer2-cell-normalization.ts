/**
 * @file golden-layer2-cell-normalization.ts
 * @description FEA-4010: the per-CELL normalization the Layer 2 snapshots are
 * captured through — host-path canonicalization plus the size bound that keeps a
 * snapshot reviewable. Extracted from `golden-layer2.ts`, which is at the
 * file-size ceiling and shrink-only (see `biome.jsonc`), so this rule and its
 * focused tests grow here instead of there.
 *
 * TWO INVARIANTS, both load-bearing for a frozen snapshot:
 *   1. HOST-INDEPENDENCE — the capture machine's home prefix never reaches the
 *      file, or the snapshot pins one developer's username and no one else can
 *      reproduce it.
 *   2. SIZE — a cell over `LONG_TEXT_THRESHOLD` collapses to `{ sha256, chars }`.
 *      A 10,000-line blob is not reviewable, and a digest still detects drift
 *      byte-exactly.
 */
import { createHash } from "node:crypto";

/** Above this many characters a cell collapses to a digest. */
export const LONG_TEXT_THRESHOLD = 200;

const UNIX_HOME_PATH = /\/(?:Users|home)\/[^/"\s]+/g;
const WINDOWS_HOME_PATH = /[A-Za-z]:\\Users\\[^\\/"\s]+/gi;

/** Host-independent form: capture-machine home prefixes → `<HOME>`. */
export function canonicalizeHostPaths(text: string): string {
  return text
    .replace(UNIX_HOME_PATH, "<HOME>")
    .replace(WINDOWS_HOME_PATH, "<HOME>");
}

/** The stand-in for an oversized cell — drift still detected byte-exactly. */
function digestCell(text: string): { sha256: string; chars: number } {
  return {
    sha256: createHash("sha256").update(text).digest("hex"),
    chars: text.length,
  };
}

/**
 * Canonicalize every STRING LEAF of a parsed structure, in place of the whole
 * serialized blob.
 *
 * Canonicalizing after `JSON.stringify` looks equivalent and is not:
 * serialization escapes each separator, so a nested `C:\Users\carol` becomes
 * `C:\\Users\\carol` and `WINDOWS_HOME_PATH` — which matches a single backslash —
 * stops matching. Windows home paths inside a `Json` column therefore survived
 * verbatim into small snapshots and produced host-specific digests in large ones,
 * defeating both invariants on exactly the platform whose separator needs
 * escaping. Walking the leaves sidesteps escaping entirely, and is identical to
 * the old behaviour for POSIX paths (forward slashes are never escaped).
 */
function canonicalizeLeaves(value: unknown): unknown {
  if (typeof value === "string") {
    return canonicalizeHostPaths(value);
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeLeaves);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = canonicalizeLeaves(nested);
    }
    return out;
  }
  return value;
}

/**
 * One captured cell, made host-independent and size-bounded.
 *
 * The size rule reached STRINGS only until FEA-4010. Prisma `Json` columns arrive
 * already PARSED, so they took the non-string early return and landed in the
 * snapshot fully expanded — which is how a single
 * `agent_component_invocation_sync_outbox.payload` became ~10,000 pretty-printed
 * lines, and why bumping `DATA_REVISION` (which that payload embeds) rewrote whole
 * files. Measured on the AA-10 merge: 24,690 changed snapshot lines, of which
 * ~870 were real; the remainder was one column re-serializing.
 */
export function normalizeCell(value: unknown): unknown {
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    const normalized = canonicalizeHostPaths(value);
    return normalized.length > LONG_TEXT_THRESHOLD
      ? digestCell(normalized)
      : normalized;
  }
  if (value !== null && typeof value === "object") {
    const canonical = canonicalizeLeaves(value);
    const serialized = JSON.stringify(canonical);
    if (serialized === undefined) {
      return value;
    }
    // Small structured cells stay EXPANDED and reviewable; only the ones no
    // human reads collapse. The digest is taken over the canonical serialization
    // so it is reproducible on any capture machine.
    return serialized.length > LONG_TEXT_THRESHOLD
      ? digestCell(serialized)
      : canonical;
  }
  return value;
}
