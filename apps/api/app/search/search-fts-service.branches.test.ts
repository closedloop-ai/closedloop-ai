import { Priority } from "@repo/api/src/types/common";
import { SearchMode } from "@repo/api/src/types/search";
import {
  OFFERED_SEARCH_ENTITY_TYPES,
  SearchEntityType,
} from "@repo/api/src/types/search-entity-kind";
import {
  PriorityFilterKind,
  SearchFilterOperator,
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
  decodeCursor,
  reauthorizeHits,
  searchFtsService,
  type UnifiedSearchParams,
} from "./search-fts-service";

const mockWithDb = vi.mocked(withDb);
const ORG = "11111111-1111-1111-1111-111111111111";
/** The `entity_id = …` equality predicate only the EXACT id/slug lane emits. */
const EXACT_ID_PREDICATE = /entity_id"?\s*=/;
/**
 * An independent one-day-in-ms oracle for the whole-day range test below —
 * deliberately not imported from the source's own (private, unexported)
 * `MS_PER_DAY`, since a test computing its expectation from the same constant
 * the code under test uses cannot catch that constant being wrong.
 */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

type Candidate = {
  entity_type: string;
  entity_id: string;
  title: string;
  snippet: string;
  rank: number;
  updated_at: Date;
  slug: string | null;
  entity_subtype: string | null;
  team_id: string | null;
  anchor_entity_id: string | null;
};

/**
 * Flatten a mocked Prisma.sql fragment tree to raw SQL text, same base shape
 * as the sibling unit-test file's helper (mirrored here since test files are
 * not a shared module boundary). Unlike the sibling's `flattenSql`, which
 * renders every bound value as an opaque `"?"` placeholder and returns the
 * real values in a side array, this one interleaves each fragment's
 * `strings` with its `values` in place (recursing into nested `Prisma.sql`/
 * `Prisma.join` fragments), so an operator and its operand land adjacent in
 * the returned text: a `Date` renders as its ISO string and every other
 * scalar via `String(...)`, so a test can assert on the actual bound value
 * rather than only the operator token. It also honors a `Prisma.join`
 * fragment's own `separator` (defaulting to a plain space only when none was
 * recorded) so a test can assert on the literal join glue (e.g. the `" OR "`
 * between the exact lane's uuid/slug match clauses).
 */
function sqlText(node: unknown): string {
  if (node === null || node === undefined) {
    return "";
  }
  if (node instanceof Date) {
    return node.toISOString();
  }
  if (typeof node === "object") {
    const n = node as {
      strings?: string[];
      values?: unknown[];
      join?: unknown[];
      separator?: unknown;
    };
    if (Array.isArray(n.join)) {
      const sep = typeof n.separator === "string" ? n.separator : " ";
      return n.join.map(sqlText).join(sep);
    }
    if (Array.isArray(n.strings)) {
      const values = n.values ?? [];
      let sql = "";
      n.strings.forEach((str, i) => {
        sql += str;
        if (i < values.length) {
          sql += sqlText(values[i]);
        }
      });
      return sql;
    }
    return "";
  }
  return String(node);
}

function isExactLaneSql(text: string): boolean {
  return text.includes("lower(") || EXACT_ID_PREDICATE.test(text);
}

/** The non-exact-lane (candidate-scan) `$queryRaw` call's flattened SQL text. */
function candidateQueryText(db: { $queryRaw: Mock }): string {
  const call = db.$queryRaw.mock.calls.find(
    (c: unknown[]) => !isExactLaneSql(sqlText(c[0]))
  );
  return sqlText(call?.[0]);
}

/** The exact-id/slug-lane `$queryRaw` call's flattened SQL text. */
function exactQueryText(db: { $queryRaw: Mock }): string {
  const call = db.$queryRaw.mock.calls.find((c: unknown[]) =>
    isExactLaneSql(sqlText(c[0]))
  );
  return sqlText(call?.[0]);
}

