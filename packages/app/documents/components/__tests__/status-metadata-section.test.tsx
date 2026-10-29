import {
  type ArtifactStatus,
  DocumentStatus,
  DocumentType,
} from "@repo/api/src/types/document";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { DOCUMENT_STATUS_LABELS } from "@repo/app/shared/lib/artifact-status-labels";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { StatusMetadataSection } from "../status-metadata-section";

const ASSIGNEE: User = {
  id: "user-1",
  name: "Marisol Ashgrove",
  email: "marisol@example.com",
};

function renderHorizontal(overrides?: { assignee: User | null }) {
  const assignee = overrides ? overrides.assignee : ASSIGNEE;
  return render(
    <StatusMetadataSection
      artifactId="doc-1"
      assignee={assignee}
      documentType={DocumentType.Prd}
      layout="horizontal"
      onAssigneeChange={vi.fn()}
      onStatusChange={vi.fn()}
      status={DocumentStatus.Approved}
      teamMembers={[ASSIGNEE]}
    />
  );
}

function renderVertical(overrides?: { assignee: User | null }) {
  const assignee = overrides ? overrides.assignee : ASSIGNEE;
  return render(
    <StatusMetadataSection
      artifactId="doc-1"
      assignee={assignee}
      documentType={DocumentType.Prd}
      layout="vertical"
      onAssigneeChange={vi.fn()}
      onStatusChange={vi.fn()}
      status={DocumentStatus.Approved}
      teamMembers={[ASSIGNEE]}
    />
  );
}

function renderUniversalStatus(
  status: ArtifactStatus,
  onStatusChange = vi.fn(),
  layout: "horizontal" | "vertical" = "vertical"
) {
  return {
    onStatusChange,
    ...render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY],
        })}
      >
        <StatusMetadataSection
          artifactId="doc-1"
          assignee={ASSIGNEE}
          documentType={DocumentType.Prd}
          layout={layout}
          onAssigneeChange={vi.fn()}
          onStatusChange={onStatusChange}
          status={status}
          teamMembers={[ASSIGNEE]}
        />
      </FeatureFlagAdapterProvider>
    ),
  };
}

describe("StatusMetadataSection accessible names (FEA-3963)", () => {
  test("status pill announces the field label plus its value", () => {
    renderHorizontal();

    // Screen reader hears "Status: Approved" rather than just "Approved".
    expect(
      screen.getByRole("combobox", { name: "Status: Approved" })
    ).toBeInTheDocument();
  });

  test("assignee pill announces the field label plus its value", () => {
    renderHorizontal();

    // Colon form matches the sibling Status/Priority pills in the metadata bar.
    expect(
      screen.getByRole("combobox", { name: "Assignee: Marisol Ashgrove" })
    ).toBeInTheDocument();
  });

  test("assignee pill keeps the field label when unassigned", () => {
    renderHorizontal({ assignee: null });

    // Unassigned falls back to the placeholder, still prefixed by the label.
    expect(
      screen.getByRole("combobox", { name: "Assignee: Select assignee..." })
    ).toBeInTheDocument();
  });

  test("vertical (sidebar) assignee control also announces its field label", () => {
    renderVertical();

    // Sidebar layout must not announce the value alone — it carries the same
    // "Assignee: <value>" accessible name as the horizontal bar.
    expect(
      screen.getByRole("combobox", { name: "Assignee: Marisol Ashgrove" })
    ).toBeInTheDocument();
  });
});

describe("StatusMetadataSection universal artifact status adoption", () => {
  test.each(["horizontal", "vertical"] as const)(
    "uses a field-qualified canonical name in the %s layout",
    (layout) => {
      renderUniversalStatus(DocumentStatus.Draft, vi.fn(), layout);

      expect(
        screen.getByRole("button", { name: "Status: Drafting" })
      ).toBeInTheDocument();
      expect(
        screen.queryByText(DOCUMENT_STATUS_LABELS[DocumentStatus.Draft])
      ).not.toBeInTheDocument();
    }
  );

  test("commits through the existing status writer", async () => {
    const user = userEvent.setup();
    const { onStatusChange } = renderUniversalStatus(DocumentStatus.Obsolete);

    await user.click(
      screen.getByRole("button", { name: "Status: Superseded" })
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Done, Approved" })
    );

    expect(onStatusChange).toHaveBeenCalledWith(DocumentStatus.Approved);
  });

  test.each(["horizontal", "vertical"] as const)(
    "keeps future evidence in the canonical Unknown slot in the %s layout",
    (layout) => {
      renderUniversalStatus(
        "AWAITING_PRODUCT_COUNCIL" as ArtifactStatus,
        vi.fn(),
        layout
      );

      expect(screen.getByText("Unknown", { exact: true })).toBeVisible();
      expect(screen.queryByText("AWAITING_PRODUCT_COUNCIL")).toBeNull();
    }
  );
});
