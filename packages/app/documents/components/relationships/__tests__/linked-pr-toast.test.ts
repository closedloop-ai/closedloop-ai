import { PullRequestLabelSyncStatus } from "@repo/api/src/types/pull-request-label-sync-status";
import { describe, expect, it } from "vitest";
import {
  buildLinkedPullRequestToast,
  LinkedPullRequestToastTone,
} from "../linked-pr-toast";

const PULL_NUMBER = 12;

function syncResult(
  overrides: Partial<{
    status: PullRequestLabelSyncStatus;
    createdLabels: string[];
    addedLabels: string[];
    droppedLabels: string[];
  }> = {}
) {
  return {
    status: PullRequestLabelSyncStatus.Applied,
    createdLabels: [],
    addedLabels: [],
    droppedLabels: [],
    ...overrides,
  };
}

describe("buildLinkedPullRequestToast", () => {
  it("reports only the link when the API did not report a label outcome", () => {
    expect(buildLinkedPullRequestToast(PULL_NUMBER)).toEqual({
      tone: LinkedPullRequestToastTone.Success,
      message: "Linked PR #12",
    });
  });

  it("celebrates an applied set as a success", () => {
    const toast = buildLinkedPullRequestToast(
      PULL_NUMBER,
      syncResult({ addedLabels: ["infra", "docs"] })
    );

    expect(toast.tone).toBe(LinkedPullRequestToastTone.Success);
    expect(toast.message).toBe("Linked PR #12. Applied 2 labels.");
  });

  it("keeps a no-op a success", () => {
    const toast = buildLinkedPullRequestToast(
      PULL_NUMBER,
      syncResult({ status: PullRequestLabelSyncStatus.NoOp })
    );

    expect(toast.tone).toBe(LinkedPullRequestToastTone.Success);
    expect(toast.message).toBe("Linked PR #12");
  });

  // Two of the four outcomes are failures; sending them through a success toast
  // told the user the labels were fine when they were not.
  it("warns and names GitHub when the provider rejected the write", () => {
    const toast = buildLinkedPullRequestToast(
      PULL_NUMBER,
      syncResult({ status: PullRequestLabelSyncStatus.Failed })
    );

    expect(toast.tone).toBe(LinkedPullRequestToastTone.Warning);
    expect(toast.message).toBe("Linked PR #12. GitHub rejected the labels.");
  });

  // `Failed` and `SourceRejected` are not the same event to the reader: one is
  // GitHub saying no, the other is Closedloop declining to supply labels.
  it("warns differently when the source could not supply labels", () => {
    const toast = buildLinkedPullRequestToast(
      PULL_NUMBER,
      syncResult({ status: PullRequestLabelSyncStatus.SourceRejected })
    );

    expect(toast.tone).toBe(LinkedPullRequestToastTone.Warning);
    expect(toast.message).toBe(
      "Linked PR #12. That feature can't supply labels for this PR."
    );
  });

  // The ceiling case used to be checked FIRST, so a run where the GitHub call
  // failed outright was reported as "two were not applied" when none landed.
  it("reports the provider failure alongside the ceiling, never instead of it", () => {
    const toast = buildLinkedPullRequestToast(
      PULL_NUMBER,
      syncResult({
        status: PullRequestLabelSyncStatus.Failed,
        droppedLabels: ["perf", "p1"],
      })
    );

    expect(toast.tone).toBe(LinkedPullRequestToastTone.Warning);
    expect(toast.message).toContain("GitHub rejected the labels.");
    expect(toast.message).toContain("perf and p1 were not applied.");
  });

  // The count is the least useful thing we know; `droppedLabels` carries names.
  it("names the refused tags rather than handing back a bare count", () => {
    const toast = buildLinkedPullRequestToast(
      PULL_NUMBER,
      syncResult({ droppedLabels: ["perf"] })
    );

    expect(toast.tone).toBe(LinkedPullRequestToastTone.Warning);
    expect(toast.message).toBe(
      "Linked PR #12. Too many tags to label. perf was not applied."
    );
  });

  it("summarises the tail once more than two tags were refused", () => {
    const toast = buildLinkedPullRequestToast(
      PULL_NUMBER,
      syncResult({ droppedLabels: ["perf", "p1", "infra", "docs"] })
    );

    expect(toast.message).toBe(
      "Linked PR #12. Too many tags to label. perf, p1 and 2 more were not applied."
    );
  });

  // Em dashes are not shipped in customer-facing copy.
  it("never renders an em dash", () => {
    const messages = [
      buildLinkedPullRequestToast(PULL_NUMBER).message,
      buildLinkedPullRequestToast(
        PULL_NUMBER,
        syncResult({ status: PullRequestLabelSyncStatus.Failed })
      ).message,
      buildLinkedPullRequestToast(
        PULL_NUMBER,
        syncResult({ status: PullRequestLabelSyncStatus.SourceRejected })
      ).message,
      buildLinkedPullRequestToast(
        PULL_NUMBER,
        syncResult({ droppedLabels: ["perf", "p1"] })
      ).message,
      buildLinkedPullRequestToast(
        PULL_NUMBER,
        syncResult({ addedLabels: ["infra"] })
      ).message,
    ];

    for (const message of messages) {
      expect(message).not.toContain("—");
    }
  });
});
