import type { Prisma } from "@repo/database";
import type {
  AgentSessionListQuery,
  AgentSessionSortColumn,
  AgentSessionSortRule,
} from "../validators";
import {
  resolveSessionSortRules,
  SESSION_SORT_COLUMN_KINDS,
  SessionSortColumnKind,
} from "./session-sort-rules";

/**
 * The Sessions list ORDER BY, as ONE source of truth.
 *
 * Four correctness invariants this module owns so no single column can regress
 * them independently:
 *
 *  - FEA-4329 — offset pagination has no natural unique key, so a tie on the sort
 *    column (two sessions with the same timestamp/cost/…) lets `skip`/`take` skip
 *    or repeat a row across pages EVEN on a static snapshot. EVERY orderBy
 *    therefore ends with {@link SESSION_UNIQUE_TIEBREAKER}, the `artifactId`
 *    primary key — a TOTAL order, so a given result set paginates deterministically
 *    with no ambiguous adjacent rows. This does NOT make `skip`/`take` stable
 *    across concurrent INSERTS: a row landing ahead of the current page still
 *    shifts every later offset by one (the row repeats), which is inherent to
 *    offset pagination — only cursor/keyset pagination is insert-stable. The
 *    tiebreaker's guarantee is a total, repeatable order for a fixed population,
 *    not immunity to a moving one.
 *  - FEA-4330 — Postgres orders NULLs FIRST on `DESC` by default, so a descending
 *    sort on a nullable column (cost, model, repository, harness, started,
 *    duration, autonomy) put blank rows ABOVE the real maxima. Every nullable sort column
 *    is pinned `nulls: "last"` in BOTH directions here, so blanks always sort to
 *    the end regardless of direction ({@link nullableColumnOrder}).
 *  - FEA-4297 / ISS-5131 — the displayed Duration is `end - start`, where `start`
 *    is `sessionStartedAt` and `end` is `now` when the DISPLAYED status
 *    classifies as running, `sessionEndedAt` otherwise, and null when neither is
 *    available (unmeasurable rather than a fabricated span).
 *
 *    ISS-5131 removed `lastActivityAt` as the END INSTANT — that anchor tracks
 *    SYNC time on a finished run, and following it is what rendered 170h for a
 *    31h session. It did NOT remove it from the rule: ISS-6270 keys the
 *    classifier on the DISPLAYED status, and the staleness fold behind that
 *    reads `lastActivityAt ?? startedAt`, so the anchor still reaches this sort
 *    key — see `DurationSortCandidate` in `./session-display-sort`, which is
 *    deliberately wider than the span itself needs for exactly that reason (a
 *    module-local type, so it is named rather than `@link`ed). Enumerating the
 *    inputs here is what went stale before; that type is the list.
 *
 *    No stored column expresses "now for some rows, `sessionEndedAt` for the
 *    rest", so `duration` is a {@link isDisplayValueSort} sort resolved in memory
 *    against the same rule the cell renders (`resolveDisplayDurationMs` here,
 *    `resolveSessionDurationWindow` in `packages/app/agents/lib/session-duration.ts`,
 *    and `resolveDurationEndMs` on the desktop working set — three copies, one
 *    rule). Cell/comparator parity was reached in steps and no single ticket was
 *    the last one: ISS-4989 tracked an early divergence, ISS-5131 fixed the
 *    endpoint, ISS-6463 made `lastActivityAt` NOT NULL, and ISS-6270 later fixed
 *    a separate raw-vs-displayed status disagreement. Read the current rule from
 *    the three functions above rather than trusting any of those to be final.
 *  - FEA-4300 — the Owner cell renders the user's display name
 *    (`"First Last"`, falling back to email), but the server ordered by the hidden
 *    email. `user` is a {@link isDisplayValueSort} sort resolved in memory against
 *    the same display-name derivation, case-insensitively.
 *
 * Every OTHER column stays in Prisma `orderBy`; the display-value columns —
 * {@link DISPLAY_VALUE_SORTS}, which is the list, deliberately not restated here —
 * route through the in-memory candidate path. Cost is NOT one of them: it read
 * that way until ISS-7176 made `estimated_cost` the column the row displays, so
 * cost is CLASSIFIED `SessionSortColumnKind.Db` and the database can rank it
 * directly. Classification is not the arm: which arm a request takes is decided
 * by the rule list as a WHOLE ({@link buildSessionSortOrderBy}), so a cost rule
 * reaches the DB-native arm only in an all-DB-native list — `[cost, user]` takes
 * {@link SESSION_DEFAULT_ORDER_BY} like any other list carrying a display-value
 * rule, and the comparator chain does the ranking. That set has grown twice
 * (`status`, then `updated` in ISS-6005) and SHRANK once (`status` left it again
 * — ISS-9939 / ISS-10262, moving it to the raw persisted column instead), and
 * prose enumerating it went stale every time, which is why the set itself is
 * the only thing named here now.
 */

