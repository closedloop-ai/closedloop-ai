import { randomUUID } from "node:crypto";
import { withDb } from "@repo/database";
import {
  ROWS_REMOVED_BY_FILTER_LABEL,
  requireIndexPredicate,
  requireRowsRemovedByFilter,
  requireScanNode,
} from "@repo/database/__tests__/test-helpers/explain-plan";
import { makePlannerDecoyOrgIds } from "@repo/database/__tests__/test-helpers/planner-fixture";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compactSessionListPlannerTables,
  purgeSessionListPlannerFixture,
  SESSION_LIST_PLANNER_TABLES,
  SessionListPlannerDetail,
  seedSessionListPlannerFixture,
} from "@/__tests__/support/agent-sessions/session-list-planner.test-fixtures";
import {
  explainCapturedStatement,
  explainWithoutLeadingIndexes,
  IndexDependentPolicy,
} from "@/__tests__/support/captured-statement-plan.test-helpers";
import {
  type ObservedStatement,
  observeStatements,
} from "@/__tests__/support/db-statement-observer";
import {
  AGENT_SESSION_SORT_COLUMNS,
  type AgentSessionListQuery,
  type AgentSessionSortColumn,
  type AgentSessionSortRule,
} from "../validators";
import { findDbPaginatedPage, type SessionListPage } from "./list-page-fetch";
import { buildAgentSessionOrderBy, buildWhere } from "./query-builder";
import type { AgentSessionListRecord } from "./records";
import { SESSIONS_SURFACE_DATE_FIELD } from "./session-date-field";
import {
  isDbSortColumn,
  isDisplayValueSort,
  SESSION_DEFAULT_ORDER_BY,
  type SessionDbSortColumn,
} from "./session-sort-order";
import {
  requiresInMemorySessionSort,
  resolveSessionSortRules,
} from "./session-sort-rules";

/**
 * ISS-9478 — the Sessions LIST read (`GET /agent-sessions`, the DB-paginated
 * arm) for every DB-native sort, under the default request: the org scope plus
 * the `lastActivityAt` date window. What ISS-9477's compiled predicates rely on.
 *
 * WHAT THIS PINS. (1) The org predicate reaches an index on the `artifacts`
 * alias the WHERE scopes through, and that scan discards no other tenant's rows.
 * (2) The ORDER BY the database receives ends in `session_detail.artifact_id` and
 * carries NULLS LAST on every key over a column the catalog reports nullable.
 * (3) Offset pages over the fixed population partition it: their concatenation
 * is the single-read order, each session once, blank sort values last in both
 * directions. The display-value sorts (duration, updated, user) never reach this
 * arm — {@link requiresInMemorySessionSort} routes them to
 * `findDisplayValueSortedPage`, whose org-scoped read
 * `session-keyset-index.integration.test.ts` guards — and are recorded N/A here.
 *
 * WHAT IT DELIBERATELY DOES NOT PIN. The `session_detail` side of the plan. It is
 * a planner cost choice that moves with table state: on this fixture it was a
 * Bitmap on the window index after VACUUM FULL, an org-first Nested Loop into
 * `session_detail_pkey` after 100,000 dead rows, and a Seq Scan after a plain
 * VACUUM — all three with the org side unchanged. Hence also the
 * `VACUUM (FULL, ANALYZE)` after seeding. The page walk has no must-fail
 * counterfactual on purpose: without the tiebreaker PostgreSQL's tie order is
 * unspecified, so such an arm would be flaky; the deterministic counterfactuals
 * are in `session-sort-order.test.ts` and `session-sort-total-order.test.ts`.
 *
 * WHY NO INDEX WAS ADDED (measured 2026-09-23, PostgreSQL 16, this fixture's
 * shape). Every one of the 18 plans is `Limit → Sort (top-N heapsort) → Hash Join
 * [session_detail by the window] ⋈ [artifacts by the org]`, ~2.5 ms at 10,000
 * rows. The org lives on `artifacts`, every sort key on `session_detail` or on a
 * SECOND `artifacts` alias Prisma joins for the relation orderBy, so no index can
 * emit an org-scoped order. Candidates were built in a rolled-back transaction:
 * one full-key composite per session_detail sort and direction (14, e.g.
 * `(estimated_cost DESC NULLS LAST, artifact_id DESC)` — NULLS LAST in both
 * directions plus the fixed DESC tiebreaker defeat backward scans), and eight
 * `artifacts` composites for priority/status, org-leading and not. At 10,000
 * rows none changed any plan. At 100,000 rows (5% tenant share) the session_detail
 * composites did remove the Sort, and page 1 dropped from 20–25 ms to 3–5 ms —
 * but only by walking the new index across ALL tenants with the window demoted
 * to a Filter (cost desc read 3,065 rows and probed 1,007 to keep 50; `started
 * asc` removed 66,660), a cost that grows with 1/(tenant share) and with offset,
 * bought with two composites per nullable column on the hottest write table. The
 * artifacts composites still changed nothing. No candidate removed a Sort or a
 * seq scan on the seeded database, so none shipped. The join sort itself is an
 * accepted decision: no `organization_id` on `session_detail` (PLN-854, upheld
 * in ISS-9478). The reasons and the reopen bar are on `SessionDetail` in
 * `packages/database/prisma/schema.prisma`.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const FIXTURE_CLERK_PREFIX = "org_iss9478_sort_plan_";
const ORG_ID = randomUUID();
/** Nineteen decoy tenants — the ISS-9627 measured configuration (twenty orgs). */
const ALL_ORG_IDS: readonly string[] = [ORG_ID, ...makePlannerDecoyOrgIds(19)];
const SESSIONS_PER_ORG = 500;

