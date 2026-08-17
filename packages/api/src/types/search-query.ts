/**
 * FEA-3930 (parent FEA-3800) — the structured query language layered on top of
 * the free-text FTS (`GET /search`, {@link searchFtsService}). Users type
 * filters INLINE in one search box; {@link parseSearchQuery} pulls the filter
 * tokens out, the remaining words become the free-text FTS query, and the
 * parsed filters become SQL predicates on the `search_document` projection.
 *
 * LIGHTWEIGHT + SHARED: pure string parsing with NO heavy deps (no Zod, no
 * `@repo/database`), so BOTH `apps/api` (to build the SQL predicates) and the
 * frontend (the future intellisense/typeahead slice) import it. The static
 * suggestion-metadata exports at the bottom describe the grammar the typeahead
 * will render; the dynamic value sources (`@owner` members, `:project` list)
 * are fetched by the frontend from existing endpoints — see
 * {@link SEARCH_FILTER_KEYS}.
 *
 * GRAMMAR:
 *   - `@handle`            — owner mention; resolves to an `assignee_id`. Repeated
 *                            `@a @b` = OR within owner (any of), AND with others.
 *   - `type:kind`          — entity-kind filter (`type:document`, `type:session`).
 *                            Repeated `type:a type:b` = OR within type (any of),
 *                            AND with others; the value is validated against the
 *                            queryable corpus (FEA-4134).
 *   - `key:value`          — equality filter (`status:TODO`, `project:acme`).
 *   - `key op value`-style — comparison via a suffixed operator on the key for
 *                            ordered keys: `priority>=medium`, `updated>7d`,
 *                            `status!=done`. Operators: `= != > < >= <=`.
 *   - `updated:2026-07-01..2026-07-15` — inclusive date RANGE form on `:updated`.
 *   - Anything else        — free text; joined back into {@link ParsedSearchQuery.text}.
 *
 * UNKNOWN keys / operators / values surface as {@link SearchFilterError}s in
 * `errors[]` (the SAFER contract — a typo is reported to the user, never
 * silently dropped so the query quietly returns the wrong corpus). The route
 * rejects a parse with any error as a 400.
 */

import {
  isSupportedSearchType,
  PHASE_1_SEARCH_ENTITY_TYPES,
  type SearchEntityType,
} from "./search-entity-kind";
import { SLUG_LOOKUP_PREFIXES } from "./slug-prefix";

/**
 * The comparison operators a structured filter can carry. A small const-object
 * enum (Biome forbids `enum`); the frontend typeahead and the SQL builder both
 * import these members instead of hardcoding the symbols.
 */
export const SearchFilterOperator = {
  Eq: "=",
  Neq: "!=",
  Gt: ">",
  Lt: "<",
  Gte: ">=",
  Lte: "<=",
} as const;
export type SearchFilterOperator =
  (typeof SearchFilterOperator)[keyof typeof SearchFilterOperator];

/** The filter keys the `:key` grammar recognizes. */
export const SearchFilterKey = {
  Type: "type",
  Status: "status",
  Priority: "priority",
  Project: "project",
  Updated: "updated",
} as const;
export type SearchFilterKey =
  (typeof SearchFilterKey)[keyof typeof SearchFilterKey];

/**
 * Ordinal rank for the ordered `priority` values, LOW < MEDIUM < HIGH < URGENT.
 * `:priority>=medium` compares against this ordinal, not the raw string. Exposed
 * so the SQL builder in the query service maps a projected `priority` TEXT
 * column to the same ordinal (a CASE expression) and the two cannot drift.
 */
export const PRIORITY_ORDINAL: Record<string, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  URGENT: 3,
};

/** The canonical priority members, low→high, for the typeahead value set. */
export const PRIORITY_VALUES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;

/**
 * The full set of status strings a `:status` filter accepts — the union of
 * every status vocabulary the projection stores (Feature, Document, Project,
 * Loop). The projection's `status` TEXT column carries the raw source value, so
 * a `:status=TODO` matches whatever rows persisted that literal regardless of
 * which entity type produced it. Kept as a flat set so the parser can validate
 * a value without importing the four separate enums (and their transitive
 * deps).
 */
