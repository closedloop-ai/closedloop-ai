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

import { withDb } from "@repo/database";
import {
  clampSearchLimit,
  decodeCursor,
  reauthorizeHits,
  searchFtsService,
  type UnifiedSearchParams,
} from "./search-fts-service";

const mockWithDb = withDb as unknown as Mock;
const ORG = "11111111-1111-1111-1111-111111111111";
/** The `entity_id = …` equality predicate only the EXACT id/slug lane emits. */
const EXACT_ID_PREDICATE = /entity_id"?\s*=/;

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
 * Install a fake `withDb` whose db exposes `$queryRaw` (returns the given
 * candidates) and `artifact/project/loop.findMany` (returns only the ids present
 * in `visible[type]`) — the source-of-truth re-auth mock. Records the ids each
 * source table was queried with so a test can assert re-auth is set-based.
 */
/**
 * Flatten a mocked Prisma.sql fragment tree to raw SQL text so the `$queryRaw`
 * fake can tell the EXACT id/slug lane (`entity_id = …::uuid` / `lower("slug")`)
 * apart from the FTS candidate scan.
 */
function sqlText(node: unknown): string {
  if (node === null || node === undefined) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (typeof node === "object") {
    const n = node as {
      strings?: string[];
      values?: unknown[];
      join?: unknown[];
    };
    if (Array.isArray(n.join)) {
      return n.join.map(sqlText).join(" ");
    }
    if (Array.isArray(n.strings)) {
      return n.strings.join(" ") + (n.values ?? []).map(sqlText).join(" ");
    }
  }
  return "";
}

