import {
  HIDE_COMPLETED_DOCUMENT_STATUSES,
  HIDE_COMPLETED_ISSUE_STATUSES,
} from "@repo/api/src/types/artifact-hide-completed";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import { PRIORITY_VALUES } from "@repo/api/src/types/search-query";
import { ArtifactSubtype, ArtifactType } from "@repo/database";
import { ASSIGNEE_ID, ORGANIZATION_ID } from "./assigned-artifact-tree.ids";

/**
 * Readers that parse each decision back OUT of the emitted anchor SQL.
 *
 * Split from the harness (ISS-10471 review): a fixture proves WHICH rows a
 * predicate returns and never HOW it is written, so operator, polarity,
 * case-fold, bound values, sort keys and the cap each need their own reader.
 * Separate from the fake because the fake CONSUMES these — it must model the
 * query that was emitted, not the one the author intended.
 */

export function sqlText(node: unknown): string {
  if (!node || typeof node !== "object" || !("strings" in node)) {
    return "";
  }
  const { strings, values, separator } = node as {
    strings: string[];
    values: unknown[];
    separator?: string;
  };
  // This branch exists for the MOCK, not for Prisma: real `join` is eager and
  // its `Sql` has no `separator` field, while `createDatabaseMockModule`'s stub
  // returns `{separator, strings: [""], values}`. Walking `strings` alone
  // therefore emitted the FIRST element of a mocked join and dropped the rest,
  // which made every `anchorQueryText()` assertion blind to anything inside
  // one — a `(... OR ...)` arm among them.
  if (typeof separator === "string") {
    return values.map((value) => sqlText(value)).join(separator);
  }
  return strings.map((part, index) => part + sqlText(values[index])).join("");
}

/**
 * The anchor SQL's `a.type` comparisons as WRITTEN: each `ArtifactType`, bound
 * or inlined as a `'X'::"ArtifactType"` literal fragment, paired with the
 * operator the SQL text puts right before it. A fixture that
 * hard-coded "anything but a branch" would report the same rows for a
 * `= DOCUMENT` predicate, which is the arms-on-different-rules divergence this
 * suite exists to catch (marisolashgrove, PR #7953).
 */
export function typeComparisons(node: unknown): {
  excluded: string[];
  required: string[];
} {
  const artifactTypes = Object.values(ArtifactType) as string[];
  const excluded: string[] = [];
  const required: string[] = [];
  const walk = (current: unknown) => {
    if (!current || typeof current !== "object" || !("strings" in current)) {
      return;
    }
    const { strings, values } = current as {
      strings: string[];
      values: unknown[];
    };
    values.forEach((value, index) => {
      const type =
        typeof value === "string"
          ? value
          : TYPE_LITERAL.exec(sqlText(value))?.[1];
      if (type === undefined || !artifactTypes.includes(type)) {
        walk(value);
        return;
      }
      const before = strings[index].trimEnd();
      if (before.endsWith("a.type <>")) {
        excluded.push(type);
      } else if (before.endsWith("a.type =")) {
        required.push(type);
      }
    });
  };
  walk(node);
  return { excluded, required };
}

/**
 * The statuses the anchor SQL actually narrowed on, or `null` when it carried no
 * status predicate at all (ISS-10471).
 *
 * Read back out of the EMITTED SQL, never from the caller's argument: a fixture
 * that filtered on what the test asked for would stay green against a service
 * that dropped the predicate on the way to the query, which is the whole defect
 * this filter exists to remove.
 */
export function anchorStatusFilter(node: unknown): string[] | null {
  // `AND a.status IN`, never the looser `a.status IN`: the latter also matches
  // the hide-completed CASE arms (`THEN a.status IN (...)`), which reported
  // those vocabularies as a status FACET and filtered the fixture by them —
  // caught by `keeps an APPROVED document visible`, where an approved row
  // vanished because APPROVED is absent from every hide-completed list.
  const fragment = findSqlFragment(node, "AND a.status IN");
  if (fragment === null) {
    return null;
  }
  const vocabulary = new Set<string>([
    ...Object.values(DocumentStatus),
    ...Object.values(IssueStatus),
  ]);
  return flattenSqlValues(fragment).filter(
    (value): value is string =>
      typeof value === "string" && vocabulary.has(value)
  );
}