/** Count non-overlapping occurrences of `needle` in `text`. */
function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function installDb(options: {
  candidates: Candidate[];
  visible: Partial<Record<string, string[]>>;
  transcriptGateOn?: boolean;
  exactCandidates?: Candidate[];
  ownerUserIds?: string[];
  projectRows?: Array<{ id: string }>;
  organizationLookup?: { searchIncludeTranscripts: boolean } | null;
}) {
  const findFor = (type: string) =>
    vi.fn(
      (args: { where: { id: { in: string[] }; [key: string]: unknown } }) => {
        const requested = args.where.id.in;
        const allowed = new Set(options.visible[type] ?? []);
        return Promise.resolve(
          requested.filter((id) => allowed.has(id)).map((id) => ({ id }))
        );
      }
    );

  const sessionFindMany = vi.fn(
    (args: { where: { artifactId: { in: string[] } } }) => {
      const requested = args.where.artifactId.in;
      const allowed = new Set(
        options.visible[SearchEntityType.AgentSession] ?? []
      );
      return Promise.resolve(
        requested
          .filter((id) => allowed.has(id))
          .map((id) => ({ artifactId: id }))
      );
    }
  );

  const queryRaw = vi.fn((node: unknown) => {
    const text = sqlText(node);
    return Promise.resolve(
      isExactLaneSql(text)
        ? (options.exactCandidates ?? [])
        : options.candidates
    );
  });

  const projectFindMany = vi.fn(
    (args: { where: { id?: { in: string[] }; organizationId?: string } }) => {
      if (args.where.id?.in) {
        const requested = args.where.id.in;
        const allowed = new Set(
          options.visible[SearchEntityType.Project] ?? []
        );
        return Promise.resolve(
          requested.filter((id) => allowed.has(id)).map((id) => ({ id }))
        );
      }
      return Promise.resolve(options.projectRows ?? []);
    }
  );

  const db = {
    $queryRaw: queryRaw,
    artifact: { findMany: findFor(SearchEntityType.Document) },
    project: { findMany: projectFindMany },
    user: {
      findMany: vi.fn(() =>
        Promise.resolve((options.ownerUserIds ?? []).map((id) => ({ id })))
      ),
    },
    sessionDetail: { findMany: sessionFindMany },
    comment: { findMany: findFor(SearchEntityType.Comment) },
    pullRequestDetail: { findMany: findFor(SearchEntityType.PullRequest) },
    branchDetail: { findMany: findFor(SearchEntityType.Branch) },
    agentComponent: { findMany: findFor(SearchEntityType.AgentComponent) },
    organization: {
      // Validates the EXACT `where`/`select` shape rather than returning the
      // configured gate value unconditionally: a mutant that blanks `where`
      // or `select` to `{}`, or flips the requested
      // `searchIncludeTranscripts: true` to `false`, sends a call this mock
      // does not recognize and gets `null` back instead of the intended
      // value — so a test asserting the DOWNSTREAM authorization outcome
      // (not just "was findUnique called") observes the mutant.
      findUnique: vi.fn(
        (args: {
          where?: Record<string, unknown>;
          select?: Record<string, unknown>;
        }) => {
          const validShape =
            args?.where !== undefined &&
            Object.keys(args.where).length === 1 &&
            typeof args.where.id === "string" &&
            args.where.id.length > 0 &&
            args?.select !== undefined &&
            Object.keys(args.select).length === 1 &&
            args.select.searchIncludeTranscripts === true;
          if (!validShape) {
            return Promise.resolve(null);
          }
          return Promise.resolve(
            options.organizationLookup === undefined
              ? { searchIncludeTranscripts: options.transcriptGateOn ?? false }
              : options.organizationLookup
          );
        }
      ),
    },
  };
  // `withDb`'s real signature takes `(db: TransactionClient) => ...`;
  // `vi.mocked` preserves that generic, but our fake `db` is a deliberately
  // narrow test double that shares almost none of Prisma's real client
  // surface, so it cannot satisfy `TransactionClient` structurally (a
  // direct `as TransactionClient` is rejected by tsc as insufficiently
  // overlapping). `as never` is a single cast — not the banned
  // `as unknown as T` pattern — since `never` is assignable to any
  // parameter position.
  mockWithDb.mockImplementation((cb) => Promise.resolve(cb(db as never)));
  return db;
}

