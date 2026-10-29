import { describe, expect, it } from "vitest";
import {
  ArtifactBoardDropPosition,
  type ArtifactBoardItem,
  ArtifactBoardSelectionIntent,
  artifactBoardMoveRootIds,
  artifactBoardRoots,
  artifactBoardSelectionFromIntent,
  normalizeArtifactBoardSelectedRoots,
  visibleArtifactBoardFields,
} from "./artifact-board-model";

const items: ArtifactBoardItem[] = [
  {
    fieldValues: { owner: "Ada", priority: "HIGH", status: "Todo" },
    id: "root-a",
    laneId: "todo",
    parentId: null,
    rootId: "root-a",
    slug: "ISS-1",
    title: "Root A",
    typeLabel: "Issue",
  },
  {
    fieldValues: { owner: "Grace", priority: "LOW", status: "Done" },
    id: "child-a",
    laneId: "done",
    parentId: "root-a",
    rootId: "root-a",
    slug: "ISS-2",
    title: "Child A",
    typeLabel: "Issue",
  },
  {
    fieldValues: { owner: "Linus", priority: "MEDIUM", status: "Todo" },
    id: "root-b",
    laneId: "todo",
    parentId: null,
    rootId: "root-b",
    slug: "PRD-1",
    title: "Root B",
    typeLabel: "PRD",
  },
];

describe("PRD-724 AC-001/AC-002 Artifact Board model", () => {
  it("renders logical roots while descendants remain attached to their root", () => {
    expect(artifactBoardRoots(items).map((item) => item.id)).toEqual([
      "root-a",
      "root-b",
    ]);
    expect(items.find((item) => item.id === "child-a")?.rootId).toBe("root-a");
  });

  it("normalizes a selected ancestor and descendant into one ordered root", () => {
    expect(
      normalizeArtifactBoardSelectedRoots(
        items,
        new Set(["root-a", "child-a", "root-b"])
      )
    ).toEqual(["root-a", "root-b"]);
    expect(
      artifactBoardMoveRootIds(
        items,
        "root-a",
        new Set(["root-a", "child-a", "root-b"])
      )
    ).toEqual(["root-a", "root-b"]);
  });

  it("moves only the active root when it is outside the selected set", () => {
    expect(
      artifactBoardMoveRootIds(items, "root-b", new Set(["root-a"]))
    ).toEqual(["root-b"]);
  });

  it("CT-15 keeps replace, toggle, and range selection in one shared reducer", () => {
    const anchor = { current: null as string | null };
    const roots = ["root-a", "root-b", "root-c"];
    expect(
      artifactBoardSelectionFromIntent(
        [],
        roots,
        "root-a",
        ArtifactBoardSelectionIntent.Replace,
        anchor
      )
    ).toEqual(["root-a"]);
    expect(
      artifactBoardSelectionFromIntent(
        ["root-a"],
        roots,
        "root-c",
        ArtifactBoardSelectionIntent.Toggle,
        anchor
      )
    ).toEqual(["root-a", "root-c"]);
    expect(
      artifactBoardSelectionFromIntent(
        [],
        roots,
        "root-a",
        ArtifactBoardSelectionIntent.Range,
        anchor
      )
    ).toEqual(["root-a", "root-b", "root-c"]);
  });

  it("PRD-718 AC4 falls back to a plain click when the range anchor is no longer painted", () => {
    const anchor = { current: "root-hidden" as string | null };
    const roots = ["root-a", "root-b", "root-c"];
    expect(
      artifactBoardSelectionFromIntent(
        ["root-hidden"],
        roots,
        "root-b",
        ArtifactBoardSelectionIntent.Range,
        anchor
      )
    ).toEqual(["root-b"]);
    expect(anchor.current).toBe("root-b");
  });
});

describe("PRD-724 AC-001/AC-004 grouped field omission", () => {
  it("omits both primary and secondary grouped fields from configured fields", () => {
    expect(
      visibleArtifactBoardFields(
        [
          { id: "status", label: "Status", tier: "primary" },
          { id: "owner", label: "Owner", tier: "primary" },
          { id: "priority", label: "Priority", tier: "secondary" },
        ],
        new Set(["status", "owner", "priority"]),
        "status",
        "owner"
      ).map((field) => field.id)
    ).toEqual(["priority"]);
  });

  it("keeps the canonical exact-position vocabulary closed", () => {
    expect(Object.values(ArtifactBoardDropPosition)).toEqual([
      ArtifactBoardDropPosition.After,
      ArtifactBoardDropPosition.Before,
      ArtifactBoardDropPosition.End,
    ]);
  });
});