/**
 * FEA-4329: the stable unique tiebreaker appended to EVERY orderBy. `artifactId`
 * is the `SessionDetail` primary key, so it is total and never null — the last
 * key in the order is guaranteed unique, giving offset pagination a deterministic,
 * repeatable order over a FIXED population (no ambiguous adjacent rows). It does
 * NOT make `skip`/`take` immune to concurrent inserts — a row landing ahead of the
 * page still shifts later offsets; that is inherent to offset (vs cursor)
 * pagination.
 */
export const SESSION_UNIQUE_TIEBREAKER: Prisma.SessionDetailOrderByWithRelationInput =
  { artifactId: "desc" };

/**
 * FEA-4330: order a nullable column with NULLs last in BOTH directions. Postgres
 * defaults to NULLs-first on `DESC`, which floats blank rows above real maxima;
 * pinning `nulls: "last"` keeps "no value" at the end whichever way the user
 * sorts.
 */
function nullableColumnOrder(
  column: keyof Prisma.SessionDetailOrderByWithRelationInput,
  dir: "asc" | "desc"
): Prisma.SessionDetailOrderByWithRelationInput {
  return { [column]: { sort: dir, nulls: "last" } };
}

/**
 * PLN-1034: the Sessions list defaults to most-recent genuine activity.
 * `sessionStartedAt` narrows ties and the unique `artifactId` key closes them
 * (FEA-4329).
 *
 * ISS-6463: `lastActivityAt` is NOT NULL, so the FEA-4330 `nulls: "last"` pin it
 * used to carry is moot — there are no blanks to float. Plain direction, like
 * the other two non-null keys here.
 */
export const SESSION_DEFAULT_ORDER_BY: Prisma.SessionDetailOrderByWithRelationInput[] =
  [
    { lastActivityAt: "desc" },
    { sessionStartedAt: "desc" },
    SESSION_UNIQUE_TIEBREAKER,
  ];

/**
 * FEA-4297/FEA-4300: the sort columns whose displayed value is a derivation
 * with no single trustworthy DB column — Duration (a computed span) and Owner
 * (a "First Last"/email display name). These route through the in-memory
 * candidate path so the ordering matches exactly what the row renders.
 *
 * Status left this set under ISS-9939's ruling (ISS-10262): its SORT key is
 * now the raw persisted `artifact.status` column, ordered by the database
 * while D5's root-order flag is off — a
 * displayed-Waiting row (which stores `active`) sorts among Active rows
 * again, which FEA-4301 is knowingly superseded to allow.
 */
export const DISPLAY_VALUE_SORTS: ReadonlySet<AgentSessionListQuery["sortBy"]> =
  new Set<AgentSessionListQuery["sortBy"]>(
    (Object.keys(SESSION_SORT_COLUMN_KINDS) as AgentSessionSortColumn[]).filter(
      (column) =>
        SESSION_SORT_COLUMN_KINDS[column] === SessionSortColumnKind.Display
    )
  );

