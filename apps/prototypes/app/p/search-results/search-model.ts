// Presentational query-grammar model for the search-results prototype.
// Mock only - this mirrors the SHAPE of the real flat grammar
// (packages/api/src/types/search-query.ts: SEARCH_FILTER_KEYS + the
// key:value token model) so reviewers feel the JQL-look compose/edit flow,
// but it does NOT wire the real parser, intellisense engine, or any API.
//
// TDZ note: every const a module-eval builder or a component reads is declared
// ABOVE its first use in this file. A prior prototype crashed at prerender
// because a builder ran before its const initialized - keep decls first.

// ---------------------------------------------------------------------------
// Entity kinds (mirrors SearchEntityType / SEARCH_ENTITY_TYPE_LABELS)
// ---------------------------------------------------------------------------

export const EntityKind = {
  Document: "document",
  Project: "project",
  Loop: "loop",
  Comment: "comment",
  PullRequest: "pull_request",
  Branch: "branch",
  Session: "session",
  Component: "component",
} as const;
export type EntityKind = (typeof EntityKind)[keyof typeof EntityKind];

// The value users type after `type:` - the machine value, not the label.
export const ENTITY_KIND_LABELS: Record<EntityKind, string> = {
  [EntityKind.Document]: "Document",
  [EntityKind.Project]: "Project",
  [EntityKind.Loop]: "Loop",
  [EntityKind.Comment]: "Comment",
  [EntityKind.PullRequest]: "Pull Request",
  [EntityKind.Branch]: "Branch",
  [EntityKind.Session]: "Session",
  [EntityKind.Component]: "Component",
};

// Stable display order for the Type control and any grouping.
export const ENTITY_KIND_ORDER: readonly EntityKind[] = [
  EntityKind.Document,
  EntityKind.Project,
  EntityKind.Loop,
  EntityKind.Comment,
  EntityKind.PullRequest,
  EntityKind.Branch,
  EntityKind.Session,
  EntityKind.Component,
];

// ---------------------------------------------------------------------------
// Filter-key vocabulary (mirrors SEARCH_FILTER_KEYS + the new `type:` key)
// ---------------------------------------------------------------------------

export const FilterKeyValueSource = {
  Static: "static",
  Dynamic: "dynamic",
} as const;
export type FilterKeyValueSource =
  (typeof FilterKeyValueSource)[keyof typeof FilterKeyValueSource];

export type FilterKeyMeta = {
  /** The token prefix a user types, e.g. `status:` or `@`. */
  prefix: string;
  /**
   * The bare filter key (`status`, `priority`, `@`) without the trailing colon.
   * Comparison operators suffix this bare key in the canonical grammar
   * (`priority>=HIGH`), so the compose flow needs the key sans colon.
   */
  key: string;
  /** Human label shown in the suggestion popover. */
  label: string;
  /** Short one-liner shown under the label in the popover. */
  hint: string;
  /** Operators the key accepts, shown once the user is composing a value. */
  operators: readonly string[];
  valueSource: FilterKeyValueSource;
  /** For static keys, the exact value vocabulary the popover suggests. */
  staticValues?: readonly string[];
};

export const STATUS_VALUES = [
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
  "BLOCKED",
  "DONE",
  "DRAFT",
  "APPROVED",
] as const;

export const PRIORITY_VALUES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;

export const UPDATED_VALUES = ["7d", "30d", "90d", "2026-01-01"] as const;

// The keys the query bar's suggestion popover offers. `type` is the new key
// this FEAT folds the old kind-pill strip into (equality, repeatable = OR).
// `operators` mirror the canonical grammar (packages/api/src/types/search-query.ts):
// comparison operators suffix the BARE key (`priority>=HIGH`, `updated>7d`), not
// `priority:>=HIGH`. Equality-only keys use the `key:value` colon form.
export const FILTER_KEYS: readonly FilterKeyMeta[] = [
  {
    prefix: "type:",
    key: "type",
    label: "Type",
    hint: "Filter by entity kind. Repeat to match more than one.",
    operators: ["="],
    valueSource: FilterKeyValueSource.Static,
    // The `type:` value vocabulary is the entity-kind machine values, in order.
    staticValues: ENTITY_KIND_ORDER,
  },
  {
    prefix: "status:",
    key: "status",
    label: "Status",
    hint: "Match the entity's status.",
    operators: ["=", "!="],
    valueSource: FilterKeyValueSource.Static,
    staticValues: STATUS_VALUES,
  },
  {
    prefix: "priority:",
    key: "priority",
    label: "Priority",
    hint: "Compare against LOW < MEDIUM < HIGH < URGENT.",
    operators: ["=", "!=", ">", "<", ">=", "<="],
    valueSource: FilterKeyValueSource.Static,
    staticValues: PRIORITY_VALUES,
  },
  {
    prefix: "project:",
    key: "project",
    label: "Project",
    hint: "Scope to a project. Suggests your projects.",
    operators: ["="],
    valueSource: FilterKeyValueSource.Dynamic,
  },
  {
    prefix: "updated:",
    key: "updated",
    label: "Updated",
    hint: "A window (7d) or a from..to range.",
    operators: [">=", "<=", "="],
    valueSource: FilterKeyValueSource.Static,
    staticValues: UPDATED_VALUES,
  },
  {
    prefix: "@",
    key: "@",
    label: "Owner",
    hint: "Mention an org member. Suggests people.",
    operators: ["="],
    valueSource: FilterKeyValueSource.Dynamic,
  },
];

// ---------------------------------------------------------------------------
// Query-string helpers (pure, string-in / string-out - mirrors spliceToken)
// ---------------------------------------------------------------------------

