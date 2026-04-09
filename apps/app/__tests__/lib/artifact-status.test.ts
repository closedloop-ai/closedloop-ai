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
  it("contains ReadyForReview with value READY_FOR_REVIEW", () => {
    expect(ArtifactStatus.ReadyForReview).toBe("READY_FOR_REVIEW");
  });

  it("contains Executed with value EXECUTED", () => {
    expect(ArtifactStatus.Executed).toBe("EXECUTED");
  });
});

// ---------------------------------------------------------------------------
// artifactStatusLabels (status-badge.tsx)
// ---------------------------------------------------------------------------

describe("artifactStatusLabels", () => {
  it("maps ReadyForReview to 'Ready for Review'", () => {
    expect(artifactStatusLabels[ArtifactStatus.ReadyForReview]).toBe(
      "Ready for Review"
    );
  });

  it("maps Executed to 'Executed'", () => {
    expect(artifactStatusLabels[ArtifactStatus.Executed]).toBe("Executed");
  });
});

// ---------------------------------------------------------------------------
// artifactStatusColors (status-badge.tsx)
// ---------------------------------------------------------------------------

describe("artifactStatusColors", () => {
  it("has a non-empty color entry for ReadyForReview", () => {
    expect(artifactStatusColors[ArtifactStatus.ReadyForReview]).toBeTruthy();
  });

  it("has a non-empty color entry for Executed", () => {
    expect(artifactStatusColors[ArtifactStatus.Executed]).toBeTruthy();
  });

  it("assigns yellow color classes to ReadyForReview", () => {
    expect(artifactStatusColors[ArtifactStatus.ReadyForReview]).toContain(
      "yellow"
    );
  });

  it("assigns blue color classes to Executed", () => {
    expect(artifactStatusColors[ArtifactStatus.Executed]).toContain("blue");
  });
});

// ---------------------------------------------------------------------------
// ARTIFACT_STATUS_LABELS (project-constants.ts)
// ---------------------------------------------------------------------------

describe("ARTIFACT_STATUS_LABELS", () => {
  it("maps ReadyForReview to 'Ready for Review'", () => {
    expect(ARTIFACT_STATUS_LABELS[ArtifactStatus.ReadyForReview]).toBe(
      "Ready for Review"
    );
  });

  it("maps Executed to 'Executed'", () => {
    expect(ARTIFACT_STATUS_LABELS[ArtifactStatus.Executed]).toBe("Executed");
  });
});

// ---------------------------------------------------------------------------
// ARTIFACT_STATUS_COLORS (project-constants.ts)
// ---------------------------------------------------------------------------

describe("ARTIFACT_STATUS_COLORS", () => {
  it("has a non-empty color entry for ReadyForReview", () => {
    expect(ARTIFACT_STATUS_COLORS[ArtifactStatus.ReadyForReview]).toBeTruthy();
  });

  it("has a non-empty color entry for Executed", () => {
    expect(ARTIFACT_STATUS_COLORS[ArtifactStatus.Executed]).toBeTruthy();
  });

  it("assigns yellow color class to ReadyForReview", () => {
    expect(ARTIFACT_STATUS_COLORS[ArtifactStatus.ReadyForReview]).toContain(
      "yellow"
    );
  });

  it("assigns blue color class to Executed", () => {
    expect(ARTIFACT_STATUS_COLORS[ArtifactStatus.Executed]).toContain("blue");
  });
});

// ---------------------------------------------------------------------------
// mapArtifactStatusToType (engineer.ts)
// ---------------------------------------------------------------------------

describe("mapArtifactStatusToType", () => {
  it("returns 'started' for ReadyForReview", () => {
    expect(mapArtifactStatusToType(ArtifactStatus.ReadyForReview)).toBe(
      "started"
    );
  });

  it("returns 'completed' for Executed", () => {
    expect(mapArtifactStatusToType(ArtifactStatus.Executed)).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// artifactStatusDisplayName (engineer.ts)
// ---------------------------------------------------------------------------

describe("artifactStatusDisplayName", () => {
  it("returns 'Ready for Review' for ReadyForReview", () => {
    expect(artifactStatusDisplayName(ArtifactStatus.ReadyForReview)).toBe(
      "Ready for Review"
    );
  });

  it("returns 'Executed' for Executed", () => {
    expect(artifactStatusDisplayName(ArtifactStatus.Executed)).toBe("Executed");
  });
});