function baseParams(
  over: Partial<UnifiedSearchParams> = {}
): UnifiedSearchParams {
  return {
    organizationId: ORG,
    query: "acme",
    mode: SearchMode.Fulltext,
    types: [],
    since: null,
    until: null,
    limit: 25,
    cursor: null,
    filters: {},
    ...over,
  };
}

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    entity_type: SearchEntityType.Document,
    entity_id: "aaaaaaaa-0000-0000-0000-000000000001",
    title: "Acme",
    snippet: "<b>Acme</b>",
    rank: 0.5,
    updated_at: new Date("2026-01-01"),
    slug: null,
    entity_subtype: null,
    team_id: null,
    anchor_entity_id: null,
    ...over,
  };
}

describe("searchFtsService.searchUnified — doomed owner/project filter branch", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("returns an empty page (no exact-lookup re-run) for a doomed filter on a paginated request", async () => {
    // ownerIds resolves to [] (no such member) -> the doomed-filter short
    // circuit. On a paginated (cursor !== null) request the exact lane must
    // NOT be re-run — it is only resolved on the cursor-less first page, so
    // `exactCandidates` must be the literal `[]`, not a call to
    // runExactLookupQuery. idLookup is deliberately set to a uuid that WOULD
    // resolve to a real, authorized row if the lookup ran anyway, so a
    // mutant that flips the ternary's condition (always running the lookup)
    // or swaps its `[]` fallback for a non-empty placeholder is caught by
    // the assertions below rather than coincidentally producing the same
    // empty result.
    const uuid = "aaaaaaaa-0000-0000-0000-00000000feed";
    const db = installDb({
      candidates: [],
      exactCandidates: [candidate({ entity_id: uuid })],
      visible: { [SearchEntityType.Document]: [uuid] },
      ownerUserIds: [],
    });
    const res = await searchFtsService.searchUnified(
      baseParams({
        filters: { owner: ["nobody"] },
        idLookup: { uuid },
        cursor: {
          rank: 0,
          updatedAt: "2026-01-01T00:00:00.000Z",
          entityType: SearchEntityType.Document,
          entityId: "prev",
        },
      })
    );
    expect(res.results).toEqual([]);
    expect(res.nextCursor).toBeNull();
    // No DB round trip at all for the exact lane: the ternary's false arm
    // must be a plain literal `[]`, never a call to runExactLookupQuery.
    expect(db.$queryRaw).not.toHaveBeenCalled();
    // Only the owner resolution touches withDb; the mutated non-empty
    // literal (`["Stryker was here"]`) would push a bogus, unmapped-type
    // candidate through authorizeAndMap -> reauthorizeHits, adding a
    // second (wasted) withDb call even though it is filtered out of the
    // final results.
    expect(mockWithDb).toHaveBeenCalledTimes(1);
  });

  it("still resolves an exact id/slug hit on the first page even when the owner filter is doomed", async () => {
    // Documented behavior (see the searchUnified docstring): a doomed
    // owner/project filter short-circuits the FTS scan, but the exact
    // id/slug lane is a separate, unfiltered lookup that still runs on the
    // cursor-less first page.
    const uuid = "aaaaaaaa-0000-0000-0000-00000000dead";
    installDb({
      candidates: [],
      exactCandidates: [candidate({ entity_id: uuid })],
      visible: { [SearchEntityType.Document]: [uuid] },
      ownerUserIds: [],
    });
    const res = await searchFtsService.searchUnified(
      baseParams({
        filters: { owner: ["nobody"] },
        idLookup: { uuid },
        cursor: null,
      })
    );
    expect(res.results.map((r) => r.entityId)).toEqual([uuid]);
    expect(res.nextCursor).toBeNull();
  });
});

describe("searchFtsService.searchUnified — exact lane with no match predicate", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("skips the exact-lane DB query entirely when idLookup carries neither uuid nor slug", async () => {
    const db = installDb({
      candidates: [candidate({ entity_id: "fts-1" })],
      visible: { [SearchEntityType.Document]: ["fts-1"] },
    });
    const res = await searchFtsService.searchUnified(
      // An idLookup object present but with neither field set builds zero
      // match clauses, so runExactLookupQuery must short-circuit to []
      // without ever calling $queryRaw for the exact lane.
      baseParams({ idLookup: {} })
    );
    expect(res.results.map((r) => r.entityId)).toEqual(["fts-1"]);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    // A mutant that swaps the early return's `[]` for a non-empty
    // placeholder still gets filtered out of `results` (its bogus,
    // unmapped entity type is never authorized), but it pushes ONE extra
    // withDb call through reauthorizeHits -> authorizedIdsForType. Real
    // behavior: exactly 2 calls — the FTS candidate scan, and the single
    // reauth query for the "fts-1" document.
    expect(mockWithDb).toHaveBeenCalledTimes(2);
  });

  it("ORs the uuid and slug match clauses when idLookup carries both", async () => {
    const uuid = "aaaaaaaa-0000-0000-0000-00000000abcd";
    const db = installDb({
      candidates: [],
      exactCandidates: [candidate({ entity_id: uuid })],
      visible: { [SearchEntityType.Document]: [uuid] },
    });
    await searchFtsService.searchUnified(
      baseParams({ idLookup: { uuid, slug: "PRO-9" } })
    );
    const text = exactQueryText(db);
    // Two match clauses (entity_id = uuid, lower(slug) IN (...)) must be
    // ORed together, not silently concatenated with no separator.
    expect(text).toContain(" OR ");
  });
});

