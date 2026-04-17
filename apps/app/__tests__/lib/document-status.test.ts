import { DocumentStatus } from "@repo/api/src/types/document";
import { describe, expect, it } from "vitest";
import {
  artifactStatusColors,
  artifactStatusLabels,
} from "@/components/status-badge";
import {
  DOCUMENT_STATUS_COLORS,
  DOCUMENT_STATUS_LABELS,
} from "@/lib/project-constants";
import {
  artifactStatusDisplayName,
  mapDocumentStatusToType,
} from "@/types/engineer";

// ---------------------------------------------------------------------------
// DocumentStatus enum values
// ---------------------------------------------------------------------------

describe("DocumentStatus", () => {
  it("contains Done with value DONE", () => {
    expect(DocumentStatus.Done).toBe("DONE");
  });

  it("contains Executed with value EXECUTED", () => {
    expect(DocumentStatus.Executed).toBe("EXECUTED");
  });
});

// ---------------------------------------------------------------------------
// artifactStatusLabels (status-badge.tsx)
// ---------------------------------------------------------------------------

describe("artifactStatusLabels", () => {
  it("maps Done to 'Done'", () => {
    expect(artifactStatusLabels[DocumentStatus.Done]).toBe("Done");
  });

  it("maps Executed to 'Executed'", () => {
    expect(artifactStatusLabels[DocumentStatus.Executed]).toBe("Executed");
  });
});

// ---------------------------------------------------------------------------
// artifactStatusColors (status-badge.tsx)
// ---------------------------------------------------------------------------

describe("artifactStatusColors", () => {
  it("has a non-empty color entry for Done", () => {
    expect(artifactStatusColors[DocumentStatus.Done]).toBeTruthy();
  });

  it("has a non-empty color entry for Executed", () => {
    expect(artifactStatusColors[DocumentStatus.Executed]).toBeTruthy();
  });

  it("assigns success token classes to Done", () => {
    expect(artifactStatusColors[DocumentStatus.Done]).toContain("success");
  });

  it("assigns info token classes to Executed", () => {
    expect(artifactStatusColors[DocumentStatus.Executed]).toContain("info");
  });
});

// ---------------------------------------------------------------------------
// DOCUMENT_STATUS_LABELS (project-constants.ts)
// ---------------------------------------------------------------------------

describe("DOCUMENT_STATUS_LABELS", () => {
  it("maps Done to 'Done'", () => {
    expect(DOCUMENT_STATUS_LABELS[DocumentStatus.Done]).toBe("Done");
  });

  it("maps Executed to 'Executed'", () => {
    expect(DOCUMENT_STATUS_LABELS[DocumentStatus.Executed]).toBe("Executed");
  });
});

// ---------------------------------------------------------------------------
// DOCUMENT_STATUS_COLORS (project-constants.ts)
// ---------------------------------------------------------------------------

describe("DOCUMENT_STATUS_COLORS", () => {
  it("has a non-empty color entry for Done", () => {
    expect(DOCUMENT_STATUS_COLORS[DocumentStatus.Done]).toBeTruthy();
  });

  it("has a non-empty color entry for Executed", () => {
    expect(DOCUMENT_STATUS_COLORS[DocumentStatus.Executed]).toBeTruthy();
  });

  it("assigns green color class to Done", () => {
    expect(DOCUMENT_STATUS_COLORS[DocumentStatus.Done]).toContain("green");
  });

  it("assigns blue color class to Executed", () => {
    expect(DOCUMENT_STATUS_COLORS[DocumentStatus.Executed]).toContain("blue");
  });
});

// ---------------------------------------------------------------------------
// mapDocumentStatusToType (engineer.ts)
// ---------------------------------------------------------------------------

describe("mapDocumentStatusToType", () => {
  it("returns 'started' for InReview", () => {
    expect(mapDocumentStatusToType(DocumentStatus.InReview)).toBe("started");
  });

  it("returns 'completed' for Done", () => {
    expect(mapDocumentStatusToType(DocumentStatus.Done)).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// artifactStatusDisplayName (engineer.ts)
// ---------------------------------------------------------------------------

describe("artifactStatusDisplayName", () => {
  it("returns 'In Review' for InReview", () => {
    expect(artifactStatusDisplayName(DocumentStatus.InReview)).toBe(
      "In Review"
    );
  });

  it("returns 'Executed' for Executed", () => {
    expect(artifactStatusDisplayName(DocumentStatus.Executed)).toBe("Executed");
  });
});
