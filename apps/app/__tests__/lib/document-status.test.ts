import { DocumentStatus } from "@repo/api/src/types/document";
import { DOCUMENT_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import {
  artifactStatusColors,
  artifactStatusLabels,
} from "@repo/app/shared/components/status-badge";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// DocumentStatus enum values (PRD-495: DONE/IN_PROGRESS dropped from Documents;
// CHANGES_REQUESTED added; APPROVED is the terminal sign-off).
// ---------------------------------------------------------------------------

describe("DocumentStatus", () => {
  it("contains Approved with value APPROVED", () => {
    expect(DocumentStatus.Approved).toBe("APPROVED");
  });

  it("contains Executed with value EXECUTED", () => {
    expect(DocumentStatus.Executed).toBe("EXECUTED");
  });

  it("contains ChangesRequested with value CHANGES_REQUESTED", () => {
    expect(DocumentStatus.ChangesRequested).toBe("CHANGES_REQUESTED");
  });

  it("no longer carries Done or InProgress", () => {
    expect((DocumentStatus as Record<string, string>).Done).toBeUndefined();
    expect(
      (DocumentStatus as Record<string, string>).InProgress
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// artifactStatusLabels (status-badge.tsx)
// ---------------------------------------------------------------------------

describe("artifactStatusLabels", () => {
  it("maps Approved to 'Approved'", () => {
    expect(artifactStatusLabels[DocumentStatus.Approved]).toBe("Approved");
  });

  it("maps Executed to 'Executed'", () => {
    expect(artifactStatusLabels[DocumentStatus.Executed]).toBe("Executed");
  });

  it("maps ChangesRequested to 'Changes Requested'", () => {
    expect(artifactStatusLabels[DocumentStatus.ChangesRequested]).toBe(
      "Changes Requested"
    );
  });
});

// ---------------------------------------------------------------------------
// artifactStatusColors (status-badge.tsx)
// ---------------------------------------------------------------------------

describe("artifactStatusColors", () => {
  it("has a non-empty color entry for Approved", () => {
    expect(artifactStatusColors[DocumentStatus.Approved]).toBeTruthy();
  });

  it("has a non-empty color entry for Executed", () => {
    expect(artifactStatusColors[DocumentStatus.Executed]).toBeTruthy();
  });

  it("assigns success token classes to the terminal Approved status", () => {
    expect(artifactStatusColors[DocumentStatus.Approved]).toContain("success");
  });
});

// ---------------------------------------------------------------------------
// DOCUMENT_STATUS_LABELS (project-constants.ts)
// ---------------------------------------------------------------------------

describe("DOCUMENT_STATUS_LABELS", () => {
  it("maps Approved to 'Approved'", () => {
    expect(DOCUMENT_STATUS_LABELS[DocumentStatus.Approved]).toBe("Approved");
  });

  it("maps Executed to 'Executed'", () => {
    expect(DOCUMENT_STATUS_LABELS[DocumentStatus.Executed]).toBe("Executed");
  });
});
