import { describe, expect, it } from "vitest";
import {
  ARTIFACT_STATUS_DETAIL,
  DISPLAYED_ARTIFACT_STATUS,
} from "./artifact-status.ts";
import {
  ARTIFACT_STATUS_DETAIL_LABELS,
  ARTIFACT_STATUS_DISPLAY_LABELS,
  ARTIFACT_STATUS_UNKNOWN_LABEL,
  ARTIFACT_STATUS_UNKNOWN_TOOLTIP,
  lookupStatusLabel,
  resolveStatusLabel,
  UNKNOWN_ARTIFACT_STATUS_DISPLAY,
} from "./artifact-status-display.ts";

describe("ARTIFACT_STATUS_DISPLAY_LABELS", () => {
  it("labels every displayed root and nothing else", () => {
    expect(ARTIFACT_STATUS_DISPLAY_LABELS).toEqual({
      todo: "Todo",
      in_progress: "In progress",
      in_review: "In review",
      done: "Done",
      canceled: "Canceled",
      unknown: "Unknown",
    });
    expect(Object.keys(ARTIFACT_STATUS_DISPLAY_LABELS).sort()).toEqual(
      Object.values(DISPLAYED_ARTIFACT_STATUS).sort()
    );
  });
});

describe("ARTIFACT_STATUS_DETAIL_LABELS", () => {
  it("labels every detail key and nothing else", () => {
    expect(ARTIFACT_STATUS_DETAIL_LABELS).toEqual({
      "document.drafting": "Drafting",
      "document.changes_requested": "Changes requested",
      "document.approved": "Approved",
      "document.executed": "Executed",
      "document.superseded": "Superseded",
      "issue.triage": "Triage",
      "issue.backlog": "Backlog",
      "issue.blocked": "Blocked",
      "branch.draft": "Draft",
      "branch.pr_open": "Open",
      "branch.review": "Review",
      "branch.changes_requested": "Changes requested",
      "branch.merged": "Merged",
      "branch.closed_without_merge": "Closed without merge",
      "project.archived": "Archived",
      "session.running": "Running",
      "session.completed": "Completed",
      "session.failed": "Failed",
    });
    expect(Object.keys(ARTIFACT_STATUS_DETAIL_LABELS).sort()).toEqual(
      Object.values(ARTIFACT_STATUS_DETAIL).sort()
    );
  });
});

describe("label maps", () => {
  it("are frozen so a consumer cannot rewrite user-facing copy", () => {
    expect(Object.isFrozen(ARTIFACT_STATUS_DISPLAY_LABELS)).toBe(true);
    expect(Object.isFrozen(ARTIFACT_STATUS_DETAIL_LABELS)).toBe(true);
  });
});

describe("ARTIFACT_STATUS_UNKNOWN_TOOLTIP", () => {
  it("is the exact unknown sentence", () => {
    expect(ARTIFACT_STATUS_UNKNOWN_TOOLTIP).toBe(
      "This app version does not recognize this artifact's status. The work may still be in progress."
    );
  });
});

describe("UNKNOWN_ARTIFACT_STATUS_DISPLAY", () => {
  it("reads the visible word FIRST, then the sentence (WCAG 2.5.3)", () => {
    expect(UNKNOWN_ARTIFACT_STATUS_DISPLAY.accessibleName).toBe(
      `${ARTIFACT_STATUS_UNKNOWN_LABEL}, ${ARTIFACT_STATUS_UNKNOWN_TOOLTIP}`
    );
    // The raw vocabularies' unknown word IS the normalized `unknown` root's
    // label — one word, not two declarations that can drift.
    expect(ARTIFACT_STATUS_UNKNOWN_LABEL).toBe(
      ARTIFACT_STATUS_DISPLAY_LABELS[DISPLAYED_ARTIFACT_STATUS.Unknown]
    );
  });
});

describe("lookupStatusLabel", () => {
  it("answers only for keys the map OWNS", () => {
    const labels = { DRAFT: "Draft" };

    expect(lookupStatusLabel(labels, "DRAFT")).toBe("Draft");
    expect(lookupStatusLabel(labels, "BRANCH_MERGED")).toBeUndefined();
    expect(lookupStatusLabel(labels, null)).toBeUndefined();
    // `Artifact.status` is freeform, so an inherited key is reachable input. A
    // bare index would hand the caller `Object.prototype.toString` — a FUNCTION
    // where a label belongs — and every `??` fallback downstream would take it
    // as a resolved label.
    expect(lookupStatusLabel(labels, "toString")).toBeUndefined();
  });
});

describe("resolveStatusLabel", () => {
  it("prefers the map, then the honest word, then the raw value", () => {
    const labels = { DRAFT: "Draft" };

    // A status the map covers keeps its own words even with the gate open —
    // inverting the first two clauses would hide it behind "Unknown".
    expect(
      resolveStatusLabel(labels, "DRAFT", UNKNOWN_ARTIFACT_STATUS_DISPLAY)
    ).toBe("Draft");
    expect(
      resolveStatusLabel(
        labels,
        "BRANCH_MERGED",
        UNKNOWN_ARTIFACT_STATUS_DISPLAY
      )
    ).toBe(ARTIFACT_STATUS_UNKNOWN_LABEL);
    // Gate shut: the raw value, unchanged. Dropping this arm would ship the
    // perceivable change to every reader without the flag.
    expect(resolveStatusLabel(labels, "BRANCH_MERGED", null)).toBe(
      "BRANCH_MERGED"
    );
  });
});
