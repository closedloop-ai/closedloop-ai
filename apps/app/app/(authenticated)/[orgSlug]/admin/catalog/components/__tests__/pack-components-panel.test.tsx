import {
  type CatalogItemDto,
  CatalogItemScope,
  CatalogItemSource,
} from "@repo/api/src/types/distribution";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PackComponentsPanel } from "../pack-components-panel";

vi.mock("../import-repo-dialog", () => ({
  ImportRepoDialog: ({ open }: { open: boolean }) => (
    <div data-open={String(open)} data-testid="repo-dialog" />
  ),
}));

vi.mock("../import-zip-dialog", () => ({
  ImportZipDialog: ({ open }: { open: boolean }) => (
    <div data-open={String(open)} data-testid="zip-dialog" />
  ),
}));

describe("PackComponentsPanel", () => {
  it("renders canonical component content and preserves management controls", () => {
    const onAdd = vi.fn();
    const onEdit = vi.fn();
    const contentComponent = makeCatalogItem({
      id: "component-with-content",
      name: "Planner Agent",
      targetKind: "agent",
      content: "# Planner\n\nYou are a planner.",
    });
    const emptyComponent = makeCatalogItem({
      id: "component-without-content",
      name: "Empty Skill",
      targetKind: "skill",
      content: null,
    });

    render(
      <PackComponentsPanel
        canCreateComponents
        canEditComponent={() => true}
        components={[contentComponent, emptyComponent]}
        onAdd={onAdd}
        onEdit={onEdit}
        onImported={vi.fn()}
        packId="pack-1"
      />
    );

    expect(screen.getByText(hasExactContentBody)).toBeDefined();
    expect(screen.queryByText("null")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add component" }));
    expect(onAdd).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Edit Planner Agent" }));
    expect(onEdit).toHaveBeenCalledWith(contentComponent);

    fireEvent.click(screen.getByRole("button", { name: "Import from repo" }));
    expect(screen.getByTestId("repo-dialog")).toHaveAttribute(
      "data-open",
      "true"
    );

    fireEvent.click(screen.getByRole("button", { name: "Import from zip" }));
    expect(screen.getByTestId("zip-dialog")).toHaveAttribute(
      "data-open",
      "true"
    );
  });
});

function hasExactContentBody(_: string, element: Element | null): boolean {
  return (
    element?.tagName.toLowerCase() === "pre" &&
    element.textContent === "# Planner\n\nYou are a planner."
  );
}

function makeCatalogItem(
  overrides: Partial<CatalogItemDto> = {}
): CatalogItemDto {
  return {
    id: "component-1",
    organizationId: "org-1",
    targetKind: "agent",
    source: CatalogItemSource.OrgCustom,
    scope: CatalogItemScope.Org,
    name: "Planner Agent",
    description: "Plans work",
    version: "1.0.0",
    sortOrder: 0,
    enabled: true,
    archived: false,
    coaching: false,
    coachingConfig: null,
    parentPackId: "pack-1",
    componentUuid: null,
    content: null,
    components: [],
    agentSlug: null,
    logoUrl: null,
    createdById: "user-1",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}
