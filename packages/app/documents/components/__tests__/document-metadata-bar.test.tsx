import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { Priority } from "@repo/api/src/types/common";
import {
  DocumentStatus,
  DocumentType,
  RepositoryRole,
  SnapshotSource,
} from "@repo/api/src/types/document";
import { TagColor, TagEntityType } from "@repo/api/src/types/tag";
import { DOCUMENT_TYPE_BADGE_LABELS } from "@repo/app/documents/lib/document-type-labels";
import { NO_PRIORITY_LABEL } from "@repo/app/documents/lib/group-by";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import type { DocumentMetadataBarProps } from "../document-metadata-bar";

const mockUseFeatureFlagEnabled = vi.fn();
const mockUseFeatureFlagEnabledOptional = vi.fn();

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (flag: string) => mockUseFeatureFlagEnabled(flag),
  useFeatureFlagEnabledOptional: (flag: string) =>
    mockUseFeatureFlagEnabledOptional(flag),
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
    surface,
  }: {
    appliedTags: { name: string }[];
    entityId: string;
    entityType: string;
    surface?: ArtifactStatusEditSurface;
  }) => (
    <div data-testid="tag-picker">
      {entityType}:{entityId}:{appliedTags.map((tag) => tag.name).join(",")}:
      {surface}
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

describe("DocumentMetadataBar — unset priority (ISS-9665)", () => {
  test("names the unset state in words with the flag on", () => {
    mockUseFeatureFlagEnabled.mockReturnValue(false);
    mockUseFeatureFlagEnabledOptional.mockReturnValue(true);

    render(
      <DocumentMetadataBar
        documentId="doc-1"
        documentType={DocumentType.Prd}
        metadata={{ ...createMetadata(), priority: null }}
      />
    );

    // The word, not just the absence of a colour (WCAG 1.4.1), and an
    // accessible name that says what activating the control does.
    expect(screen.getByText(NO_PRIORITY_LABEL)).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Set priority" })
    ).toBeInTheDocument();
  });

  test("still shows Medium for an unset priority with the flag off", () => {
    // The flag-OFF contract: this bar renders exactly what it rendered before
    // the serializer stopped folding NULL to MEDIUM.
    mockUseFeatureFlagEnabled.mockReturnValue(false);
    mockUseFeatureFlagEnabledOptional.mockReturnValue(false);

    render(
      <DocumentMetadataBar
        documentId="doc-1"
        documentType={DocumentType.Prd}
        metadata={{ ...createMetadata(), priority: null }}
      />
    );

    expect(screen.getByText("Medium")).toBeInTheDocument();
    expect(screen.queryByText(NO_PRIORITY_LABEL)).toBeNull();
  });

  test("keeps showing unset until the parent accepts the pick", async () => {
    // The Select must stay CONTROLLED while unset. Handed an `undefined` value
    // Radix takes the user's pick into its own internal state and stops
    // rendering the placeholder, so the trigger would announce a priority the
    // parent (and therefore the server) never accepted — exactly what a refused
    // write leaves behind. With the controlled empty-string value the trigger
    // reflects only what `metadata.priority` says.
    mockUseFeatureFlagEnabled.mockReturnValue(false);
    mockUseFeatureFlagEnabledOptional.mockReturnValue(true);
    const metadata = { ...createMetadata(), priority: null };

    render(
      <DocumentMetadataBar
        documentId="doc-1"
        documentType={DocumentType.Prd}
        metadata={metadata}
      />
    );

    await userEvent.click(
      screen.getByRole("combobox", { name: "Set priority" })
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Urgent" })
    );

    // The handler fired, so the control is live — but the parent state did not
    // move, so the trigger must not claim it did.
    expect(metadata.handlePriorityChange).toHaveBeenCalledWith(Priority.Urgent);
    expect(
      screen.getByRole("combobox", { name: "Set priority" })
    ).toBeInTheDocument();
    expect(screen.getByText(NO_PRIORITY_LABEL)).toBeInTheDocument();
  });

  test("reports a real priority unchanged in both flag states", () => {
    // The sibling that stops either case above from passing against a bar that
    // always says one thing.
    for (const unsetEnabled of [true, false]) {
      cleanup();
      mockUseFeatureFlagEnabled.mockReturnValue(false);
      mockUseFeatureFlagEnabledOptional.mockReturnValue(unsetEnabled);

      render(
        <DocumentMetadataBar
          documentId="doc-1"
          documentType={DocumentType.Prd}
          metadata={{ ...createMetadata(), priority: Priority.Urgent }}
        />
      );

      expect(
        screen.getByRole("combobox", { name: "Priority: Urgent" })
      ).toBeInTheDocument();
    }
  });
});

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

    expect(
      screen.queryByText(DOCUMENT_TYPE_BADGE_LABELS[DocumentType.Prd])
    ).toBeNull();
    expect(screen.getByTestId("status-metadata")).toHaveTextContent(
      "IN_REVIEW / Ada Lovelace"
    );
    expect(screen.getByText("High")).toBeInTheDocument();
    // FEA-3963: the priority pill exposes a field-labeled accessible name so a
    // screen reader announces "Priority: High", not just the value.
    expect(
      screen.getByRole("combobox", { name: "Priority: High" })
    ).toBeInTheDocument();
    expect(screen.getByText("acme/api")).toBeInTheDocument();
    expect(screen.getByTestId("tag-picker")).toHaveTextContent(
      `${TagEntityType.Artifact}:artifact-1:Urgent`
    );
    expect(screen.getByTestId("tag-picker")).toHaveTextContent(
      ArtifactStatusEditSurface.Detail
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

    expect(
      screen.queryByText(DOCUMENT_TYPE_BADGE_LABELS[DocumentType.Feature])
    ).toBeNull();
    expect(screen.queryByText("acme/api")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tag-picker")).not.toBeInTheDocument();
  });
});
