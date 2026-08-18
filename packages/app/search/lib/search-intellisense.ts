import {
  PRIORITY_VALUES,
  SEARCH_FILTER_KEYS,
  type SearchFilterKeyMeta,
  type SearchFilterOperator,
  SearchSuggestionSource,
  STATUS_VALUES,
} from "@repo/api/src/types/search-query";

/**
 * FEA-3930 Slice 5, the pure, UI-agnostic intellisense state machine that
 * powers the inline filter typeahead on the unified search box. It reads the
 * live input text plus the caret offset and decides, from the token the caret
 * sits in, WHICH suggestion surface to show and how selecting a suggestion
 * rewrites the input. It has no React, no fetch, no heavy deps, it composes the
 * shared grammar contract ({@link SEARCH_FILTER_KEYS}) so the overlay and the
 * SQL predicate builder can never disagree about the grammar. All async value
 * sources (members, projects) are fetched by the component; this module only
 * names WHICH source a value overlay needs and filters a candidate list by the
 * partial value the user has typed.
 *
 * The caret always sits inside exactly one whitespace-delimited token (or the
 * gap between tokens); the machine classifies that active token into one of the
 * {@link IntellisenseMode}s below and returns the data the overlay renders.
 */

/** Which suggestion surface the overlay should show for the current caret. */
export const IntellisenseMode = {
  /** Suggest filter keys (`status:`, `priority:`, …), caret typed a partial key. */
  FilterKeys: "filter-keys",
  /** Suggest static enum values (status/priority) for the chosen key+operator. */
  StaticValues: "static-values",
  /** Suggest dynamically-fetched values (projects) for `:project=`. */
  DynamicValues: "dynamic-values",
  /** Suggest org members for an `@partial` mention. */
  Members: "members",
  /** Nothing structured to suggest, the caller falls back to free-text FTS. */
  FreeText: "free-text",
} as const;
export type IntellisenseMode =
  (typeof IntellisenseMode)[keyof typeof IntellisenseMode];

/** The active token the caret sits in, plus its span in the raw input. */
export type ActiveToken = {
  /** The token text (may be empty when the caret is on whitespace/at the end). */
  text: string;
  /** Inclusive start offset of the token in the raw input. */
  start: number;
  /** Exclusive end offset of the token in the raw input. */
  end: number;
};

/**
 * The intellisense state for the current input+caret: which overlay to show,
 * the partial text to typeahead-filter candidates against, and enough context
 * to rewrite the input when a suggestion is committed.
 */
export type IntellisenseState = {
  mode: IntellisenseMode;
  /** The active token span, so a commit replaces exactly that token. */
  token: ActiveToken;
  /**
   * The lowercased partial the user has typed for the CURRENT surface, used to
   * typeahead-filter candidates: a partial key (`stat`), a partial value
   * (`med`), or a partial member handle (`ali`). Empty shows the full list.
   */
  filter: string;
  /**
   * For {@link IntellisenseMode.StaticValues}/{@link IntellisenseMode.DynamicValues},
   * the resolved key meta and the operator the user chose, so the commit rebuilds
   * `key<op>value`. Absent for key/member/free-text modes.
   */
  keyMeta?: SearchFilterKeyMeta;
  operator?: SearchFilterOperator;
  /**
   * For {@link IntellisenseMode.StaticValues}, the enum values to offer (already
   * the right set for the key). The component typeahead-filters these by
   * {@link IntellisenseState.filter}.
   */
  staticValues?: readonly string[];
};

/** A single rendered key suggestion (mode = FilterKeys). */
export type FilterKeySuggestion = {
  meta: SearchFilterKeyMeta;
  /** The operators this key accepts, for the secondary hint line. */
  operators: SearchFilterOperator[];
};

const OWNER_PREFIX = "@";
const WHITESPACE = /\s/;
/** Longest-first so `>=`/`<=`/`!=` win over the single-char operators. */
const OPERATOR_TOKENS = [">=", "<=", "!=", ":", "=", ">", "<"] as const;

/** The `@owner` key meta, split out so the member surface can reuse its label. */
const OWNER_KEY_META = SEARCH_FILTER_KEYS.find((k) => k.key === "owner");

