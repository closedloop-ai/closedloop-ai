import type {
  AgentSessionListQuery,
  AgentSessionSortColumn,
  AgentSessionSortRule,
} from "../validators";

/**
 * ISS-8335: the ORDERED sort rules a Sessions list request actually applies, and
 * what each of them costs to apply.
 *
 * The list has always carried ONE rule. The v2 toolbar stacks them, so the
 * server had a choice between applying every rule and the toolbar not offering a
 * second one; this module is the first half of applying them. It owns two
 * questions and nothing else: which rules a request means
 * ({@link resolveSessionSortRules}), and which ORDERING MACHINERY each column
 * needs ({@link sessionSortColumnKind}) — the DB's own `ORDER BY`, or the
 * in-memory display-value comparators. (A third kind, the reconciled-cost
 * authority, existed here before ISS-7176 made cost DB-native; two kinds
 * remain.)
 *
 * The kind is what decides the fetch path, and it is a property of the COLUMN
 * rather than of its position: a cheap DB-native primary composed with a
 * display-value SECONDARY cannot be paginated by the database, because no
 * `ORDER BY` can express the secondary. Reading the kind off the primary alone
 * is exactly the mistake that would order page 1 correctly and every later page
 * by a rule the database silently ignored.
 */

export const SessionSortColumnKind = {
  /** A real, indexable `SessionDetail` column — the database can order it. */
  Db: "db",
  /**
   * A DERIVED displayed value with no single trustworthy column (Duration,
   * Owner, Updated). Ordered in memory against the same rule the cell renders
   * — see `session-display-sort.ts`. Status left this set under ISS-9939's
   * ruling (ISS-10262): its SORT key is now the persisted `artifacts.status`
   * column, ordered by the database like any other `Db` column while D5's
   * root-order flag is off. The service overrides the path when it is on.
   */
  Display: "display",
} as const;
export type SessionSortColumnKind =
  (typeof SessionSortColumnKind)[keyof typeof SessionSortColumnKind];

/**
 * The `sortBy` value that orders the Sessions list by cost.
 *
 * Re-homed here by ISS-7176 from `cost-authority.ts`, which is gone. It is an
 * ordinary DB sort column now — the constant survives only so callers name it
 * rather than spelling the literal.
 */
export const SESSION_COST_SORT_BY = "cost";

/**
 * The machinery a sort column needs, as an exhaustive map rather than a
 * predicate per kind.
 *
 * `satisfies Record<AgentSessionSortColumn, …>` is the load-bearing half: a
 * column added to `AGENT_SESSION_SORT_COLUMNS` fails typecheck HERE until
 * someone says how it is ordered, instead of defaulting into the DB arm and
 * being handed to Prisma as a column name that does not exist.
 */
export const SESSION_SORT_COLUMN_KINDS = {
  autonomy: SessionSortColumnKind.Db,
  cost: SessionSortColumnKind.Db,
  duration: SessionSortColumnKind.Display,
  harness: SessionSortColumnKind.Db,
  lastActivity: SessionSortColumnKind.Db,
  model: SessionSortColumnKind.Db,
  priority: SessionSortColumnKind.Db,
  repo: SessionSortColumnKind.Db,
  started: SessionSortColumnKind.Db,
  // ISS-9939 / ISS-10262: the operator ruling narrowed the Sessions status
  // SORT to the three PERSISTED statuses — the sort key is `artifacts.status`
  // (via the `artifact` relation), not the projected/displayed value, so this
  // no longer needs the in-memory candidate path while D5 is off. A Waiting row (stored
  // `active`) sorts among Active rows again — FEA-4301 is knowingly
  // superseded by the ruling, not a regression to fix.
  status: SessionSortColumnKind.Db,
  updated: SessionSortColumnKind.Display,
  user: SessionSortColumnKind.Display,
  assignee: SessionSortColumnKind.Display,
} as const satisfies Record<AgentSessionSortColumn, SessionSortColumnKind>;

export function sessionSortColumnKind(
  column: AgentSessionSortColumn
): SessionSortColumnKind {
  return SESSION_SORT_COLUMN_KINDS[column];
}

/**
 * The rules this request applies, in priority order.
 *
 * The repeatable `sorts` list wins when it carries anything; the scalar
 * `sortBy`/`sortDir` pair is the ONE-RULE spelling every version-skewed client
 * still sends and is read when `sorts` is absent or empty. They are never
 * merged: a client that sends both is speaking the newer contract, and folding
 * the scalar in as an extra rule would order by a column the caller only meant
 * as its back-compat echo of `sorts[0]`.
 *
 * De-duplicated by COLUMN, first occurrence winning. A column's second
 * appearance can only be reached by rows already tied on its first, where it
 * necessarily ties again — so it can never break a tie and only costs a
 * comparison. The toolbar cannot emit one (an active field is filtered out of
 * "Add another sort"); this guards the hand-built query.
 *
 * An empty result means "no explicit sort", which the order builders answer with
 * the list's default recency order — NOT an unordered read.
 *
 * ISS-12251: `assignee` resolves to `user`, its alias, because every ordering
 * path downstream (the comparators and the typed-SQL statements) names the
 * Owner sort `user`. So `[user, assignee]` is one rule, deduplicated like any
 * repeat.
 */
export function resolveSessionSortRules(
  filters: Pick<AgentSessionListQuery, "sortBy" | "sortDir" | "sorts">
): readonly AgentSessionSortRule[] {
  const requested =
    filters.sorts && filters.sorts.length > 0
      ? filters.sorts
      : toScalarSortRules(filters);
  const seen = new Set<string>();
  const deduped: AgentSessionSortRule[] = [];
  for (const rule of requested) {
    const column = rule.column === "assignee" ? "user" : rule.column;
    if (seen.has(column)) {
      continue;
    }
    seen.add(column);
    deduped.push({ column, dir: rule.dir });
  }
  return deduped;
}

/**
 * Does ANY rule need the in-memory ordering paths?
 *
 * Any single one does, for the whole query: the database cannot express a
 * display-value or reconciled-cost key at all, so a chain containing one has to
 * be resolved where every key can be read. A rule list that is entirely DB-native
 * keeps the cheap indexed `ORDER BY` + `skip`/`take` path however long it is.
 */
export function requiresInMemorySessionSort(
  rules: readonly AgentSessionSortRule[]
): boolean {
  return rules.some(
    (rule) => sessionSortColumnKind(rule.column) !== SessionSortColumnKind.Db
  );
}

/** Does any rule order by a display-value column? */
export function sessionSortRulesIncludeDisplayValue(
  rules: readonly AgentSessionSortRule[]
): boolean {
  return rules.some(
    (rule) =>
      sessionSortColumnKind(rule.column) === SessionSortColumnKind.Display
  );
}

/**
 * The scalar `sortBy`/`sortDir` pair as a rule list — empty when no explicit
 * sort was asked for. `desc` is the direction the list has always defaulted to
 * when `sortBy` arrives without one.
 */
function toScalarSortRules(
  filters: Pick<AgentSessionListQuery, "sortBy" | "sortDir">
): readonly AgentSessionSortRule[] {
  if (filters.sortBy === undefined) {
    return [];
  }
  return [{ column: filters.sortBy, dir: filters.sortDir ?? "desc" }];
}