export const STATUS_VALUES = [
  // IssueStatus
  "TRIAGE",
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
  "BLOCKED",
  "DONE",
  "CANCELED",
  // DocumentStatus (adds these beyond the shared IN_REVIEW/IN_PROGRESS)
  "DRAFT",
  "CHANGES_REQUESTED",
  "APPROVED",
  "EXECUTED",
  "OBSOLETE",
  // ProjectStatus
  "NOT_STARTED",
  "COMPLETED",
  "ARCHIVED",
  // LoopStatus
  "PENDING",
  "CLAIMED",
  "RUNNING",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
] as const;

/** A single owner mention token (the raw `@handle` text, sans `@`). */
export type OwnerFilterToken = string;

/**
 * A `type:` filter: equality-only, repeatable. Each `type:kind` token adds one
 * queryable {@link SearchEntityType}; repeated tokens OR within the type
 * dimension (any of), AND with the other filters — matching the `types[]` query
 * param the route already honors as an `entity_type IN (...)` predicate. The
 * kinds are deduped, in first-seen order.
 */
export type TypeFilter = {
  kinds: SearchEntityType[];
};

/** A `:status` filter: equality-only (`=` / `!=`). */
export type StatusFilter = {
  operator: typeof SearchFilterOperator.Eq | typeof SearchFilterOperator.Neq;
  value: string;
};

/** A `:priority` filter: any comparison operator, compared by ordinal. */
export type PriorityFilter = {
  operator: SearchFilterOperator;
  /** Normalized upper-case priority member (a key of {@link PRIORITY_ORDINAL}). */
  value: string;
};

/** A `:project` filter: equality-only; the value is a project slug OR name. */
export type ProjectFilter = {
  /** Project slug or name — resolved to project id(s) by the query service. */
  value: string;
};

/**
 * A parsed `:updated` filter over the entity's `updated_at`. Either a single
 * bound (`operator` + `date`) or an inclusive range (`from`..`to`). Dates are
 * resolved to absolute `Date`s at parse time (relative `7d` → now − 7 days).
 */
export type UpdatedFilter =
  | { kind: "bound"; operator: SearchFilterOperator; date: Date }
  | { kind: "range"; from: Date; to: Date };

/** The structured filters lifted out of a raw query. */
export type SearchFilters = {
  /** Owner mentions — OR within, AND with the rest. Absent when none typed. */
  owner?: OwnerFilterToken[];
  /** Entity kinds — OR within, AND with the rest. Absent when none typed. */
  type?: TypeFilter;
  status?: StatusFilter;
  priority?: PriorityFilter;
  project?: ProjectFilter;
  updated?: UpdatedFilter;
};

/** A recoverable parse problem surfaced to the client (never silently dropped). */
export type SearchFilterError = {
  /** The raw token that failed to parse (e.g. `"priority:huge"`). */
  token: string;
  /** Human-readable reason, safe to show inline in the search box. */
  message: string;
};

/**
 * An exact-record lookup lifted out of the raw query (FEA-3930, Mike's explicit
 * requirement): pasting a record's ID or slug must return that exact record. A
 * token is detected as a UUID (the projection's `entity_id` format) or a known
 * slug (`FEA-####`/`PRD-####`/`PLN-####`/`PRO-####`, case-insensitive; session
 * `SES-####` is excluded — sessions carry no projected slug to match).
 * The query service runs an org-scoped exact match on `entity_id`/`lower(slug)`
 * and ranks the hit ABOVE the full-text results. At most one lookup token is
 * lifted; the first ID/slug wins and later ones fall back to free text.
 */
export type IdLookup = {
  /** A UUID token matched against the projection's `entity_id`. */
  uuid?: string;
  /** A known-slug token matched (case-insensitively) against `slug`. */
  slug?: string;
};

/** The result of parsing a raw search string. */
export type ParsedSearchQuery = {
  /** The free-text remainder, filter tokens removed, for the FTS query. */
  text: string;
  filters: SearchFilters;
  /** Non-empty when a filter token was malformed; the route 400s on any. */
  errors: SearchFilterError[];
  /**
   * Present when the query carried an exact-record ID or slug token. Optional +
   * additive so existing callers (and the frontend) that ignore it are
   * unaffected; the query service short-circuits to the exact record when the
   * remaining `text` is empty, or ranks it first when the query mixed an id with
   * other words.
   */
  idLookup?: IdLookup;
};

