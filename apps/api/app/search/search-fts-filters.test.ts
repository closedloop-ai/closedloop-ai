/**
 * FEA-3930 — the query-language filter application in `searchFtsService.
 * searchUnified`. Drives the service against a mocked `@repo/database` and
 * asserts the SQL predicate + bound values sent to `$queryRaw` (NOT timing):
 * `@owner`→`assignee_id IN`, `:status`/`:priority`→ the projection columns
 * (priority via the ordinal CASE), `:project`→ resolved `project_id IN`,
 * `:updated`→ an `updated_at` window, org-scoping intact, and the empty-text +
 * only-filters recency path.
 */

import { Priority } from "@repo/api/src/types/common";
import { SearchMode } from "@repo/api/src/types/search";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import {
  PriorityFilterKind,
  SearchFilterOperator,
  type SearchFilters,
} from "@repo/api/src/types/search-query";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  Prisma: {
    empty: { strings: [""], values: [] },
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: [...strings],
      values,
    }),
    join: (items: unknown[], separator = ",") => ({ join: items, separator }),
    QueryMode: { insensitive: "insensitive" },
  },
}));

import { withDb } from "@repo/database";
import {
  searchFtsService,
  type UnifiedSearchParams,
} from "./search-fts-service";

const mockWithDb = withDb as unknown as Mock;
const ORG = "11111111-1111-1111-1111-111111111111";

/** A mocked Prisma.sql fragment (see the mock above). */
type SqlNode =
  | { strings: string[]; values: unknown[] }
  | { join: unknown[]; separator: string }
  | string
  | number
  | Date
  | null
  | undefined;

/**
 * Recursively flatten a mocked Prisma.sql fragment tree into a single SQL string
 * (interpolating nested fragments) and the flat list of bound scalar values, so
 * a test can assert on the composed predicate + parameters.
 */
function flattenSql(node: SqlNode): { sql: string; values: unknown[] } {
  if (node === null || node === undefined) {
    return { sql: "", values: [] };
  }
  if (
    typeof node === "string" ||
    typeof node === "number" ||
    node instanceof Date
  ) {
    // A leaf bound value.
    return { sql: "?", values: [node] };
  }
  if ("join" in node) {
    const parts = node.join.map((item) => flattenSql(item as SqlNode));
    return {
      sql: parts.map((p) => p.sql).join(node.separator),
      values: parts.flatMap((p) => p.values),
    };
  }
  // A template fragment: interleave its literal strings with its flattened values.
  let sql = "";
  const values: unknown[] = [];
  node.strings.forEach((str, i) => {
    sql += str;
    if (i < node.values.length) {
      const inner = flattenSql(node.values[i] as SqlNode);
      sql += inner.sql;
      values.push(...inner.values);
    }
  });
  return { sql, values };
}

/**
 * Install a mocked db that (1) records the candidate `$queryRaw` SQL for
 * assertion, (2) resolves `user.findMany` (owner) and `project.findMany`
 * (project) to the given ids, and (3) authorizes every candidate on re-auth so
 * the filter SQL is what the test inspects, not redaction.
 *
 * The scan honours exactly ONE predicate: a candidate that declares a
 * `priority` is withheld unless the composed SQL's `"priority" IS NULL` agrees
 * with its stored value. Without that, a filter test seeded with one row asserts
 * the fake and not the filter — the row comes back whatever predicate the query
 * carried. Every other predicate is unhonoured, which is why a test that needs
 * one asserts on the captured SQL instead.
 */
