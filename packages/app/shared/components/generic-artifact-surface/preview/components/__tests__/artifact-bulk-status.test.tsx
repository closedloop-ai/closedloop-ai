// @vitest-environment jsdom

import {
  ARTIFACT_STATUS_DETAIL,
  ARTIFACT_STATUS_ROOT,
} from "@repo/api/src/types/artifact-status";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  GenericArtifactKind,
  GenericArtifactStatus,
  genericArtifactCompatibleStatusOptions,
} from "../../../generic-artifact-status";
import { type GenericArtifact, genericArtifacts } from "../../fixtures";
import { resolveArtifactBulkStatusUpdates } from "../artifact-list-bulk-actions";
import { ArtifactBulkActionBar } from "../artifact-list-control-adapters";

describe("ArtifactBulkActionBar status options", () => {
  it("renders canonical bulk facets and commits their stable key", async () => {
    const onStatusChange = vi.fn();
    const statusOptions = genericArtifactCompatibleStatusOptions([
      {
        kind: GenericArtifactKind.Issue,
        status: GenericArtifactStatus.Todo,
      },
    ]);
    render(
      <ArtifactBulkActionBar
        count={2}
        currentTags={[]}
        noun={{ plural: "artifacts", singular: "artifact" }}
        onAction={vi.fn()}
        onClear={vi.fn()}
        onStatusChange={onStatusChange}
        statusOptions={statusOptions}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Change status" }));
    fireEvent.click(await screen.findByRole("button", { name: "In progress" }));

    expect(onStatusChange).toHaveBeenCalledWith(
      ARTIFACT_STATUS_ROOT.InProgress
    );
  });

  it("distinguishes all-no-op, partial-change, and resolution failure", () => {
    const issue = genericArtifacts.find(
      (artifact) => artifact.kind === GenericArtifactKind.Issue
    )!;
    const document = genericArtifacts.find(
      (artifact) => artifact.kind === GenericArtifactKind.Document
    )!;
    const inReviewIssue = {
      ...issue,
      status: GenericArtifactStatus.InReview,
    } as GenericArtifact;
    const todoIssue = {
      ...issue,
      id: "todo-issue",
      status: GenericArtifactStatus.Todo,
    } as GenericArtifact;

    expect(
      resolveArtifactBulkStatusUpdates(
        [inReviewIssue],
        ARTIFACT_STATUS_ROOT.InReview
      )
    ).toEqual([]);
    expect(
      resolveArtifactBulkStatusUpdates(
        [inReviewIssue, todoIssue],
        ARTIFACT_STATUS_ROOT.InReview
      )
    ).toEqual([
      {
        artifactId: "todo-issue",
        status: GenericArtifactStatus.InReview,
      },
    ]);
    expect(
      resolveArtifactBulkStatusUpdates([document], ARTIFACT_STATUS_ROOT.Todo)
    ).toBeNull();
    expect(
      resolveArtifactBulkStatusUpdates(
        [document, todoIssue],
        ARTIFACT_STATUS_ROOT.Done
      )
    ).toBeNull();
    expect(
      resolveArtifactBulkStatusUpdates(
        [document],
        ARTIFACT_STATUS_DETAIL.DocumentExecuted
      )
    ).toEqual([
      { artifactId: document.id, status: GenericArtifactStatus.Completed },
    ]);
  });

  it("offers only exact targets supported by every selected row", () => {
    const issue = genericArtifacts.find(
      (artifact) => artifact.kind === GenericArtifactKind.Issue
    )!;
    const document = genericArtifacts.find(
      (artifact) => artifact.kind === GenericArtifactKind.Document
    )!;
    expect(
      genericArtifactCompatibleStatusOptions([issue, document]).map(
        (option) => option.key
      )
    ).toEqual([ARTIFACT_STATUS_ROOT.InReview]);
    expect(
      genericArtifactCompatibleStatusOptions([document]).map(
        (option) => option.key
      )
    ).toEqual([
      ARTIFACT_STATUS_DETAIL.DocumentDrafting,
      ARTIFACT_STATUS_ROOT.InReview,
      ARTIFACT_STATUS_DETAIL.DocumentChangesRequested,
      ARTIFACT_STATUS_DETAIL.DocumentApproved,
      ARTIFACT_STATUS_DETAIL.DocumentExecuted,
      ARTIFACT_STATUS_DETAIL.DocumentSuperseded,
    ]);
  });
});