describe("searchFtsService.searchUnified — next-cursor anchor on an over-filled page", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("anchors the cursor on the last authorized FTS hit that fit the page, not the last scanned row", async () => {
    // limit=2, 3 authorized candidates, no exact hits: authorizedFts.length(3)
    // > ftsSlots(2), so the cursor must resume after the LAST RETURNED hit
    // (index ftsSlots-1), not after the last scanned candidate.
    const c1 = candidate({
      entity_id: "c1",
      rank: 0.9,
      updated_at: new Date("2026-03-03"),
    });
    const c2 = candidate({
      entity_id: "c2",
      rank: 0.8,
      updated_at: new Date("2026-03-02"),
    });
    const c3 = candidate({
      entity_id: "c3",
      rank: 0.7,
      updated_at: new Date("2026-03-01"),
    });
    installDb({
      candidates: [c1, c2, c3],
      visible: { [SearchEntityType.Document]: ["c1", "c2", "c3"] },
    });

    const res = await searchFtsService.searchUnified(baseParams({ limit: 2 }));

    expect(res.results.map((r) => r.entityId)).toEqual(["c1", "c2"]);
    const decoded = decodeCursor(res.nextCursor as string);
    expect(decoded?.entityId).toBe("c2");
  });

  it("anchors on the last SCANNED candidate (not an authorizedFts slot) when the page is under-filled", async () => {
    // limit=5 -> ftsSlots=5. 11 raw candidates (fetchLimit=11) but only 2 are
    // authorized, so authorizedFts.length(2) is NOT > ftsSlots(5):
    // `moreAuthorized` is false. scanFilled is true (11 >= fetchLimit 11), so
    // the function still must not return null — it anchors on
    // `candidates.at(-1)`, the last RAW scanned row (visible or not). A
    // mutant that forces `moreAuthorized && ftsSlots > 0` to always be true
    // would instead index `authorizedFts[ftsSlots - 1]` == `authorizedFts[4]`,
    // which is out of bounds (undefined) on a 2-element array, collapsing
    // the anchor and the whole cursor to null.
    const rawIds = Array.from({ length: 11 }, (_, i) => `r${i}`);
    const candidates = rawIds.map((id, i) =>
      candidate({
        entity_id: id,
        rank: 1 - i * 0.01,
        updated_at: new Date(2026, 0, 11 - i),
      })
    );
    installDb({
      candidates,
      // Only the first two rows are authorized.
      visible: { [SearchEntityType.Document]: ["r0", "r1"] },
    });

    const res = await searchFtsService.searchUnified(baseParams({ limit: 5 }));

    expect(res.results.map((r) => r.entityId)).toEqual(["r0", "r1"]);
    expect(res.nextCursor).not.toBeNull();
    const decoded = decodeCursor(res.nextCursor as string);
    expect(decoded?.entityId).toBe("r10");
  });
});

describe("searchFtsService.searchUnified — cursor anchor guard against an unclamped limit", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("degrades to a null cursor instead of throwing when limit is negative and the corpus is empty", async () => {
    // pins current behavior; looks odd because the SERVICE itself never
    // clamps `limit` (that is `clampSearchLimit`'s job at the route layer,
    // not exercised here) — calling it directly with a negative limit drives
    // fetchLimit negative too, so `scanFilled` (candidates.length >=
    // fetchLimit) is true even with ZERO scanned rows. That reaches the
    // `anchor = candidates.at(-1)` fallback on an EMPTY array — the one
    // reachable case where `anchor` really is falsy — and the `if (!anchor)
    // return null;` guard is what stops `anchor.rank` from throwing on
    // `undefined` a few lines later.
    installDb({ candidates: [], visible: {} });
    const res = await searchFtsService.searchUnified(baseParams({ limit: -5 }));
    expect(res.results).toEqual([]);
    expect(res.nextCursor).toBeNull();
  });
});