function installDb(options: {
  candidates: Candidate[];
  visible: Partial<Record<string, string[]>>;
  onFind?: (type: string, ids: string[]) => void;
  /** Org's `searchIncludeTranscripts` value returned by organization.findUnique. */
  transcriptGateOn?: boolean;
  /** Rows the EXACT id/slug lookup lane returns (defaults to none). */
  exactCandidates?: Candidate[];
  /** Users the `@owner` resolver returns (defaults to none). */
  ownerUserIds?: string[];
  /** Projects the `:project` resolver returns (defaults to none). */
  projectRows?: Array<{ id: string }>;
}) {
  const findFor = (type: string) =>
    vi.fn(
      (args: { where: { id: { in: string[] }; [key: string]: unknown } }) => {
        const requested = args.where.id.in;
        options.onFind?.(type, requested);
        const allowed = new Set(options.visible[type] ?? []);
        return Promise.resolve(
          requested.filter((id) => allowed.has(id)).map((id) => ({ id }))
        );
      }
    );

  // agent_session re-auth queries SessionDetail by `artifactId` and returns
  // `{ artifactId }` rows, so it needs its own shaped fake.
  const sessionFindMany = vi.fn(
    (args: { where: { artifactId: { in: string[] } } }) => {
      const requested = args.where.artifactId.in;
      options.onFind?.(SearchEntityType.AgentSession, requested);
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

  // Comment re-auth queries `comment.findMany` scoped through the owning thread
  // (`thread.is.organizationId`) + `deletedAt: null`, returning `{ id }` rows.
  const commentFindMany = vi.fn(
    (args: { where: { id: { in: string[] }; [key: string]: unknown } }) => {
      const requested = args.where.id.in;
      options.onFind?.(SearchEntityType.Comment, requested);
      const allowed = new Set(options.visible[SearchEntityType.Comment] ?? []);
      return Promise.resolve(
        requested.filter((id) => allowed.has(id)).map((id) => ({ id }))
      );
    }
  );

  // Branch re-auth queries `branchDetail.findMany` by `artifactId`, returning
  // `{ artifactId }` rows.
  const branchFindMany = vi.fn(
    (args: { where: { artifactId: { in: string[] } } }) => {
      const requested = args.where.artifactId.in;
      options.onFind?.(SearchEntityType.Branch, requested);
      const allowed = new Set(options.visible[SearchEntityType.Branch] ?? []);
      return Promise.resolve(
        requested
          .filter((id) => allowed.has(id))
          .map((id) => ({ artifactId: id }))
      );
    }
  );

  // The EXACT id/slug lane and the FTS candidate scan both hit `$queryRaw`; route
  // by SQL shape (the exact lane carries `entity_id = …::uuid` / `lower("slug")`
  // and never a `tsv @@` match).
  const queryRaw = vi.fn((node: unknown) => {
    const text = sqlText(node);
    const isExactLane =
      text.includes("lower(") || EXACT_ID_PREDICATE.test(text);
    return Promise.resolve(
      isExactLane ? (options.exactCandidates ?? []) : options.candidates
    );
  });

  const projectFindMany = vi.fn(
    (args: { where: { id?: { in: string[] }; organizationId?: string } }) => {
      // `:project` resolver (id-less where) vs the project re-auth lane (id.in).
      if (args.where.id?.in) {
        const requested = args.where.id.in;
        options.onFind?.(SearchEntityType.Project, requested);
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
    loop: { findMany: findFor(SearchEntityType.Loop) },
    user: {
      findMany: vi.fn(() =>
        Promise.resolve((options.ownerUserIds ?? []).map((id) => ({ id })))
      ),
    },
    sessionDetail: { findMany: sessionFindMany },
    comment: { findMany: commentFindMany },
    pullRequestDetail: { findMany: findFor(SearchEntityType.PullRequest) },
    branchDetail: { findMany: branchFindMany },
    // agent_component re-auth (FEA-4011 Slice A) queries `agentComponent.findMany`
    // by `id` scoped to the org, returning `{ id }` rows — same shape as findFor.
    agentComponent: { findMany: findFor(SearchEntityType.AgentComponent) },
    organization: {
      findUnique: vi.fn().mockResolvedValue({
        searchIncludeTranscripts: options.transcriptGateOn ?? false,
      }),
    },
  };
  mockWithDb.mockImplementation((cb: (d: unknown) => unknown) => cb(db));
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
        candidate({ entity_type: SearchEntityType.Loop, entity_id: "l1" }),
      ],
      visible: {
        [SearchEntityType.Document]: ["d1", "d2"],
        [SearchEntityType.Loop]: ["l1"],
      },
      onFind: (type, ids) => calls.push({ type, count: ids.length }),
    });

    await searchFtsService.searchUnified(baseParams());

    // Exactly one re-auth query per distinct type present in the candidates.
    const docCalls = calls.filter((c) => c.type === SearchEntityType.Document);
    const loopCalls = calls.filter((c) => c.type === SearchEntityType.Loop);
    expect(docCalls).toHaveLength(1);
    expect(loopCalls).toHaveLength(1);
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
          entity_type: SearchEntityType.Loop,
          entity_id: "l1",
          slug: null,
          entity_subtype: null,
          team_id: null,
        }),
      ],
      visible: { [SearchEntityType.Loop]: ["l1"] },
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
  ] as const)("slug-only query %s returns the exact row (case-insensitive)", async (slug, entityType) => {
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
  });

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

