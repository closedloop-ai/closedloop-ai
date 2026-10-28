import { LinkDirection, LinkType } from "@repo/api/src/types/artifact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({
      artifactLinkTreePage: {
        findFirst: mocks.read,
        createMany: mocks.write,
        findMany: mocks.list,
        deleteMany: mocks.remove,
      },
    }),
}));
vi.mock("@repo/observability/log", () => ({ log: { error: mocks.error } }));

import {
  readLinkTreePage,
  saveLinkTreePages,
  sweepExpiredLinkTreePages,
} from "../link-tree-pages";
import { windowForCursor } from "../resolved-page";

const scope = {
  organizationId: "org",
  artifactId: "root",
  direction: LinkDirection.Both,
  maxDepth: 5,
};

const links = Array.from({ length: 1001 }, (_, index) => ({
  id: String(index),
  organizationId: "org",
  sourceId: "root",
  targetId: String(index),
  linkType: LinkType.Produces,
  createdAt: new Date(0),
  metadata: null,
}));

beforeEach(() => vi.resetAllMocks());

describe("additive tree snapshot table deploy window", () => {
  it("falls back to numeric paging when the new table is not yet deployed", async () => {
    mocks.read.mockRejectedValueOnce({ code: "P2021" });
    mocks.write.mockRejectedValueOnce({ code: "P2021" });
    expect(await readLinkTreePage(scope, windowForCursor(1000))).toBeNull();
    expect(
      await saveLinkTreePages(scope, links, windowForCursor())
    ).toBeUndefined();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });

  it("does not hide an unrelated database failure as a cache miss", async () => {
    const error = new Error("connection failed");
    mocks.read.mockRejectedValueOnce(error);
    await expect(readLinkTreePage(scope, windowForCursor(1000))).rejects.toBe(
      error
    );
  });

  it.each([{ code: "P2024" }, new Error("statement timeout")])(
    "keeps a successful traversal usable when snapshot writes fail: %s",
    async (error) => {
      mocks.write.mockRejectedValueOnce(error);
      expect(
        await saveLinkTreePages(scope, links, windowForCursor())
      ).toBeUndefined();
      expect(mocks.error).toHaveBeenCalledWith(
        "artifact_link_tree_snapshot_unavailable",
        {
          organizationId: scope.organizationId,
          error,
        }
      );
    }
  );

  it("bounds each sweep and leaves further committed work for the next tick", async () => {
    const pages = Array.from({ length: 1000 }, (_, offset) => ({
      snapshotId: "snapshot",
      offset,
    }));
    mocks.list.mockResolvedValue(pages);
    mocks.remove.mockResolvedValue({ count: 1000 });
    expect(await sweepExpiredLinkTreePages()).toBe(20_000);
    expect(mocks.list).toHaveBeenCalledTimes(20);
    expect(mocks.remove).toHaveBeenCalledTimes(20);
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1000 })
    );
    expect(mocks.remove).toHaveBeenCalledWith({
      where: { expiresAt: { lte: expect.any(Date) }, OR: pages },
    });
  });
});
