import { SearchMode } from "@repo/api/src/types/search";
import {
  isSupportedSearchType,
  SearchEntityType,
} from "@repo/api/src/types/search-entity-kind";
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

import {
  baseParams,
  candidate,
  EXACT_ID_PREDICATE,
  installDb,
  sqlText,
} from "@/__tests__/support/search/search-fts-service.test-fixtures";
import {
  clampSearchLimit,
  decodeCursor,
  searchFtsService,
} from "./search-fts-service";

describe("searchFtsService.searchUnified — per-hit re-authorization (redaction)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops a candidate whose source row the requester cannot access", async () => {
    const visibleDoc = candidate({ entity_id: "doc-visible" });
    const hiddenDoc = candidate({ entity_id: "doc-hidden" });
    installDb({
      candidates: [visibleDoc, hiddenDoc],
      // Only the visible doc exists under this org in the source of truth.
      visible: { [SearchEntityType.Document]: ["doc-visible"] },
    });

    const res = await searchFtsService.searchUnified(baseParams());

    const ids = res.results.map((r) => r.entityId);
    expect(ids).toContain("doc-visible");
    expect(ids).not.toContain("doc-hidden");
  });

  it("re-authorizes set-based: one findMany per entity type, not per row", async () => {
    const calls: Array<{ type: string; count: number }> = [];
    installDb({
      candidates: [
        candidate({ entity_type: SearchEntityType.Document, entity_id: "d1" }),
        candidate({ entity_type: SearchEntityType.Document, entity_id: "d2" }),
        candidate({ entity_type: SearchEntityType.Project, entity_id: "p1" }),
      ],
      visible: {
        [SearchEntityType.Document]: ["d1", "d2"],
        [SearchEntityType.Project]: ["p1"],
      },
      onFind: (type, ids) => calls.push({ type, count: ids.length }),
    });

    await searchFtsService.searchUnified(baseParams());

    // Exactly one re-auth query per distinct type present in the candidates.
    const docCalls = calls.filter((c) => c.type === SearchEntityType.Document);
    const projectCalls = calls.filter(
      (c) => c.type === SearchEntityType.Project
    );
    expect(docCalls).toHaveLength(1);
    expect(projectCalls).toHaveLength(1);
    // The single doc query batched both ids (set-based, not per-row).
    expect(docCalls[0].count).toBe(2);
  });

  it("emits a next cursor advancing past a fully-redacted scan window (no stall)", async () => {
    // A full page of candidates, all unauthorized, but the scan filled fetchLimit
    // (limit=1 -> fetchLimit=3): pagination must still advance, not halt at null,
    // so authorized rows deeper in the corpus are reachable on the next page.
    const scanned = [
      candidate({
        entity_id: "h1",
        rank: 0.9,
        updated_at: new Date("2026-03-03"),
      }),
      candidate({
        entity_id: "h2",
        rank: 0.8,
        updated_at: new Date("2026-03-02"),
      }),
      candidate({
        entity_id: "h3",
        rank: 0.7,
        updated_at: new Date("2026-03-01"),
      }),
    ];
    installDb({
      candidates: scanned,
      visible: { [SearchEntityType.Document]: [] },
    });

    const res = await searchFtsService.searchUnified(baseParams({ limit: 1 }));

    expect(res.results).toHaveLength(0);
    expect(res.nextCursor).not.toBeNull();
    // The cursor anchors on the last SCANNED candidate (h3), guaranteeing forward
    // progress even though nothing was returned.
    const decoded = decodeCursor(res.nextCursor as string);
    expect(decoded?.entityId).toBe("h3");
  });

  it("returns null cursor when the corpus is drained (short scan, all authorized)", async () => {
    installDb({
      candidates: [candidate({ entity_id: "only" })],
      visible: { [SearchEntityType.Document]: ["only"] },
    });
    const res = await searchFtsService.searchUnified(baseParams({ limit: 25 }));
    expect(res.results).toHaveLength(1);
    expect(res.nextCursor).toBeNull();
  });

  it("returns heterogeneous ranked hits with type, snippet and deepLink", async () => {
    installDb({
      candidates: [
        candidate({ entity_type: SearchEntityType.Project, entity_id: "p1" }),
      ],
      visible: { [SearchEntityType.Project]: ["p1"] },
    });

    const res = await searchFtsService.searchUnified(baseParams());
    expect(res.results).toHaveLength(1);
    const hit = res.results[0];
    expect(hit.entityType).toBe(SearchEntityType.Project);
    expect(hit.snippet).toBe("<b>Acme</b>");
    expect(hit.deepLink).toBe("/projects/p1");
    expect(res.mode).toBe(SearchMode.Fulltext);
  });

  it("returns the Phase-2 route fields when the projection carries them", async () => {
    installDb({
      candidates: [
        candidate({
          entity_type: SearchEntityType.Document,
          entity_id: "d1",
          slug: "my-prd",
          entity_subtype: "PRD",
          team_id: null,
        }),
      ],
      visible: { [SearchEntityType.Document]: ["d1"] },
    });

    const res = await searchFtsService.searchUnified(baseParams());
    const hit = res.results[0];
    expect(hit.slug).toBe("my-prd");
    expect(hit.entitySubtype).toBe("PRD");
    // A null projection column is OMITTED, never serialized as null/undefined,
    // so a version-skewed/old client sees the optional field absent.
    expect("teamId" in hit).toBe(false);
  });

  it("returns the anchor_entity_id route field for a pull_request hit (FEA-3930)", async () => {
    installDb({
      candidates: [
        candidate({
          entity_type: SearchEntityType.PullRequest,
          entity_id: "pr1",
          anchor_entity_id: "branch-artifact-7",
        }),
      ],
      visible: { [SearchEntityType.PullRequest]: ["pr1"] },
    });

    const hit = (await searchFtsService.searchUnified(baseParams())).results[0];
    expect(hit.entityType).toBe(SearchEntityType.PullRequest);
    expect(hit.anchorEntityId).toBe("branch-artifact-7");
  });

  it("omits the anchor_entity_id field when the projection column is null", async () => {
    installDb({
      candidates: [
        candidate({
          entity_type: SearchEntityType.Document,
          entity_id: "d1",
          anchor_entity_id: null,
        }),
      ],
      visible: { [SearchEntityType.Document]: ["d1"] },
    });

    const hit = (await searchFtsService.searchUnified(baseParams())).results[0];
    expect("anchorEntityId" in hit).toBe(false);
  });

  it("omits every route field for an old projection row that predates them (null columns)", async () => {
    installDb({
      candidates: [
        candidate({
          entity_type: SearchEntityType.Project,
          entity_id: "p1",
          slug: null,
          entity_subtype: null,
          team_id: null,
        }),
      ],
      visible: { [SearchEntityType.Project]: ["p1"] },
    });

    const hit = (await searchFtsService.searchUnified(baseParams())).results[0];
    expect("slug" in hit).toBe(false);
    expect("entitySubtype" in hit).toBe(false);
    expect("teamId" in hit).toBe(false);
  });
});