export function isDisplayValueSort(
  sortBy: AgentSessionListQuery["sortBy"]
): boolean {
  return sortBy !== undefined && DISPLAY_VALUE_SORTS.has(sortBy);
}

/**
 * The DB-native ORDER BY for a sort column, with FEA-4330 nulls-last on every
 * nullable column and the FEA-4329 unique tiebreaker appended. The
 * {@link DISPLAY_VALUE_SORTS} columns DO reach here — `query-builder.ts` calls
 * this unconditionally — and take {@link SESSION_DEFAULT_ORDER_BY}, which is
 * their candidate PRE-SCAN order, not their ranking; the ranking is resolved in
 * memory. An unset `sortBy` keeps the same default as its final order. The
 * exhaustive
 * `switch` makes a newly-added sort column fail typecheck until it is mapped here
 * or routed through the display-value path.
 */
export function buildDbSortOrderBy(
  filters: AgentSessionListQuery
): Prisma.SessionDetailOrderByWithRelationInput[] {
  return buildSessionSortOrderBy(resolveSessionSortRules(filters));
}

/**
 * ISS-8335: the DB-native `orderBy` for an ORDERED RULE LIST, with the FEA-4329
 * unique tiebreaker still LAST.
 *
 * Two arms, and which one a request takes is decided by the rule list as a
 * WHOLE:
 *
 *  - EVERY rule DB-native → each rule's own key, in priority order, then the
 *    last rule's narrowing keys, then {@link SESSION_UNIQUE_TIEBREAKER}. The
 *    cheap indexed path, however many rules there are.
 *  - ANY rule display-value → {@link SESSION_DEFAULT_ORDER_BY}, which is
 *    the candidate PRE-SCAN order and not the ranking; the ranking is the
 *    in-memory comparator chain (`buildSessionSortComparator`). A single such
 *    rule takes the whole query with it, because a chain the database can order
 *    only PART of is a chain it orders WRONGLY: `[repo asc, user asc]` emitted
 *    as `ORDER BY repository_full_name ASC` paginates by repo and settles every
 *    repo-tie by the tiebreaker, so the Owner rule the toolbar shows as applied
 *    decides nothing.
 *
 * Narrowing keys are the deterministic-but-not-requested keys a column carries
 * (today only `lastActivity`'s `sessionStartedAt desc`). They are appended ONLY
 * after the last rule and only for columns no rule already named — a narrowing
 * key emitted BETWEEN two rules would settle almost every tie before the second
 * rule was consulted, which is the same silent drop in a subtler place.
 */
export function buildSessionSortOrderBy(
  rules: readonly AgentSessionSortRule[]
): Prisma.SessionDetailOrderByWithRelationInput[] {
  const dbRules: { column: SessionDbSortColumn; dir: "asc" | "desc" }[] = [];
  for (const rule of rules) {
    if (!isDbSortColumn(rule.column)) {
      break;
    }
    dbRules.push({ column: rule.column, dir: rule.dir });
  }
  if (rules.length === 0 || dbRules.length !== rules.length) {
    return SESSION_DEFAULT_ORDER_BY;
  }
  const named = new Set<AgentSessionSortColumn>(
    dbRules.map((rule) => rule.column)
  );
  const lastRule = dbRules.at(-1);
  const narrowing = lastRule
    ? dbColumnNarrowing(lastRule.column).filter(
        (entry) => !named.has(entry.column)
      )
    : [];
  return [
    ...dbRules.map((rule) => dbColumnOrderBy(rule.column, rule.dir)),
    ...narrowing.map((entry) => entry.orderBy),
    SESSION_UNIQUE_TIEBREAKER,
  ];
}

/**
 * The DB-native sort columns, DERIVED from {@link SESSION_SORT_COLUMN_KINDS}
 * rather than re-listed, so the exhaustive switch below covers exactly the
 * columns classified `Db` and a re-classification is a typecheck failure.
 */
