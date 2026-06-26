import { DocumentStatus } from "@repo/api/src/types/document";
import {
  DOCUMENT_STATUS_COLORS,
  DOCUMENT_STATUS_LABELS,
} from "@repo/app/projects/lib/project-constants";
import {
  artifactStatusColors,
  artifactStatusLabels,
} from "@repo/app/shared/components/status-badge";
import { describe, expect, it } from "vitest";

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
