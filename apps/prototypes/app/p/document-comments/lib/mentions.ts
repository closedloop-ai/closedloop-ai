// Pure text-model helpers for the @-mention composer in this prototype.
// Presentational mirror of packages/app/shared/lib/mentions.ts: the sandbox
// cannot import that module (it pulls the collaboration matching package), so
// the same caret/token rules are replicated here on the prototype's mock member
// shape. Kept framework-free so the prototype's vitest suite can exercise the
// caret-splice, token-replacement, and mention-resolution rules directly.

import type { CommentAuthor } from "../mock";

/** Matches a single whitespace char; the right boundary of a mention token. */
const WHITESPACE_PATTERN = /\s/;

/**
 * Detects an in-progress "@query" token immediately before the caret. The "@"
 * must start the input or follow whitespace, so a mid-word "@" (an email, a
 * handle in prose) does not open the picker. Returns the token's start index
 * and the query text, or null when the caret is not inside a mention token.
 */
export function findActiveMentionQuery(
  value: string,
  caret: number
): { start: number; query: string } | null {
  const upToCaret = value.slice(0, caret);
  const at = upToCaret.lastIndexOf("@");
  if (at < 0) {
    return null;
  }
  const query = upToCaret.slice(at + 1);
  // Whitespace inside the run closes the token.
  if (WHITESPACE_PATTERN.test(query)) {
    return null;
  }
  const charBefore = at > 0 ? upToCaret[at - 1] : "";
  if (charBefore && !WHITESPACE_PATTERN.test(charBefore)) {
    return null;
  }
  return { start: at, query };
}

/**
 * Replaces the active "@query" token at `start..caret` with "@Name " (trailing
 * space) and returns the new text plus the caret position after the inserted
 * mention. Only the active token is rewritten, so whitespace and line breaks on
 * either side of it are preserved.
 */
export function applyMentionSelection(input: {
  value: string;
  caret: number;
  start: number;
  label: string;
}): { value: string; caret: number } {
  const { value, caret, start, label } = input;
  const before = value.slice(0, start);
  const after = value.slice(caret);
  const inserted = `@${label} `;
  return {
    value: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}

/**
 * Inserts a bare "@" at the caret (space-prefixed when mid-line) so the picker
 * opens with an empty query, matching the type-"@" path. Returns the new text
 * and the caret position just after the inserted "@".
 */
export function insertMentionTrigger(input: { value: string; caret: number }): {
  value: string;
  caret: number;
} {
  const { value, caret } = input;
  const before = value.slice(0, caret);
  const after = value.slice(caret);
  const needsSpace =
    before.length > 0 && !WHITESPACE_PATTERN.test(before.at(-1) ?? "");
  const insertion = `${needsSpace ? " " : ""}@`;
  return {
    value: `${before}${insertion}${after}`,
    caret: before.length + insertion.length,
  };
}

/**
 * Given the members the author picked plus the final body, returns the distinct
 * user IDs whose exact "@Name" token still appears in the body followed by a
 * boundary (whitespace or end-of-string). Deleting or editing the token drops
 * the mention, and a shorter name cannot match a longer one ("@Marcus" no
 * longer matches "@Marcus Leeway").
 */
export function resolveMentions(
  body: string,
  pickedById: ReadonlyMap<string, CommentAuthor>
): string[] {
  const ids: string[] = [];
  for (const [id, user] of pickedById) {
    const token = `@${user.name}`;
    let from = body.indexOf(token);
    while (from !== -1) {
      const nextChar = body[from + token.length];
      if (nextChar === undefined || WHITESPACE_PATTERN.test(nextChar)) {
        ids.push(id);
        break;
      }
      from = body.indexOf(token, from + 1);
    }
  }
  return [...new Set(ids)];
}
