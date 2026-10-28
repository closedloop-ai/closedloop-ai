import { describe, expect, it } from "vitest";
import { ArtifactKind, ArtifactStatus } from "../../fixtures";
import {
  type ArtifactCreationValues,
  buildCreatedArtifact,
  defaultArtifactCreationConfig,
} from "../artifact-creation";

const baseValues: ArtifactCreationValues = {
  attachments: [],
  collaborators: [],
  customValues: {},
  linkedArtifacts: [],
  owner: "Ottilie Eastwick",
  project: null,
  repository: null,
  status: ArtifactStatus.Approved,
  summary: "",
  tags: [],
  title: "Created artifact",
};

describe("buildCreatedArtifact status validity", () => {
  it("revalidates status after the generic creator changes kind", () => {
    const artifact = buildCreatedArtifact({
      config: defaultArtifactCreationConfig,
      nextNumber: 7,
      values: {
        ...baseValues,
        customValues: { "artifact-type": ArtifactKind.Prototype },
      },
    });

    expect(artifact.kind).toBe(ArtifactKind.Prototype);
    expect(artifact.status).toBe(ArtifactStatus.Todo);
  });

  it("preserves a status that is valid for the resolved kind", () => {
    const artifact = buildCreatedArtifact({
      config: defaultArtifactCreationConfig,
      nextNumber: 8,
      values: {
        ...baseValues,
        customValues: { "artifact-type": ArtifactKind.Document },
      },
    });

    expect(artifact.kind).toBe(ArtifactKind.Document);
    expect(artifact.status).toBe(ArtifactStatus.Approved);
  });
});
