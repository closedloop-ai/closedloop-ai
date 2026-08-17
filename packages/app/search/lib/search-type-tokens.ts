import {
  isSupportedSearchType,
  type SearchEntityType,
} from "@repo/api/src/types/search-entity-kind";
import { parseSearchQuery } from "@repo/api/src/types/search-query";

/**
 * FEA-4134 — pure helpers that read and write the inline `type:` tokens in the
 * search query string, so the mouse-first {@link SearchTypeControl} and the
 * editable query bar stay ONE source of truth (the query string). Reading the
 * active kinds delegates to the canonical {@link parseSearchQuery} grammar so
 * the control can never disagree with the parser about which `type:` values are
 * valid; writing splices whitespace-delimited `type:<kind>` tokens.
 */

const WHITESPACE_RE = /\s+/;

/** Whitespace-split a query into non-empty tokens (the bar's space-joined tokens). */
function splitTokens(query: string): string[] {
  return query.split(WHITESPACE_RE).filter((token) => token.length > 0);
}

/**
 * The queryable entity kinds currently expressed as `type:` tokens in the query,
 * in first-seen order. Derived from the canonical parser so an unknown/invalid
 * `type:` value is ignored here exactly as it errors there.
 */
export function activeTypeKinds(query: string): SearchEntityType[] {
  return parseSearchQuery(query).filters.type?.kinds ?? [];
}

/** Add a `type:<kind>` token if absent, appended after the existing tokens. */
export function addTypeToken(query: string, kind: SearchEntityType): string {
  const tokens = splitTokens(query);
  const token = `type:${kind}`;
  if (tokens.includes(token)) {
    return query;
  }
  return [...tokens, token].join(" ");
}

/**
 * Remove every `type:<kind>` token for the given kind, matched case-insensitively
 * on the value so a hand-typed `type:Document` is still cleared by the control.
 */
export function removeTypeToken(query: string, kind: SearchEntityType): string {
  return splitTokens(query)
    .filter((token) => !isTypeTokenFor(token, kind))
    .join(" ");
}

/** Toggle a `type:` token on/off (the mouse-first Type control writes these). */
export function toggleTypeToken(query: string, kind: SearchEntityType): string {
  return activeTypeKinds(query).includes(kind)
    ? removeTypeToken(query, kind)
    : addTypeToken(query, kind);
}

const TYPE_TOKEN_PREFIXES = ["type:", "type="] as const;

function isTypeTokenFor(token: string, kind: SearchEntityType): boolean {
  const lower = token.toLowerCase();
  // The canonical parser marks a kind active for both the `type:kind` and the
  // equality-operator `type=kind` forms (see splitKeyOperator in search-query),
  // so the control must recognize the same syntaxes to deselect them — matching
  // only `type:` would strand a `type=loop` filter as un-removable. Quotes are
  // already stripped upstream by the query bar's tokenizer, so `type:"loop"`
  // reaches here as `type:loop`.
  const prefix = TYPE_TOKEN_PREFIXES.find((candidate) =>
    lower.startsWith(candidate)
  );
  if (!prefix) {
    return false;
  }
  const value = lower.slice(prefix.length);
  return isSupportedSearchType(value) && value === kind;
}