/** The Sessions list's recent window, the default request's date predicate. */
const WINDOW_DAYS = 30;
const WINDOW_START = new Date(
  Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000
).toISOString();

/** Page size for the walk: small against the ~1/3 of a tenant the window keeps. */
const WALK_PAGE_SIZE = 25;
const CAPTURE_PAGE_SIZE = 50;

const DIRECTIONS = ["asc", "desc"] as const;
type SortDirection = (typeof DIRECTIONS)[number];

const DB_SORT_COLUMNS: readonly SessionDbSortColumn[] =
  AGENT_SESSION_SORT_COLUMNS.filter(isDbSortColumn);
const DISPLAY_SORT_COLUMNS: readonly AgentSessionSortColumn[] =
  AGENT_SESSION_SORT_COLUMNS.filter(isDisplayValueSort);

const ORG_COLUMN = "organization_id";
const ORG_LEADING_ARTIFACTS_INDEXES = {
  table: "artifacts",
  leadingColumn: ORG_COLUMN,
  dependents: IndexDependentPolicy.DropForeignKeys,
} as const;
const PLAN_DESCRIPTION = "sessions list page";
const TIEBREAKER_COLUMN = { table: "session_detail", column: "artifact_id" };

/** A page statement: it reads `session_detail` and takes a bounded page. */
const PAGE_STATEMENT_PATTERN =
  /FROM\s+"?public"?\."?session_detail"?[\s\S]*\bLIMIT\b/i;
const WHERE_ORG_ALIAS_PATTERN = /"(\w+)"\."organization_id"\s*=\s*\$\d+/;
const JOIN_ALIAS_PATTERN = /JOIN\s+"public"\."(\w+)"\s+AS\s+"(\w+)"/g;
const ORDER_BY_CLAUSE_PATTERN = /\bORDER BY\s+([\s\S]+?)\s+LIMIT\b/i;
const ORDER_BY_TERM_PATTERN =
  /^(?:"public"\.)?"(\w+)"\."(\w+)"\s*(ASC|DESC)(?:\s+NULLS\s+(FIRST|LAST))?$/i;
