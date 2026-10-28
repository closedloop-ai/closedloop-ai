import { IssueStatus } from "@repo/api/src/types/document";
import { describe, expect, it } from "vitest";
import { parseReceiptSnapshot } from "../project-artifact-placement-service-support";

const SOURCE_A = "00000000-0000-4000-8000-000000000001";
const SOURCE_B = "00000000-0000-4000-8000-000000000002";
const PARENT = "00000000-0000-4000-8000-000000000003";
const PROJECT = "00000000-0000-4000-8000-000000000004";

describe("parseReceiptSnapshot", () => {
  it.each([
    {
      label: "missing source",
      movedRootParents: [{ artifactId: SOURCE_A, sourceIds: [] }],
    },
    {
      label: "duplicate source",
      movedRootParents: [
        { artifactId: SOURCE_A, sourceIds: [] },
        { artifactId: SOURCE_A, sourceIds: [] },
      ],
    },
    {
      label: "unknown source",
      movedRootParents: [
        { artifactId: SOURCE_A, sourceIds: [] },
        { artifactId: PARENT, sourceIds: [] },
      ],
    },
    {
      label: "multiple parents",
      movedRootParents: [
        { artifactId: SOURCE_A, sourceIds: [PARENT, PROJECT] },
        { artifactId: SOURCE_B, sourceIds: [] },
      ],
    },
  ])("rejects a current snapshot with $label", ({ movedRootParents }) => {
    expect(
      parseReceiptSnapshot({ version: 2, rankRows: rows(), movedRootParents }, [
        SOURCE_A,
        SOURCE_B,
      ])
    ).toBeNull();
  });

  it("rejects a legacy snapshot without one row for every moved source", () => {
    expect(
      parseReceiptSnapshot(rows().slice(0, 1), [SOURCE_A, SOURCE_B])
    ).toBeNull();
  });

  it("accepts an exact current parent snapshot", () => {
    expect(
      parseReceiptSnapshot(
        {
          version: 2,
          rankRows: rows(),
          movedRootParents: [
            { artifactId: SOURCE_A, sourceIds: [PARENT] },
            { artifactId: SOURCE_B, sourceIds: [] },
          ],
        },
        [SOURCE_A, SOURCE_B]
      )
    ).not.toBeNull();
  });

  it("keeps root field snapshots only when every moved root is represented", () => {
    const snapshot = {
      version: 2,
      rankRows: rows(),
      movedRootParents: [
        { artifactId: SOURCE_A, sourceIds: [PARENT] },
        { artifactId: SOURCE_B, sourceIds: [] },
      ],
      rootFields: [SOURCE_A, SOURCE_B].map((artifactId) => ({
        artifactId,
        status: IssueStatus.Todo,
        assigneeId: null,
        priority: null,
        tagIds: [],
      })),
    };

    expect(
      parseReceiptSnapshot(snapshot, [SOURCE_A, SOURCE_B])?.rootFields
    ).toEqual(snapshot.rootFields);
    expect(
      parseReceiptSnapshot(
        { ...snapshot, rootFields: snapshot.rootFields.slice(0, 1) },
        [SOURCE_A, SOURCE_B]
      )
    ).toBeNull();
  });
});

function rows() {
  return [SOURCE_A, SOURCE_B].map((artifactId, index) => ({
    artifactId,
    projectId: PROJECT,
    parentId: index === 0 ? PARENT : null,
    sortOrder: index * 1024,
  }));
}