function installDb(options: {
  candidates: Array<{
    entity_type: string;
    entity_id: string;
    priority?: string | null;
  }>;
  ownerUserIds?: string[];
  projectRows?: Array<{ id: string }>;
  capture: (captured: { sql: string; values: unknown[] }) => void;
}) {
  const authorizeAll = () =>
    vi.fn((args: { where: { id: { in: string[] } } }) =>
      Promise.resolve(args.where.id.in.map((id) => ({ id })))
    );

  const queryRaw = vi.fn((node: SqlNode) => {
    const flattened = flattenSql(node);
    // The FIRST $queryRaw call is the candidate scan (the one we assert on).
    if (queryRaw.mock.calls.length === 1) {
      options.capture(flattened);
    }
    const wantsUnsetPriority = flattened.sql.includes('"priority" IS NULL');
    return Promise.resolve(
      options.candidates
        .filter(
          (c) =>
            !(Object.hasOwn(c, "priority") && wantsUnsetPriority) ||
            c.priority === null
        )
        .map((c) => ({
          entity_type: c.entity_type,
          entity_id: c.entity_id,
          title: "T",
          snippet: "T",
          rank: 0,
          updated_at: new Date("2026-01-01"),
          slug: null,
          entity_subtype: null,
          team_id: null,
          anchor_entity_id: null,
        }))
    );
  });

  const db = {
    $queryRaw: queryRaw,
    user: {
      findMany: vi.fn(() =>
        Promise.resolve((options.ownerUserIds ?? []).map((id) => ({ id })))
      ),
    },
    project: {
      findMany: vi.fn(() => Promise.resolve(options.projectRows ?? [])),
    },
    artifact: { findMany: authorizeAll() },
  };
  mockWithDb.mockImplementation((cb: (d: unknown) => unknown) => cb(db));
  return db;
}

function baseParams(
  filters: SearchFilters,
  query = "acme"
): UnifiedSearchParams {
  return {
    organizationId: ORG,
    query,
    mode: SearchMode.Fulltext,
    types: [],
    since: null,
    until: null,
    limit: 25,
    cursor: null,
    filters,
  };
}