const TERM_SEPARATOR_PATTERN = /,\s*/;

/**
 * The value each DB-native sort orders by, read off a list row. Keyed by the
 * production column union, so a new DB-native column fails typecheck here until
 * the walk knows how to read it.
 */
const SORT_VALUE: Record<
  SessionDbSortColumn,
  (row: AgentSessionListRecord) => unknown
> = {
  autonomy: (row) => row.autonomy,
  cost: (row) => row.estimatedCost,
  harness: (row) => row.harness,
  lastActivity: (row) => row.lastActivityAt,
  model: (row) => row.model,
  priority: (row) => row.artifact.priority,
  repo: (row) => row.repositoryFullName,
  started: (row) => row.sessionStartedAt,
  status: (row) => row.artifact.status,
};

type SortCase = { column: SessionDbSortColumn; dir: SortDirection };

type OrderByTerm = {
  table: string;
  column: string;
  nullsLast: boolean;
};

describeIfDb("sessions list DB-paginated sort plans (ISS-9478)", () => {
  const captured = new Map<string, ObservedStatement[]>();
  let nullableColumns: ReadonlySet<string>;

  beforeAll(async () => {
    await purgeSessionListPlannerFixture(FIXTURE_CLERK_PREFIX);
    await withDb(async (db) => {
      await seedSessionListPlannerFixture(db, {
        orgIds: ALL_ORG_IDS,
        sessionsPerOrg: SESSIONS_PER_ORG,
        clerkPrefix: FIXTURE_CLERK_PREFIX,
        detail: SessionListPlannerDetail.Varied,
      });
    });
    await compactSessionListPlannerTables();
    nullableColumns = await readNullableColumns();
    for (const sortCase of allSortCases()) {
      const { statements } = await observeStatements(() =>
        readPage(sortCase, 0, CAPTURE_PAGE_SIZE)
      );
      captured.set(
        caseKey(sortCase),
        statements.filter((statement) =>
          PAGE_STATEMENT_PATTERN.test(statement.sql)
        )
      );
    }
  });

  afterAll(async () => {
    await purgeSessionListPlannerFixture(FIXTURE_CLERK_PREFIX);
  });

  it("captured one tenant-bound page statement per DB-native sort and direction", () => {
    // Everything below plans a statement that had to come from somewhere; an
    // empty or foreign capture would make each assertion about nothing.
    expect(DB_SORT_COLUMNS.length).toBeGreaterThan(0);
    for (const sortCase of allSortCases()) {
      const statements = captured.get(caseKey(sortCase)) ?? [];
      expect(statements, caseKey(sortCase)).toHaveLength(1);
      expect(statements[0].values, caseKey(sortCase)).toContain(ORG_ID);
    }
  });

  it("seeded a multi-page window with blank and non-blank values for every nullable sort key", async () => {
    const population = await readPage(
      { column: "lastActivity", dir: "desc" },
      0,
      SESSIONS_PER_ORG
    );
    expect(population.total).toBeGreaterThan(WALK_PAGE_SIZE * 2);
    for (const column of DB_SORT_COLUMNS) {
      const primary = orderByTermsOf(statementFor({ column, dir: "asc" }))[0];
      if (!nullableColumns.has(columnKey(primary))) {
        continue;
      }
      const values = population.items.map(SORT_VALUE[column]);
      expect(values, column).toContain(null);
      expect(
        values.some((value) => value !== null),
        column
      ).toBe(true);
    }
  });

  it("orders on catalog-nullable columns NULLS LAST and ends on the unique artifact_id", () => {
    for (const sortCase of allSortCases()) {
      const terms = orderByTermsOf(statementFor(sortCase));
      expect(terms.at(-1), caseKey(sortCase)).toMatchObject(TIEBREAKER_COLUMN);
      for (const term of terms) {
        if (nullableColumns.has(columnKey(term))) {
          expect(
            term.nullsLast,
            `${caseKey(sortCase)} ${columnKey(term)}`
          ).toBe(true);
        }
      }
    }
  });

  it.each(DB_SORT_COLUMNS)(
    "%s: the org predicate reaches an index and no other tenant's row is discarded",
    async (column) => {
      for (const dir of DIRECTIONS) {
        const statement = statementFor({ column, dir });
        const plan = await explainCapturedStatement(
          statement,
          PLAN_DESCRIPTION
        );
        const relation = orgScanRelation(statement);
        expect(
          requireIndexPredicate(plan, relation),
          `${column} ${dir}`
        ).toContain(ORG_COLUMN);
        // PostgreSQL omits the line when nothing was discarded, so its ABSENCE
        // is the pass; the counterfactual below is where the reader belongs.
        expect(
          requireScanNode(plan, relation),
          `${column} ${dir}`
        ).not.toContain(ROWS_REMOVED_BY_FILTER_LABEL);
      }
    }
  );

  it.each(DB_SORT_COLUMNS)(
    "%s: offset pages partition the fixed population in the single-read order, blanks last",
    async (column) => {
      for (const dir of DIRECTIONS) {
        const whole = await readPage({ column, dir }, 0, SESSIONS_PER_ORG);
        expect(whole.items, `${column} ${dir}`).toHaveLength(whole.total);
        const paged: string[] = [];
        for (let offset = 0; offset < whole.total; offset += WALK_PAGE_SIZE) {
          const page = await readPage({ column, dir }, offset, WALK_PAGE_SIZE);
          paged.push(...page.items.map((row) => row.artifactId));
        }
        const wholeIds = whole.items.map((row) => row.artifactId);
        expect(paged, `${column} ${dir}`).toEqual(wholeIds);
        expect(new Set(paged).size, `${column} ${dir}`).toBe(whole.total);
        const values = whole.items.map(SORT_VALUE[column]);
        const firstBlank = values.indexOf(null);
        if (firstBlank !== -1) {
          expect(
            values.slice(firstBlank).every((value) => value === null),
            `${column} ${dir}`
          ).toBe(true);
        }
      }
    }
  );

  it("discards other tenants' rows once no org-leading artifacts index exists (counterfactual)", async () => {
    const statements = allSortCases().map(statementFor);
    const plans = await explainWithoutLeadingIndexes(
      statements,
      ORG_LEADING_ARTIFACTS_INDEXES,
      PLAN_DESCRIPTION
    );
    for (const [index, plan] of plans.entries()) {
      const scan = requireScanNode(plan, orgScanRelation(statements[index]));
      expect(scan, `statement ${index}`).toContain(
        ROWS_REMOVED_BY_FILTER_LABEL
      );
      expect(
        requireRowsRemovedByFilter(scan),
        `statement ${index}`
      ).toBeGreaterThan(SESSIONS_PER_ORG);
    }
  });

  it("routes the display-value sorts off this arm, to the in-memory ranking (N/A here)", () => {
    expect(DISPLAY_SORT_COLUMNS.length).toBeGreaterThan(0);
    for (const column of DISPLAY_SORT_COLUMNS) {
      for (const dir of DIRECTIONS) {
        const rules: AgentSessionSortRule[] = [{ column, dir }];
        expect(
          requiresInMemorySessionSort(resolveSessionSortRules({ sorts: rules }))
        ).toBe(true);
        expect(buildAgentSessionOrderBy({ sorts: rules })).toEqual(
          SESSION_DEFAULT_ORDER_BY
        );
      }
    }
  });

  function statementFor(sortCase: SortCase): ObservedStatement {
    const statements = captured.get(caseKey(sortCase));
    if (statements?.length !== 1) {
      throw new Error(
        `Expected exactly one captured page statement for ${caseKey(sortCase)}, found ${statements?.length ?? 0}.`
      );
    }
    return statements[0];
  }
});