describe("reauthorizeHits", () => {
  beforeEach(() => vi.clearAllMocks());

  it("never authorizes an unmapped/unknown entity type (fail-closed default)", async () => {
    installDb({ candidates: [], visible: {} });
    const authorized = await reauthorizeHits(ORG, [
      candidate({ entity_type: "not-a-real-type", entity_id: "x1" }),
    ]);
    expect(authorized.size).toBe(0);
  });

  it("drops a document whose source artifact is not org-visible (stale/deleted projection)", async () => {
    installDb({
      candidates: [],
      // The projection still carries d-stale, but the source artifact is not
      // under this org (moved orgs / hard-deleted): re-auth must drop it.
      visible: { [SearchEntityType.Document]: ["d-live"] },
    });
    const authorized = await reauthorizeHits(ORG, [
      candidate({
        entity_type: SearchEntityType.Document,
        entity_id: "d-live",
      }),
      candidate({
        entity_type: SearchEntityType.Document,
        entity_id: "d-stale",
      }),
    ]);
    expect(authorized.has(`${SearchEntityType.Document}:d-live`)).toBe(true);
    expect(authorized.has(`${SearchEntityType.Document}:d-stale`)).toBe(false);
  });

  it("drops a project whose source is not org-visible (stale/deleted/cross-org)", async () => {
    installDb({
      candidates: [],
      visible: { [SearchEntityType.Project]: ["p-live"] },
    });
    const authorized = await reauthorizeHits(ORG, [
      candidate({ entity_type: SearchEntityType.Project, entity_id: "p-live" }),
      candidate({
        entity_type: SearchEntityType.Project,
        entity_id: "p-stale",
      }),
    ]);
    expect(authorized.has(`${SearchEntityType.Project}:p-live`)).toBe(true);
    expect(authorized.has(`${SearchEntityType.Project}:p-stale`)).toBe(false);
  });

  it("drops a loop whose source is not org-visible (stale/deleted/cross-org)", async () => {
    installDb({
      candidates: [],
      visible: { [SearchEntityType.Loop]: ["l-live"] },
    });
    const authorized = await reauthorizeHits(ORG, [
      candidate({ entity_type: SearchEntityType.Loop, entity_id: "l-live" }),
      candidate({ entity_type: SearchEntityType.Loop, entity_id: "l-stale" }),
    ]);
    expect(authorized.has(`${SearchEntityType.Loop}:l-live`)).toBe(true);
    expect(authorized.has(`${SearchEntityType.Loop}:l-stale`)).toBe(false);
  });

  it("authorizes a comment whose thread is in-org and drops a cross-org one (FEA-3930)", async () => {
    installDb({
      candidates: [],
      // Only c-in-org exists under this org (via its thread); c-other-org does
      // not — a cross-org/stale projection row must not leak.
      visible: { [SearchEntityType.Comment]: ["c-in-org"] },
    });
    const authorized = await reauthorizeHits(ORG, [
      candidate({
        entity_type: SearchEntityType.Comment,
        entity_id: "c-in-org",
      }),
      candidate({
        entity_type: SearchEntityType.Comment,
        entity_id: "c-other-org",
      }),
    ]);
    expect(authorized.has(`${SearchEntityType.Comment}:c-in-org`)).toBe(true);
    expect(authorized.has(`${SearchEntityType.Comment}:c-other-org`)).toBe(
      false
    );
  });

  it("authorizes a pull_request in-org and drops a cross-org one (FEA-3930)", async () => {
    installDb({
      candidates: [],
      visible: { [SearchEntityType.PullRequest]: ["pr-in-org"] },
    });
    const authorized = await reauthorizeHits(ORG, [
      candidate({
        entity_type: SearchEntityType.PullRequest,
        entity_id: "pr-in-org",
      }),
      candidate({
        entity_type: SearchEntityType.PullRequest,
        entity_id: "pr-other-org",
      }),
    ]);
    expect(authorized.has(`${SearchEntityType.PullRequest}:pr-in-org`)).toBe(
      true
    );
    expect(authorized.has(`${SearchEntityType.PullRequest}:pr-other-org`)).toBe(
      false
    );
  });

  it("gates a pull_request on its owning branch being live (not soft-deleted)", async () => {
    const db = installDb({
      candidates: [],
      visible: { [SearchEntityType.PullRequest]: ["pr1"] },
    });
    await reauthorizeHits(ORG, [
      candidate({
        entity_type: SearchEntityType.PullRequest,
        entity_id: "pr1",
      }),
    ]);
    // The PR reauth query must require the owning branch to be un-deleted, so a
    // PR on a soft-deleted branch never resolves to a dead `/branches/…` route.
    const call = (db.pullRequestDetail.findMany as Mock).mock.calls[0][0] as {
      where: {
        branchArtifact: { is: { branch: { is: { deletedAt: unknown } } } };
      };
    };
    expect(call.where.branchArtifact.is.branch.is.deletedAt).toBeNull();
  });

  it("gates a comment against a soft-deleted branch anchor", async () => {
    const db = installDb({
      candidates: [],
      visible: { [SearchEntityType.Comment]: ["c1"] },
    });
    await reauthorizeHits(ORG, [
      candidate({ entity_type: SearchEntityType.Comment, entity_id: "c1" }),
    ]);
    // A branch-anchored comment must be excluded when its anchor branch is
    // soft-deleted (it would otherwise link to a dead branch route); session
    // anchors are unaffected because the branch relation is absent.
    const call = (db.comment.findMany as Mock).mock.calls[0][0] as {
      where: {
        NOT: {
          thread: {
            is: {
              artifact: { is: { branch: { is: { deletedAt: unknown } } } };
            };
          };
        };
      };
    };
    expect(call.where.NOT.thread.is.artifact.is.branch.is.deletedAt).toEqual({
      not: null,
    });
  });

  it("authorizes a branch in-org and drops a cross-org one (FEA-3930)", async () => {
    installDb({
      candidates: [],
      visible: { [SearchEntityType.Branch]: ["b-in-org"] },
    });
    const authorized = await reauthorizeHits(ORG, [
      candidate({
        entity_type: SearchEntityType.Branch,
        entity_id: "b-in-org",
      }),
      candidate({
        entity_type: SearchEntityType.Branch,
        entity_id: "b-other-org",
      }),
    ]);
    expect(authorized.has(`${SearchEntityType.Branch}:b-in-org`)).toBe(true);
    expect(authorized.has(`${SearchEntityType.Branch}:b-other-org`)).toBe(
      false
    );
  });

  it("authorizes an agent_component in-org and drops a cross-org one (FEA-4011 Slice A)", async () => {
    installDb({
      candidates: [],
      // Only ac-in-org exists under this org; ac-other-org does not — a
      // cross-org/stale projection row must not leak.
      visible: { [SearchEntityType.AgentComponent]: ["ac-in-org"] },
    });
    const authorized = await reauthorizeHits(ORG, [
      candidate({
        entity_type: SearchEntityType.AgentComponent,
        entity_id: "ac-in-org",
      }),
      candidate({
        entity_type: SearchEntityType.AgentComponent,
        entity_id: "ac-other-org",
      }),
    ]);
    expect(authorized.has(`${SearchEntityType.AgentComponent}:ac-in-org`)).toBe(
      true
    );
    expect(
      authorized.has(`${SearchEntityType.AgentComponent}:ac-other-org`)
    ).toBe(false);
  });

  it("gates an agent_component on it not being uninstalled (FEA-4011 Slice A)", async () => {
    const db = installDb({
      candidates: [],
      visible: { [SearchEntityType.AgentComponent]: ["ac1"] },
    });
    await reauthorizeHits(ORG, [
      candidate({
        entity_type: SearchEntityType.AgentComponent,
        entity_id: "ac1",
      }),
    ]);
    // A since-uninstalled component must be excluded so a raced/missed
    // projection removal cannot keep it searchable (parity with the
    // branch/PR soft-delete gate).
    const call = (db.agentComponent.findMany as Mock).mock.calls[0][0] as {
      where: { uninstalledAt: unknown };
    };
    expect(call.where.uninstalledAt).toBeNull();
  });

  it("authorizes an agent_session hit only when the org transcript gate is ON", async () => {
    installDb({
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
  });

  it("drops an agent_session hit when the org transcript gate is OFF (defense-in-depth)", async () => {
    // Even though the SessionDetail source row exists and belongs to the org,
    // the gate being off must hide it — a stale projection row from when it was
    // on cannot leak.
    installDb({
      candidates: [],
      visible: { [SearchEntityType.AgentSession]: ["sess-1"] },
      transcriptGateOn: false,
    });
    const authorized = await reauthorizeHits(ORG, [
      candidate({
        entity_type: SearchEntityType.AgentSession,
        entity_id: "sess-1",
      }),
    ]);
    expect(authorized.size).toBe(0);
  });

  it("drops an agent_session hit whose SessionDetail is not in the org even when the gate is ON", async () => {
    // Gate on, but the source row is not visible under this org (cross-org /
    // stale projection): still dropped.
    installDb({
      candidates: [],
      visible: { [SearchEntityType.AgentSession]: [] },
      transcriptGateOn: true,
    });
    const authorized = await reauthorizeHits(ORG, [
      candidate({
        entity_type: SearchEntityType.AgentSession,
        entity_id: "other-org-sess",
      }),
    ]);
    expect(authorized.size).toBe(0);
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
