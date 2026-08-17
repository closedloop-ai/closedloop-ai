import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { StatusMetadataSection } from "../status-metadata-section";

const ASSIGNEE: User = {
  id: "user-1",
  name: "Mike Angstadt",
  email: "mike@example.com",
};

function renderHorizontal(overrides?: { assignee: User | null }) {
  const assignee = overrides ? overrides.assignee : ASSIGNEE;
  return render(
    <StatusMetadataSection
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
      screen.getByRole("combobox", { name: "Assignee: Mike Angstadt" })
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
      screen.getByRole("combobox", { name: "Assignee: Mike Angstadt" })
    ).toBeInTheDocument();
  });
});
