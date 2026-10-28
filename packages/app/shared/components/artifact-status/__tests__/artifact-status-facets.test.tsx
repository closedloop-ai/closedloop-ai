import { IssueStatus } from "@closedloop-ai/loops-api/document";
import { ARTIFACT_STATUS_DETAIL } from "@repo/api/src/types/artifact-status";
import { ArtifactStatusVocabulary } from "@repo/api/src/types/artifact-status-contract";
import {
  ARTIFACT_STATUS_DETAIL_LABELS,
  ARTIFACT_STATUS_DISPLAY_LABELS,
} from "@repo/api/src/types/artifact-status-display";
import { toArtifactStatusFromIssue } from "@repo/api/src/types/artifact-status-mapping";
import { ArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import type { ArtifactStatusView } from "@repo/app/shared/lib/artifact-status-view-contract";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const TRIAGE_LABEL =
  ARTIFACT_STATUS_DETAIL_LABELS[ARTIFACT_STATUS_DETAIL.IssueTriage];

/**
 * A full row, passed through the FACET arm on purpose: a view IS a facet, so
 * this is the assignability the facet props promise, exercised at a real call
 * site rather than asserted separately.
 */
const TRIAGE_ROW: ArtifactStatusView = {
  artifactId: "artifact-7f3c",
  normalized: toArtifactStatusFromIssue(IssueStatus.Triage),
  raw: IssueStatus.Triage,
  vocabulary: ArtifactStatusVocabulary.Issue,
};

describe("the facet variants", () => {
  it("states the lane's status exactly once in the accessibility tree", () => {
    render(
      <ArtifactStatus
        facet={TRIAGE_ROW}
        variant={ArtifactStatusVariant.BoardLane}
      />
    );

    // The visible word is the statement, so the glyph beside it stays out of
    // the tree — leaving its name on announces the status twice. WCAG 1.4.1 is
    // the other half: the word is present at all, so tone is never the only
    // carrier.
    expect(screen.queryAllByRole("img", { name: TRIAGE_LABEL })).toHaveLength(
      0
    );
    expect(screen.getByText(TRIAGE_LABEL)).toBeInTheDocument();
  });

  it("gives the lane header the heading scale and an option the option scale", () => {
    // The scale is the one thing that genuinely differs across the three facet
    // variants, and it is read off the element the component RENDERED rather
    // than off the table it selected from — so swapping the rows of
    // `ARTIFACT_STATUS_FACET_LABEL_CLASS` reddens this instead of passing.
    const lane = render(
      <ArtifactStatus
        facet={TRIAGE_ROW}
        variant={ArtifactStatusVariant.BoardLane}
      />
    );
    expect(screen.getByText(TRIAGE_LABEL)).toHaveClass("text-sm");
    lane.unmount();

    render(
      <ArtifactStatus
        facet={TRIAGE_ROW}
        variant={ArtifactStatusVariant.FilterOption}
      />
    );
    expect(screen.getByText(TRIAGE_LABEL)).not.toHaveClass("text-sm");
    expect(
      screen.queryByText(ARTIFACT_STATUS_DISPLAY_LABELS.todo)
    ).not.toBeInTheDocument();
  });

  it("draws a filter option as the status word alone and keeps the glyph elsewhere", () => {
    // ISS-12919 (Ottilie Eastwick): filter menus carry no icons. The word stays, so
    // the option still names its status in text rather than by tone.
    const option = render(
      <ArtifactStatus
        facet={TRIAGE_ROW}
        variant={ArtifactStatusVariant.FilterOption}
      />
    );
    expect(screen.getByText(TRIAGE_LABEL)).toBeInTheDocument();
    expect(option.container.querySelector("svg")).toBeNull();
    option.unmount();

    for (const variant of [
      ArtifactStatusVariant.BulkOption,
      ArtifactStatusVariant.BoardLane,
    ]) {
      const other = render(
        <ArtifactStatus facet={TRIAGE_ROW} variant={variant} />
      );
      expect(screen.getByText(TRIAGE_LABEL)).toBeInTheDocument();
      expect(other.container.querySelector("svg")).not.toBeNull();
      other.unmount();
    }
  });
});
