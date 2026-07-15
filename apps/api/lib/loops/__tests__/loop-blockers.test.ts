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
  it("applies the per-subtype terminal set: terminal Document and Feature blockers are excluded (PRD-495)", async () => {
    mockArtifactLinks([
      // Feature DONE is terminal (feature set) -> excluded.
      { source: { id: "a", name: "A", status: "DONE", subtype: "FEATURE" } },
      // Feature IN_REVIEW is non-terminal -> included.
      {
        source: { id: "b", name: "B", status: "IN_REVIEW", subtype: "FEATURE" },
      },
      // Document OBSOLETE is terminal (document set) -> excluded.
      { source: { id: "c", name: "C", status: "OBSOLETE", subtype: "PRD" } },
      // Document DRAFT is non-terminal -> included.
      { source: { id: "d", name: "D", status: "DRAFT", subtype: "PRD" } },
      // Document APPROVED is now terminal (absorbs old DONE) -> excluded.
      {
        source: {
          id: "e",
          name: "E",
          status: "APPROVED",
          subtype: "IMPLEMENTATION_PLAN",
        },
      },
      // Feature BLOCKED is non-terminal -> included.
      {
        source: { id: "f", name: "F", status: "BLOCKED", subtype: "FEATURE" },
      },
    ]);

    const result = await findNonTerminalBlockers("org-1", "doc-1");

    expect(result).toEqual([
      { id: "b", name: "B", status: "IN_REVIEW" },
      { id: "d", name: "D", status: "DRAFT" },
      { id: "f", name: "F", status: "BLOCKED" },
    ]);
  });

  it("ignores links whose source has been deleted (null)", async () => {
    mockArtifactLinks([
      { source: null },
      {
        source: {
          id: "b",
          name: "B",
          status: "IN_PROGRESS",
          subtype: "FEATURE",
        },
      },
    ]);

    const result = await findNonTerminalBlockers("org-1", "doc-1");

    expect(result).toEqual([{ id: "b", name: "B", status: "IN_PROGRESS" }]);
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
