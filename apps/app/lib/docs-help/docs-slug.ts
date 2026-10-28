const SLUG_STRIP_RE = /[^a-z0-9\s-]/g;
const SLUG_SPACE_RE = /\s+/g;

/**
 * ISS-10006 — the anchor id web stamps on a rendered doc heading.
 *
 * Its own module, with no `node:fs` above it, because `slugifyHeading` is a
 * required PROP of `HelpSurfaceV2` and therefore runs in the BROWSER; importing
 * it from the corpus reader would drag the server-only parser into the client
 * bundle.
 *
 * Punctuation is DROPPED, not turned into a separator. The corpus stamps
 * "Closedloop.ai" as `closedloopai`, so a `[^a-z0-9]+ -> "-"` spelling emits
 * `closedloop-ai`, misses the rendered id, and `HelpReader` clears the pending
 * anchor with nothing said — a deep link that silently lands at the top of the
 * page. `docs-corpus-parity.test.ts` holds this to the algorithm the desktop
 * bundle generator stamped the same corpus with.
 */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(SLUG_STRIP_RE, "")
    .trim()
    .replace(SLUG_SPACE_RE, "-");
}