describe("buildTsQuery — mode dispatch", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("uses websearch_to_tsquery (not the Prefix to_tsquery path) for Fulltext mode", async () => {
    // A mutant that forces `mode === SearchMode.Prefix` to always be true
    // would route a Fulltext-mode query through toPrefixTsQueryExpression
    // instead, producing a `to_tsquery('english', 'fulltextmarker:*')`
    // fragment rather than the real websearch_to_tsquery call.
    const db = installDb({ candidates: [], visible: {} });
    await searchFtsService.searchUnified(
      baseParams({ mode: SearchMode.Fulltext, query: "fulltextmarker" })
    );
    const text = candidateQueryText(db);
    expect(text).toContain("websearch_to_tsquery");
    expect(text).not.toContain("fulltextmarker:*");
  });
});

describe("buildTsQuery / toPrefixTsQueryExpression — Prefix mode", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("falls back to a websearch query when a Prefix-mode query has no alphanumeric token", async () => {
    const db = installDb({ candidates: [], visible: {} });
    await searchFtsService.searchUnified(
      baseParams({ mode: SearchMode.Prefix, query: "!!!" })
    );
    const text = candidateQueryText(db);
    expect(text).toContain("websearch_to_tsquery");
    expect(text).toContain("!!!");
  });

  it("builds a to_tsquery expression with the trailing token as a prefix", async () => {
    const db = installDb({ candidates: [], visible: {} });
    await searchFtsService.searchUnified(
      baseParams({ mode: SearchMode.Prefix, query: "impl pla" })
    );
    const text = candidateQueryText(db);
    expect(text).not.toContain("websearch_to_tsquery");
    expect(text).toContain("to_tsquery");
    // Only the LAST token gets the `:*` prefix suffix; earlier tokens are
    // joined plain with `&`.
    expect(text).toContain("impl & pla:*");
  });
});

describe("runCandidateQuery — type/since/until filters", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("applies the type, since, and until filters as bound SQL fragments", async () => {
    const since = new Date("2026-01-01T00:00:00.000Z");
    const until = new Date("2026-02-01T00:00:00.000Z");
    const db = installDb({
      candidates: [candidate({ entity_id: "d1" })],
      visible: { [SearchEntityType.Document]: ["d1"] },
    });
    await searchFtsService.searchUnified(
      baseParams({ types: [SearchEntityType.Document], since, until })
    );
    const text = candidateQueryText(db);
    // `"entity_type"` alone also appears in the unconditional SELECT column
    // list, so it is a vacuous marker for the typeFilter WHERE fragment —
    // anchor on the `IN (` clause the filter itself builds.
    expect(text).toContain('"entity_type" IN (');
    // Assert the bound date lands on ITS OWN operator, not merely that both
    // operator tokens appear somewhere in the query — a mutant that swapped
    // which bound feeds `sinceFilter` vs. `untilFilter` would still pass a
    // bare `toContain` check on the operator alone.
    expect(text).toContain(`"updated_at" >= ${since.toISOString()}`);
    expect(text).toContain(`"updated_at" <= ${until.toISOString()}`);
  });

  it("scopes an unfiltered scan to the offered kinds, never a retired one (ISS-12435)", async () => {
    const db = installDb({
      candidates: [candidate({ entity_id: "d1" })],
      visible: { [SearchEntityType.Document]: ["d1"] },
    });
    await searchFtsService.searchUnified(baseParams({ types: [] }));
    const text = candidateQueryText(db);
    expect(text).toContain('"entity_type" IN (');
    for (const offered of OFFERED_SEARCH_ENTITY_TYPES) {
      expect(text).toContain(offered);
    }
    expect(text).not.toContain(`${SearchEntityType.Loop},`);
    expect(text).not.toContain(`${SearchEntityType.Loop})`);
  });

  it("matches nothing when the types filter names only a retired kind (ISS-12435)", async () => {
    const db = installDb({
      candidates: [],
      visible: {},
    });
    await searchFtsService.searchUnified(
      baseParams({ types: [SearchEntityType.Loop] })
    );
    const text = candidateQueryText(db);
    expect(text).toContain("AND FALSE");
    expect(text).not.toContain('"entity_type" IN (');
  });
});

