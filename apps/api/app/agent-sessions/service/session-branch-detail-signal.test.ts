import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import type { TransactionClient } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitBranchDetailsChanged } from "@/app/branches/branch-detail-signal";
import {
  emitSessionBranchDetailChanged,
  readSessionBranchIds,
} from "./session-branch-detail-signal";

vi.mock("@/app/branches/branch-detail-signal", () => ({
  emitBranchDetailsChanged: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

describe("session branch membership notifications", () => {
  it("notifies the removed branch when replacement retracts its last link", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([{ targetId: "removed-branch" }])
      .mockResolvedValueOnce([]);
    const tx = { artifactLink: { findMany } } as unknown as TransactionClient;

    const previous = await readSessionBranchIds(tx, "org", "session");
    await emitSessionBranchDetailChanged(tx, "org", "session", previous);

    expect(findMany).toHaveBeenNthCalledWith(1, {
      where: {
        organizationId: "org",
        sourceId: "session",
        linkType: LinkType.RelatesTo,
        target: { organizationId: "org", type: ArtifactType.Branch },
      },
      select: { targetId: true },
    });
    expect(emitBranchDetailsChanged).toHaveBeenCalledExactlyOnceWith(
      tx,
      "org",
      ["removed-branch"]
    );
  });

  it("notifies the union once per branch in one batch on the caller's transaction", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([{ targetId: "retained" }, { targetId: "added" }]);
    const tx = { artifactLink: { findMany } } as unknown as TransactionClient;

    await emitSessionBranchDetailChanged(tx, "org", "session", [
      "removed",
      "retained",
    ]);

    expect(emitBranchDetailsChanged).toHaveBeenCalledExactlyOnceWith(
      tx,
      "org",
      ["removed", "retained", "added"]
    );
  });
});
