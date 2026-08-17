/**
 * ISS-6004 — `GET /branches` must not scale its statement count (and therefore
 * its pooled connection checkouts) with the size of the page.
 *
 * Two production traces on 2026-08-11 showed one `GET /branches` issuing 522
 * `pg.query:SELECT` spans and 523 `pg-pool.connect` checkouts against a 20-slot
 * pool, for 1.5–2.0 s wall. The fan-out was the per-Branch comment-evidence read
 * in `resolveBranchIdentities`: three statements for every Branch on the page.
 *
 * These cases assert the SHAPE of the read (a bounded, page-size-independent
 * statement count and peak in-flight concurrency) rather than the response body,
 * because a body-only assertion stays green if the fan-out comes back. The page
 * here is 100 Branches — the route's `BRANCH_LIST_MAX_LIMIT`, and far ABOVE the
 * bound under test, so an unbounded implementation cannot pass by accident.
 */

import {
  BranchCollaboratorSource,
  BranchIdentityAvailability,
} from "@repo/api/src/types/branch-identity";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: { UNKNOWN: "UNKNOWN" },
  });
});

vi.mock("@repo/github", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/github")>("@repo/github");
  return {
    ...actual,
    getSinglePullRequestWithProviderResult: vi.fn(),
  };
});

import {
  createMockDb,
  makeBranchRow,
  makeSessionLink,
  mockBranchCandidatePage,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { DB_FANOUT_MAX_CONCURRENCY } from "@/lib/db-fanout";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import {
  BRANCH_LIST_MAX_LIMIT,
  branchReadService,
} from "./branch-read-service";
import {
  COMMENT_EVIDENCE_LIMIT,
  SESSION_COMMENT_ID_CHUNK_SIZE,
} from "./branch-read-service/identity-attribution";

/** The largest page a caller can ask for — read from the route, never re-declared. */
const PAGE_BRANCHES = BRANCH_LIST_MAX_LIMIT;
/**
 * The comment-evidence read may issue at most one statement per evidence source
 * (branch-native, session-native, GitHub projection) for the WHOLE page.
 */
const MAX_NATIVE_COMMENT_QUERIES = 2;
const MAX_GITHUB_COMMENT_QUERIES = 1;
/**
 * Peak pooled-connection checkouts one `GET /branches` may hold at once. Read
 * from `DB_FANOUT_MAX_CONCURRENCY`, which is DERIVED from the pool size so that
 * shrinking the pool moves the bound automatically — a hardcoded copy would keep
 * asserting the old bound and quietly stop guarding (PRD-528 / FEA-3299).
 */
const MAX_PEAK_IN_FLIGHT = DB_FANOUT_MAX_CONCURRENCY;

const authorA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const authorB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function pageBranchId(index: number): string {
  return `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
}

/**
 * One native comment row in the shape the page-wide read selects, including the
 * `createdAt`/`id` order keys the per-Branch cap is applied on.
 */
function makeComment(authorId: string, artifactId: string, index: number) {
  return {
    authorId,
    createdAt: new Date(now.getTime() + index),
    id: `comment-${artifactId}-${index}`,
    thread: { artifactId },
  };
}

function makeUser(id: string, firstName: string) {
  return {
    id,
    email: `${firstName.toLowerCase()}@example.com`,
    firstName,
    lastName: "Tester",
    avatarUrl: null,
  };
}

describe("branch list identity evidence is read page-wide, not per Branch (ISS-6004)", () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let inFlight: number;
  let peakInFlight: number;

  /**
   * Wrap every mocked read so the harness observes real overlap: each call holds
   * a "connection" across an awaited tick, exactly as a pooled query does.
   */
  function trackInFlight<T>(resolve: (args: never) => T) {
    return async (args: never): Promise<T> => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return resolve(args);
    };
  }

  function listPage() {
    return branchReadService.listBranches(organizationId, {
      limit: PAGE_BRANCHES,
      offset: 0,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    inFlight = 0;
    peakInFlight = 0;
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);

    const ids = Array.from({ length: PAGE_BRANCHES }, (_, index) =>
      pageBranchId(index)
    );
    mockBranchCandidatePage(mockDb, ids);
    mockDb.artifact.findMany.mockResolvedValue(
      ids.map((id, index) =>
        makeBranchRow({ id, branchName: `feature-${index}` })
      )
    );
    // One session per Branch, so every Branch has session evidence to read.
    mockDb.artifactLink.findMany.mockResolvedValue(
      ids.map((id, index) => makeSessionLink(id, `session-${index}`, "1.00"))
    );
    mockDb.comment.findMany.mockImplementation(trackInFlight(() => []));
    mockDb.gitHubCommentProjection.findMany.mockImplementation(
      trackInFlight(() => [])
    );
  });

  it("reads a 100-Branch page's comment evidence in three statements, not 300", async () => {
    await listPage();

    // The regression this pins: before ISS-6004 these were 200 and 100.
    expect(mockDb.comment.findMany).toHaveBeenCalledTimes(
      MAX_NATIVE_COMMENT_QUERIES
    );
    expect(mockDb.gitHubCommentProjection.findMany).toHaveBeenCalledTimes(
      MAX_GITHUB_COMMENT_QUERIES
    );
    // And the read is keyed on the WHOLE page, not one Branch.
    expect(mockDb.comment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          thread: expect.objectContaining({
            artifactId: {
              in: expect.arrayContaining([pageBranchId(0), pageBranchId(99)]),
            },
          }),
        }),
      })
    );
  });

  // Stated plainly: this case passes BOTH before and after ISS-6004, because the
  // pre-fix fan-out already ran through `mapWithDbConcurrency` and was bounded at
  // `DB_FANOUT_MAX_CONCURRENCY`. The 523 checkouts in the production trace were
  // 523 SEQUENTIAL borrows, not 523 held at once — the pool was never exhausted,
  // the round trips were the cost. It is kept as the standing guard on the bound
  // (a future `Promise.all` over the page would fail it); the counterfactual
  // proof for the fix itself lives in the statement-count cases above.
  it("holds no more than the fan-out bound of pooled connections at once", async () => {
    await listPage();

    // 100 Branches is 20x this bound, so an unbounded per-Branch fan-out cannot
    // satisfy it by having too small a payload.
    expect(peakInFlight).toBeLessThanOrEqual(MAX_PEAK_IN_FLIGHT);
    expect(peakInFlight).toBeGreaterThan(0);
  });

  it("keeps the page's total statement count independent of the page size", async () => {
    await listPage();
    const queriesForFullPage = totalQueries(mockDb);

    vi.clearAllMocks();
    mockDb.comment.findMany.mockImplementation(trackInFlight(() => []));
    mockDb.gitHubCommentProjection.findMany.mockImplementation(
      trackInFlight(() => [])
    );
    mockBranchCandidatePage(mockDb, [pageBranchId(0)]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({ id: pageBranchId(0) }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(pageBranchId(0), "session-0", "1.00"),
    ]);
    await listPage();

    // A 100x larger page must not cost 100x the statements. Before ISS-6004 the
    // full page cost 306 and the single-Branch page cost 9.
    expect(queriesForFullPage).toBe(totalQueries(mockDb));
  });

  it("attributes each Branch's own comment authors without leaking across the page", async () => {
    const firstBranch = pageBranchId(0);
    const secondBranch = pageBranchId(1);
    mockDb.comment.findMany.mockImplementation(
      trackInFlight(({ where }: { where: CommentWhere }) =>
        where.thread.artifactId.in.includes(firstBranch)
          ? [
              makeComment(authorA, firstBranch, 0),
              makeComment(authorB, secondBranch, 1),
            ]
          : []
      )
    );
    mockDb.user.findMany.mockResolvedValue([
      makeUser(authorA, "Ada"),
      makeUser(authorB, "Bob"),
    ]);

    const response = await listPage();

    expect(collaboratorUserIds(response, firstBranch)).toEqual([authorA]);
    expect(collaboratorUserIds(response, secondBranch)).toEqual([authorB]);
  });

  it("gives a session's comments to every Branch that links it", async () => {
    const firstBranch = pageBranchId(0);
    const secondBranch = pageBranchId(1);
    // One session written to by BOTH Branches — the shared-session case the
    // per-Branch read covered by simply querying twice.
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(firstBranch, "session-shared", "1.00"),
      makeSessionLink(secondBranch, "session-shared", "1.00"),
    ]);
    mockDb.comment.findMany.mockImplementation(
      trackInFlight(({ where }: { where: CommentWhere }) =>
        where.thread.artifactId.in.includes("session-shared")
          ? [makeComment(authorA, "session-shared", 0)]
          : []
      )
    );
    mockDb.user.findMany.mockResolvedValue([makeUser(authorA, "Ada")]);

    const response = await listPage();

    expect(collaboratorUserIds(response, firstBranch)).toEqual([authorA]);
    expect(collaboratorUserIds(response, secondBranch)).toEqual([authorA]);
  });

  it("reports every Branch incomplete when the page-wide evidence bound truncates", async () => {
    const firstBranch = pageBranchId(0);
    // One row past the page-wide bound: the overflow cannot be attributed to a
    // Branch, so no Branch may claim a complete corpus.
    const overflowing = Array.from(
      { length: COMMENT_EVIDENCE_LIMIT * PAGE_BRANCHES + 1 },
      (_row, index) => makeComment(authorA, firstBranch, index)
    );
    mockDb.comment.findMany.mockImplementation(
      trackInFlight(({ where }: { where: CommentWhere }) =>
        where.thread.artifactId.in.includes(firstBranch) ? overflowing : []
      )
    );
    mockDb.user.findMany.mockResolvedValue([makeUser(authorA, "Ada")]);

    const response = await listPage();

    for (const branch of [
      pageBranchId(0),
      pageBranchId(50),
      pageBranchId(99),
    ]) {
      expect(
        sourceAvailability(
          response,
          branch,
          BranchCollaboratorSource.BranchComments
        )
      ).toBe(BranchIdentityAvailability.Incomplete);
    }
  });

  it("bounds the session-comment read by the Branch count, not the session count", async () => {
    // A Branch can only ever CONSUME its own COMMENT_EVIDENCE_LIMIT rows however
    // many sessions it links, so the page bound is keyed on Branches. Keying it
    // on sessions would let one statement's worst-case row set grow with the
    // session fan-out — looser than the per-Branch reads this replaced.
    mockDb.artifactLink.findMany.mockResolvedValue(
      Array.from({ length: PAGE_BRANCHES }, (_row, index) =>
        Array.from({ length: 8 }, (_session, sessionIndex) =>
          makeSessionLink(
            pageBranchId(index),
            `session-${index}-${sessionIndex}`,
            "1.00"
          )
        )
      ).flat()
    );

    await listPage();

    const expectedTake = COMMENT_EVIDENCE_LIMIT * PAGE_BRANCHES + 1;
    for (const [args] of mockDb.comment.findMany.mock.calls) {
      expect(args.take).toBe(expectedTake);
    }
  });

  it("chunks the session-id predicate so a link-heavy page cannot exceed the bind-parameter limit", async () => {
    // The session-id list is the union across the page and is NOT page-size
    // bounded; Prisma emits one bind parameter per id and does not chunk, so an
    // unchunked list turns a link-heavy org's `GET /branches` into a 500.
    const sessionsPerBranch = 30;
    mockDb.artifactLink.findMany.mockResolvedValue(
      Array.from({ length: PAGE_BRANCHES }, (_row, index) =>
        Array.from({ length: sessionsPerBranch }, (_session, sessionIndex) =>
          makeSessionLink(
            pageBranchId(index),
            `session-${index}-${sessionIndex}`,
            "1.00"
          )
        )
      ).flat()
    );

    await listPage();

    const predicateSizes = mockDb.comment.findMany.mock.calls.map(
      ([args]) => args.where.thread.artifactId.in.length
    );
    // 3,000 distinct sessions must arrive as chunks, never one 3,000-id `IN`.
    expect(Math.max(...predicateSizes)).toBeLessThanOrEqual(
      SESSION_COMMENT_ID_CHUNK_SIZE
    );
    // Still bounded and small: one Branch statement plus ceil(3000 / 1000).
    expect(mockDb.comment.findMany).toHaveBeenCalledTimes(
      1 +
        Math.ceil(
          (PAGE_BRANCHES * sessionsPerBranch) / SESSION_COMMENT_ID_CHUNK_SIZE
        )
    );
  });
});

/**
 * The page-wide session-comment read is CHUNKED over the session-id list, and
 * the row budget is spent across those chunks rather than handed to each one.
 *
 * This page is deliberately ONE Branch, unlike the cases above: the fan-out
 * under test multiplies over CHUNKS, not Branches, and a one-Branch page puts
 * the budget at a single Branch's `COMMENT_EVIDENCE_LIMIT` so the arithmetic is
 * checkable by hand instead of needing 300,000 fixture rows.
 */
describe("the session-comment read spends one page-wide row budget (ISS-6004)", () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let reads: ChunkRead[];

  const branch = pageBranchId(0);
  /** One Branch on the page ⇒ the page budget is one Branch's cap, plus the overflow probe. */
  const pageBudget = COMMENT_EVIDENCE_LIMIT + 1;
  const chunks = 3;

  /**
   * The comment mock a real database behaves like: a chunk answers with at most
   * its `take` of the rows it matches, and records what it was asked for. A mock
   * that IGNORES `take` returns the same rows however small the remaining budget
   * is, so it cannot show the accumulation these cases bound.
   */
  function mockSessionChunkRows(available: number): void {
    mockDb.comment.findMany.mockImplementation(
      ({ where, take }: ChunkRead & { where: CommentWhere }) => {
        const [firstId] = where.thread.artifactId.in;
        if (!firstId?.startsWith("session-")) {
          return Promise.resolve([]);
        }
        const rowCount = Math.min(take, available);
        reads.push({ take, rows: rowCount });
        return Promise.resolve(
          Array.from({ length: rowCount }, (_row, index) =>
            makeComment(authorA, firstId, index)
          )
        );
      }
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    reads = [];
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
    mockBranchCandidatePage(mockDb, [branch]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow({ id: branch })]);
    // Enough linked sessions to span three session-id chunks.
    mockDb.artifactLink.findMany.mockResolvedValue(
      Array.from(
        { length: SESSION_COMMENT_ID_CHUNK_SIZE * chunks },
        (_link, index) => makeSessionLink(branch, `session-${index}`, "1.00")
      )
    );
    mockDb.user.findMany.mockResolvedValue([makeUser(authorA, "Ada")]);
  });

  function listOneBranchPage() {
    return branchReadService.listBranches(organizationId, {
      limit: PAGE_BRANCHES,
      offset: 0,
    });
  }

  it("holds no more rows than the page budget however many chunks it reads", async () => {
    // Every chunk matches far more rows than the page has budget for.
    mockSessionChunkRows(pageBudget * chunks);

    const response = await listOneBranchPage();

    // When each chunk carried its OWN `take`, the accumulated set was
    // `chunks × (pageCap + 1)`: 3,003 rows here, and ~3M for an org with 30k
    // distinct linked session ids — all of it live before the sort and group.
    expect(totalRows(reads)).toBeLessThanOrEqual(pageBudget);
    // And the read stops issuing statements once the budget is spent: the one
    // Branch statement plus the single chunk that fit, not one per chunk.
    expect(mockDb.comment.findMany).toHaveBeenCalledTimes(2);
    // `truncated` still means what it meant: rows matched that this read did not
    // return, so no Branch may claim a complete corpus. (Also Incomplete before
    // the fix, where the first chunk overflowed the cap on its own — this is the
    // semantics guard, not the counterfactual.)
    expect(
      sourceAvailability(
        response,
        branch,
        BranchCollaboratorSource.SessionComments
      )
    ).toBe(BranchIdentityAvailability.Incomplete);
  });

  it("shrinks each chunk's take by what the earlier chunks already spent", async () => {
    const perChunk = 400;
    mockSessionChunkRows(perChunk);

    await listOneBranchPage();

    // Each chunk asks for the remainder, and the last one still asks for a
    // POSITIVE take rather than 0 or a negative: 1001 → 601 → 201.
    expect(reads.map((read) => read.take)).toEqual([
      pageBudget,
      pageBudget - perChunk,
      pageBudget - perChunk * 2,
    ]);
    // Three chunks that each matched 400 rows accumulated 1,200 before the
    // budget was shared; the budget is the ceiling now, not the per-chunk take.
    expect(totalRows(reads)).toBe(pageBudget);
  });
});

type CommentWhere = { thread: { artifactId: { in: string[] } } };
/** What one chunked session-comment statement asked for, and what it returned. */
type ChunkRead = { take: number; rows: number };

type ListResponse = Awaited<ReturnType<typeof branchReadService.listBranches>>;

function findItem(response: ListResponse, branchIdValue: string) {
  const item = response.items.find((row) => row.id === branchIdValue);
  if (!item) {
    throw new Error(`branch ${branchIdValue} missing from list response`);
  }
  return item;
}

function collaboratorUserIds(
  response: ListResponse,
  branchIdValue: string
): (string | undefined)[] {
  return (findItem(response, branchIdValue).collaborators?.people ?? []).map(
    (person) => person.userId
  );
}

function sourceAvailability(
  response: ListResponse,
  branchIdValue: string,
  source: BranchCollaboratorSource
): BranchIdentityAvailability | undefined {
  return findItem(response, branchIdValue).collaborators?.sources?.[source];
}

/** Every statement the read issued, across every mocked model on the client. */
function totalQueries(mockDb: ReturnType<typeof createMockDb>): number {
  return Object.values(mockDb).reduce(
    (total, api) => total + callCount(api),
    0
  );
}

/** Rows the chunked session-comment read actually accumulated in memory. */
function totalRows(reads: readonly ChunkRead[]): number {
  return reads.reduce((total, read) => total + read.rows, 0);
}

function callCount(api: Mock | Record<string, Mock>): number {
  if (typeof api === "function") {
    return api.mock.calls.length;
  }
  return Object.values(api).reduce(
    (total, fn) => total + fn.mock.calls.length,
    0
  );
}
