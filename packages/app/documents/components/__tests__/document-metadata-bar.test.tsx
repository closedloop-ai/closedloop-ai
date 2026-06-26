import { Priority } from "@repo/api/src/types/common";
import {
  DocumentStatus,
  DocumentType,
  RepositoryRole,
  SnapshotSource,
} from "@repo/api/src/types/document";
import { TagColor, TagEntityType } from "@repo/api/src/types/tag";
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { DocumentMetadataBarProps } from "../document-metadata-bar";

const mockUseFeatureFlagEnabled = vi.fn();

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (flag: string) => mockUseFeatureFlagEnabled(flag),
}));

vi.mock("@repo/app/documents/components/attach-files-button", () => ({
  AttachFilesButton: ({ documentId }: { documentId: string }) => (
    <button type="button">Attach files for {documentId}</button>
  ),
}));

vi.mock("@repo/app/documents/components/status-metadata-section", () => ({
  StatusMetadataSection: ({
    assignee,
    status,
  }: {
    assignee: { name: string } | null;
    status: string;
  }) => (
    <div data-testid="status-metadata">
      {status} / {assignee?.name ?? "Unassigned"}
    </div>
  ),
}));

vi.mock("@repo/app/tags/components/tag-picker", () => ({
  TagPicker: ({
    appliedTags,
    entityId,
    entityType,
  }: {
    appliedTags: { name: string }[];
    entityId: string;
    entityType: string;
  }) => (
    <div data-testid="tag-picker">
      {entityType}:{entityId}:{appliedTags.map((tag) => tag.name).join(",")}
    </div>
  ),
}));

import { DocumentMetadataBar } from "../document-metadata-bar";

function createMetadata(): DocumentMetadataBarProps["metadata"] {
  return {
    assignee: {
      id: "user-1",
      name: "Ada Lovelace",
      email: "ada@example.com",
    },
    handleAssigneeChange: vi.fn(),
    handlePriorityChange: vi.fn(),
    handleStatusChange: vi.fn(),
    priority: Priority.High,
    repositorySnapshot: {
      repositories: [
        {
          fullName: "acme/api",
          position: 0,
          role: RepositoryRole.Primary,
        },
      ],
      source: SnapshotSource.ProjectDefaults,
    },
    status: DocumentStatus.InReview,
    teamMembers: [],
  };
}

describe("DocumentMetadataBar", () => {
  test("renders shared document metadata controls and repositories", () => {
    mockUseFeatureFlagEnabled.mockReturnValue(true);

    render(
      <DocumentMetadataBar
        documentId="artifact-1"
        documentType={DocumentType.Prd}
        metadata={createMetadata()}
        tags={[{ id: "tag-1", name: "Urgent", color: TagColor.Orange }]}
      />
    );

    expect(screen.getByText("PRD")).toBeInTheDocument();
    expect(screen.getByTestId("status-metadata")).toHaveTextContent(
      "IN_REVIEW / Ada Lovelace"
    );
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByText("acme/api")).toBeInTheDocument();
    expect(screen.getByTestId("tag-picker")).toHaveTextContent(
      `${TagEntityType.Artifact}:artifact-1:Urgent`
    );
    expect(
      screen.getByRole("button", { name: "Attach files for artifact-1" })
    ).toBeInTheDocument();
  });

  test("hides repositories and tags when those app-level options are disabled", () => {
    mockUseFeatureFlagEnabled.mockReturnValue(false);

    render(
      <DocumentMetadataBar
        documentId="artifact-1"
        documentType={DocumentType.Feature}
        metadata={createMetadata()}
        showRepositories={false}
      />
    );

    expect(screen.getByText("Feature")).toBeInTheDocument();
    expect(screen.queryByText("acme/api")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tag-picker")).not.toBeInTheDocument();
  });
});
