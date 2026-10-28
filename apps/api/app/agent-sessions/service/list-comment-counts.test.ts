import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadListCommentCounts,
  SESSIONS_LIST_COMMENT_COUNT_READ_FAILED_EVENT,
} from "./list-comment-counts";

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: vi.fn(),
}));
vi.mock("@repo/observability/log", () => ({ log: { error: vi.fn() } }));
const queryRaw = vi.fn();
const orgId = "11111111-1111-4111-8111-111111111111";
const artifactId = "22222222-2222-4222-8222-222222222222";

describe("Sessions direct artifact comment counts", () => {
  beforeEach(() => {
    vi.mocked(withDb).mockImplementation(async (read) =>
      read({ $queryRaw: queryRaw } as never)
    );
  });
  it("preserves uncapped thread counts and measured zeros", async () => {
    queryRaw.mockResolvedValue([
      { artifactId, commentCount: 203 },
      { artifactId: "quiet", commentCount: 0 },
    ]);
    expect(
      await loadListCommentCounts(orgId, [artifactId, "quiet", artifactId])
    ).toEqual(
      new Map([
        [artifactId, 203],
        ["quiet", 0],
      ])
    );
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sql = queryRaw.mock.calls[0][0];
    expect(sql.text).toContain("COUNT(DISTINCT c.thread_id)");
    expect(sql.text).toContain("c.deleted_at IS NULL");
    expect(sql.values).toContain(orgId);
    expect(sql.values).toContain("NATIVE");
    expect(sql.values).toContain("LIVEBLOCKS");
    expect(sql.text).not.toContain("metadata");
    expect(sql.text).not.toContain("LIMIT");
  });
  it("does no work for an empty list", async () => {
    expect(await loadListCommentCounts(orgId, [])).toEqual(new Map());
    expect(queryRaw).not.toHaveBeenCalled();
  });
  it("omits failed enrichment while retaining monitored errors", async () => {
    queryRaw.mockRejectedValue(new Error("unavailable"));
    expect(await loadListCommentCounts(orgId, [artifactId])).toEqual(new Map());
    expect(log.error).toHaveBeenCalledWith(
      SESSIONS_LIST_COMMENT_COUNT_READ_FAILED_EVENT,
      expect.objectContaining({ organizationId: orgId, sessionCount: 1 })
    );
  });
});