describe("priorityPredicate — ordinal comparison operators", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("emits a bare = for the = operator (CASE embedded, no comparison-chain marker)", async () => {
    const db = installDb({ candidates: [], visible: {} });
    await searchFtsService.searchUnified(
      baseParams({
        filters: {
          priority: {
            kind: PriorityFilterKind.Ordinal,
            operator: SearchFilterOperator.Eq,
            value: Priority.High,
          },
        },
      })
    );
    const text = candidateQueryText(db);
    // Eq is the only real case with none of the other cases' markers, so
    // presence of the ordinal CASE plus absence of every other case's
    // marker uniquely pins the switch having actually dispatched to Eq
    // (rather than, say, a mutant that reorders/merges the case labels).
    expect(text).toContain('CASE "priority"');
    expect(text).not.toContain("IS DISTINCT FROM");
    expect(text).not.toContain("<");
    expect(text).not.toContain(">");
  });

  it("emits >= for the >= operator", async () => {
    const db = installDb({ candidates: [], visible: {} });
    await searchFtsService.searchUnified(
      baseParams({
        filters: {
          priority: {
            kind: PriorityFilterKind.Ordinal,
            operator: SearchFilterOperator.Gte,
            value: Priority.High,
          },
        },
      })
    );
    expect(candidateQueryText(db)).toContain(" >= ");
  });

  it("emits IS DISTINCT FROM for the != operator", async () => {
    const db = installDb({ candidates: [], visible: {} });
    await searchFtsService.searchUnified(
      baseParams({
        filters: {
          priority: {
            kind: PriorityFilterKind.Ordinal,
            operator: SearchFilterOperator.Neq,
            value: Priority.High,
          },
        },
      })
    );
    expect(candidateQueryText(db)).toContain("IS DISTINCT FROM");
  });

  it("emits > for the > operator", async () => {
    const db = installDb({ candidates: [], visible: {} });
    await searchFtsService.searchUnified(
      baseParams({
        filters: {
          priority: {
            kind: PriorityFilterKind.Ordinal,
            operator: SearchFilterOperator.Gt,
            value: Priority.High,
          },
        },
      })
    );
    expect(candidateQueryText(db)).toContain(" > ");
  });

  it("emits < for the < operator", async () => {
    const db = installDb({ candidates: [], visible: {} });
    await searchFtsService.searchUnified(
      baseParams({
        filters: {
          priority: {
            kind: PriorityFilterKind.Ordinal,
            operator: SearchFilterOperator.Lt,
            value: Priority.High,
          },
        },
      })
    );
    expect(candidateQueryText(db)).toContain(" < ");
  });

  it("emits <= for the <= operator", async () => {
    const db = installDb({ candidates: [], visible: {} });
    await searchFtsService.searchUnified(
      baseParams({
        filters: {
          priority: {
            kind: PriorityFilterKind.Ordinal,
            operator: SearchFilterOperator.Lte,
            value: Priority.High,
          },
        },
      })
    );
    expect(candidateQueryText(db)).toContain(" <= ");
  });

  // No test for priorityPredicate's `default` switch arm: `PriorityFilter`'s
  // `operator` field is only ever constructed by `parsePriority` in
  // `packages/api/src/types/search-query.ts`, which derives it from
  // `splitKeyOperator`'s scan over the fixed `KEY_OPERATORS` list — i.e. it
  // is always one of the 6 real `SearchFilterOperator` members already. No
  // wire/JSON boundary constructs a `PriorityFilter` directly (the only
  // producer reaching `searchFtsService` is the route's
  // `parseSearchQuery` call), so reaching `default` here requires an
  // in-process value the type forbids (a cast), not a real runtime input —
  // per AGENTS.md, that case is dropped rather than kept behind a cast.
});