const OWNER_PREFIX = "@";
/** Ordered longest-first so `>=`/`<=` win over `>`/`<`/`=` when splitting a key. */
const KEY_OPERATORS: SearchFilterOperator[] = [
  SearchFilterOperator.Gte,
  SearchFilterOperator.Lte,
  SearchFilterOperator.Neq,
  SearchFilterOperator.Gt,
  SearchFilterOperator.Lt,
  SearchFilterOperator.Eq,
];
const RELATIVE_DAYS = /^(\d+)d$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RANGE_SEPARATOR = "..";
const MS_PER_DAY = 86_400_000;
const WHITESPACE = /\s/;

/**
 * A canonical UUID (any version), matching the `entity_id` format the
 * `search_document` projection stores. Anchored + case-insensitive.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A known artifact/project slug: one of the {@link SLUG_LOOKUP_PREFIXES} members
 * followed by `-<digits>` (e.g. `FEA-123`, `PRD-4`, `PLN-77`, `PRO-9`). Built
 * from the shared lookup-prefix SSOT so a new slug-bearing prefix is picked up
 * automatically. Session slugs (`SES-###`) are intentionally excluded: the
 * `search_document` projection stores `slug: null` for sessions, so a `SES-###`
 * exact-slug lookup could never match — treating it as a lookup would return a
 * doomed empty result instead of falling through to free text. Anchored +
 * case-insensitive.
 */
const KNOWN_SLUG_RE = new RegExp(
  `^(?:${SLUG_LOOKUP_PREFIXES.join("|")})-\\d+$`,
  "i"
);

/**
 * Split a raw query into whitespace-separated tokens while keeping a
 * double-quoted span as ONE token (so `project:"My Project"` and
 * `status:"IN_PROGRESS"` survive). Quotes are stripped from the emitted token.
 * A trailing unterminated quote takes the rest of the string.
 */