/**
 * Find the whitespace-delimited token the caret sits in (or the empty gap
 * between tokens). Quotes are NOT special here, the intellisense operates on
 * the surface text; the authoritative parse still runs server-side.
 */
export function activeTokenAt(raw: string, caret: number): ActiveToken {
  const clampedCaret = Math.max(0, Math.min(caret, raw.length));
  let start = clampedCaret;
  while (start > 0 && !WHITESPACE.test(raw[start - 1])) {
    start -= 1;
  }
  let end = clampedCaret;
  while (end < raw.length && !WHITESPACE.test(raw[end])) {
    end += 1;
  }
  return { text: raw.slice(start, end), start, end };
}

/**
 * Split a `key<op>value` token at its operator, longest-operator-first. Returns
 * the recognized key text, the operator, and the partial value AFTER it, or null
 * when the token carries no operator yet (still typing the key).
 */
function splitAtOperator(token: string): {
  keyRaw: string;
  operator: string;
  value: string;
} | null {
  for (const op of OPERATOR_TOKENS) {
    const idx = token.indexOf(op);
    if (idx > 0) {
      return {
        keyRaw: token.slice(0, idx),
        operator: op,
        value: token.slice(idx + op.length),
      };
    }
  }
  return null;
}

function findKeyMeta(keyRaw: string): SearchFilterKeyMeta | undefined {
  const lower = keyRaw.toLowerCase();
  return SEARCH_FILTER_KEYS.find(
    (meta) => meta.key !== "owner" && meta.key === lower
  );
}

/** The static enum set a key offers, or undefined for dynamic/owner keys. */
function staticValuesFor(
  meta: SearchFilterKeyMeta
): readonly string[] | undefined {
  if (meta.valueSource !== SearchSuggestionSource.Static) {
    return;
  }
  // Prefer the live enum tuples over the meta's illustrative `staticValues`
  // sample so status/priority stay in lockstep with the parser's vocabulary.
  if (meta.key === "status") {
    return STATUS_VALUES;
  }
  if (meta.key === "priority") {
    return PRIORITY_VALUES;
  }
  return meta.staticValues;
}

function valueMode(meta: SearchFilterKeyMeta): IntellisenseMode {
  return meta.valueSource === SearchSuggestionSource.Dynamic
    ? IntellisenseMode.DynamicValues
    : IntellisenseMode.StaticValues;
}

function operatorMember(op: string): SearchFilterOperator {
  // Every OPERATOR_TOKENS entry is a valid SearchFilterOperator symbol except
  // the `:` equality sugar, which maps to `=`.
  return op === ":" ? "=" : (op as SearchFilterOperator);
}

/**
 * Classify the caret's active token into an {@link IntellisenseState}. Pure and
 * synchronous, the component turns the returned mode into a rendered overlay and
 * fetches dynamic values when the mode calls for it.
 */
export function intellisenseStateAt(
  raw: string,
  caret: number
): IntellisenseState {
  const token = activeTokenAt(raw, caret);
  const { text } = token;

  // `@partial`, member mention (an `@`-prefixed token stays in the members
  // surface; a trailing space closes it via the token split).
  if (text.startsWith(OWNER_PREFIX)) {
    return {
      mode: IntellisenseMode.Members,
      token,
      filter: text.slice(1).toLowerCase(),
    };
  }

  const split = splitAtOperator(text);
  if (split === null) {
    // No operator yet, a bare partial word. It could still become a `:key`
    // filter, so surface the key list filtered by the partial (a keyless word
    // is also valid FTS text; the component keeps the FTS fallback for a word
    // that matches no key prefix).
    return {
      mode: IntellisenseMode.FilterKeys,
      token,
      filter: text.toLowerCase(),
    };
  }

  const meta = findKeyMeta(split.keyRaw);
  if (meta === undefined) {
    // `foo:bar` where `foo` is not a known key → free text (mirrors the parser,
    // which leaves an unknown `key:` as FTS text, not an error).
    return { mode: IntellisenseMode.FreeText, token, filter: "" };
  }

  return {
    mode: valueMode(meta),
    token,
    filter: split.value.toLowerCase(),
    keyMeta: meta,
    operator: operatorMember(split.operator),
    staticValues: staticValuesFor(meta),
  };
}