describe("updatedPredicate — bound comparison operators", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("emits < for the < operator", async () => {
    const date = new Date("2026-01-01");
    const db = installDb({ candidates: [], visible: {} });
    await searchFtsService.searchUnified(
      baseParams({
        filters: {
          updated: {
            kind: "bound",
            operator: SearchFilterOperator.Lt,
            date,
          },
        },
      })
    );
    // Pin the operator adjacent to the actual bound date, not just the
    // operator token in isolation.
    expect(candidateQueryText(db)).toContain(
      `"updated_at" < ${date.toISOString()}`
    );
  });

  it("emits >= for the >= operator", async () => {
    const date = new Date("2026-01-01");
    const db = installDb({ candidates: [], visible: {} });
    await searchFtsService.searchUnified(
      baseParams({
        filters: {
          updated: {
            kind: "bound",
            operator: SearchFilterOperator.Gte,
            date,
          },
        },
      })
    );
    expect(candidateQueryText(db)).toContain(
      `"updated_at" >= ${date.toISOString()}`
    );
  });

  it("emits <= for the <= operator", async () => {
    const date = new Date("2026-01-01");
    const db = installDb({ candidates: [], visible: {} });
    await searchFtsService.searchUnified(
      baseParams({
        filters: {
          updated: {
            kind: "bound",
            operator: SearchFilterOperator.Lte,
            date,
          },
        },
      })
    );
    expect(candidateQueryText(db)).toContain(
      `"updated_at" <= ${date.toISOString()}`
    );
  });

  it("falls back to the whole-day range for an operator with no explicit case (!=)", async () => {
    // pins current behavior; looks odd because SearchFilterOperator.Neq has
    // no case of its own in updatedPredicate's switch, so `updated!=<date>`
    // silently falls through to the `default` arm's "=" whole-calendar-day
    // range instead of a not-equal comparison — tracked in ISS-10522.
    const date = new Date("2026-01-01");
    const nextDay = new Date(date.getTime() + ONE_DAY_MS);
    const db = installDb({ candidates: [], visible: {} });
    await searchFtsService.searchUnified(
      baseParams({
        filters: {
          updated: {
            kind: "bound",
            operator: SearchFilterOperator.Neq,
            date,
          },
        },
      })
    );
    const text = candidateQueryText(db);
    // Assert the two distinct bound instants, not just the two operator
    // tokens: with MS_PER_DAY mutated to 0 the upper bound collapses onto the
    // lower one (a zero-width range that matches nothing), and a bare
    // `toContain('"updated_at" >= ')` / `toContain('"updated_at" < ')` cannot
    // tell that apart from the real whole-day range.
    expect(text).toContain(`"updated_at" >= ${date.toISOString()}`);
    expect(text).toContain(`"updated_at" < ${nextDay.toISOString()}`);
    expect(nextDay.getTime()).toBeGreaterThan(date.getTime());
  });
});

describe("cursorPredicate — rank expression by query mode", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("compares against a literal 0 rank when the query text is empty (no ts_rank_cd anywhere)", async () => {
    const db = installDb({
      candidates: [candidate({ entity_id: "d1" })],
      visible: { [SearchEntityType.Document]: ["d1"] },
    });
    const res = await searchFtsService.searchUnified(
      baseParams({
        query: "",
        cursor: {
          rank: 0,
          updatedAt: "2026-01-01T00:00:00.000Z",
          entityType: SearchEntityType.Document,
          entityId: "prev",
        },
      })
    );
    const text = candidateQueryText(db);
    expect(text).not.toContain("ts_rank_cd");
    // The literal `rank` var is reused 4x inside cursorPredicate's OR chain
    // PLUS once more by the SELECT-column rankExpr, so a mutant that blanks
    // ONLY cursorPredicate's own `0::float8` template still leaves the
    // SELECT-column's independent `0::float8` behind — counting occurrences
    // (rather than a bare `toContain`) is what actually distinguishes them.
    expect(countOccurrences(text, "0::float8")).toBeGreaterThanOrEqual(5);
    expect(res.results.map((r) => r.entityId)).toEqual(["d1"]);
  });

  it("compares against ts_rank_cd (not a literal 0) when the query carries real text", async () => {
    const db = installDb({
      candidates: [candidate({ entity_id: "d1" })],
      visible: { [SearchEntityType.Document]: ["d1"] },
    });
    await searchFtsService.searchUnified(
      baseParams({
        query: "acme",
        cursor: {
          rank: 0.5,
          updatedAt: "2026-01-01T00:00:00.000Z",
          entityType: SearchEntityType.Document,
          entityId: "prev",
        },
      })
    );
    const text = candidateQueryText(db);
    // Same 4x-reuse-plus-SELECT-column reasoning as above, mirrored for the
    // non-null tsQuery branch.
    expect(countOccurrences(text, "ts_rank_cd")).toBeGreaterThanOrEqual(5);
    expect(text).not.toContain("0::float8");
  });
});