function allSortCases(): SortCase[] {
  return DB_SORT_COLUMNS.flatMap((column) =>
    DIRECTIONS.map((dir) => ({ column, dir }))
  );
}

function caseKey(sortCase: SortCase): string {
  return `${sortCase.column} ${sortCase.dir}`;
}

function columnKey(term: Pick<OrderByTerm, "table" | "column">): string {
  return `${term.table}.${term.column}`;
}

/** The production read for one sort: the list route's where, order and fetch. */
async function readPage(
  sortCase: SortCase,
  offset: number,
  limit: number
): Promise<SessionListPage> {
  const filters: AgentSessionListQuery = {
    sortBy: sortCase.column,
    sortDir: sortCase.dir,
    startDate: WINDOW_START,
  };
  const where = await buildWhere(
    { organizationId: ORG_ID },
    filters,
    SESSIONS_SURFACE_DATE_FIELD
  );
  return findDbPaginatedPage({
    organizationId: ORG_ID,
    where,
    idleWhere: null,
    orderBy: buildAgentSessionOrderBy(filters),
    offset,
    limit,
  });
}

/** `artifacts <alias>` for the alias the WHERE scopes the tenant through. */
function orgScanRelation(statement: ObservedStatement): string {
  const alias = WHERE_ORG_ALIAS_PATTERN.exec(statement.sql)?.[1];
  if (!alias) {
    throw new Error(
      `The captured statement scopes no alias by ${ORG_COLUMN}, so there is no org scan to assert on.\n${statement.sql}`
    );
  }
  return `artifacts ${alias}`;
}

