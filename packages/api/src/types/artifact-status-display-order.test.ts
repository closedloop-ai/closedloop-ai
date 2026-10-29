import { describe, expect, it } from "vitest";
import { STATUS_DISPLAY_ORDER } from "./artifact-status-display-order.ts";
import { DocumentStatus, IssueStatus } from "./document.ts";

describe("STATUS_DISPLAY_ORDER", () => {
  it("includes every DocumentStatus value", () => {
    for (const status of Object.values(DocumentStatus)) {
      expect(STATUS_DISPLAY_ORDER).toContain(status);
    }
  });

  it("includes every IssueStatus value", () => {
    for (const status of Object.values(IssueStatus)) {
      expect(STATUS_DISPLAY_ORDER).toContain(status);
    }
  });

  it("lists the shared IN_REVIEW status exactly once", () => {
    // DocumentStatus.InReview and IssueStatus.InReview are the same string
    // ("IN_REVIEW") -- the combined order must not repeat it.
    expect(DocumentStatus.InReview).toBe(IssueStatus.InReview);
    const occurrences = STATUS_DISPLAY_ORDER.filter(
      (status) => status === DocumentStatus.InReview
    );
    expect(occurrences).toHaveLength(1);
  });

  it("starts with the not-started statuses, Draft then Triage", () => {
    expect(STATUS_DISPLAY_ORDER[0]).toBe(DocumentStatus.Draft);
    expect(STATUS_DISPLAY_ORDER[1]).toBe(IssueStatus.Triage);
  });

  it("has no duplicate entries beyond the shared IN_REVIEW value", () => {
    const seen = new Set(STATUS_DISPLAY_ORDER);
    expect(seen.size).toBe(STATUS_DISPLAY_ORDER.length);
  });
});
