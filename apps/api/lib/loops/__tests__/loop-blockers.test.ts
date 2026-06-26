import { describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

import { withDb } from "@repo/database";
import { findNonTerminalBlockers } from "../loop-blockers";

const mockWithDb = withDb as unknown as Mock;

function mockArtifactLinks(rows: unknown[]): Mock {
  const findMany = vi.fn().mockResolvedValue(rows);
  mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({ artifactLink: { findMany } })
  );
  return findMany;
}

describe("findNonTerminalBlockers", () => {
  it("returns only the blocking sources whose status is non-terminal", async () => {
    mockArtifactLinks([
      { source: { id: "a", name: "A", status: "DONE" } },
      { source: { id: "b", name: "B", status: "IN_REVIEW" } },
      { source: { id: "c", name: "C", status: "OBSOLETE" } },
      { source: { id: "d", name: "D", status: "DRAFT" } },
    ]);

    const result = await findNonTerminalBlockers("org-1", "doc-1");

    expect(result).toEqual([
      { id: "b", name: "B", status: "IN_REVIEW" },
      { id: "d", name: "D", status: "DRAFT" },
    ]);
  });

  it("ignores links whose source has been deleted (null)", async () => {
    mockArtifactLinks([
      { source: null },
      { source: { id: "b", name: "B", status: "APPROVED" } },
    ]);

    const result = await findNonTerminalBlockers("org-1", "doc-1");

    expect(result).toEqual([{ id: "b", name: "B", status: "APPROVED" }]);
  });

  it("returns an empty list when there are no inbound BLOCKS links", async () => {
    mockArtifactLinks([]);

    expect(await findNonTerminalBlockers("org-1", "doc-1")).toEqual([]);
  });

  it("queries inbound BLOCKS links scoped to the artifact and org", async () => {
    const findMany = mockArtifactLinks([]);

    await findNonTerminalBlockers("org-9", "doc-9");

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-9",
          targetId: "doc-9",
          linkType: "BLOCKS",
        },
      })
    );
  });
});