/**
 * The ORDER BY terms of a captured statement, each resolved to its table.
 *
 * Fails closed on anything it cannot read — an unparsed term would otherwise
 * drop out of the nullability check silently.
 */
function orderByTermsOf(statement: ObservedStatement): OrderByTerm[] {
  const clause = ORDER_BY_CLAUSE_PATTERN.exec(statement.sql)?.[1];
  if (!clause) {
    throw new Error(
      `No ORDER BY clause in the captured statement.\n${statement.sql}`
    );
  }
  const aliases = new Map<string, string>(
    [...statement.sql.matchAll(JOIN_ALIAS_PATTERN)].map((match) => [
      match[2],
      match[1],
    ])
  );
  return clause.split(TERM_SEPARATOR_PATTERN).map((raw) => {
    const match = ORDER_BY_TERM_PATTERN.exec(raw.trim());
    if (!match) {
      throw new Error(
        `Unreadable ORDER BY term ${JSON.stringify(raw)}.\n${clause}`
      );
    }
    const [, qualifier, column, , nulls] = match;
    return {
      table: resolveOrderByTable(qualifier, aliases, clause),
      column,
      nullsLast: nulls?.toUpperCase() === "LAST",
    };
  });
}

/** `table.column` for every nullable column of the two tables the list reads. */
async function readNullableColumns(): Promise<ReadonlySet<string>> {
  const rows = await withDb((db) =>
    db.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ANY($1::text[])
          AND is_nullable = 'YES'`,
      [...SESSION_LIST_PLANNER_TABLES]
    )
  );
  return new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
}

/**
 * The table an ORDER BY qualifier names: a JOIN alias, or one of the two tables
 * the list reads. Anything else throws — a qualifier that resolved to nothing
 * would drop its term out of the nullability check silently.
 */
function resolveOrderByTable(
  qualifier: string,
  aliases: ReadonlyMap<string, string>,
  clause: string
): string {
  const table = aliases.get(qualifier) ?? qualifier;
  if (!(SESSION_LIST_PLANNER_TABLES as readonly string[]).includes(table)) {
    throw new Error(
      `ORDER BY qualifier "${qualifier}" resolves to no table the Sessions list reads.\n${clause}`
    );
  }
  return table;
}