function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  for (const char of raw) {
    if (char === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && WHITESPACE.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function isFilterKey(value: string): value is SearchFilterKey {
  return (Object.values(SearchFilterKey) as string[]).includes(value);
}

/**
 * Split a `key op value` token into its parts, or null when the token carries no
 * recognized filter key/operator. `key:value` is equality sugar; the suffixed
 * operators (`>=` etc.) match longest-first so `>=` beats `>`. The value may be
 * empty (an error the caller reports).
 */
function splitKeyOperator(token: string): {
  key: SearchFilterKey;
  operator: SearchFilterOperator;
  value: string;
} | null {
  const lower = token.toLowerCase();
  // `key:value` — only when the segment before `:` is a known key (so a bare
  // `http://...` in free text is not mistaken for a filter).
  const colon = lower.indexOf(":");
  if (colon > 0) {
    const key = lower.slice(0, colon);
    if (isFilterKey(key)) {
      return {
        key,
        operator: SearchFilterOperator.Eq,
        value: token.slice(colon + 1),
      };
    }
  }
  for (const op of KEY_OPERATORS) {
    const idx = lower.indexOf(op);
    if (idx > 0) {
      const key = lower.slice(0, idx);
      if (isFilterKey(key)) {
        return { key, operator: op, value: token.slice(idx + op.length) };
      }
    }
  }
  return null;
}

/**
 * Resolve a relative (`7d`) or absolute (`2026-07-01`) date token to a `Date`,
 * or null when unparseable. Relative days count back from `now`.
 */
function resolveDate(raw: string, now: Date): Date | null {
  const trimmed = raw.trim();
  const relative = RELATIVE_DAYS.exec(trimmed);
  if (relative) {
    const days = Number(relative[1]);
    return new Date(now.getTime() - days * MS_PER_DAY);
  }
  if (ISO_DATE.test(trimmed)) {
    const date = new Date(`${trimmed}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  // Any other ISO-8601 string Date can parse (full timestamp).
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Parse a single `type:kind` token into the queryable {@link SearchEntityType}
 * it names, appending it (deduped) to the accumulating {@link TypeFilter}.
 * Equality-only and repeatable: `type:document type:loop` ORs the two kinds.
 * An unknown kind is a recoverable {@link SearchFilterError} (never silently
 * dropped), validated against the same corpus the route/service enforce.
 */
function parseType(
  filters: SearchFilters,
  token: string,
  operator: SearchFilterOperator,
  value: string,
  errors: SearchFilterError[]
): void {
  if (operator !== SearchFilterOperator.Eq) {
    errors.push({
      token,
      message: `:type supports ${SearchFilterOperator.Eq} only`,
    });
    return;
  }
  const normalized = value.trim().toLowerCase();
  if (!isSupportedSearchType(normalized)) {
    errors.push({ token, message: `Unknown type value: ${value}` });
    return;
  }
  const existing = filters.type?.kinds ?? [];
  if (existing.includes(normalized)) {
    filters.type = { kinds: existing };
    return;
  }
  filters.type = { kinds: [...existing, normalized] };
}

function parseStatus(
  token: string,
  operator: SearchFilterOperator,
  value: string,
  errors: SearchFilterError[]
): StatusFilter | undefined {
  if (
    operator !== SearchFilterOperator.Eq &&
    operator !== SearchFilterOperator.Neq
  ) {
    errors.push({
      token,
      message: `:status supports ${SearchFilterOperator.Eq} and ${SearchFilterOperator.Neq} only`,
    });
    return;
  }
  const normalized = value.trim().toUpperCase();
  if (!(STATUS_VALUES as readonly string[]).includes(normalized)) {
    errors.push({ token, message: `Unknown status value: ${value}` });
    return;
  }
  return { operator, value: normalized };
}

function parsePriority(
  token: string,
  operator: SearchFilterOperator,
  value: string,
  errors: SearchFilterError[]
): PriorityFilter | undefined {
  const normalized = value.trim().toUpperCase();
  if (PRIORITY_ORDINAL[normalized] === undefined) {
    errors.push({ token, message: `Unknown priority value: ${value}` });
    return;
  }
  return { operator, value: normalized };
}

function parseProject(
  token: string,
  operator: SearchFilterOperator,
  value: string,
  errors: SearchFilterError[]
): ProjectFilter | undefined {
  if (operator !== SearchFilterOperator.Eq) {
    errors.push({
      token,
      message: `:project supports ${SearchFilterOperator.Eq} only`,
    });
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    errors.push({ token, message: ":project requires a slug or name" });
    return;
  }
  return { value: trimmed };
}

function parseUpdated(
  token: string,
  operator: SearchFilterOperator,
  value: string,
  now: Date,
  errors: SearchFilterError[]
): UpdatedFilter | undefined {
  const trimmed = value.trim();
  if (trimmed.includes(RANGE_SEPARATOR)) {
    if (operator !== SearchFilterOperator.Eq) {
      errors.push({
        token,
        message: `:updated range requires the ${SearchFilterOperator.Eq} form (updated:from..to)`,
      });
      return;
    }
    const [rawFrom, rawTo] = trimmed.split(RANGE_SEPARATOR);
    const from = resolveDate(rawFrom, now);
    const to = resolveDate(rawTo, now);
    if (from === null || to === null) {
      errors.push({ token, message: `Invalid :updated range: ${value}` });
      return;
    }
    return { kind: "range", from, to };
  }
  const date = resolveDate(trimmed, now);
  if (date === null) {
    errors.push({ token, message: `Invalid :updated date: ${value}` });
    return;
  }
  return { kind: "bound", operator, date };
}

function applyFilter(
  filters: SearchFilters,
  token: string,
  key: SearchFilterKey,
  operator: SearchFilterOperator,
  value: string,
  now: Date,
  errors: SearchFilterError[]
): void {
  switch (key) {
    case SearchFilterKey.Type: {
      parseType(filters, token, operator, value, errors);
      return;
    }
    case SearchFilterKey.Status: {
      const parsed = parseStatus(token, operator, value, errors);
      if (parsed) {
        filters.status = parsed;
      }
      return;
    }
    case SearchFilterKey.Priority: {
      const parsed = parsePriority(token, operator, value, errors);
      if (parsed) {
        filters.priority = parsed;
      }
      return;
    }
    case SearchFilterKey.Project: {
      const parsed = parseProject(token, operator, value, errors);
      if (parsed) {
        filters.project = parsed;
      }
      return;
    }
    case SearchFilterKey.Updated: {
      const parsed = parseUpdated(token, operator, value, now, errors);
      if (parsed) {
        filters.updated = parsed;
      }
      return;
    }
    default: {
      // Exhaustiveness guard: a new SearchFilterKey without a case fails tsc here.
      const _exhaustive: never = key;
      throw new Error(`Unhandled search filter key: ${_exhaustive}`);
    }
  }
}

/**
 * Parse a raw search string into free text + structured filters + errors.
 *
 * Pure and deterministic given `now` (injected for testability; defaults to the
 * wall clock). Never throws — a malformed filter token becomes a
 * {@link SearchFilterError} in `errors[]` and is NOT applied, so the caller (the
 * route) can 400 with a specific message rather than silently running the wrong
 * query.
 */
export function parseSearchQuery(
  raw: string,
  now: Date = new Date()
): ParsedSearchQuery {
  const filters: SearchFilters = {};
  const errors: SearchFilterError[] = [];
  const owner: OwnerFilterToken[] = [];
  const textTokens: string[] = [];
  let idLookup: IdLookup | undefined;

  for (const token of tokenize(raw)) {
    if (token.startsWith(OWNER_PREFIX) && token.length > 1) {
      owner.push(token.slice(1));
      continue;
    }
    const split = splitKeyOperator(token);
    if (split === null) {
      // A non-filter token: if it is the FIRST exact-record ID or slug, lift it
      // as the lookup (so a query that is ONLY an id/slug leaves empty text);
      // otherwise it is free text. Later id/slug tokens fall back to text.
      if (idLookup === undefined) {
        const detected = detectIdLookup(token);
        if (detected !== null) {
          idLookup = detected;
          continue;
        }
      }
      textTokens.push(token);
      continue;
    }
    if (split.value.trim().length === 0) {
      errors.push({ token, message: `${split.key} requires a value` });
      continue;
    }
    applyFilter(
      filters,
      token,
      split.key,
      split.operator,
      split.value,
      now,
      errors
    );
  }

  if (owner.length > 0) {
    filters.owner = owner;
  }

  const parsed: ParsedSearchQuery = {
    text: textTokens.join(" "),
    filters,
    errors,
  };
  if (idLookup !== undefined) {
    parsed.idLookup = idLookup;
  }
  return parsed;
}

/**
 * True when the parsed query carried at least one inline structured filter
 * (`@owner` or a `:key` filter). Shared by the route (to decide the unified
 * path) and the FTS service (to decide the exact-only short-circuit) so the two
 * cannot drift.
 */
export function hasStructuredFilters(filters: SearchFilters): boolean {
  return (
    filters.owner !== undefined ||
    filters.type !== undefined ||
    filters.status !== undefined ||
    filters.priority !== undefined ||
    filters.project !== undefined ||
    filters.updated !== undefined
  );
}

/**
 * Detect an exact-record ID or slug token (FEA-3930). Returns an {@link IdLookup}
 * when the token is a UUID (matched against the projection's `entity_id`) or a
 * known slug (`FEA-####`/`PRD-####`/`PLN-####`/`PRO-####`, case-insensitive;
 * session `SES-####` excluded — no projected slug), or null when it is neither
 * (ordinary free text). The slug
 * is preserved verbatim; the query service compares it case-insensitively.
 */
function detectIdLookup(token: string): IdLookup | null {
  if (UUID_RE.test(token)) {
    return { uuid: token };
  }
  if (KNOWN_SLUG_RE.test(token)) {
    return { slug: token };
  }
  return null;
}

/**
 * The operators each `:key` supports, for the future typeahead. The `@owner`
 * mention is not a `:key` filter — it is its own token grammar — so it is
 * described separately in {@link SEARCH_FILTER_KEYS}.
 */
export const TYPE_OPERATORS: SearchFilterOperator[] = [SearchFilterOperator.Eq];
export const STATUS_OPERATORS: SearchFilterOperator[] = [
  SearchFilterOperator.Eq,
  SearchFilterOperator.Neq,
];
export const PRIORITY_OPERATORS: SearchFilterOperator[] = [
  SearchFilterOperator.Eq,
  SearchFilterOperator.Neq,
  SearchFilterOperator.Gt,
  SearchFilterOperator.Lt,
  SearchFilterOperator.Gte,
  SearchFilterOperator.Lte,
];
export const PROJECT_OPERATORS: SearchFilterOperator[] = [
  SearchFilterOperator.Eq,
];
export const UPDATED_OPERATORS: SearchFilterOperator[] = [
  SearchFilterOperator.Eq,
  SearchFilterOperator.Gt,
  SearchFilterOperator.Lt,
  SearchFilterOperator.Gte,
  SearchFilterOperator.Lte,
];

/**
 * How a filter's suggestion values are sourced by the typeahead. `static` value
 * sets ship in this contract module; `dynamic` sets are fetched from an existing
 * endpoint at type-time (the `endpoint` names it).
 */
export const SearchSuggestionSource = {
  Static: "static",
  Dynamic: "dynamic",
} as const;
export type SearchSuggestionSource =
  (typeof SearchSuggestionSource)[keyof typeof SearchSuggestionSource];

/**
 * One entry the typeahead renders: the token prefix the user types, a label, the
 * operators it accepts, and where its values come from. `owner` is the `@`
 * mention grammar; the rest are `:key` filters. This is the ONLY suggestion
 * contract the UI slice consumes — no UI is built here.
 */
export type SearchFilterKeyMeta = {
  /** The literal token prefix the user types (`@` or `status:`). */
  prefix: string;
  /** Filter key for the `:key` filters; `owner` for the mention grammar. */
  key: SearchFilterKey | "owner";
  label: string;
  operators: SearchFilterOperator[];
  valueSource: SearchSuggestionSource;
  /** For `static` sources, the value set the typeahead offers. */
  staticValues?: readonly string[];
  /**
   * For `dynamic` sources, the existing endpoint the frontend already exposes
   * to fetch candidate values (documented, not fetched here).
   */
  dynamicEndpoint?: string;
};

/**
 * The suggestion metadata the future intellisense/typeahead slice consumes.
 * Static value sets (status, priority) are inline; dynamic sets name their
 * source endpoint:
 *   - `@owner` — org members, from the existing members endpoint
 *     (`GET /organizations/members`).
 *   - `:project` — the project list, from the existing projects endpoint
 *     (`GET /projects`).
 */
export const SEARCH_FILTER_KEYS: SearchFilterKeyMeta[] = [
  {
    prefix: `${SearchFilterKey.Type}:`,
    key: SearchFilterKey.Type,
    label: "Type",
    operators: TYPE_OPERATORS,
    valueSource: SearchSuggestionSource.Static,
    // The queryable entity-kind wire values (the machine value typed after
    // `type:`), in corpus order. Repeatable to match more than one kind.
    staticValues: PHASE_1_SEARCH_ENTITY_TYPES,
  },
  {
    prefix: OWNER_PREFIX,
    key: "owner",
    label: "Owner",
    operators: [SearchFilterOperator.Eq],
    valueSource: SearchSuggestionSource.Dynamic,
    dynamicEndpoint: "GET /organizations/members",
  },
  {
    prefix: `${SearchFilterKey.Status}:`,
    key: SearchFilterKey.Status,
    label: "Status",
    operators: STATUS_OPERATORS,
    valueSource: SearchSuggestionSource.Static,
    staticValues: STATUS_VALUES,
  },
  {
    prefix: `${SearchFilterKey.Priority}:`,
    key: SearchFilterKey.Priority,
    label: "Priority",
    operators: PRIORITY_OPERATORS,
    valueSource: SearchSuggestionSource.Static,
    staticValues: PRIORITY_VALUES,
  },
  {
    prefix: `${SearchFilterKey.Project}:`,
    key: SearchFilterKey.Project,
    label: "Project",
    operators: PROJECT_OPERATORS,
    valueSource: SearchSuggestionSource.Dynamic,
    dynamicEndpoint: "GET /projects",
  },
  {
    prefix: `${SearchFilterKey.Updated}:`,
    key: SearchFilterKey.Updated,
    label: "Updated",
    operators: UPDATED_OPERATORS,
    valueSource: SearchSuggestionSource.Static,
    staticValues: ["7d", "30d", "2026-01-01", "from..to"],
  },
];
