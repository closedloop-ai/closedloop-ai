// ISS-9713 branch coverage for the null-handling in toGitDiffStats /
// toBranchDiffStats, the Loop-origin branch of toAgentSessionOrigin, and the
// sourceArtifact document-type projection (toSourceArtifactSummary /
// toSourceArtifactDocumentType). Kept in its own sibling so
// projections.test.ts stays under the size ceiling; this file owns the
// diff-stats-null-handling and source-artifact-type fixture shapes.

import { AgentSessionOrigin } from "@repo/api/src/types/agent-session";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionListRecord,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

async function projectSessions(overridesList: Record<string, unknown>[]) {
  installDb({
    sessionDetail: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          overridesList.map((overrides) => buildSessionListRecord(overrides))
        ),
      count: vi.fn().mockResolvedValue(overridesList.length),
    },
  });
  return await agentSessionsService.findSessions({
    organizationId: "org-1",
    filters: {},
  });
}

async function projectFirstSession(overrides: Record<string, unknown>) {
  const result = await projectSessions([overrides]);
  return result.items[0];
}

describe("toGitDiffStats null handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports null when every line/file scalar is null despite a recognized loc source", async () => {
    const item = await projectFirstSession({
      locSource: "branch_fallback",
      linesAdded: null,
      linesRemoved: null,
      filesChanged: null,
    });

    expect(item?.gitDiffStats).toBeNull();
  });

  it("defaults a null linesAdded to 0 while preserving the other real scalars", async () => {
    const item = await projectFirstSession({
      locSource: "branch_fallback",
      linesAdded: null,
      linesRemoved: 7,
      filesChanged: 2,
    });

    expect(item?.gitDiffStats).toEqual({
      linesAdded: 0,
      linesRemoved: 7,
      filesChanged: 2,
      source: "branch_fallback",
    });
  });

  it("defaults a null linesRemoved to 0 while preserving the other real scalars", async () => {
    const item = await projectFirstSession({
      locSource: "branch_fallback",
      linesAdded: 5,
      linesRemoved: null,
      filesChanged: 2,
    });

    expect(item?.gitDiffStats).toEqual({
      linesAdded: 5,
      linesRemoved: 0,
      filesChanged: 2,
      source: "branch_fallback",
    });
  });

  it("defaults a null filesChanged to 0 while preserving the other real scalars", async () => {
    const item = await projectFirstSession({
      locSource: "branch_fallback",
      linesAdded: 5,
      linesRemoved: 7,
      filesChanged: null,
    });

    expect(item?.gitDiffStats).toEqual({
      linesAdded: 5,
      linesRemoved: 7,
      filesChanged: 0,
      source: "branch_fallback",
    });
  });
});

describe("toBranchDiffStats null handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports null when every branch line/file scalar is null despite a recorded branch loc source", async () => {
    const item = await projectFirstSession({
      branchLocSource: "git",
      branchLinesAdded: null,
      branchLinesRemoved: null,
      branchFilesChanged: null,
    });

    expect(item?.branchDiffStats).toBeNull();
  });

  it("defaults a null branchLinesAdded to 0 while preserving the other real scalars", async () => {
    const item = await projectFirstSession({
      branchLocSource: "git",
      branchLinesAdded: null,
      branchLinesRemoved: 9,
      branchFilesChanged: 3,
    });

    expect(item?.branchDiffStats).toEqual({
      linesAdded: 0,
      linesRemoved: 9,
      filesChanged: 3,
      source: "git",
    });
  });

  it("defaults a null branchLinesRemoved to 0 while preserving the other real scalars", async () => {
    const item = await projectFirstSession({
      branchLocSource: "git",
      branchLinesAdded: 9,
      branchLinesRemoved: null,
      branchFilesChanged: 3,
    });

    expect(item?.branchDiffStats).toEqual({
      linesAdded: 9,
      linesRemoved: 0,
      filesChanged: 3,
      source: "git",
    });
  });

  it("defaults a null branchFilesChanged to 0 while preserving the other real scalars", async () => {
    const item = await projectFirstSession({
      branchLocSource: "git",
      branchLinesAdded: 9,
      branchLinesRemoved: 3,
      branchFilesChanged: null,
    });

    expect(item?.branchDiffStats).toEqual({
      linesAdded: 9,
      linesRemoved: 3,
      filesChanged: 0,
      source: "git",
    });
  });
});

describe("toAgentSessionOrigin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps a Loop-originated session to the Loop origin", async () => {
    const item = await projectFirstSession({ origin: AgentSessionOrigin.Loop });

    expect(item?.origin).toBe(AgentSessionOrigin.Loop);
  });
});

describe("source-artifact document-type projection", () => {
  const SOURCE_ARTIFACT_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function projectWithSourceArtifact(sourceArtifact: {
    type: string;
    subtype: string | null;
  }) {
    installDb({
      sessionDetail: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            buildSessionListRecord({ sourceArtifactId: SOURCE_ARTIFACT_ID }),
          ]),
        count: vi.fn().mockResolvedValue(1),
      },
      artifact: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: SOURCE_ARTIFACT_ID,
            name: "Source Artifact",
            slug: "SRC-1",
            ...sourceArtifact,
          },
        ]),
      },
    });
    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });
    return result.items[0];
  }

  it("reports a null documentType when the source artifact is not a Document", async () => {
    const item = await projectWithSourceArtifact({
      type: ArtifactType.Branch,
      subtype: null,
    });

    expect(item?.sourceArtifact).toEqual({
      id: SOURCE_ARTIFACT_ID,
      name: "Source Artifact",
      slug: "SRC-1",
      documentType: null,
    });
  });

  it("maps the ImplementationPlan document subtype", async () => {
    const item = await projectWithSourceArtifact({
      type: ArtifactType.Document,
      subtype: DocumentType.ImplementationPlan,
    });

    expect(item?.sourceArtifact?.documentType).toBe(
      DocumentType.ImplementationPlan
    );
  });

  it("maps the Template document subtype", async () => {
    const item = await projectWithSourceArtifact({
      type: ArtifactType.Document,
      subtype: DocumentType.Template,
    });

    expect(item?.sourceArtifact?.documentType).toBe(DocumentType.Template);
  });

  it("reports a null documentType for an unrecognized document subtype", async () => {
    const item = await projectWithSourceArtifact({
      type: ArtifactType.Document,
      subtype: "not-a-real-subtype",
    });

    expect(item?.sourceArtifact?.documentType).toBeNull();
  });
});
