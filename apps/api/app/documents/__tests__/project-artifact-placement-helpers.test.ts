import { LinkType } from "@repo/api/src/types/artifact";
import type { PlaceProjectArtifactsRequest } from "@repo/api/src/types/project-artifact-placement";
import {
  ProjectArtifactPlacementErrorReason,
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import { describe, expect, it } from "vitest";
import {
  collectSubtrees,
  compareArtifactRows,
  computeProjectVersion,
  fitsDepthLimit,
  hashPlacementRequest,
  normalizeSourceRoots,
  resolveDestinationParentId,
  staleVersionDetail,
} from "@/app/documents/project-artifact-placement-helpers";

const PROJECT_ID = "00000000-0000-4000-8000-000000000010";

describe("project artifact placement helpers", () => {
  it("AC-007 produces one deterministic version for equivalent hierarchy state", () => {
    const createdAt = new Date("2026-10-19T12:00:00.000Z");
    const artifacts = [
      { id: "b", projectId: PROJECT_ID, sortOrder: 1024, createdAt },
      { id: "a", projectId: PROJECT_ID, sortOrder: 0, createdAt },
    ];
    const parents = new Map([
      ["b", { parentId: "a", linkType: LinkType.Produces }],
    ]);

    expect(computeProjectVersion(artifacts, parents)).toBe(
      computeProjectVersion([...artifacts].reverse(), parents)
    );
    expect(computeProjectVersion(artifacts, new Map())).not.toBe(
      computeProjectVersion(artifacts, parents)
    );
  });

  it("AC-009 canonicalizes version-map order in idempotency fingerprints", () => {
    const base: Omit<PlaceProjectArtifactsRequest, "expectedProjectVersions"> =
      {
        kind: ProjectArtifactPlacementKind.Place,
        sourceArtifactIds: ["00000000-0000-4000-8000-000000000001"],
        destinationProjectId: PROJECT_ID,
        position: ProjectArtifactPlacementPosition.Root,
        idempotencyKey: "same-key",
        source: ProjectArtifactPlacementSource.Api,
      };
    expect(
      hashPlacementRequest("00000000-0000-4000-8000-000000000001", {
        ...base,
        expectedProjectVersions: { b: "2", a: "1" },
      })
    ).toBe(
      hashPlacementRequest("00000000-0000-4000-8000-000000000001", {
        ...base,
        expectedProjectVersions: { a: "1", b: "2" },
      })
    );
  });

  it("AC-008 normalizes ancestor selections and preserves subtree order", () => {
    const parents = new Map([
      ["child", { parentId: "root", linkType: LinkType.Produces }],
      ["leaf", { parentId: "child", linkType: LinkType.Produces }],
    ]);
    const children = new Map([
      ["root", ["child"]],
      ["child", ["leaf"]],
    ]);
    expect(normalizeSourceRoots(["child", "root"], parents)).toEqual(["root"]);
    expect(collectSubtrees(["root"], children)).toEqual([
      "root",
      "child",
      "leaf",
    ]);
  });

  it("AC-008 rejects a move whose subtree would exceed four levels", () => {
    const parents = new Map([
      ["destination", { parentId: "ancestor", linkType: LinkType.Produces }],
    ]);
    const children = new Map([
      ["source", ["child"]],
      ["child", ["leaf"]],
    ]);
    expect(
      fitsDepthLimit(["source"], "destination", {
        canonicalParents: parents,
        childrenByParent: children,
      })
    ).toBe(false);
    expect(
      fitsDepthLimit(["source"], null, {
        canonicalParents: parents,
        childrenByParent: children,
      })
    ).toBe(true);
  });

  it("AC-002 resolves before, inside, and root parent intent without indices", () => {
    const parents = new Map([
      ["target", { parentId: "parent", linkType: LinkType.Produces }],
    ]);
    const base: Omit<
      PlaceProjectArtifactsRequest,
      "position" | "targetArtifactId"
    > = {
      kind: ProjectArtifactPlacementKind.Place,
      sourceArtifactIds: ["source"],
      destinationProjectId: PROJECT_ID,
      expectedProjectVersions: { [PROJECT_ID]: "v1" },
      idempotencyKey: "key",
      source: ProjectArtifactPlacementSource.Api,
    };
    expect(
      resolveDestinationParentId(
        {
          ...base,
          position: ProjectArtifactPlacementPosition.Before,
          targetArtifactId: "target",
        },
        parents
      )
    ).toBe("parent");
    expect(
      resolveDestinationParentId(
        {
          ...base,
          position: ProjectArtifactPlacementPosition.Inside,
          targetArtifactId: "target",
        },
        parents
      )
    ).toBe("target");
    expect(
      resolveDestinationParentId(
        { ...base, position: ProjectArtifactPlacementPosition.Root },
        parents
      )
    ).toBeNull();
  });

  it("AC-007 shares the canonical null-rank total order", () => {
    const earlier = new Date("2026-10-18T12:00:00.000Z");
    const later = new Date("2026-10-19T12:00:00.000Z");
    expect(
      [
        {
          id: "unranked",
          projectId: PROJECT_ID,
          sortOrder: null,
          createdAt: later,
        },
        {
          id: "ranked",
          projectId: PROJECT_ID,
          sortOrder: 0,
          createdAt: earlier,
        },
      ]
        .sort(compareArtifactRows)
        .map(({ id }) => id)
    ).toEqual(["ranked", "unranked"]);
  });

  it("AC-009 reports every actual version on a stale precondition", () => {
    expect(
      staleVersionDetail(
        ["a", "b"],
        { a: "old", b: "same" },
        { a: "new", b: "same" }
      )
    ).toEqual({
      reason: ProjectArtifactPlacementErrorReason.StaleVersion,
      actualProjectVersions: { a: "new", b: "same" },
    });
    expect(staleVersionDetail(["a"], { a: "new" }, { a: "new" })).toBeNull();
  });
});
