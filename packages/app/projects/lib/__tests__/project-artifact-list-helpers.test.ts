import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import { describe, expect, it } from "vitest";
import {
  asChild,
  makeTreeArtifact,
} from "../../../documents/lib/__tests__/tree-fixtures";
import {
  projectArtifactFilterState,
  projectArtifactHref,
  projectArtifactMatchesCategory,
  projectArtifactParents,
  projectRelatedSessionFilterStatus,
} from "../project-artifact-list-helpers";
import { projectArtifactReadModel } from "../project-artifact-read-model";

describe("project artifact presentation evidence", () => {
  it("keeps external deployments external while prefixing shell routes", () => {
    const orgPath = (path: string) => `/organization${path}`;
    expect(
      projectArtifactHref(
        ArtifactType.Deployment,
        "https://preview.example.com",
        orgPath
      )
    ).toBe("https://preview.example.com");
    expect(
      projectArtifactHref(ArtifactType.Branch, "/branches/branch", orgPath)
    ).toBe("/organization/branches/branch");
    expect(
      projectArtifactHref(ArtifactType.Document, null, orgPath)
    ).toBeUndefined();
  });

  it("selects canonical document subtypes and retains the direct hierarchy parent", () => {
    const parent = {
      ...makeTreeArtifact("parent", ArtifactType.Document),
      subtype: ArtifactSubtype.Prd,
    };
    const child = {
      ...makeTreeArtifact("child", ArtifactType.Document),
      subtype: ArtifactSubtype.Feature,
    };
    const model = projectArtifactReadModel({
      nodes: [
        {
          root: parent,
          children: [asChild(child, parent.id)],
        },
      ],
      externalParents: [],
    });
    expect(projectArtifactMatchesCategory(model, parent.id, "documents")).toBe(
      true
    );
    expect(projectArtifactMatchesCategory(model, child.id, "issues")).toBe(
      true
    );
    expect(projectArtifactMatchesCategory(model, child.id, "documents")).toBe(
      false
    );
    expect(projectArtifactMatchesCategory(model, "missing", "all")).toBe(false);
    expect(projectArtifactParents(model, child.id)).toEqual([parent]);
  });

  it("keeps pending session filters distinct from failed or unavailable evidence", () => {
    const input = {
      loading: false,
      failed: false,
      evidenceUnavailable: false,
      sessionFilterPending: false,
      sessionFilterFailed: false,
    };
    expect(
      projectArtifactFilterState({ ...input, sessionFilterPending: true })
    ).toEqual({
      unavailable: true,
      summaryLoading: true,
      summaryFailed: false,
    });
    expect(
      projectArtifactFilterState({ ...input, evidenceUnavailable: true })
    ).toEqual({
      unavailable: true,
      summaryLoading: false,
      summaryFailed: true,
    });
  });

  it("distinguishes pending, failed, and inactive related-session filters", () => {
    const selectedIds = ["session-a"];
    const base = {
      selectedIds,
      appliedIds: selectedIds,
      isFetching: false,
      isError: false,
    };
    expect(projectRelatedSessionFilterStatus(base)).toEqual({
      pending: false,
      failed: false,
    });
    expect(
      projectRelatedSessionFilterStatus({ ...base, appliedIds: [] })
    ).toEqual({ pending: true, failed: false });
    expect(
      projectRelatedSessionFilterStatus({ ...base, isError: true })
    ).toEqual({ pending: false, failed: true });
    expect(
      projectRelatedSessionFilterStatus({ ...base, selectedIds: [] })
    ).toEqual({ pending: false, failed: false });
  });
});