describe("searchFtsService.searchUnified — query-language filters (FEA-3930)", () => {
  let captured: { sql: string; values: unknown[] };

  beforeEach(() => {
    vi.clearAllMocks();
    captured = { sql: "", values: [] };
  });
  afterEach(() => vi.restoreAllMocks());

  it("org-scoping is always the leading predicate, even with filters", async () => {
    installDb({
      candidates: [{ entity_type: SearchEntityType.Document, entity_id: "d1" }],
      capture: (c) => {
        captured = c;
      },
    });
    await searchFtsService.searchUnified(
      baseParams({
        status: { operator: SearchFilterOperator.Eq, value: "TODO" },
      })
    );
    expect(captured.sql).toContain('"organization_id" = ');
    expect(captured.values).toContain(ORG);
  });

  it("@owner → assignee_id IN over the resolved user ids", async () => {
    const db = installDb({
      candidates: [{ entity_type: SearchEntityType.Document, entity_id: "d1" }],
      ownerUserIds: ["user-a", "user-b"],
      capture: (c) => {
        captured = c;
      },
    });
    await searchFtsService.searchUnified(
      baseParams({ owner: ["alice", "bob"] })
    );
    expect(db.user.findMany).toHaveBeenCalledTimes(1);
    expect(captured.sql).toContain('"assignee_id" IN (');
    expect(captured.values).toContain("user-a");
    expect(captured.values).toContain("user-b");
  });

  it("@owner resolving to zero members short-circuits to an empty page (never ignored)", async () => {
    const db = installDb({
      candidates: [{ entity_type: SearchEntityType.Document, entity_id: "d1" }],
      ownerUserIds: [],
      capture: (c) => {
        captured = c;
      },
    });
    const res = await searchFtsService.searchUnified(
      baseParams({ owner: ["ghost"] })
    );
    expect(res.results).toHaveLength(0);
    expect(res.nextCursor).toBeNull();
    // The candidate scan never runs — the doomed filter is not silently dropped.
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it(":status = → status column equality", async () => {
    installDb({
      candidates: [{ entity_type: SearchEntityType.Document, entity_id: "d1" }],
      capture: (c) => {
        captured = c;
      },
    });
    await searchFtsService.searchUnified(
      baseParams({
        status: { operator: SearchFilterOperator.Eq, value: "IN_PROGRESS" },
      })
    );
    expect(captured.sql).toContain('"status" = ');
    expect(captured.values).toContain("IN_PROGRESS");
  });

  it(":status != → IS DISTINCT FROM (also matches null-status rows)", async () => {
    installDb({
      candidates: [{ entity_type: SearchEntityType.Document, entity_id: "d1" }],
      capture: (c) => {
        captured = c;
      },
    });
    await searchFtsService.searchUnified(
      baseParams({
        status: { operator: SearchFilterOperator.Neq, value: "DONE" },
      })
    );
    expect(captured.sql).toContain('"status" IS DISTINCT FROM ');
    expect(captured.values).toContain("DONE");
  });

  it(":priority >= medium → ordinal CASE compared against the MEDIUM ordinal (1)", async () => {
    installDb({
      candidates: [{ entity_type: SearchEntityType.Document, entity_id: "d1" }],
      capture: (c) => {
        captured = c;
      },
    });
    await searchFtsService.searchUnified(
      baseParams({
        priority: {
          kind: PriorityFilterKind.Ordinal,
          operator: SearchFilterOperator.Gte,
          value: "MEDIUM",
        },
      })
    );
    // The predicate maps priority TEXT → ordinal and compares with `>=`.
    expect(captured.sql).toContain('CASE "priority"');
    expect(captured.sql).toContain(">= ");
    // The bound target ordinal for MEDIUM is 1 (LOW=0, MEDIUM=1, HIGH=2, URGENT=3).
    expect(captured.values).toContain(1);
    // The CASE mapping binds each priority value → ordinal (so LOW/HIGH/URGENT present).
    expect(captured.values).toContain("MEDIUM");
    expect(captured.values).toContain("URGENT");
  });

  it(":priority = high binds the HIGH ordinal (2)", async () => {
    installDb({
      candidates: [{ entity_type: SearchEntityType.Document, entity_id: "d1" }],
      capture: (c) => {
        captured = c;
      },
    });
    await searchFtsService.searchUnified(
      baseParams({
        priority: {
          kind: PriorityFilterKind.Ordinal,
          operator: SearchFilterOperator.Eq,
          value: "HIGH",
        },
      })
    );
    // The comparison target is the HIGH ordinal, 2.
    expect(captured.values).toContain(2);
  });

  it(":priority = NONE → an IS NULL test, never an ordinal comparison", async () => {
    installDb({
      candidates: [{ entity_type: SearchEntityType.Document, entity_id: "d1" }],
      capture: (c) => {
        captured = c;
      },
    });
    await searchFtsService.searchUnified(
      baseParams({
        priority: {
          kind: PriorityFilterKind.Unset,
          operator: SearchFilterOperator.Eq,
        },
      })
    );
    expect(captured.sql).toContain('"priority" IS NULL');
    // The negative half matters as much as the positive one: an ordinal CASE in
    // this predicate would silently exclude every row it claims to select,
    // because a NULL compares to nothing (ISS-9665).
    expect(captured.sql).not.toContain('"priority" IS NOT NULL');
    expect(captured.sql).not.toContain('CASE "priority"');
  });

  it("scopes = NONE to the kinds that can hold a priority", async () => {
    // The comment, PR and component projections write a literal
    // `priority: null` because the field does not APPLY to them. Without this
    // clause `priority:none` answers with every one of those in the org — a
    // NULL meaning "not applicable" read as a NULL meaning "unset". Sessions
    // and branches joined the priority-bearing set with ISS-10332.
    installDb({
      candidates: [{ entity_type: SearchEntityType.Document, entity_id: "d1" }],
      capture: (c) => {
        captured = c;
      },
    });
    // Faceted to documents so the corpus `types` predicate binds only
    // Document; every other kind below can then come only from the priority
    // clause.
    await searchFtsService.searchUnified({
      ...baseParams({
        priority: {
          kind: PriorityFilterKind.Unset,
          operator: SearchFilterOperator.Eq,
        },
      }),
      types: [SearchEntityType.Document],
    });

    expect(captured.sql).toContain('"entity_type" IN (');
    expect(captured.values).toContain(SearchEntityType.Document);
    expect(captured.values).toContain(SearchEntityType.Project);
    expect(captured.values).toContain(SearchEntityType.Branch);
    expect(captured.values).toContain(SearchEntityType.AgentSession);
    for (const entityType of [
      SearchEntityType.Comment,
      SearchEntityType.PullRequest,
      SearchEntityType.AgentComponent,
    ]) {
      expect(captured.values).not.toContain(entityType);
    }
  });

  it(":priority != NONE → an IS NOT NULL test", async () => {
    installDb({
      candidates: [{ entity_type: SearchEntityType.Document, entity_id: "d1" }],
      capture: (c) => {
        captured = c;
      },
    });
    await searchFtsService.searchUnified(
      baseParams({
        priority: {
          kind: PriorityFilterKind.Unset,
          operator: SearchFilterOperator.Neq,
        },
      })
    );
    expect(captured.sql).toContain('"priority" IS NOT NULL');
    expect(captured.sql).not.toContain('CASE "priority"');
  });

  /**
   * ISS-9441: a project whose priority a user CLEARED now exists, and the two
   * priority predicates have to answer for it in opposite directions.
   *
   * The `>=` half is the one that can silently break. Its ordinal `CASE` yields
   * NULL for a cleared row, and `NULL >= 0` is NULL, so the row is not matched —
   * which is correct and is also entirely a property of three-valued logic
   * rather than of anything written down. A `COALESCE("priority", 'MEDIUM')`
   * added to that CASE, the obvious way to "fix" an ordinal over a nullable
   * column, would put every cleared project into `:priority>=low` while leaving
   * every other case in this file green.
   */
  it("answers a cleared project for = NONE and never folds it into an ordinal bound", async () => {
    // A MIXED population, and both rows authorized, so the result assertion is
    // about the PREDICATE: a scan that lost `"priority" IS NULL` returns the
    // MEDIUM project too, and the `toEqual` below fails.
    const projectCandidates = [
      {
        entity_type: SearchEntityType.Project,
        entity_id: "proj-cleared",
        priority: null,
      },
      {
        entity_type: SearchEntityType.Project,
        entity_id: "proj-medium",
        priority: Priority.Medium,
      },
    ];
    const authorizedProjects = [{ id: "proj-cleared" }, { id: "proj-medium" }];
    installDb({
      candidates: projectCandidates,
      projectRows: authorizedProjects,
      capture: (c) => {
        captured = c;
      },
    });
    const unset = await searchFtsService.searchUnified(
      baseParams({
        priority: {
          kind: PriorityFilterKind.Unset,
          operator: SearchFilterOperator.Eq,
        },
      })
    );

    expect(captured.sql).toContain('"priority" IS NULL');
    expect(captured.values).toContain(SearchEntityType.Project);
    expect(
      unset.results.map((result) => [result.entityType, result.entityId])
    ).toEqual([[SearchEntityType.Project, "proj-cleared"]]);

    installDb({
      candidates: projectCandidates,
      projectRows: authorizedProjects,
      capture: (c) => {
        captured = c;
      },
    });
    await searchFtsService.searchUnified(
      baseParams({
        priority: {
          kind: PriorityFilterKind.Ordinal,
          operator: SearchFilterOperator.Gte,
          value: Priority.Low,
        },
      })
    );

    // The CASE reads the BARE column, so a cleared row maps to NULL. A
    // `CASE COALESCE("priority", 'MEDIUM')` fails this line.
    expect(captured.sql).toContain('CASE "priority"');
    // LOW's ordinal, the weakest bound there is: if a cleared project can be
    // pulled into any ordinal comparison, it is pulled into this one.
    expect(captured.values).toContain(0);
    // And no null-rescuing disjunct beside the comparison.
    expect(captured.sql).not.toContain('"priority" IS NULL');
  });

  it(":project → resolves slug/name to ids then project_id IN", async () => {
    const db = installDb({
      candidates: [{ entity_type: SearchEntityType.Document, entity_id: "d1" }],
      projectRows: [{ id: "proj-1" }, { id: "proj-2" }],
      capture: (c) => {
        captured = c;
      },
    });
    await searchFtsService.searchUnified(
      baseParams({ project: { value: "acme-web" } })
    );
    expect(db.project.findMany).toHaveBeenCalledTimes(1);
    expect(captured.sql).toContain('"project_id" IN (');
    expect(captured.values).toContain("proj-1");
    expect(captured.values).toContain("proj-2");
  });

  it(":project resolving to zero projects short-circuits to empty", async () => {
    const db = installDb({
      candidates: [{ entity_type: SearchEntityType.Document, entity_id: "d1" }],
      projectRows: [],
      capture: (c) => {
        captured = c;
      },
    });
    const res = await searchFtsService.searchUnified(
      baseParams({ project: { value: "nope" } })
    );
    expect(res.results).toHaveLength(0);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it(":updated bound → updated_at comparison with the bound date", async () => {
    installDb({
      candidates: [{ entity_type: SearchEntityType.Document, entity_id: "d1" }],
      capture: (c) => {
        captured = c;
      },
    });
    const date = new Date("2026-07-01T00:00:00.000Z");
    await searchFtsService.searchUnified(
      baseParams({
        updated: { kind: "bound", operator: SearchFilterOperator.Gt, date },
      })
    );
    expect(captured.sql).toContain('"updated_at" > ');
    expect(captured.values).toContainEqual(date);
  });

  it(":updated range → an inclusive updated_at window", async () => {
    installDb({
      candidates: [{ entity_type: SearchEntityType.Document, entity_id: "d1" }],
      capture: (c) => {
        captured = c;
      },
    });
    const from = new Date("2026-07-01T00:00:00.000Z");
    const to = new Date("2026-07-15T00:00:00.000Z");
    await searchFtsService.searchUnified(
      baseParams({ updated: { kind: "range", from, to } })
    );
    expect(captured.sql).toContain('"updated_at" >= ');
    expect(captured.sql).toContain('"updated_at" <= ');
    expect(captured.values).toContainEqual(from);
    expect(captured.values).toContainEqual(to);
  });

  it("empty text + only filters is valid: no tsv match, recency-ordered, rank 0", async () => {
    installDb({
      candidates: [{ entity_type: SearchEntityType.Document, entity_id: "d1" }],
      capture: (c) => {
        captured = c;
      },
    });
    // The query is entirely a filter (parsed text is empty).
    const res = await searchFtsService.searchUnified(
      baseParams(
        { status: { operator: SearchFilterOperator.Eq, value: "TODO" } },
        ""
      )
    );
    // The full-text match predicate is absent; the status filter is present.
    expect(captured.sql).not.toContain('"tsv" @@');
    expect(captured.sql).toContain('"status" = ');
    // A row still comes back (recency-ordered), so filters-only is a real query.
    expect(res.results).toHaveLength(1);
  });

  it("full-text text keeps the tsv match predicate alongside a filter", async () => {
    installDb({
      candidates: [{ entity_type: SearchEntityType.Document, entity_id: "d1" }],
      capture: (c) => {
        captured = c;
      },
    });
    await searchFtsService.searchUnified(
      baseParams(
        { status: { operator: SearchFilterOperator.Eq, value: "TODO" } },
        "rocket"
      )
    );
    expect(captured.sql).toContain('"tsv" @@');
    expect(captured.sql).toContain('"status" = ');
  });
});