describe("reauthorizeHits — agent_session transcript gate fallback", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("treats a missing organization row as the gate being OFF (fail-closed)", async () => {
    const db = installDb({
      candidates: [],
      visible: { [SearchEntityType.AgentSession]: ["sess-1"] },
      organizationLookup: null,
    });
    const authorized = await reauthorizeHits(ORG, [
      candidate({
        entity_type: SearchEntityType.AgentSession,
        entity_id: "sess-1",
      }),
    ]);
    // The gate reads OFF (organizationLookup: null), so the session must
    // never be authorized and the source-of-truth session read must never
    // even run.
    expect(authorized.has(`${SearchEntityType.AgentSession}:sess-1`)).toBe(
      false
    );
    expect(authorized.size).toBe(0);
    expect(db.sessionDetail.findMany).not.toHaveBeenCalled();
    // The mock only returns the configured gate value for this EXACT
    // where/select shape (see installDb's organization.findUnique) — a
    // mutant that blanks `where`/`select` to `{}`, or flips the requested
    // `searchIncludeTranscripts: true` to `false`, would get `null` back
    // here too, so this call-args assertion is load-bearing evidence for
    // WHY the gate read OFF, not a duplicate of the outcome assertions.
    expect(db.organization.findUnique).toHaveBeenCalledWith({
      where: { id: ORG },
      select: { searchIncludeTranscripts: true },
    });
  });

  it("authorizes and queries the session through the exact where/select shape when the gate is ON", async () => {
    const db = installDb({
      candidates: [],
      visible: { [SearchEntityType.AgentSession]: ["sess-1"] },
      transcriptGateOn: true,
    });
    const authorized = await reauthorizeHits(ORG, [
      candidate({
        entity_type: SearchEntityType.AgentSession,
        entity_id: "sess-1",
      }),
    ]);
    expect(authorized.has(`${SearchEntityType.AgentSession}:sess-1`)).toBe(
      true
    );
    // The name promises the exact where/select shape, so pin the call args
    // directly: the source scopes through the PARENT artifact's
    // organizationId (`artifact: { is: { organizationId } }`) precisely so a
    // stale/cross-org projection row can never leak — dropping that clause
    // would still resolve the mocked `sessionFindMany`, which ignores it, so
    // only a call-args assertion (not the outcome above) catches its removal.
    expect(db.sessionDetail.findMany).toHaveBeenCalledWith({
      where: {
        artifactId: { in: ["sess-1"] },
        artifact: { is: { organizationId: ORG } },
      },
      select: { artifactId: true },
    });
    // Same load-bearing reasoning as the OFF-gate test: a mutant that
    // corrupts the findUnique args would fail installDb's shape check and
    // get `null` back, flipping the gate to OFF and failing the
    // authorization assertion above instead of just this one.
    expect(db.organization.findUnique).toHaveBeenCalledWith({
      where: { id: ORG },
      select: { searchIncludeTranscripts: true },
    });
  });
});

describe("toSearchHit — snippet and teamId field mapping", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("falls back to the title when the snippet is whitespace-only", async () => {
    installDb({
      candidates: [
        candidate({ entity_id: "d1", title: "My Title", snippet: "   " }),
      ],
      visible: { [SearchEntityType.Document]: ["d1"] },
    });
    const res = await searchFtsService.searchUnified(baseParams());
    expect(res.results[0].snippet).toBe("My Title");
  });

  it("populates teamId when the projection column is set", async () => {
    installDb({
      candidates: [
        candidate({
          entity_type: SearchEntityType.Project,
          entity_id: "p1",
          team_id: "team-123",
        }),
      ],
      visible: { [SearchEntityType.Project]: ["p1"] },
    });
    const res = await searchFtsService.searchUnified(baseParams());
    expect(res.results[0].teamId).toBe("team-123");
  });
});