export type SessionDbSortColumn = {
  [K in AgentSessionSortColumn]: (typeof SESSION_SORT_COLUMN_KINDS)[K] extends typeof SessionSortColumnKind.Db
    ? K
    : never;
}[AgentSessionSortColumn];

/** Is this column one the database can order by itself? */
export function isDbSortColumn(
  column: AgentSessionSortColumn
): column is SessionDbSortColumn {
  return SESSION_SORT_COLUMN_KINDS[column] === SessionSortColumnKind.Db;
}

/** One rule's own `orderBy` key — no tiebreaker, no narrowing. */
function dbColumnOrderBy(
  column: SessionDbSortColumn,
  dir: "asc" | "desc"
): Prisma.SessionDetailOrderByWithRelationInput {
  switch (column) {
    case "autonomy":
      return nullableColumnOrder("autonomy", dir);
    case "cost":
      // ISS-7176: `estimated_cost` IS the cost the row displays, so the database
      // ranks it. This column used to be its own `SessionSortColumnKind.Cost`,
      // taking the whole query onto an in-memory candidate path that re-derived
      // each session's cost from `agent_session_token_events` — the rollup was
      // emitted here only as a PRE-SCAN approximation of that ranking, and
      // deliberately never inside a rule chain, because an approximation that is
      // right most of the time settles most ties before the reader's next rule is
      // consulted. There is no approximation now: this is the value, so it
      // composes in a chain like any other key.
      //
      // Nullable since ISS-7813, and `nullableColumnOrder` floats those last —
      // an unpriced session sorts after every priced one rather than tying with
      // a genuine $0.
      return nullableColumnOrder("estimatedCost", dir);
    case "lastActivity":
      // `lastActivityAt` is non-null (ISS-6463); nulls-ordering is moot.
      return { lastActivityAt: dir };
    case "repo":
      return nullableColumnOrder("repositoryFullName", dir);
    case "harness":
      // `harness` is non-null (schema default "unknown"), so nulls-ordering is
      // moot.
      return { harness: dir };
    case "model":
      return nullableColumnOrder("model", dir);
    case "priority":
      // ISS-10332: `artifacts.priority` is the Postgres `Priority` enum, which
      // orders by DECLARATION order — LOW, MEDIUM, HIGH, URGENT — the same
      // low→high order as the wire `PRIORITY_ORDINAL` the in-memory comparator
      // reads (`session-sort-order.test.ts` holds the declaration order to it).
      // Nullable, so blanks are pinned last in both directions (FEA-4330).
      return { artifact: { priority: { sort: dir, nulls: "last" } } };
    case "started":
      // `sessionStartedAt` is non-null; nulls-ordering is moot.
      return { sessionStartedAt: dir };
    case "status":
      // ISS-9939 / ISS-10262: the PERSISTED status, `artifacts.status` — a
      // relation order because the column lives on `Artifact`, not
      // `SessionDetail` (`apps/api/AGENTS.md` "Session State": do not re-key a
      // status derivation onto `SessionDetail.state`, `artifacts.status` owns
      // that axis). Non-null, so nulls-ordering is moot.
      return { artifact: { status: dir } };
    default: {
      const exhaustive: never = column;
      return exhaustive;
    }
  }
}

/**
 * The keys a column narrows its own ties with when it is the LAST rule, each
 * paired with the sort column that owns it so
 * {@link buildSessionSortOrderBy} can drop one a rule already named.
 */
function dbColumnNarrowing(column: SessionDbSortColumn): readonly {
  column: AgentSessionSortColumn;
  orderBy: Prisma.SessionDetailOrderByWithRelationInput;
}[] {
  if (column === "lastActivity") {
    return [{ column: "started", orderBy: { sessionStartedAt: "desc" } }];
  }
  return [];
}
