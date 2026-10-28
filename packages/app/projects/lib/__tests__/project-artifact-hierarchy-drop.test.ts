import { ProjectArtifactPlacementSource } from "@repo/api/src/types/project-artifact-placement";
import {
  buildArtifactHierarchyForest,
  expansionAfterArtifactHierarchyMove,
  flattenVisibleArtifactHierarchy,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-hierarchy";
import {
  type GenericArtifact,
  genericArtifacts,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { describe, expect, it, vi } from "vitest";
import { submitProjectArtifactHierarchyDrop } from "../project-artifact-hierarchy-drop";

describe("project artifact hierarchy drop", () => {
  it("opens a former leaf after a successful inside drop so the moved row stays visible", async () => {
    const source = genericArtifacts[0];
    const target = genericArtifacts[1];
    if (!(source && target)) {
      throw new Error("Expected artifact fixtures");
    }
    const rows = [source, target];
    let expanded = new Set<string>();
    const hierarchyView = {
      isExpanded: (id: string) => expanded.has(id),
      syncExpansionAfterMove: (
        nextRows: readonly GenericArtifact[],
        insideTargetId?: string
      ) => {
        expanded = expansionAfterArtifactHierarchyMove(
          nextRows,
          expanded,
          insideTargetId
        );
      },
      toggleExpanded: (id: string) => {
        expanded = new Set(expanded);
        if (expanded.has(id)) {
          expanded.delete(id);
        } else {
          expanded.add(id);
        }
      },
    };
    const controller = {
      groupBy: "none",
      secondaryGroupBy: "none",
      groupedArtifacts: undefined,
      hierarchyView,
    } satisfies Parameters<
      typeof submitProjectArtifactHierarchyDrop
    >[0]["controller"];
    const submitMove = vi.fn().mockResolvedValue({ placed: true });

    submitProjectArtifactHierarchyDrop({
      row: source,
      target,
      placement: "inside",
      controller,
      rows,
      sourceIds: [source.id],
      submitMove,
    });

    await vi.waitFor(() =>
      expect(hierarchyView.isExpanded(target.id)).toBe(true)
    );
    expect(submitMove).toHaveBeenCalledWith({
      artifactIds: [source.id],
      placement: "inside",
      targetArtifactId: target.id,
      source: ProjectArtifactPlacementSource.Pointer,
    });
    const postMoveRows = [{ ...source, parentArtifactId: target.id }, target];
    expect(
      flattenVisibleArtifactHierarchy(
        buildArtifactHierarchyForest(postMoveRows),
        expanded,
        4
      ).map((row) => row.artifact.id)
    ).toContain(source.id);
  });
});