describe("searchFtsService.searchUnified — exact ID/slug lookup (FEA-3930)", () => {
  const UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("UUID-only query returns the exact row and skips the tsvector scan", async () => {
    const db = installDb({
      candidates: [],
      exactCandidates: [candidate({ entity_id: UUID })],
      visible: { [SearchEntityType.Document]: [UUID] },
    });
    const res = await searchFtsService.searchUnified(
      baseParams({ query: "", idLookup: { uuid: UUID } })
    );
    expect(res.results).toHaveLength(1);
    expect(res.results[0].entityId).toBe(UUID);
    // Exactly one $queryRaw call: the exact lane; the FTS scan is short-circuited.
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["FEA-123", SearchEntityType.Document],
    ["PRD-4", SearchEntityType.Document],
    ["PLN-77", SearchEntityType.Document],
    ["PRO-9", SearchEntityType.Project],
  ] as const)(
    "slug-only query %s returns the exact row (case-insensitive)",
    async (slug, entityType) => {
      const exactId = `${slug}-row`;
      installDb({
        candidates: [],
        exactCandidates: [
          candidate({ entity_type: entityType, entity_id: exactId }),
        ],
        visible: { [entityType]: [exactId] },
      });
      const res = await searchFtsService.searchUnified(
        baseParams({ query: "", idLookup: { slug: slug.toLowerCase() } })
      );
      expect(res.results).toHaveLength(1);
      expect(res.results[0].entityId).toBe(exactId);
    }
  );

  it("cross-org id returns nothing (source-of-truth re-auth drops it)", async () => {
    const db = installDb({
      candidates: [],
      // The projection carries the row, but the source of truth does NOT show it
      // under this org (cross-org / stale projection): re-auth drops it.
      exactCandidates: [candidate({ entity_id: UUID })],
      visible: { [SearchEntityType.Document]: [] },
    });
    const res = await searchFtsService.searchUnified(
      baseParams({ query: "", idLookup: { uuid: UUID } })
    );
    expect(res.results).toHaveLength(0);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("two-org isolation: an id/slug lookup is org-scoped at the DB layer AND re-authorized", async () => {
    // Org A requests an id that in truth belongs to org B. Even if a stale
    // projection row surfaced it, the exact lane's SQL must carry the requester
    // org id and re-auth (visible=[] for org A) must drop it — org A can never
    // see org B's record.
    const orgA = "aaaaaaaa-1111-1111-1111-111111111111";
    const db = installDb({
      candidates: [],
      exactCandidates: [candidate({ entity_id: UUID })],
      // The source of truth shows the row under NO org visible to org A.
      visible: { [SearchEntityType.Document]: [] },
    });
    const res = await searchFtsService.searchUnified(
      baseParams({ organizationId: orgA, query: "", idLookup: { uuid: UUID } })
    );
    expect(res.results).toHaveLength(0);
    // The exact-lane SQL bound the requester's org id (DB-layer scoping, not a
    // post-query filter).
    const exactCall = (db.$queryRaw as unknown as Mock).mock.calls.find((c) => {
      const text = sqlText(c[0]);
      return text.includes("lower(") || EXACT_ID_PREDICATE.test(text);
    });
    expect(sqlText(exactCall?.[0])).toContain(orgA);
    expect(sqlText(exactCall?.[0])).toContain("organization_id");
    // The re-auth artifact query was scoped to org A.
    expect(db.artifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: orgA }),
      })
    );
  });

  it("a UUID that matches no projection row returns empty (no crash)", async () => {
    installDb({
      candidates: [],
      exactCandidates: [],
      visible: {},
    });
    const res = await searchFtsService.searchUnified(
      baseParams({ query: "", idLookup: { uuid: UUID } })
    );
    expect(res.results).toEqual([]);
    expect(res.nextCursor).toBeNull();
  });

  it("mixed id + text returns the exact record FIRST, then the FTS hits", async () => {
    const ftsHit = candidate({ entity_id: "fts-1", rank: 0.9 });
    installDb({
      candidates: [ftsHit],
      exactCandidates: [candidate({ entity_id: UUID })],
      visible: { [SearchEntityType.Document]: [UUID, "fts-1"] },
    });
    const res = await searchFtsService.searchUnified(
      baseParams({ query: "rocket", idLookup: { uuid: UUID } })
    );
    expect(res.results.map((r) => r.entityId)).toEqual([UUID, "fts-1"]);
  });

  it("de-dupes a record that matched BOTH the exact lane and the FTS scan", async () => {
    installDb({
      // Same id in both lanes: it must appear once, in the exact (top) slot.
      candidates: [candidate({ entity_id: UUID, rank: 0.9 })],
      exactCandidates: [candidate({ entity_id: UUID })],
      visible: { [SearchEntityType.Document]: [UUID] },
    });
    const res = await searchFtsService.searchUnified(
      baseParams({ query: "rocket", idLookup: { uuid: UUID } })
    );
    const ids = res.results.map((r) => r.entityId);
    expect(ids).toEqual([UUID]);
  });

  it("does NOT re-emit the exact record on a paginated (cursor) request", async () => {
    // Page 2+: the exact record was already returned on page 1, so it must not
    // be emitted again — only the FTS keyset scan's results appear.
    installDb({
      candidates: [candidate({ entity_id: "fts-2", rank: 0.4 })],
      exactCandidates: [candidate({ entity_id: UUID })],
      visible: { [SearchEntityType.Document]: [UUID, "fts-2"] },
    });
    const res = await searchFtsService.searchUnified(
      baseParams({
        query: "rocket",
        idLookup: { uuid: UUID },
        cursor: {
          rank: 0.9,
          updatedAt: "2026-01-01T00:00:00.000Z",
          entityType: SearchEntityType.Document,
          entityId: "prev",
        },
      })
    );
    const ids = res.results.map((r) => r.entityId);
    expect(ids).not.toContain(UUID);
    expect(ids).toEqual(["fts-2"]);
  });

  it("excludes the promoted exact record from the FTS lane on a later page (no reappearance)", async () => {
    // Regression: the exact record's native FTS rank drops below page 1's
    // cursor, so it resurfaces in the FTS scan on page 2. Its identity must
    // still be resolved on every page and filtered out of the FTS results even
    // though it is not re-emitted as an exact hit.
    installDb({
      // The FTS scan on page 2 returns BOTH the promoted record and a fresh hit.
      candidates: [
        candidate({ entity_id: UUID, rank: 0.3 }),
        candidate({ entity_id: "fts-3", rank: 0.2 }),
      ],
      exactCandidates: [candidate({ entity_id: UUID })],
      visible: { [SearchEntityType.Document]: [UUID, "fts-3"] },
    });
    const res = await searchFtsService.searchUnified(
      baseParams({
        query: "rocket",
        idLookup: { uuid: UUID },
        cursor: {
          rank: 0.9,
          updatedAt: "2026-01-01T00:00:00.000Z",
          entityType: SearchEntityType.Document,
          entityId: "prev",
        },
      })
    );
    const ids = res.results.map((r) => r.entityId);
    expect(ids).not.toContain(UUID);
    expect(ids).toEqual(["fts-3"]);
  });

  it("scopes the exact lane to the requested types filter", async () => {
    // Regression: `?q=FEA-42&types=project` must not surface a document exact
    // hit — the exact lane honors the corpus `types` filter like the FTS lane.
    const db = installDb({
      candidates: [],
      // With the type filter applied, the exact lane returns no project row.
      exactCandidates: [],
      visible: {},
    });
    const res = await searchFtsService.searchUnified(
      baseParams({
        query: "",
        idLookup: { slug: "FEA-42" },
        types: [SearchEntityType.Project],
      })
    );
    expect(res.results).toEqual([]);
    // The exact-lane SQL carried the `entity_type IN (...)` predicate.
    const exactCall = (db.$queryRaw as unknown as Mock).mock.calls.find((c) => {
      const text = sqlText(c[0]);
      return text.includes("lower(") || EXACT_ID_PREDICATE.test(text);
    });
    expect(exactCall).toBeDefined();
    expect(sqlText(exactCall?.[0])).toContain("entity_type");
  });

  it("resumes the FTS lane from its top when an exact hit filled the whole page", async () => {
    // `limit=1` + an exact hit leaves zero FTS slots, yet the FTS scan saw
    // candidates. The next cursor must be the `ftsStart` sentinel so page 2
    // shows the FTS top instead of skipping past it.
    installDb({
      candidates: [candidate({ entity_id: "fts-top", rank: 0.9 })],
      exactCandidates: [candidate({ entity_id: UUID })],
      visible: { [SearchEntityType.Document]: [UUID, "fts-top"] },
    });
    const res = await searchFtsService.searchUnified(
      baseParams({ query: "rocket", idLookup: { uuid: UUID }, limit: 1 })
    );
    // Only the exact hit fits the single slot.
    expect(res.results.map((r) => r.entityId)).toEqual([UUID]);
    expect(res.nextCursor).not.toBeNull();
    const decoded = decodeCursor(res.nextCursor as string);
    expect(decoded?.ftsStart).toBe(true);
  });
});

