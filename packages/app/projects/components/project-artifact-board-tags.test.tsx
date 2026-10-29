import { DocumentType, IssueStatus } from "@repo/api/src/types/document";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectArtifactBoardTags } from "./project-artifact-board-tags";

const mocks = vi.hoisted(() => ({
  enabled: false,
  props: vi.fn(),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: () => mocks.enabled,
}));

vi.mock("@repo/app/tags/components/entity-tags-cell", () => ({
  EntityTagsCell: (props: unknown) => {
    mocks.props(props);
    return <div data-testid="tags" />;
  },
}));

const DOCUMENT: DocumentRowData = {
  assignee: null,
  assigneeId: null,
  createdAt: new Date("2026-10-19T00:00:00.000Z"),
  id: "artifact-1",
  priority: null,
  projectId: "project-1",
  slug: "ISS-724",
  sortOrder: 1024,
  status: IssueStatus.InProgress,
  tags: [],
  title: "Artifact Board",
  type: DocumentType.Feature,
  updatedAt: new Date("2026-10-19T00:00:00.000Z"),
};

describe("CT-12/CT-19 Project board tag mutation authority", () => {
  beforeEach(() => {
    mocks.enabled = false;
    mocks.props.mockReset();
  });

  it("keeps tags read-only and withholds identity while the owning flag is closed", () => {
    render(<ProjectArtifactBoardTags document={DOCUMENT} />);

    expect(mocks.props).toHaveBeenCalledWith(
      expect.objectContaining({
        canApply: false,
        canRemove: false,
        entityId: null,
      })
    );
  });

  it("delegates supported mutations to the canonical tag cell when enabled", () => {
    mocks.enabled = true;
    render(<ProjectArtifactBoardTags document={DOCUMENT} />);

    expect(mocks.props).toHaveBeenCalledWith(
      expect.objectContaining({
        canApply: true,
        canRemove: true,
        entityId: DOCUMENT.id,
      })
    );
  });
});
