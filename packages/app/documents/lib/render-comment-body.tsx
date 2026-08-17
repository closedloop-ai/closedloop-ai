import type { ReactNode } from "react";

/**
 * Escapes regex metacharacters in a mention display name so a literal "@Name"
 * match is built safely. Module-level so the pattern is not reconstructed per
 * render (Ultracite `useTopLevelRegex`).
 */
const REGEX_SPECIAL_CHARS_PATTERN = /[.*+?^${}()|[\]\\]/g;

/**
 * Renders a document-comment body with "@Display Name" runs that resolve to a
 * known org member drawn as a single shared mention chip; all other text stays
 * plain. Document threads persist the mention as inline "@Name" text in the body
 * (structured mention IDs are a later backend slice, FEA-4135), so a chip is
 * only drawn when its "@Name" maps to a real member name we were handed — never
 * a decorative match on arbitrary "@word". Empty member list ⇒ plain text.
 *
 * `names` is the set of exact display names the composer could have inserted
 * (the active org members). Longest-first ordering makes the alternation prefer
 * "@First Last" over a shorter "@First" so a full name is chipped as one token.
 *
 * The match is bounded by whitespace/string edges on both sides — the same token
 * boundaries the composer uses when it inserts "@Name " — so a name that only
 * appears as a substring is never chipped: "x@Ada.com" (left boundary fails) and
 * "@Adaline" (right boundary fails) both stay plain text when "Ada" is a member.
 */
export function renderCommentBody(
  body: string,
  names: readonly string[]
): ReactNode {
  if (names.length === 0) {
    return body;
  }
  const tokens = [...names]
    .sort((a, b) => b.length - a.length)
    .map((name) => `@${name}`);
  // `(?<![^\s])` / `(?![^\s])` are whitespace-or-edge boundaries: the captured
  // "@Name" group must be preceded and followed by whitespace or a string edge.
  // The assertions sit outside the capture group so `split()` still yields the
  // "@Name" token itself as the delimiter.
  const pattern = new RegExp(
    `(?<![^\\s])(${tokens
      .map((token) =>
        token.replace(REGEX_SPECIAL_CHARS_PATTERN, String.raw`\$&`)
      )
      .join("|")})(?![^\\s])`,
    "g"
  );
  const tokenSet = new Set(tokens);
  const parts = body.split(pattern);
  return parts.map((part, index) => {
    if (!tokenSet.has(part)) {
      return part;
    }
    return (
      <span
        className="rounded bg-primary/10 px-1 font-medium text-primary text-sm"
        // biome-ignore lint/suspicious/noArrayIndexKey: split() yields a fixed positional array; a repeated token has no identity but its position, so the index is the stable key.
        key={`${part}-${index}`}
      >
        {part}
      </span>
    );
  });
}