describe("query param validation helpers", () => {
  it("accepts the queryable corpus types (incl. agent_session, comment, pr, branch) and rejects others", () => {
    expect(isSupportedSearchType(SearchEntityType.Document)).toBe(true);
    expect(isSupportedSearchType(SearchEntityType.Loop)).toBe(true);
    // FEA-3930: agent_session is a queryable facet (gated at query time).
    expect(isSupportedSearchType(SearchEntityType.AgentSession)).toBe(true);
    // FEA-3930 corpus slice: comment/pull_request/branch are queryable facets.
    expect(isSupportedSearchType(SearchEntityType.Comment)).toBe(true);
    expect(isSupportedSearchType(SearchEntityType.PullRequest)).toBe(true);
    expect(isSupportedSearchType(SearchEntityType.Branch)).toBe(true);
    expect(isSupportedSearchType("bogus")).toBe(false);
  });

  it("clamps limit to [1, 100] and defaults when absent", () => {
    expect(clampSearchLimit(null)).toBe(25);
    expect(clampSearchLimit(0)).toBe(1);
    expect(clampSearchLimit(-5)).toBe(1);
    expect(clampSearchLimit(500)).toBe(100);
    expect(clampSearchLimit(10)).toBe(10);
  });

  it("round-trips a cursor and rejects garbage", () => {
    const encoded = Buffer.from(
      JSON.stringify({
        rank: 0.5,
        updatedAt: "2026-01-01T00:00:00.000Z",
        entityType: SearchEntityType.Document,
        entityId: "d1",
      }),
      "utf8"
    ).toString("base64url");
    expect(decodeCursor(encoded)?.entityId).toBe("d1");
    expect(decodeCursor("not-valid-base64-json!!")).toBeNull();
  });

  it("rejects a cursor whose updatedAt or rank is unparseable (would 500 the raw query)", () => {
    const withUpdatedAt = (updatedAt: string) =>
      Buffer.from(
        JSON.stringify({
          rank: 0.5,
          updatedAt,
          entityType: SearchEntityType.Document,
          entityId: "d1",
        }),
        "utf8"
      ).toString("base64url");
    // A well-typed string that `new Date()` cannot parse becomes an Invalid Date
    // in `cursorPredicate`; reject it here so the request degrades to page 1.
    expect(decodeCursor(withUpdatedAt("not-a-date"))).toBeNull();
    expect(decodeCursor(withUpdatedAt(""))).toBeNull();
    // A non-finite rank would likewise poison the keyset SQL.
    const nonFiniteRank = Buffer.from(
      JSON.stringify({
        rank: "not-a-number",
        updatedAt: "2026-01-01T00:00:00.000Z",
        entityType: SearchEntityType.Document,
        entityId: "d1",
      }),
      "utf8"
    ).toString("base64url");
    expect(decodeCursor(nonFiniteRank)).toBeNull();
  });
});