const WHITESPACE_RE = /\s+/;

/** Whitespace-split, dropping empty spans. The bar's tokens are space-joined. */
export function splitTokens(query: string): string[] {
  return query.split(WHITESPACE_RE).filter((token) => token.length > 0);
}

/** The active `type:` values currently in the query, in bar order. */
export function activeTypeKinds(query: string): EntityKind[] {
  const kinds: EntityKind[] = [];
  for (const token of splitTokens(query)) {
    if (!token.startsWith("type:")) {
      continue;
    }
    const value = token.slice("type:".length);
    if (isEntityKind(value) && !kinds.includes(value)) {
      kinds.push(value);
    }
  }
  return kinds;
}

/** Add a `type:<kind>` token if absent, appended after existing tokens. */
export function addTypeToken(query: string, kind: EntityKind): string {
  const tokens = splitTokens(query);
  const token = `type:${kind}`;
  if (tokens.includes(token)) {
    return query;
  }
  return [...tokens, token].join(" ");
}

/** Remove every `type:<kind>` token for the given kind. */
export function removeTypeToken(query: string, kind: EntityKind): string {
  const token = `type:${kind}`;
  return splitTokens(query)
    .filter((existing) => existing !== token)
    .join(" ");
}

/** Toggle a `type:` token on/off (the mouse-first Type control writes these). */
export function toggleTypeToken(query: string, kind: EntityKind): string {
  return activeTypeKinds(query).includes(kind)
    ? removeTypeToken(query, kind)
    : addTypeToken(query, kind);
}

function isEntityKind(value: string): value is EntityKind {
  return ENTITY_KIND_ORDER.includes(value as EntityKind);
}

// ---------------------------------------------------------------------------
// Caret-aware token editing (mirrors the real intellisense spliceToken: the
// suggestion applies to the token the CARET is inside, not always the tail).
// ---------------------------------------------------------------------------

/** The whitespace-delimited span [start, end) that a caret position sits in. */
export type TokenSpan = { start: number; end: number; text: string };

// The comparison operators the canonical grammar suffixes onto a key. Ordered
// longest-first so `>=`/`<=`/`!=` win over `>`/`<`/`=` when we detect one.
export const COMPARISON_OPERATORS = [">=", "<=", "!=", ">", "<", "="] as const;

/**
 * The token span the caret is editing. A token is a run of non-whitespace; when
 * the caret sits between tokens (on whitespace or at a boundary) it belongs to
 * the token immediately to its left, or an empty span at the caret for a fresh
 * token. This is what the popover suggests against and what a commit replaces.
 */
export function tokenSpanAtCaret(query: string, caret: number): TokenSpan {
  const clamped = Math.max(0, Math.min(caret, query.length));
  let start = clamped;
  while (start > 0 && !isWhitespace(query[start - 1])) {
    start -= 1;
  }
  let end = clamped;
  while (end < query.length && !isWhitespace(query[end])) {
    end += 1;
  }
  return { start, end, text: query.slice(start, end) };
}

/**
 * Splice `insert` into `query` in place of the token the caret is inside,
 * returning the new query and the caret offset to place after the insert. When
 * `withTrailingSpace` is set (a completed value), a space is added and the caret
 * lands after it so the next token starts clean; a bare key prefix leaves the
 * caret right after the colon so the value composes onto the SAME token.
 */
export function spliceTokenAtCaret(
  query: string,
  caret: number,
  insert: string,
  withTrailingSpace: boolean
): { query: string; caret: number } {
  const span = tokenSpanAtCaret(query, caret);
  const before = query.slice(0, span.start);
  const after = query.slice(span.end);
  // Add a separating space only when one is wanted AND the next char is not
  // already whitespace, so replacing a mid-query token never doubles the gap.
  const nextIsSpace = after.length > 0 && isWhitespace(after[0]);
  const separator = withTrailingSpace && !nextIsSpace ? " " : "";
  const nextQuery = `${before}${insert}${separator}${after}`;
  return {
    query: nextQuery,
    caret: span.start + insert.length + separator.length,
  };
}

/**
 * Split a token into { key, operator, valuePrefix } when it opens a known filter
 * key in either grammar form: `status:TODO` (colon/equality), `priority>=HI`
 * (suffixed comparison operator), or `@handle` (the owner mention, whose `@`
 * plays the role of the `key:` colon). Returns null for a bare word. Used to
 * decide whether the popover shows VALUES for a key.
 */
export function matchKeyValueToken(token: string): {
  meta: FilterKeyMeta;
  operator: string;
  valuePrefix: string;
} | null {
  for (const meta of FILTER_KEYS) {
    if (token.startsWith(meta.prefix)) {
      return {
        meta,
        operator: "=",
        valuePrefix: token.slice(meta.prefix.length),
      };
    }
    const comparison = matchComparisonToken(token, meta);
    if (comparison) {
      return comparison;
    }
  }
  return null;
}

function matchComparisonToken(
  token: string,
  meta: FilterKeyMeta
): { meta: FilterKeyMeta; operator: string; valuePrefix: string } | null {
  if (!token.startsWith(meta.key)) {
    return null;
  }
  const rest = token.slice(meta.key.length);
  for (const op of COMPARISON_OPERATORS) {
    if (op === "=") {
      continue;
    }
    if (rest.startsWith(op) && meta.operators.includes(op)) {
      return { meta, operator: op, valuePrefix: rest.slice(op.length) };
    }
  }
  return null;
}

function isWhitespace(char: string): boolean {
  return WHITESPACE_RE.test(char);
}
