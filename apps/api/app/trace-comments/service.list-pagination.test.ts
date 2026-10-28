import { TRACE_COMMENT_LIST_MAX_OFFSET } from "@repo/api/src/types/comment";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ArtifactType: { SESSION: "SESSION", BRANCH: "BRANCH" },
  });
});

import { mockWithDbTx } from "../../__tests__/utils/db-helpers";
import { traceCommentsService } from "./service";

/**
 * `listAll` cursor pagination (FEA-3550, ISS-8734).
 *
 * `nextCursor` is a token this endpoint MINTS and the client replays, and
 * ISS-8734 bounds the `cursor` the schema accepts. These cases pin the two
 * halves of that coupling: the token is still minted when the next offset lands
 * exactly on the ceiling, and withheld once it would pass it, so the endpoint
 * can never answer 400 to a cursor it issued itself.
 */
describe("traceCommentsService.listAll pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty page with a null cursor when nothing matches (FEA-3550)", async () => {
    mockWithDbTx({
      $queryRaw: vi.fn().mockResolvedValueOnce([{ id: null, count: 0n }]),
      commentThread: { findMany: vi.fn() },
      user: { findMany: vi.fn() },
    });

    const response = await traceCommentsService.listAll({
      organizationId: "org-1",
      userId: "user-1",
      filters: { resolved: false },
    });

    expect(response).toEqual({ items: [], total: 0, nextCursor: null });
  });

  it("still mints a cursor when the next offset lands exactly on the ceiling (ISS-8734)", async () => {
    mockWithDbTx({
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([
          { id: "thread-1", count: BigInt(TRACE_COMMENT_LIST_MAX_OFFSET + 5) },
        ]),
      commentThread: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const response = await traceCommentsService.listAll({
      organizationId: "org-1",
      userId: "user-1",
      filters: { resolved: false, offset: TRACE_COMMENT_LIST_MAX_OFFSET - 1 },
    });

    expect(response.nextCursor).toBe(String(TRACE_COMMENT_LIST_MAX_OFFSET));
  });

  it("withholds the cursor past the ceiling rather than minting a token the schema rejects (ISS-8734)", async () => {
    mockWithDbTx({
      $queryRaw: vi.fn().mockResolvedValueOnce([
        {
          id: "thread-1",
          count: BigInt(TRACE_COMMENT_LIST_MAX_OFFSET + 500),
        },
      ]),
      commentThread: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const response = await traceCommentsService.listAll({
      organizationId: "org-1",
      userId: "user-1",
      filters: { resolved: false, offset: TRACE_COMMENT_LIST_MAX_OFFSET },
    });

    // Rows remain — `total` says so — so this is not "exhausted". The null
    // cursor says this pagination cannot reach them. Minting
    // `TRACE_COMMENT_LIST_MAX_OFFSET + 1` would be a token
    // `traceCommentListQuerySchema` answers 400 to.
    expect(response.total).toBe(TRACE_COMMENT_LIST_MAX_OFFSET + 500);
    expect(response.nextCursor).toBeNull();
  });
});