/**
 * The key suggestions to render in the FilterKeys surface, filtered by a partial
 * key the user has typed. Excludes `@owner` (its own `@` grammar). Empty filter
 * returns every `:key`.
 */
export function filterKeySuggestions(filter: string): FilterKeySuggestion[] {
  const lower = filter.toLowerCase();
  return SEARCH_FILTER_KEYS.filter(
    (meta) => meta.key !== "owner" && meta.key.startsWith(lower)
  ).map((meta) => ({ meta, operators: meta.operators }));
}

/**
 * Typeahead-filter a static enum value set by the partial the user typed. Empty
 * filter returns the whole set (capped by the caller if needed).
 */
export function filterStaticValues(
  values: readonly string[],
  filter: string
): string[] {
  const lower = filter.toLowerCase();
  if (lower.length === 0) {
    return [...values];
  }
  return values.filter((value) => value.toLowerCase().includes(lower));
}

/**
 * Rewrite the raw input so the active token becomes `key=value` (or `key:value`
 * for the equality operator, matching how a user would type it). Returns the new
 * raw string and the caret offset to place after the committed token so typing
 * continues naturally.
 */
export function commitFilterValue(
  raw: string,
  token: ActiveToken,
  keyMeta: SearchFilterKeyMeta,
  operator: SearchFilterOperator,
  value: string
): { text: string; caret: number } {
  // The `:` form is the canonical equality sugar users type; keep any explicit
  // comparison operator (`>=`, `!=`, …) as the user chose it.
  const opText = operator === "=" ? ":" : operator;
  const key = keyMeta.key === "owner" ? "" : keyMeta.key;
  const quoted = value.includes(" ") ? `"${value}"` : value;
  return spliceToken(raw, token, `${key}${opText}${quoted}`, true);
}

/**
 * Rewrite the active `@partial` token to a committed `@handle` mention. `handle`
 * is the value the parser resolves (email / GitHub username / name); it is
 * quoted only when it contains whitespace so a multi-word name survives.
 */
export function commitMemberMention(
  raw: string,
  token: ActiveToken,
  handle: string
): { text: string; caret: number } {
  const quoted = handle.includes(" ") ? `"${handle}"` : handle;
  return spliceToken(raw, token, `${OWNER_PREFIX}${quoted}`, true);
}

/**
 * Rewrite the active token to a chosen `key:` prefix so the value surface opens
 * next. Places the caret right after the operator so the user types the value.
 */
export function commitFilterKey(
  raw: string,
  token: ActiveToken,
  keyMeta: SearchFilterKeyMeta
): { text: string; caret: number } {
  // `owner` is the `@` grammar, not a `:key`; commit its trigger char.
  const replacement =
    keyMeta.key === "owner" ? OWNER_PREFIX : `${keyMeta.key}:`;
  return spliceToken(raw, token, replacement);
}

/** The display label for the `@owner` surface, from the shared meta. */
export function ownerLabel(): string {
  return OWNER_KEY_META?.label ?? "Owner";
}

/**
 * Replace the active token span with `replacement`, returning the new raw text
 * and the caret to place right after it. When `commitTrailingSpace` is set (a
 * fully-committed filter/mention), a single space is inserted after the token so
 * the next token starts fresh, but ONLY when the token is not already followed
 * by whitespace, so committing mid-query never doubles a space. A `key:` prefix
 * commit (no trailing space) leaves the caret at the operator so the value
 * surface opens next.
 */
function spliceToken(
  raw: string,
  token: ActiveToken,
  replacement: string,
  commitTrailingSpace = false
): { text: string; caret: number } {
  const before = raw.slice(0, token.start);
  const after = raw.slice(token.end);
  const needsSpace =
    commitTrailingSpace && !(after.length > 0 && WHITESPACE.test(after[0]));
  const suffix = needsSpace ? " " : "";
  const text = `${before}${replacement}${suffix}${after}`;
  return { text, caret: token.start + replacement.length + suffix.length };
}
