import { ArtifactType } from "@repo/api/src/types/artifact";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTreeArtifact } from "../../../documents/lib/__tests__/tree-fixtures";
import { projectArtifactReadModel } from "../../lib/project-artifact-read-model";
import { useProjectArtifactListMetadata } from "../use-project-artifact-list-metadata";

const reads = vi.hoisted(() => ({ people: vi.fn(), sessions: vi.fn() }));
vi.mock("../../../shared/hooks/use-artifact-collaborators", () => ({
  useArtifactCollaborators: reads.people,
}));
vi.mock("../../../documents/hooks/use-related-sessions", () => ({
  useRelatedSessionsPage: reads.sessions,
}));

const document = makeTreeArtifact("document", ArtifactType.Document);
const branch = makeTreeArtifact("branch", ArtifactType.Branch);
const session = makeTreeArtifact("session", ArtifactType.Session);
const deployment = makeTreeArtifact("deployment", ArtifactType.Deployment);
const hidden = makeTreeArtifact("hidden", ArtifactType.Document);
const model = projectArtifactReadModel({
  nodes: [document, branch, session, deployment, hidden].map((root) => ({
    root,
    children: [],
  })),
  externalParents: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  reads.people.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  });
  reads.sessions.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  });
});

describe("useProjectArtifactListMetadata", () => {
  it("reads the visible cohort separately for each canonical artifact type", () => {
    renderHook(() =>
      useProjectArtifactListMetadata({
        model,
        visibleArtifactIds: [
          document.id,
          branch.id,
          session.id,
          deployment.id,
          branch.id,
          "unknown",
        ],
        includePeople: true,
        includeRelatedSessions: true,
      })
    );
    for (const artifact of [document, branch, session, deployment]) {
      expect(reads.people).toHaveBeenCalledWith({
        artifactType: artifact.type,
        artifactIds: [artifact.id],
        enabled: true,
      });
    }
    expect(reads.sessions).toHaveBeenCalledWith(
      [document.id, branch.id, deployment.id],
      true
    );
  });

  it("defers metadata while its columns are hidden and preserves missing evidence", () => {
    const { result } = renderHook(() =>
      useProjectArtifactListMetadata({
        model,
        visibleArtifactIds: [document.id],
        includePeople: false,
        includeRelatedSessions: false,
      })
    );
    expect(
      reads.people.mock.calls.every(([options]) => options.enabled === false)
    ).toBe(true);
    expect(reads.sessions).toHaveBeenCalledWith([document.id], false);
    expect(result.current.peopleByArtifactId.has(document.id)).toBe(false);
    expect(result.current.relatedSessions.data).toBeUndefined();
  });

  it("keeps canonical per-kind loading and failure states independently available", () => {
    const documentRead = { data: undefined, isLoading: false, isError: true };
    reads.people.mockImplementation(({ artifactType }) =>
      artifactType === ArtifactType.Document
        ? documentRead
        : { data: undefined, isLoading: true, isError: false }
    );
    const { result } = renderHook(() =>
      useProjectArtifactListMetadata({
        model,
        visibleArtifactIds: [document.id, session.id],
        includePeople: true,
        includeRelatedSessions: false,
      })
    );
    expect(result.current.peopleReads.documents).toBe(documentRead);
    expect(result.current.peopleReads.sessions.isLoading).toBe(true);
  });
});