/**
 * The member arm as ISS-12657 writes it: the column UNCAST, compared against
 * inlined enum literals. Deliberately does not match `a.priority::text IN`, so
 * a regression to the unindexable spelling reads as NO member arm and fails
 * loudly rather than passing with a different plan.
 */
const PRIORITY_MEMBER_ARM = /a\.priority IN \(/;
const PRIORITY_LITERAL = /'([A-Z_]+)'::"Priority"/g;

/**
 * The two arms are reported separately because they are separately droppable: a
 * production helper that emitted only the `IN` would still satisfy a
 * members-only assertion while silently refusing every unset row.
 */
export type EmittedPriorityFilter = {
  members: string[];
  includesUnset: boolean;
  /** How the two arms are joined, or `null` when fewer than two were emitted. */
  combinator: "AND" | "OR" | null;
};

/**
 * The priority selection the anchor SQL narrowed on, or `null` when it carried
 * no priority predicate (ISS-10471). Read out of the EMITTED SQL for the same
 * reason {@link anchorStatusFilter} is.
 */
export function anchorPriorityFilter(
  node: unknown
): EmittedPriorityFilter | null {
  const text = sqlText(node);
  const hasMembers = PRIORITY_MEMBER_ARM.test(text);
  const includesUnset = text.includes("a.priority IS NULL");
  if (!(hasMembers || includesUnset)) {
    return null;
  }
  const vocabulary = new Set<string>(PRIORITY_VALUES);
  return {
    // Read from the TEXT, not from the bound values: ISS-12657 inlines each
    // member as a `'X'::"Priority"` literal, because `a.priority::text` cannot
    // be indexed at all — the enum-to-text cast is STABLE, so Postgres refuses
    // an expression index on it. Reading `values` here would report an EMPTY
    // member list for a facet that is in fact narrowing, and the fake would
    // then admit every row.
    members: [...text.matchAll(PRIORITY_LITERAL)]
      .map((match) => match[1])
      .filter((value) => vocabulary.has(value)),
    includesUnset,
    // The OPERATOR, not just the operands: `IN (...) AND IS NULL` is
    // unsatisfiable, and a fake that applied its own OR would report the same
    // rows for it. Read from the text so the arms' relationship is observable.
    combinator: resolvePriorityCombinator(text, hasMembers && includesUnset),
  };
}

function resolvePriorityCombinator(
  text: string,
  bothArms: boolean
): "AND" | "OR" | null {
  if (!bothArms) {
    return null;
  }
  return text.includes(" OR a.priority IS NULL") ? "OR" : "AND";
}

/**
 * The date window the anchor SQL bound, or `null` when it carried none
 * (ISS-10471).
 *
 * Reports the COLUMN and both OPERATORS, not just the bounds. The bounds alone
 * cannot distinguish a window on `created_at` from one on `updated_at`, nor an
 * inclusive upper bound from an exclusive one — and those are the two ways this
 * predicate goes wrong while still returning a plausible set of rows.
 */
export function anchorDateWindow(node: unknown): {
  column: "created_at" | "updated_at";
  fromInclusive: boolean;
  toInclusive: boolean;
  from: Date;
  to: Date;
} | null {
  const text = sqlText(node);
  const createdAt = text.includes("a.created_at >=");
  const updatedAt = text.includes("a.updated_at >=");
  if (!(createdAt || updatedAt)) {
    return null;
  }
  const column = createdAt ? "created_at" : "updated_at";
  const dates = flattenSqlValues(node).filter(
    (value): value is Date => value instanceof Date
  );
  return {
    column,
    fromInclusive: text.includes(`a.${column} >=`),
    toInclusive: text.includes(`a.${column} <=`),
    from: dates[0] as Date,
    to: dates[1] as Date,
  };
}

/**
 * Whether the anchor SQL carried the hide-completed CASE, and the status lists
 * it bound per vocabulary (ISS-10471).
 *
 * The LISTS are reported, not a boolean, because the defect worth catching is
 * the wrong vocabulary reaching an arm — a document arm bound with the
 * domain-wide terminal set would hide approved work while every "the filter is
 * applied" assertion stayed green.
 */
export type EmittedHideCompleted = {
  issue: string[];
  document: string[];
  /** The subtypes the SQL routed to the issue arm, not the ones we expected. */
  issueSubtypes: string[];
  /**
   * Whether the CASE is NEGATED. Read from the text because the polarity is the
   * single most destructive thing that can go wrong here: without the `NOT` the
   * facet keeps ONLY completed work, and a fake that hardcoded "completed means
   * filtered out" reports the same rows either way.
   */
  negated: boolean;
};

export function anchorHideCompleted(
  node: unknown
): EmittedHideCompleted | null {
  const text = sqlText(node);
  if (!text.includes("a.status IN")) {
    return null;
  }
  const fragment = findSqlFragment(node, "ELSE false");
  if (fragment === null) {
    return null;
  }
  const bound = flattenSqlValues(fragment).filter(
    (value): value is string => typeof value === "string"
  );
  // Positional, because the arms bind in CASE order: each arm's type literal
  // and the two issue subtypes interleave with the status lists, so the
  // discriminators are removed first and what remains is the three lists in
  // order. Safe only because no status in any vocabulary spells an
  // `ArtifactType` or a subtype — asserted by `binds each vocabulary to its own
  // arm`, which compares against the shared constants themselves.
  const subtypes = bound.filter((value) => ISSUE_SUBTYPES.has(value));
  const statuses = bound.filter(
    (value) => !(ISSUE_SUBTYPES.has(value) || TYPE_LITERALS.has(value))
  );
  const issueCount = HIDE_COMPLETED_ISSUE_STATUSES.length;
  const documentCount = HIDE_COMPLETED_DOCUMENT_STATUSES.length;
  return {
    issue: subtypes.length === 0 ? [] : statuses.slice(0, issueCount),
    document: statuses.slice(issueCount, issueCount + documentCount),
    issueSubtypes: subtypes,
    negated: sqlText(fragment).includes("AND NOT ("),
  };
}

const ISSUE_SUBTYPES: ReadonlySet<string> = new Set<string>([
  ArtifactSubtype.FEATURE,
  ArtifactSubtype.ISSUE,
]);

const TYPE_LITERALS: ReadonlySet<string> = new Set<string>(
  Object.values(ArtifactType)
);

/**
 * The user id the anchor SQL scoped `favorite_artifacts` to, or `null` when it
 * carried no favorites predicate (ISS-10471).
 *
 * Returns the ID, not a boolean, because the whole point of the facet is WHOSE
 * favorites it reads — a reader that only reported "a favorites clause exists"
 * would pass identically for the viewer's id and the assignee's.
 */
export function anchorFavoritesPredicate(
  node: unknown
): { userId: string | null; negated: boolean; operator: string } | null {
  const fragment = findSqlFragment(node, "FROM favorite_artifacts");
  if (fragment === null) {
    return null;
  }
  const text = sqlText(fragment);
  return {
    userId: boundUuidsExcludingScope(fragment)[0] ?? null,
    negated: NEGATED_EXISTS.test(text),
    // `fa.user_id <>` binds the same viewer id `=` does, so the bound value
    // cannot distinguish them.
    operator: FAVORITES_OPERATOR.exec(text)?.[1] ?? "",
  };
}

export function anchorFavoritesUserId(node: unknown): string | null {
  return anchorFavoritesPredicate(node)?.userId ?? null;
}

/**
 * The project ids the anchor SQL narrowed on, or `null` when it carried no
 * project predicate (ISS-10471). Read out of the EMITTED SQL, like its siblings.
 *
 * Identified by UUID shape minus the ids the surrounding predicate already
 * binds. The tag reader does the same; the two cannot be confused because each
 * first checks for its own clause, and a query carrying both narrows the
 * candidate set the same way for each.
 */
export function anchorProjectFilter(node: unknown): string[] | null {
  const text = sqlText(node);
  if (!text.includes("a.project_id IN")) {
    return null;
  }
  const borrowed = new Set([
    ...tagScopedUuids(node),
    ...(anchorFavoritesUserId(node) === null
      ? []
      : [anchorFavoritesUserId(node) as string]),
  ]);
  return boundUuidsExcludingScope(node).filter((value) => !borrowed.has(value));
}

/**
 * Every bound uuid that is not the organization or the assignee — the two the
 * anchor predicate always binds, whatever facets are active.
 */
function boundUuidsExcludingScope(node: unknown): string[] {
  return flattenSqlValues(node).filter(
    (value): value is string =>
      typeof value === "string" &&
      UUID_SHAPE.test(value) &&
      value !== ORGANIZATION_ID &&
      value !== ASSIGNEE_ID
  );
}

/**
 * The uuids bound inside the tag `EXISTS` specifically, so a project read can
 * subtract them. Sliced from the clause's own fragment rather than from the
 * whole statement, because both facets bind bare uuids and nothing in the value
 * list says which clause each belongs to.
 */
function tagScopedUuids(node: unknown): string[] {
  const tagFragment = findSqlFragment(node, "FROM tag_artifacts");
  return tagFragment === null ? [] : boundUuidsExcludingScope(tagFragment);
}

/** The innermost nested `Sql` whose own text contains `marker`. */
function findSqlFragment(node: unknown, marker: string): unknown {
  if (!node || typeof node !== "object" || !("strings" in node)) {
    return null;
  }
  if (!sqlText(node).includes(marker)) {
    return null;
  }
  // Cast shape mirrors `sqlText`'s: it must name `strings` as well, or it does
  // not overlap the type the `in` guard above already narrowed to.
  const { values } = node as { strings: string[]; values: unknown[] };
  for (const value of values) {
    const deeper = findSqlFragment(value, marker);
    if (deeper !== null) {
      return deeper;
    }
  }
  return node;
}

/**
 * The tag ids the anchor SQL narrowed on, or `null` when it carried no tag
 * predicate (ISS-10471). Read out of the EMITTED SQL, like its siblings.
 *
 * The ids are the bound values that are not already accounted for by the org,
 * assignee, status or priority predicates, identified by UUID shape — the tag
 * vocabulary is open, so there is no closed list to match them against.
 */
export function anchorTagPredicate(
  node: unknown
): { tagIds: string[]; negated: boolean; membership: string } | null {
  const fragment = findSqlFragment(node, "FROM tag_artifacts");
  if (fragment === null) {
    return null;
  }
  const text = sqlText(fragment);
  return {
    tagIds: boundUuidsExcludingScope(fragment),
    // `toContain("EXISTS")` passes on `NOT EXISTS`, so the marker cannot carry
    // polarity and the bound ids are identical either way.
    negated: NEGATED_EXISTS.test(text),
    membership: TAG_MEMBERSHIP.exec(text)?.[1] ?? "",
  };
}

export function anchorTagFilter(node: unknown): string[] | null {
  return anchorTagPredicate(node)?.tagIds ?? null;
}

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function flattenSqlValues(node: unknown): unknown[] {
  if (!node || typeof node !== "object") {
    return [node];
  }
  if (!("values" in node)) {
    return [];
  }
  const { values } = node as { values: unknown[] };
  return values.flatMap((value) =>
    value && typeof value === "object" && "values" in value
      ? flattenSqlValues(value)
      : [value]
  );
}

const TYPE_LITERAL = /^'(\w+)'::"ArtifactType"$/;
const NEGATED_EXISTS = /NOT\s+EXISTS/;
const TAG_MEMBERSHIP = /ta\.tag_id\s+(NOT\s+IN|IN)/;
const FAVORITES_OPERATOR = /fa\.user_id\s*(<>|=)/;
const ANCHOR_ORDER_BY = /ORDER BY a\.created_at (ASC|DESC), a\.id (ASC|DESC)/;

/**
 * The anchor cap as BOUND, or `null` when the query carried no `LIMIT` at all.
 * Deleting the cap is invisible to any fixture small enough to fit under it,
 * and the cap is what the facets exist to spend wisely.
 */
export function anchorLimit(node: unknown): number | null {
  if (!sqlText(node).includes("LIMIT ")) {
    return null;
  }
  const limit = flattenSqlValues(node).find(
    (value): value is number => typeof value === "number"
  );
  return limit ?? null;
}

/**
 * The anchor sort as WRITTEN. No row set distinguishes a stated tiebreak from an
 * incidental one, and the two arms deliberately differ — `id DESC` on the narrow
 * arm so the partial index serves the sort as an ordered scan, `id ASC` on the
 * contributor arm — so the fake orders by what the query said rather than by one
 * hardcoded rule.
 */
export function anchorOrderBy(
  node: unknown
): { createdAt: string; id: string } | null {
  const match = ANCHOR_ORDER_BY.exec(sqlText(node));
  if (match === null) {
    return null;
  }
  return { createdAt: match[1], id: match[2] };
}
