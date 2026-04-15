import { ArtifactStatus } from "@repo/api/src/types/artifact";
import { describe, expect, it } from "vitest";
import {
  artifactStatusColors,
  artifactStatusLabels,
} from "@/components/status-badge";
import {
  ARTIFACT_STATUS_COLORS,
  ARTIFACT_STATUS_LABELS,
} from "@/lib/project-constants";
import {
  artifactStatusDisplayName,
  mapArtifactStatusToType,
} from "@/types/engineer";

// ---------------------------------------------------------------------------
// ArtifactStatus enum values
// ---------------------------------------------------------------------------

describe("ArtifactStatus", () => {
  it("contains Done with value DONE", () => {
    expect(ArtifactStatus.Done).toBe("DONE");
  });

  it("contains Executed with value EXECUTED", () => {
    expect(ArtifactStatus.Executed).toBe("EXECUTED");
  });
});

// ---------------------------------------------------------------------------
// artifactStatusLabels (status-badge.tsx)
// ---------------------------------------------------------------------------

describe("artifactStatusLabels", () => {
  it("maps Done to 'Done'", () => {
    expect(artifactStatusLabels[ArtifactStatus.Done]).toBe("Done");
  });

  it("maps Executed to 'Executed'", () => {
    expect(artifactStatusLabels[ArtifactStatus.Executed]).toBe("Executed");
  });
});

// ---------------------------------------------------------------------------
// artifactStatusColors (status-badge.tsx)
// ---------------------------------------------------------------------------

describe("artifactStatusColors", () => {
  it("has a non-empty color entry for Done", () => {
    expect(artifactStatusColors[ArtifactStatus.Done]).toBeTruthy();
  });

  it("has a non-empty color entry for Executed", () => {
    expect(artifactStatusColors[ArtifactStatus.Executed]).toBeTruthy();
  });

  it("assigns success token classes to Done", () => {
    expect(artifactStatusColors[ArtifactStatus.Done]).toContain("success");
  });

  it("assigns info token classes to Executed", () => {
    expect(artifactStatusColors[ArtifactStatus.Executed]).toContain("info");
  });
});

// ---------------------------------------------------------------------------
// ARTIFACT_STATUS_LABELS (project-constants.ts)
// ---------------------------------------------------------------------------

describe("ARTIFACT_STATUS_LABELS", () => {
  it("maps Done to 'Done'", () => {
    expect(ARTIFACT_STATUS_LABELS[ArtifactStatus.Done]).toBe("Done");
  });

  it("maps Executed to 'Executed'", () => {
    expect(ARTIFACT_STATUS_LABELS[ArtifactStatus.Executed]).toBe("Executed");
  });
});

// ---------------------------------------------------------------------------
// ARTIFACT_STATUS_COLORS (project-constants.ts)
// ---------------------------------------------------------------------------

describe("ARTIFACT_STATUS_COLORS", () => {
  it("has a non-empty color entry for Done", () => {
    expect(ARTIFACT_STATUS_COLORS[ArtifactStatus.Done]).toBeTruthy();
  });

  it("has a non-empty color entry for Executed", () => {
    expect(ARTIFACT_STATUS_COLORS[ArtifactStatus.Executed]).toBeTruthy();
  });

  it("assigns green color class to Done", () => {
    expect(ARTIFACT_STATUS_COLORS[ArtifactStatus.Done]).toContain("green");
  });

  it("assigns blue color class to Executed", () => {
    expect(ARTIFACT_STATUS_COLORS[ArtifactStatus.Executed]).toContain("blue");
  });
});

// ---------------------------------------------------------------------------
// mapArtifactStatusToType (engineer.ts)
// ---------------------------------------------------------------------------

describe("mapArtifactStatusToType", () => {
  it("returns 'started' for InReview", () => {
    expect(mapArtifactStatusToType(ArtifactStatus.InReview)).toBe("started");
  });

  it("returns 'completed' for Done", () => {
    expect(mapArtifactStatusToType(ArtifactStatus.Done)).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// artifactStatusDisplayName (engineer.ts)
// ---------------------------------------------------------------------------

describe("artifactStatusDisplayName", () => {
  it("returns 'In Review' for InReview", () => {
    expect(artifactStatusDisplayName(ArtifactStatus.InReview)).toBe(
      "In Review"
    );
  });

  it("returns 'Executed' for Executed", () => {
    expect(artifactStatusDisplayName(ArtifactStatus.Executed)).toBe("Executed");
  });
});
